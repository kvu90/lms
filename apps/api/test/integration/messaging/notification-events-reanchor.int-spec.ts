import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminToken, createTestApp, createUserViaApi } from '../../support/identity-access-helpers';
import { NotificationEventsConsumer } from '../../../src/modules/messaging/notification-events.consumer';
import { MessagingService } from '../../../src/modules/messaging/messaging.service';

/**
 * Spec hồi quy cho việc nối tiếp của issue #125: `NotificationEventsConsumer`
 * tự neo lại watermark khi DB bị dựng lại trong lúc tiến trình vẫn chạy
 * (reset DB production không kèm khởi động lại tiến trình) — cùng
 * nguyên lý bản sửa
 * của `MessagingOutboxConsumer` ở PR #126, áp cho kênh thông báo.
 *
 * Mô hình hoá sự cố live: watermark của consumer (bộ nhớ + Redis)
 * thuộc về đời DB trước và CAO hơn mọi `seq` hiện có của
 * `outbox_events`. Trước bản sửa, bộ lọc `seq > watermark` không bao
 * giờ khớp → mọi nhịp no-op im lặng → thông báo chết mà consumer
 * không hề lỗi. Bảng outbox được xoá sạch giữa các ca để mô phỏng đời
 * DB mới; seq danh tính của DB test vẫn tăng đơn điệu nên mọi quan hệ
 * so sánh đều tương đối (watermark "cũ" = seq hiện tại + 100000),
 * đúng bất biến mà bản sửa dựa vào: trong một đời DB, seq chỉ tăng,
 * nên `max(seq) < watermark` chỉ xảy ra khi DB đã bị dựng lại.
 *
 * Consumer được lấy thẳng từ app test, DỪNG nhịp tự động 500ms và
 * gọi `tick()` thủ công để spec tất định, không chờ thời gian thực;
 * điểm phân phối được quan sát bằng spy trên `MessagingService.notify`
 * (điểm consumer này biến sự kiện thành thông báo; đường ghi thông
 * báo thật đã có các spec notifications-* bao phủ). Sự kiện
 * `course_completed` được ghi thẳng vào outbox bằng SQL vì handler
 * của nó chỉ cần (userId, courseId) và không đòi hỏi khoá tồn tại —
 * hợp đồng của consumer là đọc outbox đã commit, không phải luồng
 * nghiệp vụ phát sự kiện.
 */

interface ConsumerInternals {
  watermark: number | null;
  watermarkKey: string;
  redis: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
    del(key: string): Promise<unknown>;
  };
  timer: NodeJS.Timeout | null;
  tick(): Promise<void>;
}

describe('Notification events consumer — tự neo lại watermark sau reset DB (việc nối tiếp #125)', () => {
  let app: INestApplication;
  let pg: Client;
  let internals: ConsumerInternals;
  let notifySpy: ReturnType<typeof vi.spyOn>;
  let userId: string;

  /** Ghi một sự kiện course_completed cho user của spec, trả seq của nó. */
  async function insertCourseCompleted(courseId: string): Promise<number> {
    const { rows } = await pg.query(
      `INSERT INTO outbox_events (aggregate, type, payload)
       VALUES ('course', 'course_completed', $1::jsonb)
       RETURNING seq`,
      [JSON.stringify({ userId, courseId })],
    );
    expect(rows).toHaveLength(1);
    return Number(rows[0].seq);
  }

  async function dbMaxSeq(): Promise<number> {
    const { rows } = await pg.query('SELECT max(seq) AS max FROM outbox_events');
    return rows[0].max === null ? 0 : Number(rows[0].max);
  }

  /** Số lần sự kiện của một khoá cụ thể đã biến thành thông báo qua spy. */
  function notificationsFor(courseId: string): number {
    return notifySpy.mock.calls.filter(
      (call: unknown[]) => call[0] === userId
        && call[1] === 'course_completed'
        && (call[2] as { contextUrl?: string }).contextUrl === `/courses/${courseId}`,
    ).length;
  }

  beforeAll(async () => {
    app = await createTestApp();
    const admin = await adminToken(app);
    const user = await createUserViaApi(app, admin);
    userId = user.id;

    const consumer = app.get(NotificationEventsConsumer);
    internals = consumer as unknown as ConsumerInternals;
    // Dừng nhịp tự động: spec gọi tick() thủ công cho tất định.
    if (internals.timer) {
      clearInterval(internals.timer);
      internals.timer = null;
    }
    // Điểm phân phối: chặn tại notify() để spec chỉ quan sát hợp đồng
    // của consumer (sự kiện nào được biến thành thông báo, mấy lần),
    // không phụ thuộc đường ghi thông báo thật.
    notifySpy = vi.spyOn(app.get(MessagingService), 'notify').mockResolvedValue({
      provider: 'course_completed', userId: '', notificationId: null, channels: {},
    });

    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });

  afterAll(async () => {
    await pg.end();
    await app.close();
  });

  it('đường bình thường: sự kiện mới thành thông báo đúng một lần, nhịp sau không phát lại', async () => {
    await pg.query('DELETE FROM outbox_events');
    const courseId = randomUUID();
    const seq = await insertCourseCompleted(courseId);

    internals.watermark = seq - 1;
    await internals.redis.set(internals.watermarkKey, String(seq - 1));
    await internals.tick();

    expect(notificationsFor(courseId)).toBe(1);
    expect(internals.watermark).toBe(seq);
    expect(await internals.redis.get(internals.watermarkKey)).toBe(String(seq));

    // Nhịp kế tiếp không còn gì mới: không phát lại, watermark đứng yên.
    await internals.tick();
    expect(notificationsFor(courseId)).toBe(1);
    expect(internals.watermark).toBe(seq);
  });

  it('sau reset DB: watermark cũ cao hơn mọi seq hiện có → neo lại và xử lý sự kiện của đời DB mới', async () => {
    // Đời DB mới: bảng outbox trống, sau đó mới phát sinh sự kiện.
    await pg.query('DELETE FROM outbox_events');
    const courseId = randomUUID();
    const seq = await insertCourseCompleted(courseId);

    // Watermark còn sót từ đời DB trước: cao hơn hẳn seq hiện tại.
    const stale = seq + 100_000;
    internals.watermark = stale;
    await internals.redis.set(internals.watermarkKey, String(stale));

    // Trước bản sửa, nhịp này no-op vĩnh viễn (seq > watermark không
    // bao giờ khớp). Sau bản sửa: phát hiện max(seq) < watermark →
    // neo về 0 → sự kiện sau reset được xử lý ngay trong nhịp.
    await internals.tick();

    expect(notificationsFor(courseId)).toBe(1);
    expect(internals.watermark).toBe(seq);
    expect(await internals.redis.get(internals.watermarkKey)).toBe(String(seq));

    // Đã neo xong thì nhịp sau lại im lặng bình thường, không phát lại.
    await internals.tick();
    expect(notificationsFor(courseId)).toBe(1);
  });

  it('đối chứng: nhịp trống khi seq của DB không thấp hơn watermark thì KHÔNG neo lại', async () => {
    const max = await dbMaxSeq();
    internals.watermark = max;
    await internals.redis.set(internals.watermarkKey, String(max));
    notifySpy.mockClear();

    await internals.tick();

    // Không neo thừa: không phát lại lịch sử, watermark và Redis giữ nguyên.
    expect(notifySpy).not.toHaveBeenCalled();
    expect(internals.watermark).toBe(max);
    expect(await internals.redis.get(internals.watermarkKey)).toBe(String(max));
  });
});
