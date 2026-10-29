import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
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
 *   một mail: hàng rào là chiếm dấu nguyên tử trước khi gửi, nên
 *   ca đồng thời (transport có cổng chặn ép hai lượt chồng lấn)
 *   ghim đường đua mà kiểm tra-rồi-ghi dấu rời nhau từng để lọt.
 * - Lỗi gửi tạm thời không để lại dấu đã xử lý: job bị ném lỗi cho
 *   hàng đợi thử lại và lần xử lý sau gửi được, tổng cộng vẫn đúng
 *   một mail.
 * - Payload hỏng thì job kết thúc lặng (không gửi, không ném) để
 *   không chặn hàng đợi; môi trường chưa cấu hình Resend thì coi
 *   như đã xử lý như đường consumer cũ.
 *
 * Transport và dấu đã xử lý đều là bản giả trong bộ nhớ theo đúng bề
 * mặt processor dùng; đường Redis thật của dấu được kiểm chứng ở
 * spec tích hợp `test/integration/mail/auth-mail-queue.int-spec.ts`.
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
 * Dấu chiếm/đã xử lý giả trong bộ nhớ, đúng hợp đồng
 * {@link AuthMailSentMarker}. `claim` kiểm tra-và-ghi trong một
 * khối đồng bộ không có điểm chờ ở giữa, nên nguyên tử đúng như
 * `SET ... NX` phía Redis trên vòng lặp sự kiện đơn luồng.
 */
class FakeSentMarker implements AuthMailSentMarker {
  private readonly marked = new Set<string>();

  async has(outboxId: string): Promise<boolean> {
    return this.marked.has(outboxId);
  }

  async claim(outboxId: string): Promise<boolean> {
    if (this.marked.has(outboxId)) return false;
    this.marked.add(outboxId);
    return true;
  }

  async release(outboxId: string): Promise<void> {
    this.marked.delete(outboxId);
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

  it('hai lượt xử lý đồng thời cùng một sự kiện (cùng outboxId) chỉ gửi đúng một mail', async () => {
    const mailer = new GatedMailer();
    const processor = new AuthMailProcessor(mailer as unknown as ResendMailService, new FakeSentMarker());
    const job = makeJob({ kind: 'password_reset', to: 'user@example.com', url: RESET_URL });

    // Hai lượt xử lý cùng một job chạy chồng lấn: lượt thứ hai bắt
    // đầu khi lượt thứ nhất còn đang treo ở transport (cổng chưa
    // mở) — đúng tình huống job bị nhận xử lý lại sau khi mất khoá
    // BullMQ trong lúc lượt đầu chưa gửi xong.
    const first = processor.process(job);
    let secondSettled = false;
    const second = processor.process(job).then((result) => {
      secondSettled = true;
      return result;
    });

    // Chờ tới khi đường đua bộc lộ: hoặc cả hai lượt cùng tới được
    // transport (hàng rào thủng — ca này phải đỏ trên cơ chế kiểm
    // tra-rồi-ghi dấu rời nhau), hoặc lượt thứ hai đã bị hàng rào
    // chặn lại và kết thúc trước khi gửi.
    await vi.waitFor(() => {
      expect(mailer.calls >= 2 || secondSettled).toBe(true);
    });
    mailer.openGate();

    const results = await Promise.all([first, second]);
    expect(mailer.calls).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(results.map((result) => result.status).sort()).toEqual(['duplicate', 'sent']);
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

  it('lỗi gửi tạm thời thì ném lỗi cho hàng đợi thử lại, không ghi dấu, và lần xử lý sau gửi được đúng một mail', async () => {
    const mailer = new FakeMailer();
    const marker = new FakeSentMarker();
    const processor = makeProcessor(mailer, marker);
    const job = makeJob({ kind: 'password_reset', to: 'user@example.com', url: RESET_URL });

    mailer.mode = 'throw';
    await expect(processor.process(job)).rejects.toThrow('Resend API trả 500');
    expect(await marker.has(DEFAULT_OUTBOX_ID)).toBe(false);
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
