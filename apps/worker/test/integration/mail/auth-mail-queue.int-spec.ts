import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { eventLog, outboxEvents } from '@lms/db';
import { redisConnectionFromUrl } from '../../../src/config/env';
import { OutboxRelayScheduler } from '../../../src/outbox-relay.scheduler';
import { AuthMailProcessor, RedisAuthMailSentMarker } from '../../../src/processors/auth-mail.processor';
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
 * - Processor xử lý dữ liệu job đó bằng dấu đã xử lý trên Redis
 *   thật: gửi đúng một mail dựng từ template dùng chung, và xử lý
 *   lại cùng một sự kiện (cùng `outboxId`) không gửi lần hai —
 *   tính idempotent theo `outboxId` kiểm chứng ở tầng hạ tầng thật
 *   chứ không chỉ bằng bản giả trong bộ nhớ của spec unit.
 *
 * Vì sao processor ở ca thứ hai được dựng tay: module đã boot có
 * processor nền riêng đang tiêu thụ cùng hàng đợi (đúng như
 * production), nên việc "job nào tới processor nào" không xác định
 * giữa các spec chạy song song — mẫu chung của suite này (xem
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

/** Chờ một điều kiện hạ tầng thành đúng (thăm dò 250ms), hết hạn thì ném lỗi rõ trạng thái cuối. */
async function waitFor(description: string, condition: () => Promise<boolean>, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`Hết hạn chờ: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
    const marker = new RedisAuthMailSentMarker({
      getOrThrow: (key: string) => process.env[key],
    } as unknown as ConfigService);
    const processor = new AuthMailProcessor(mailer as never, marker);
    const outboxId = `0191e8f2-7c3a-7b21-9f00-${suffix.slice(-12).padStart(12, '0')}`;
    const job = {
      data: {
        outboxId,
        seq: 1,
        aggregate: 'auth',
        type: 'auth_mail_requested',
        payload: { kind: 'email_otp', to: recipient, otp: '482916', otpType: 'sign-in' },
        tenantId: null,
        occurredAt: new Date().toISOString(),
      },
    };

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
});
