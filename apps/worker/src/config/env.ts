import type { PoolConfig } from 'pg';
import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Bật TLS cho kết nối PostgreSQL khi nhà cung cấp bắt buộc (Heroku
  // Postgres chỉ nhận kết nối có mã hoá). Mặc định tắt: môi trường local
  // và CI chạy PostgreSQL thường không có TLS.
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  REDIS_URL: z.string().min(1),
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
 * có `ssl.rejectUnauthorized = false` — chứng chỉ của Heroku Postgres do
 * CA riêng của họ ký nên không kiểm chứng theo CA hệ thống được, đây là
 * cấu hình Heroku khuyến nghị cho driver `pg`.
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
    // URL dạng rediss:// (Heroku Key-Value Store) bắt buộc TLS. Chứng chỉ
    // phía addon không kiểm chứng theo CA hệ thống được nên tắt kiểm chứng
    // như khuyến nghị của Heroku cho ioredis.
    ...(parsed.protocol === 'rediss:' ? { tls: { rejectUnauthorized: false } } : {}),
    maxRetriesPerRequest: null,
  };
}
