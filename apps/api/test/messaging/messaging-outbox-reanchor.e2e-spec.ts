import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../support/identity-access-helpers';
import { MessagingOutboxConsumer } from '../../src/modules/messaging/messaging-outbox.consumer';
import { MessagingRealtimeService } from '../../src/modules/messaging/messaging-realtime.service';

/**
 * Spec hồi quy cho issue #125: `MessagingOutboxConsumer` tự neo lại
 * watermark khi DB bị dựng lại trong lúc tiến trình vẫn chạy (reset
 * DB production không kèm khởi động lại tiến trình).
 *
 * Mô hình hoá sự cố live: watermark của consumer (bộ nhớ + Redis)
 * thuộc về đời DB trước và CAO hơn mọi `seq` hiện có của
 * `outbox_events`. Trước bản sửa, bộ lọc `seq > watermark` không bao
 * giờ khớp → mọi nhịp no-op im lặng → phân phối realtime chết mà
 * consumer không hề lỗi. Bảng outbox được xoá sạch giữa các ca để
 * mô phỏng đời DB mới; seq danh tính của DB test vẫn tăng đơn điệu
 * nên mọi quan hệ so sánh đều tương đối (watermark "cũ" = seq hiện
 * tại + 100000), đúng bất biến mà bản sửa dựa vào: trong một đời DB,
 * seq chỉ tăng, nên `max(seq) < watermark` chỉ xảy ra khi DB đã bị
 * dựng lại.
 *
 * Consumer được lấy thẳng từ app test, DỪNG nhịp tự động 500ms và
 * gọi `tick()` thủ công để spec tất định, không chờ thời gian thực;
 * điểm phân phối được quan sát bằng spy trên
 * `MessagingRealtimeService.distributeNewMessage` (đường socket tới
 * client đã có messaging-realtime-flow.e2e-spec.ts bao phủ).
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

interface WireMessage { id: string }

describe('Messaging outbox consumer — tự neo lại watermark sau reset DB (issue #125)', () => {
  let app: INestApplication;
  let pg: Client;
  let internals: ConsumerInternals;
  let distributeSpy: ReturnType<typeof vi.spyOn>;
  let tokenA: string;
  let convId: string;

  async function sendMessage(text: string): Promise<WireMessage> {
    const res = await http(app).post(`/api/v1/messages/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ text });
    expect(res.status).toBe(201);
    return res.body as WireMessage;
  }

  async function outboxSeqOf(messageId: string): Promise<number> {
    const { rows } = await pg.query(
      "SELECT seq FROM outbox_events WHERE type = 'message_sent' AND payload->>'messageId' = $1",
      [messageId],
    );
    expect(rows).toHaveLength(1);
    return Number(rows[0].seq);
  }

  async function dbMaxSeq(): Promise<number> {
    const { rows } = await pg.query('SELECT max(seq) AS max FROM outbox_events');
    return rows[0].max === null ? 0 : Number(rows[0].max);
  }

  /** Số lần một tin cụ thể đã được phân phối qua spy. */
  function deliveriesOf(messageId: string): number {
    return distributeSpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { id: string }).id === messageId,
    ).length;
  }

  beforeAll(async () => {
    app = await createTestApp();
    const admin = await adminToken(app);
    const userA = await createUserViaApi(app, admin);
    const userB = await createUserViaApi(app, admin);
    tokenA = (await login(app, userA.username, STRONG_PASSWORD)).accessToken;
    // Nhóm 2 người do admin tạo (học sinh không tự lập nhóm — chính
    // sách #33); chỉ cần một conversation để sinh sự kiện message_sent.
    const conv = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ type: 2, memberIds: [userA.id, userB.id], name: 'Nhóm kiểm thử #125' });
    expect(conv.status).toBe(201);
    convId = conv.body.id as string;

    const consumer = app.get(MessagingOutboxConsumer);
    internals = consumer as unknown as ConsumerInternals;
    // Dừng nhịp tự động: spec gọi tick() thủ công cho tất định.
    if (internals.timer) {
      clearInterval(internals.timer);
      internals.timer = null;
    }
    distributeSpy = vi.spyOn(app.get(MessagingRealtimeService), 'distributeNewMessage');

    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });

  afterAll(async () => {
    await pg.end();
    await app.close();
  });

  it('đường bình thường: sự kiện mới phân phối đúng một lần, nhịp sau không phát lại', async () => {
    await pg.query('DELETE FROM outbox_events');
    distributeSpy.mockClear();
    const message = await sendMessage('tin đường bình thường');
    const seq = await outboxSeqOf(message.id);

    internals.watermark = seq - 1;
    await internals.redis.set(internals.watermarkKey, String(seq - 1));
    await internals.tick();

    expect(deliveriesOf(message.id)).toBe(1);
    expect(internals.watermark).toBe(seq);
    expect(await internals.redis.get(internals.watermarkKey)).toBe(String(seq));

    // Nhịp kế tiếp không còn gì mới: không phát lại, watermark đứng yên.
    await internals.tick();
    expect(deliveriesOf(message.id)).toBe(1);
    expect(internals.watermark).toBe(seq);
  });

  it('sau reset DB: watermark cũ cao hơn mọi seq hiện có → neo lại và phân phối sự kiện của đời DB mới', async () => {
    // Đời DB mới: bảng outbox trống, sau đó mới phát sinh sự kiện.
    await pg.query('DELETE FROM outbox_events');
    const message = await sendMessage('tin đầu tiên sau reset');
    const seq = await outboxSeqOf(message.id);

    // Watermark còn sót từ đời DB trước: cao hơn hẳn seq hiện tại.
    const stale = seq + 100_000;
    internals.watermark = stale;
    await internals.redis.set(internals.watermarkKey, String(stale));
    distributeSpy.mockClear();

    // Trước bản sửa, nhịp này no-op vĩnh viễn (seq > watermark không
    // bao giờ khớp). Sau bản sửa: phát hiện max(seq) < watermark →
    // neo về 0 → sự kiện sau reset được phân phối ngay trong nhịp.
    await internals.tick();

    expect(deliveriesOf(message.id)).toBe(1);
    expect(internals.watermark).toBe(seq);
    expect(await internals.redis.get(internals.watermarkKey)).toBe(String(seq));

    // Đã neo xong thì nhịp sau lại im lặng bình thường, không phát lại.
    await internals.tick();
    expect(deliveriesOf(message.id)).toBe(1);
  });

  it('đối chứng: nhịp trống khi seq của DB không thấp hơn watermark thì KHÔNG neo lại', async () => {
    const max = await dbMaxSeq();
    internals.watermark = max;
    await internals.redis.set(internals.watermarkKey, String(max));
    distributeSpy.mockClear();

    await internals.tick();

    // Không neo thừa: không phát lại lịch sử, watermark và Redis giữ nguyên.
    expect(distributeSpy).not.toHaveBeenCalled();
    expect(internals.watermark).toBe(max);
    expect(await internals.redis.get(internals.watermarkKey)).toBe(String(max));
  });
});
