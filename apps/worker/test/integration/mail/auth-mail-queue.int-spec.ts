import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DelayedError, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { eventLog, outboxEvents } from '@lms/db';
import { redisConnectionFromUrl } from '../../../src/config/env';
import { OutboxRelayScheduler } from '../../../src/outbox-relay.scheduler';
import {
  AuthMailProcessor,
  RedisAuthMailSentMarker,
  type AuthMailProcessResult,
} from '../../../src/processors/auth-mail.processor';
import type { WorkerMailMessage, WorkerMailSendResult } from '../../../src/resend-mail.service';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Đường mail auth qua hàng đợi ở worker (issue #517) trên hạ tầng
 * thật của suite worker (DB `lms_test_worker`, Redis thật):
 *
 * - Một dòng outbox `auth_mail_requested` được relay duy nhất phát
 *   thành job trên hàng đợi `auth-mail` theo bảng định tuyến: job
 *   mang `jobId` bằng id của dòng và dữ liệu là toàn bộ dòng; dòng
 *   được đóng dấu `publishedAt` và phản chiếu vào `event_log` như
 *   mọi dòng outbox khác.
 * - Processor xử lý dữ liệu job đó bằng hàng rào hai trạng thái
 *   trên Redis thật: dấu ĐÃ GỬI chỉ ghi sau khi transport nhận
 *   mail, nên xử lý lại cùng một sự kiện (cùng `outboxId`) không
 *   gửi lần hai; hai lượt xử lý ĐỒNG THỜI cùng một sự kiện cũng
 *   chỉ gửi đúng một mail (lease ĐANG XỬ LÝ chiếm nguyên tử
 *   `SET ... NX` phía Redis, lượt thua ném tín hiệu hẹn thử lại
 *   `DelayedError` chứ không kết thúc như đã xử lý); lượt giữ
 *   lease chết trước khi gửi thì lease hết hạn và lượt sau gửi
 *   được mail (khôi phục sau sập); nhả lease kiểm tra token chủ
 *   sở hữu bằng script Lua phía Redis. Tính idempotent theo
 *   `outboxId` kiểm chứng ở tầng hạ tầng thật chứ không chỉ bằng
 *   bản giả trong bộ nhớ của spec unit.
 *
 * Vì sao processor ở các ca sau ca đầu được dựng tay: module đã
 * boot có processor nền riêng đang tiêu thụ cùng hàng đợi (đúng
 * như production), nên việc "job nào tới processor nào" không xác
 * định giữa các spec chạy song song — mẫu chung của suite này (xem
 * `notification-email.int-spec.ts`) là dựng processor cần kiểm
 * chứng bằng tay với transport giả, còn ca thứ nhất chỉ khẳng định
 * các hệ quả bền của relay (dấu trên dòng, job trong hàng đợi, bản
 * phản chiếu) vốn không phụ thuộc processor nào tiêu thụ job.
 */

/** Transport giả ghi lại mọi mail được yêu cầu gửi. */
class FakeMailer {
  readonly sent: WorkerMailMessage[] = [];

  async send(message: WorkerMailMessage): Promise<WorkerMailSendResult> {
    this.sent.push(message);
    return { status: 'sent', providerId: 'fake-resend-id' };
  }
}

/**
 * Transport giả có cổng chặn: mọi lượt `send` treo lại cho tới khi
 * test mở cổng — ép hai lượt xử lý đồng thời chồng lấn tại cửa sổ
 * gửi để kiểm chứng hàng rào lease nguyên tử trên Redis thật.
 */
class GatedMailer {
  readonly sent: WorkerMailMessage[] = [];
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

  openGate(): void {
    this.open();
  }
}

/** Chờ một điều kiện hạ tầng thành đúng (thăm dò 250ms), hết hạn thì ném lỗi rõ trạng thái cuối. */
async function waitFor(description: string, condition: () => Promise<boolean>, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`Hết hạn chờ: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Bọc kết quả một lượt xử lý thành dạng phân biệt được thắng/thua để khẳng định trên cả hai lượt đồng thời. */
type SettledOutcome =
  | { outcome: 'resolved'; result: AuthMailProcessResult }
  | { outcome: 'rejected'; error: unknown };

function settleProcess(promise: Promise<AuthMailProcessResult>): Promise<SettledOutcome> {
  return promise.then(
    (result) => ({ outcome: 'resolved' as const, result }),
    (error: unknown) => ({ outcome: 'rejected' as const, error }),
  );
}

describe('Worker: mail auth qua hàng đợi (issue #517)', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: OrdinaryWorkerModuleHarness['adminDb'];
  let queue: Queue;

  const suffix = `${Date.now()}`;
  const recipient = `auth-mail-int-${suffix}@example.com`;
  const resetUrl = `http://localhost:5173/reset-password/token-${suffix}?callbackURL=%2Freset-password`;

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    queue = new Queue('auth-mail', {
      connection: redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    });
  });

  afterAll(async () => {
    await queue?.close();
    await harness?.close();
  });

  /** Dựng một bản dấu Redis thật mới (kết nối riêng) như một tiến trình worker riêng. */
  function makeMarker(): RedisAuthMailSentMarker {
    return new RedisAuthMailSentMarker({
      getOrThrow: (key: string) => process.env[key],
    } as unknown as ConfigService);
  }

  /** Dựng dữ liệu job như relay phát cho một outboxId cho trước. */
  function makeJobData(outboxId: string, seq: number): Record<string, unknown> {
    return {
      outboxId,
      seq,
      aggregate: 'auth',
      type: 'auth_mail_requested',
      payload: { kind: 'email_otp', to: recipient, otp: '482916', otpType: 'sign-in' },
      tenantId: null,
      occurredAt: new Date().toISOString(),
    };
  }

  it('relay phát dòng auth_mail_requested thành job trên hàng đợi auth-mail, đóng dấu và phản chiếu event_log', async () => {
    const [row] = await db.insert(outboxEvents).values({
      aggregate: 'auth',
      type: 'auth_mail_requested',
      payload: { kind: 'password_reset', to: recipient, url: resetUrl },
    }).returning();
    expect(row?.id).toBeTruthy();

    // Chủ động xả một lượt relay thay vì chờ nhịp nền 5 giây; nhịp
    // nền có thể đã phát dòng này trước thì các khẳng định dưới đây
    // vẫn đúng nguyên trạng.
    const relay = context.get(OutboxRelayScheduler);
    await relay.publishPending().catch(() => undefined);

    await waitFor('dòng outbox được đóng dấu publishedAt', async () => {
      const [current] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, row.id));
      return current?.publishedAt != null;
    });

    await waitFor('job của dòng xuất hiện trên hàng đợi auth-mail', async () => {
      const job = await queue.getJob(row.id);
      return job !== undefined;
    });
    const job = await queue.getJob(row.id);
    expect(job?.name).toBe('auth_mail_requested');
    expect(job?.data?.outboxId).toBe(row.id);
    expect(job?.data?.type).toBe('auth_mail_requested');
    expect(job?.data?.payload?.to).toBe(recipient);
    expect(job?.data?.payload?.url).toBe(resetUrl);

    await waitFor('dòng được phản chiếu vào event_log', async () => {
      const logs = await db.select().from(eventLog).where(eq(eventLog.eventType, 'auth_mail_requested'));
      return logs.some(
        (entry) => (entry.payload as { outboxId?: string } | null)?.outboxId === row.id,
      );
    });

    await job?.remove().catch(() => undefined);
  });

  it('processor với dấu Redis thật gửi đúng một mail và bỏ qua lần xử lý lại cùng outboxId', async () => {
    const mailer = new FakeMailer();
    const marker = makeMarker();
    const processor = new AuthMailProcessor(mailer as never, marker);
    const outboxId = `0191e8f2-7c3a-7b21-9f00-${suffix.slice(-12).padStart(12, '0')}`;
    const job = { data: makeJobData(outboxId, 1) };

    try {
      const first = await processor.process(job as never);
      const replay = await processor.process(job as never);

      expect(first.status).toBe('sent');
      expect(replay.status).toBe('duplicate');
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]?.to).toBe(recipient);
      expect(mailer.sent[0]?.subject).toBe('Mã đăng nhập LMS của bạn');
      expect(mailer.sent[0]?.text).toContain('482916');
    } finally {
      await marker.onModuleDestroy();
    }
  });

  it('hai lượt xử lý đồng thời cùng outboxId trên Redis thật chỉ gửi đúng một mail và lượt thua bị hẹn thử lại', async () => {
    // Hai processor và hai bản dấu riêng (mỗi bản một kết nối) trên
    // cùng một Redis — mô phỏng hai tiến trình worker cùng nhận xử
    // lý một sự kiện (job mất khoá BullMQ được nhận lại trong lúc
    // lượt đầu còn đang gửi). Lượt nào chiếm được lease trước là
    // không xác định qua mạng, nên khẳng định đặt trên CẶP kết quả:
    // đúng một lượt gửi thành công, lượt còn lại ném DelayedError.
    const mailer = new GatedMailer();
    const markerA = makeMarker();
    const markerB = makeMarker();
    const processorA = new AuthMailProcessor(mailer as never, markerA);
    const processorB = new AuthMailProcessor(mailer as never, markerB);
    const outboxId = `0191e8f2-7c3a-7b21-9f01-${suffix.slice(-12).padStart(12, '0')}`;
    const job = { data: makeJobData(outboxId, 2) };

    try {
      let settledCount = 0;
      const track = (promise: Promise<SettledOutcome>): Promise<SettledOutcome> =>
        promise.then((settled) => {
          settledCount += 1;
          return settled;
        });
      const first = track(settleProcess(processorA.process(job as never)));
      const second = track(settleProcess(processorB.process(job as never)));

      // Chờ đường đua bộc lộ: một lượt đã tới transport (đang treo
      // ở cổng) và lượt còn lại đã bị hàng rào chặn xong (ném tín
      // hiệu hẹn thử lại) — hoặc cả hai cùng tới transport nếu
      // hàng rào thủng, khi đó ca này phải đỏ.
      const deadline = Date.now() + 10000;
      while (!(mailer.calls >= 2 || (mailer.calls >= 1 && settledCount >= 1))) {
        if (Date.now() > deadline) throw new Error('Hết hạn chờ hai lượt xử lý đồng thời tới điểm quyết định');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      mailer.openGate();

      const outcomes = await Promise.all([first, second]);
      expect(mailer.calls).toBe(1);
      expect(mailer.sent).toHaveLength(1);
      const resolvedResults = outcomes.flatMap((settled) =>
        settled.outcome === 'resolved' ? [settled.result] : [],
      );
      const rejectedErrors = outcomes.flatMap((settled) =>
        settled.outcome === 'rejected' ? [settled.error] : [],
      );
      expect(resolvedResults.map((result) => result.status)).toEqual(['sent']);
      expect(rejectedErrors).toHaveLength(1);
      expect(rejectedErrors[0]).toBeInstanceOf(DelayedError);
    } finally {
      await markerA.onModuleDestroy();
      await markerB.onModuleDestroy();
    }
  });

  it('lease đang bị một lượt khác giữ trên Redis thật thì processor ném tín hiệu hẹn thử lại và không gửi mail', async () => {
    const mailer = new FakeMailer();
    const marker = makeMarker();
    const processor = new AuthMailProcessor(mailer as never, marker);
    const outboxId = `0191e8f2-7c3a-7b21-9f02-${suffix.slice(-12).padStart(12, '0')}`;
    const job = { data: makeJobData(outboxId, 3) };

    try {
      // Một lượt xử lý khác đang giữ lease của sự kiện này.
      const otherLease = await marker.claimProcessing(outboxId);
      expect(otherLease).not.toBeNull();

      await expect(processor.process(job as never)).rejects.toBeInstanceOf(DelayedError);
      expect(mailer.sent).toHaveLength(0);
      expect(await marker.hasSent(outboxId)).toBe(false);

      await marker.releaseProcessing(outboxId, otherLease as string);
    } finally {
      await marker.onModuleDestroy();
    }
  });

  it('lượt giữ lease chết trước khi gửi thì sau khi lease hết hạn, lượt xử lý lại trên Redis thật vẫn gửi được mail đúng một lần', async () => {
    const mailer = new FakeMailer();
    const marker = makeMarker();
    const processor = new AuthMailProcessor(mailer as never, marker);
    const outboxId = `0191e8f2-7c3a-7b21-9f03-${suffix.slice(-12).padStart(12, '0')}`;
    const job = { data: makeJobData(outboxId, 4) };
    const raw = new Redis({
      ...redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    });

    try {
      // Lượt xử lý trước chiếm lease rồi chết ngay: không gửi,
      // không nhả lease, không ghi dấu đã gửi.
      const deadLease = await marker.claimProcessing(outboxId);
      expect(deadLease).not.toBeNull();
      expect(mailer.sent).toHaveLength(0);

      // Rút hạn lease xuống 1 mili-giây để mô phỏng TTL 60 giây
      // trôi qua — đúng trạng thái Redis tự tới khi tiến trình giữ
      // lease đã chết và hạn lease đáo hạn, mà test không phải chờ
      // thật 60 giây.
      await raw.pexpire(`lms:auth-mail:processing:${outboxId}`, 1);
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Hàng đợi phát lại job sau khi worker cũ chết: mail phải
      // được gửi, không bị coi là đã xử lý.
      const recovered = await processor.process(job as never);
      expect(recovered.status).toBe('sent');
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]?.to).toBe(recipient);

      // Sau khôi phục, dấu đã gửi đã đứng: phát lại nữa thì bỏ qua.
      const replay = await processor.process(job as never);
      expect(replay.status).toBe('duplicate');
      expect(mailer.sent).toHaveLength(1);
    } finally {
      await raw.quit().catch(() => undefined);
      await marker.onModuleDestroy();
    }
  });

  it('nhả lease bằng token sai trên Redis thật không xoá được lease của lượt khác, token đúng thì xoá được', async () => {
    const markerA = makeMarker();
    const markerB = makeMarker();
    const outboxId = `0191e8f2-7c3a-7b21-9f04-${suffix.slice(-12).padStart(12, '0')}`;

    try {
      const ownerToken = await markerA.claimProcessing(outboxId);
      expect(ownerToken).not.toBeNull();

      // Bản dấu của tiến trình khác nhả bằng token sai: lease của
      // chủ thật phải còn nguyên (script Lua chỉ xoá khi token khớp).
      await markerB.releaseProcessing(outboxId, 'token-khong-phai-cua-chu-lease');
      expect(await markerB.claimProcessing(outboxId)).toBeNull();

      // Chủ lease nhả bằng token đúng: lease mất, lượt khác chiếm lại được.
      await markerA.releaseProcessing(outboxId, ownerToken as string);
      const reclaimed = await markerB.claimProcessing(outboxId);
      expect(reclaimed).not.toBeNull();
      await markerB.releaseProcessing(outboxId, reclaimed as string);
    } finally {
      await markerA.onModuleDestroy();
      await markerB.onModuleDestroy();
    }
  });
});
