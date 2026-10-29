import type { Client } from 'pg';
import type Redis from 'ioredis';

/**
 * Chờ tín hiệu chốt của các consumer quét outbox thay cho sleep cứng.
 *
 * Mọi consumer quét outbox trong hệ (thông báo, phân phối tin nhắn,
 * tổng hợp phụ huynh, đồng bộ cohort) đều xử lý sự kiện
 * theo `seq` tăng dần: await xử lý xong từng sự kiện rồi mới ghi
 * watermark (seq lớn nhất đã xử lý) vào Redis. Hệ quả dùng làm tín
 * hiệu chốt trong test: khi watermark của một consumer đã >= seq của
 * một sự kiện thì sự kiện đó — và mọi sự kiện đứng trước nó trong
 * outbox — chắc chắn đã được consumer đó xử lý xong, kể cả các nhánh
 * xử lý "bỏ qua không sinh kết quả nhìn thấy được" (sự kiện thuộc loại
 * không thông báo, người nhận đã tắt tiếng, hàng gộp đã có bản chưa
 * đọc...). Sleep cố định không gắn với tín hiệu nào nên vừa chậm vừa
 * chập chờn; chờ watermark thì nhanh đúng bằng thời gian xử lý thật
 * và xác định.
 *
 * Khoá watermark của từng consumer (đối chiếu code consumer tương
 * ứng): hậu tố là tên cơ sở dữ liệu trong `DATABASE_URL` của tiến
 * trình test.
 */
export type OutboxWatermarkConsumer =
  | 'notifications'
  | 'distributor'
  | 'guardian-digest'
  | 'cohort-sync';

const WATERMARK_KEY_PREFIX: Record<OutboxWatermarkConsumer, string> = {
  notifications: 'lms:messaging:notifications:',
  distributor: 'lms:messaging:distributor:',
  'guardian-digest': 'lms:guardians:digest:',
  'cohort-sync': 'lms:cohort-sync:',
};

/** Khoá Redis giữ watermark của một consumer trong môi trường test hiện tại. */
export function outboxWatermarkKey(consumer: OutboxWatermarkConsumer): string {
  const dbName = new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  return `${WATERMARK_KEY_PREFIX[consumer]}${dbName}:seq`;
}

/**
 * Seq lớn nhất hiện có trong outbox của một loại sự kiện, tuỳ chọn lọc
 * thêm theo một trường trong payload (dạng `payload->>'<field>'`).
 * Dùng ngay sau hành động phát sự kiện (lời gọi API đồng bộ hoặc lệnh
 * chèn trực tiếp) để lấy mốc seq mà consumer phải vượt qua.
 */
export async function latestOutboxSeq(
  pg: Client,
  type: string,
  payloadField?: string,
  payloadValue?: string,
): Promise<number> {
  const rows = payloadField
    ? await pg.query(
        `select max(seq) as seq from outbox_events where type = $1 and payload->>$2 = $3`,
        [type, payloadField, payloadValue],
      )
    : await pg.query(`select max(seq) as seq from outbox_events where type = $1`, [type]);
  const seq = (rows.rows[0] as { seq: string | number | null } | undefined)?.seq;
  return seq == null ? 0 : Number(seq);
}

/**
 * Chờ tới khi watermark của consumer đạt ít nhất `minSeq` — tức mọi
 * sự kiện outbox có seq <= `minSeq` đã được consumer đó xử lý xong.
 * Thăm dò mỗi 100ms, hết hạn thì ném lỗi kèm trạng thái cuối để ca
 * kiểm đỏ rõ nguyên nhân thay vì treo.
 */
export async function waitForOutboxWatermark(
  redis: Redis,
  consumer: OutboxWatermarkConsumer,
  minSeq: number,
  timeoutMs = 20000,
): Promise<void> {
  const key = outboxWatermarkKey(consumer);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await redis.get(key);
    if (raw != null && Number(raw) >= minSeq) return;
    if (Date.now() > deadline) {
      throw new Error(
        `outbox watermark ${key} did not reach ${minSeq} within ${timeoutMs}ms (last=${raw ?? 'null'})`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
