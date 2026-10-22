import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Auth policy (Moodle auth framework: policy is config, never hard-coded)
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(1).default(8),
  PASSWORD_MIN_DIGITS: z.coerce.number().int().min(0).default(1),
  PASSWORD_MIN_LOWER: z.coerce.number().int().min(0).default(1),
  PASSWORD_MIN_UPPER: z.coerce.number().int().min(0).default(1),
  PASSWORD_MIN_NONALNUM: z.coerce.number().int().min(0).default(0),
  LOCKOUT_THRESHOLD: z.coerce.number().int().min(0).default(5),
  LOCKOUT_WINDOW_MINUTES: z.coerce.number().int().positive().default(20),
  LOCKOUT_DURATION_MINUTES: z.coerce.number().int().positive().default(30),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Giới hạn tốc độ theo IP (chống dò mật khẩu/phá hoại ở biên HTTP):
  // hạn mức chung cho mọi route và hạn mức chặt riêng cho các route
  // cấp token. Khoá tài khoản sau LOCKOUT_THRESHOLD lần sai vẫn là lớp
  // bảo vệ theo tài khoản; hai lớp này bổ sung cho nhau. Mặc định phải
  // đủ rộng cho cả lớp học cùng ra Internet qua một IP NAT của trường
  // — xem runbook vận hành trước khi siết chặt hơn.
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(3000),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(300),
  // Danh sách origin được phép gọi API trực tiếp (phân tách bằng dấu
  // phẩy). Frontend dev đi qua proxy của Vite nên mặc định chỉ cần
  // origin của web; production khai đúng domain thật.
  CORS_ORIGINS: z.string().min(1).default('http://localhost:5173'),
  // Files
  FILE_STORAGE_DIR: z.string().min(1).default('./data/files'),
  FILE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Bootstrap admin (seeded on first boot when no site admin exists)
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(8).default('Admin123!'),
  ADMIN_EMAIL: z.string().min(3).default('admin@localhost'),
});

export type Env = z.infer<typeof envSchema>;

/** Fail-fast validation for @nestjs/config — the app refuses to boot on bad env. */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment variables: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function redisConnectionFromUrl(url: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  maxRetriesPerRequest: null;
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
  };
}
