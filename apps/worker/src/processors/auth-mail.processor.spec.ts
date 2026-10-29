import { describe, expect, it, vi } from 'vitest';
import { DelayedError, type Job } from 'bullmq';
import type { OutboxEventJobData } from '../outbox-event-routes';
import type { ResendMailService, WorkerMailMessage, WorkerMailSendResult } from '../resend-mail.service';
import { AuthMailProcessor, type AuthMailSentMarker } from './auth-mail.processor';

/**
 * Kiểm chứng hành vi của consumer mail auth trên hàng đợi ở worker
 * (issue #517) qua các hệ quả quan sát được — mail nào thật sự tới
 * transport, job nào bị bỏ qua, lỗi nào được ném lại cho cơ chế thử
 * lại của hàng đợi:
 *
 * - Job hợp lệ được dựng nội dung bằng template dùng chung và gửi
 *   đúng một lần qua transport phía worker.
 * - PHÁT LẠI cùng một sự kiện (cùng `outboxId`) không gửi mail lần
 *   hai — tính idempotent theo `outboxId` là hàng rào chống tác
 *   dụng phụ trùng ngoài cửa sổ chống trùng bằng `jobId` của
 *   BullMQ, nên ca phát lại là ca trung tâm của spec này.
 * - Hai lượt xử lý ĐỒNG THỜI cùng một sự kiện cũng chỉ gửi đúng
 *   một mail: hàng rào là lease ĐANG XỬ LÝ chiếm nguyên tử trước
 *   khi gửi; lượt thua không được kết thúc như đã xử lý (mail có
 *   thể chưa hề được gửi) mà ném tín hiệu hẹn thử lại
 *   `DelayedError` của BullMQ.
 * - Lượt giữ lease CHẾT trước khi gửi (không nhả lease) thì mail
 *   không mất: lease tự hết hạn và lượt xử lý lại chiếm lại được
 *   lease để gửi — ca khôi phục sau sập này ghim đúng cửa sổ mà
 *   cơ chế một khoá (chiếm dấu trước khi gửi và giữ luôn làm dấu
 *   đã xử lý) từng để mất mail im lặng.
 * - Nhả lease có kiểm tra chủ sở hữu: token sai không xoá được
 *   lease của lượt khác.
 * - Lỗi gửi tạm thời không để lại dấu đã gửi: job bị ném lỗi cho
 *   hàng đợi thử lại và lần xử lý sau gửi được, tổng cộng vẫn đúng
 *   một mail.
 * - Payload hỏng thì job kết thúc lặng (không gửi, không ném) để
 *   không chặn hàng đợi; môi trường chưa cấu hình Resend thì coi
 *   như đã xử lý như đường consumer cũ.
 *
 * Transport và hàng rào hai trạng thái đều là bản giả trong bộ nhớ
 * theo đúng bề mặt processor dùng; đường Redis thật của hàng rào
 * được kiểm chứng ở spec tích hợp
 * `test/integration/mail/auth-mail-queue.int-spec.ts`.
 */

/** Transport giả: ghi lại mọi mail được yêu cầu gửi; chế độ lỗi/bỏ qua điều khiển được theo ca. */
class FakeMailer {
  readonly sent: WorkerMailMessage[] = [];
  /** Số lần `send` được gọi, kể cả lần lỗi và lần bỏ qua. */
  calls = 0;
  mode: 'sent' | 'skipped' | 'throw' = 'sent';

  async send(message: WorkerMailMessage): Promise<WorkerMailSendResult> {
    this.calls += 1;
    if (this.mode === 'throw') throw new Error('Resend API trả 500 (giả lập)');
    if (this.mode === 'skipped') return { status: 'skipped', reason: 'resend_not_configured' };
    this.sent.push(message);
    return { status: 'sent', providerId: 'fake-resend-id' };
  }
}

/**
 * Transport giả có cổng chặn: mọi lượt `send` treo lại cho tới khi
 * test mở cổng — dùng để ép hai lượt xử lý ĐỒNG THỜI cùng một sự
 * kiện chồng lấn lên nhau tại đúng cửa sổ gửi, tái hiện đường đua
 * chống trùng (job bị nhận xử lý lại trong khi lượt trước còn đang
 * gửi).
 */
class GatedMailer {
  readonly sent: WorkerMailMessage[] = [];
  /** Số lần `send` được gọi — mỗi lượt xử lý tới được transport đều tăng biến này. */
  calls = 0;
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });

  async send(message: WorkerMailMessage): Promise<WorkerMailSendResult> {
    this.calls += 1;
    await this.gate;
    this.sent.push(message);
    return { status: 'sent', providerId: 'fake-resend-id' };
  }

  /** Mở cổng: mọi lượt gửi đang treo hoàn tất. */
  openGate(): void {
    this.open();
  }
}

/**
 * Hàng rào hai trạng thái giả trong bộ nhớ, đúng hợp đồng
 * {@link AuthMailSentMarker}: dấu ĐÃ GỬI là một tập khoá riêng;
 * lease ĐANG XỬ LÝ mang token chủ sở hữu và mốc hết hạn theo đồng
 * hồ thật (hạn lease rút ngắn được qua tham số dựng để test mô
 * phỏng được lease hết hạn). `claimProcessing` kiểm tra-và-ghi
 * trong một khối đồng bộ không có điểm chờ ở giữa, nên nguyên tử
 * đúng như `SET ... NX` phía Redis trên vòng lặp sự kiện đơn
 * luồng; nhả lease chỉ xoá khi token khớp.
 */
class FakeSentMarker implements AuthMailSentMarker {
  private readonly sent = new Set<string>();
  private readonly leases = new Map<string, { ownerToken: string; expiresAt: number }>();
  private leaseCounter = 0;

  constructor(private readonly leaseTtlMs: number = 60000) {}

  async hasSent(outboxId: string): Promise<boolean> {
    return this.sent.has(outboxId);
  }

  async claimProcessing(outboxId: string): Promise<string | null> {
    const current = this.leases.get(outboxId);
    if (current && current.expiresAt > Date.now()) return null;
    this.leaseCounter += 1;
    const ownerToken = `fake-lease-${this.leaseCounter}`;
    this.leases.set(outboxId, { ownerToken, expiresAt: Date.now() + this.leaseTtlMs });
    return ownerToken;
  }

  async markSent(outboxId: string): Promise<void> {
    this.sent.add(outboxId);
  }

  async releaseProcessing(outboxId: string, ownerToken: string): Promise<void> {
    const current = this.leases.get(outboxId);
    if (current && current.ownerToken === ownerToken) this.leases.delete(outboxId);
  }
}

const RESET_URL = 'http://localhost:5173/reset-password/token-abc?callbackURL=%2Freset-password';
const DEFAULT_OUTBOX_ID = '0191e8f2-7c3a-7b21-9f00-000000000517';

/** Dựng một job như relay phát: dữ liệu là toàn bộ dòng outbox đã chuẩn hoá. */
function makeJob(
  payload: Record<string, unknown> | null,
  outboxId: string = DEFAULT_OUTBOX_ID,
): Job<OutboxEventJobData> {
  return {
    data: {
      outboxId,
      seq: 42,
      aggregate: 'auth',
      type: 'auth_mail_requested',
      payload,
      tenantId: null,
      occurredAt: '2026-10-29T00:00:00.000Z',
    },
  } as Job<OutboxEventJobData>;
}

function makeProcessor(mailer: FakeMailer, marker: FakeSentMarker): AuthMailProcessor {
  return new AuthMailProcessor(mailer as unknown as ResendMailService, marker);
}

describe('AuthMailProcessor (consumer mail auth trên hàng đợi ở worker)', () => {
  it('gửi mail đặt lại mật khẩu dựng từ payload của job qua transport phía worker', async () => {
    const mailer = new FakeMailer();
    const processor = makeProcessor(mailer, new FakeSentMarker());

    const result = await processor.process(
      makeJob({ kind: 'password_reset', to: 'user@example.com', url: RESET_URL }),
    );

    expect(result.status).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('user@example.com');
    expect(mailer.sent[0]?.subject).toBe('Đặt lại mật khẩu tài khoản LMS');
    expect(mailer.sent[0]?.text).toContain(RESET_URL);
  });

  it('gửi mail OTP đăng nhập với tiêu đề và mã đúng theo payload của job', async () => {
    const mailer = new FakeMailer();
    const processor = makeProcessor(mailer, new FakeSentMarker());

    const result = await processor.process(
      makeJob({ kind: 'email_otp', to: 'user@example.com', otp: '482916', otpType: 'sign-in' }),
    );

    expect(result.status).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toBe('Mã đăng nhập LMS của bạn');
    expect(mailer.sent[0]?.text).toContain('482916');
  });

  it('phát lại cùng một job (cùng outboxId) thì không gửi mail lần hai', async () => {
    const mailer = new FakeMailer();
    const processor = makeProcessor(mailer, new FakeSentMarker());
    const job = makeJob({ kind: 'password_reset', to: 'user@example.com', url: RESET_URL });

    const first = await processor.process(job);
    const replay = await processor.process(job);

    expect(first.status).toBe('sent');
    expect(replay.status).toBe('duplicate');
    expect(mailer.calls).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('hai lượt xử lý đồng thời cùng một sự kiện (cùng outboxId) chỉ gửi đúng một mail và lượt thua bị hẹn thử lại thay vì kết thúc như đã xử lý', async () => {
    const mailer = new GatedMailer();
    const processor = new AuthMailProcessor(mailer as unknown as ResendMailService, new FakeSentMarker());
    const job = makeJob({ kind: 'password_reset', to: 'user@example.com', url: RESET_URL });

    // Hai lượt xử lý cùng một job chạy chồng lấn: lượt thứ hai bắt
    // đầu khi lượt thứ nhất còn đang treo ở transport (cổng chưa
    // mở) — đúng tình huống job bị nhận xử lý lại sau khi mất khoá
    // BullMQ trong lúc lượt đầu chưa gửi xong. Lượt thứ hai không
    // chiếm được lease nên phải ném tín hiệu hẹn thử lại
    // DelayedError thay vì trả duplicate như thể mail đã gửi.
    const first = processor.process(job);
    let secondSettled = false;
    const second = processor.process(job).then(
      (result) => {
        secondSettled = true;
        return { outcome: 'resolved' as const, result };
      },
      (error: unknown) => {
        secondSettled = true;
        return { outcome: 'rejected' as const, error };
      },
    );

    // Chờ tới khi đường đua bộc lộ: hoặc cả hai lượt cùng tới được
    // transport (hàng rào thủng — ca này phải đỏ), hoặc lượt thứ
    // hai đã bị hàng rào chặn lại và kết thúc trước khi gửi.
    await vi.waitFor(() => {
      expect(mailer.calls >= 2 || secondSettled).toBe(true);
    });
    mailer.openGate();

    const firstResult = await first;
    const secondOutcome = await second;
    expect(mailer.calls).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(firstResult.status).toBe('sent');
    expect(secondOutcome.outcome).toBe('rejected');
    const rejectedErrors = [secondOutcome].flatMap((settled) =>
      settled.outcome === 'rejected' ? [settled.error] : [],
    );
    expect(rejectedErrors).toHaveLength(1);
    expect(rejectedErrors[0]).toBeInstanceOf(DelayedError);
  });

  it('lease đang bị một lượt xử lý khác giữ thì ném tín hiệu hẹn thử lại DelayedError, không gọi transport và không ghi dấu đã gửi', async () => {
    const mailer = new FakeMailer();
    const marker = new FakeSentMarker();
    const processor = makeProcessor(mailer, marker);
    const job = makeJob({ kind: 'password_reset', to: 'user@example.com', url: RESET_URL });

    // Một lượt xử lý khác đang giữ lease của sự kiện này (đang
    // trong cửa sổ gửi, chưa rõ kết quả) — lượt này không được
    // coi là đã xử lý.
    const otherLease = await marker.claimProcessing(DEFAULT_OUTBOX_ID);
    expect(otherLease).not.toBeNull();

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);
    expect(mailer.calls).toBe(0);
    expect(await marker.hasSent(DEFAULT_OUTBOX_ID)).toBe(false);
  });

  it('lượt giữ lease chết trước khi gửi (không nhả lease) thì sau khi lease hết hạn, lượt xử lý lại vẫn gửi được mail đúng một lần', async () => {
    const mailer = new FakeMailer();
    // Hạn lease rút xuống 50ms để test mô phỏng được lease hết hạn
    // trong thời gian ngắn — đúng trạng thái hệ thống tự tới khi
    // TTL của lease trôi qua sau lúc tiến trình giữ lease chết.
    const marker = new FakeSentMarker(50);
    const processor = makeProcessor(mailer, marker);
    const job = makeJob({ kind: 'password_reset', to: 'user@example.com', url: RESET_URL });

    // Lượt xử lý trước chiếm lease rồi chết ngay: không gửi,
    // không nhả lease, không ghi dấu đã gửi.
    const deadLease = await marker.claimProcessing(DEFAULT_OUTBOX_ID);
    expect(deadLease).not.toBeNull();
    expect(mailer.calls).toBe(0);

    // Chờ lease của lượt đã chết hết hạn, rồi hàng đợi phát lại job.
    await new Promise((resolve) => setTimeout(resolve, 90));
    const recovered = await processor.process(job);

    expect(recovered.status).toBe('sent');
    expect(mailer.calls).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    // Sau khi khôi phục, dấu đã gửi đã đứng: phát lại nữa thì bỏ qua.
    const replay = await processor.process(job);
    expect(replay.status).toBe('duplicate');
    expect(mailer.calls).toBe(1);
  });

  it('nhả lease bằng token sai không xoá được lease của lượt khác, nhả bằng token đúng thì xoá được', async () => {
    const marker = new FakeSentMarker();

    const ownerToken = await marker.claimProcessing(DEFAULT_OUTBOX_ID);
    expect(ownerToken).not.toBeNull();

    // Token không phải của chủ lease: lease phải còn nguyên — một
    // lượt kết thúc muộn không được xoá lease của lượt đang giữ.
    await marker.releaseProcessing(DEFAULT_OUTBOX_ID, 'token-khong-phai-cua-chu-lease');
    expect(await marker.claimProcessing(DEFAULT_OUTBOX_ID)).toBeNull();

    // Token đúng của chủ lease: nhả được, lượt khác chiếm lại được.
    await marker.releaseProcessing(DEFAULT_OUTBOX_ID, ownerToken as string);
    expect(await marker.claimProcessing(DEFAULT_OUTBOX_ID)).not.toBeNull();
  });

  it('hai sự kiện khác outboxId thì gửi hai mail riêng, dấu của sự kiện này không chặn sự kiện kia', async () => {
    const mailer = new FakeMailer();
    const processor = makeProcessor(mailer, new FakeSentMarker());

    await processor.process(
      makeJob({ kind: 'email_otp', to: 'a@example.com', otp: '111111', otpType: 'sign-in' }, '0191e8f2-7c3a-7b21-9f00-000000000a01'),
    );
    const second = await processor.process(
      makeJob({ kind: 'email_otp', to: 'b@example.com', otp: '222222', otpType: 'sign-in' }, '0191e8f2-7c3a-7b21-9f00-000000000a02'),
    );

    expect(second.status).toBe('sent');
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent.map((mail) => mail.to)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('lỗi gửi tạm thời thì ném lỗi cho hàng đợi thử lại, không ghi dấu đã gửi, và lần xử lý sau gửi được đúng một mail', async () => {
    const mailer = new FakeMailer();
    const marker = new FakeSentMarker();
    const processor = makeProcessor(mailer, marker);
    const job = makeJob({ kind: 'password_reset', to: 'user@example.com', url: RESET_URL });

    mailer.mode = 'throw';
    await expect(processor.process(job)).rejects.toThrow('Resend API trả 500');
    expect(await marker.hasSent(DEFAULT_OUTBOX_ID)).toBe(false);
    expect(mailer.sent).toHaveLength(0);

    mailer.mode = 'sent';
    const retried = await processor.process(job);
    expect(retried.status).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
  });

  it('payload không hợp lệ thì kết thúc job không gửi và không ném lỗi', async () => {
    const mailer = new FakeMailer();
    const processor = makeProcessor(mailer, new FakeSentMarker());

    const unknownKind = await processor.process(makeJob({ kind: 'marketing', to: 'user@example.com' }));
    const missingRecipient = await processor.process(makeJob({ kind: 'email_otp', otp: '123456', otpType: 'sign-in' }));
    const emptyPayload = await processor.process(makeJob(null));

    expect(unknownKind.status).toBe('invalid');
    expect(missingRecipient.status).toBe('invalid');
    expect(emptyPayload.status).toBe('invalid');
    expect(mailer.calls).toBe(0);
  });

  it('chưa cấu hình Resend thì coi như đã xử lý: lần phát lại không thử gửi lại nữa', async () => {
    const mailer = new FakeMailer();
    mailer.mode = 'skipped';
    const processor = makeProcessor(mailer, new FakeSentMarker());
    const job = makeJob({ kind: 'password_reset', to: 'user@example.com', url: RESET_URL });

    const first = await processor.process(job);
    const replay = await processor.process(job);

    expect(first.status).toBe('skipped');
    expect(replay.status).toBe('duplicate');
    expect(mailer.calls).toBe(1);
    expect(mailer.sent).toHaveLength(0);
  });
});
