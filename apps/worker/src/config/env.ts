import type { PoolConfig } from 'pg';
import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /**
   * Trần kết nối của pool nghiệp vụ phía worker (issue #586 — ngân
   * sách kết nối của cụm): số kết nối tối đa mà tiến trình worker
   * được mở tới kho nghiệp vụ. TUỲ CHỌN — chưa đặt thì giữ mặc
   * định của thư viện `pg` như trước. Xem biến cùng tên phía api
   * để biết cách cộng ngân sách toàn cụm.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(1000).optional(),
  // Bật TLS cho kết nối PostgreSQL khi nhà cung cấp bắt buộc (một số
  // nhà cung cấp PostgreSQL chỉ nhận kết nối có mã hoá). Mặc định tắt:
  // môi trường local và CI chạy PostgreSQL thường không có TLS.
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  REDIS_URL: z.string().min(1),
  /**
   * URL kết nối của database CONTROL PLANE — worker đọc sổ đăng ký
   * không gian qua biến này để khung định tuyến theo trung tâm
   * (issue #581) phân giải đích cho tác vụ nền. TUỲ CHỌN: chưa cấu
   * hình thì khung định tuyến báo chưa cấu hình khi được gọi, các
   * đường kho chung của worker vẫn chạy như cũ. Giá trị là bí mật
   * kết nối — không ghi ra log.
   */
  CONTROL_PLANE_DATABASE_URL: z.string().min(1).optional(),
  // Khung định tuyến kết nối theo trung tâm (issue #581) — cùng
  // ngữ nghĩa và cùng giá trị mặc định với phía API: TTL đệm phân
  // giải đích, trần kết nối cho pool của mỗi kho riêng, ngưỡng
  // nhàn rỗi để đóng pool của kho không còn traffic.
  SPACE_ROUTING_CACHE_TTL_MS: z.coerce.number().int().positive().default(5_000),
  // Trần lượt quét outbox theo trung tâm chạy ĐỒNG THỜI ở mỗi nhịp
  // relay (issue #582): mỗi lượt quét đang chạy giữ pool của kho
  // riêng tương ứng mở, nên trần này là một phần của ngân sách kết
  // nối của cụm — chỉ phía worker đọc biến này.
  SPACE_SWEEP_CONCURRENCY: z.coerce.number().int().positive().default(3),
  SPACE_DB_POOL_MAX: z.coerce.number().int().positive().default(5),
  SPACE_DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  JWT_SECRET: z.string().min(16),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  FILE_STORAGE_DIR: z.string().min(1).default('./data/files'),
  // Gửi mail thông báo qua Resend (NB-5, issue #174): cả hai đều tuỳ
  // chọn — thiếu thì transport mail chạy chế độ ghi log có khai báo
  // (không gửi, không lỗi), trùng ngữ nghĩa với module mail phía API.
  RESEND_API_KEY: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment variables: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Dựng tham số `connection` cho Drizzle từ URL và cờ TLS.
 *
 * Không bật TLS thì trả nguyên chuỗi (hành vi cũ). Bật thì trả PoolConfig
 * có `ssl.rejectUnauthorized = false` — chứng chỉ của nhà cung cấp
 * PostgreSQL do CA riêng của nhà cung cấp ký nên không kiểm chứng theo
 * CA hệ thống được; đây là cấu hình driver `pg` cần khi gặp CA riêng
 * như vậy.
 */
export function databaseConnectionFromEnv(url: string, ssl: boolean): string | PoolConfig {
  if (!ssl) return url;
  return { connectionString: url, ssl: { rejectUnauthorized: false } };
}

export function redisConnectionFromUrl(url: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: { rejectUnauthorized: boolean };
  maxRetriesPerRequest: null;
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    // URL dạng rediss:// bắt buộc TLS. Chứng chỉ phía dịch vụ không
    // kiểm chứng theo CA hệ thống được nên tắt kiểm chứng cho ioredis.
    ...(parsed.protocol === 'rediss:' ? { tls: { rejectUnauthorized: false } } : {}),
    maxRetriesPerRequest: null,
  };
}
