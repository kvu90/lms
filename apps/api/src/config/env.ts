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
  // MFA TOTP: khoá mã hoá secret TOTP lúc lưu (AES-256-GCM, khoá suy ra
  // bằng SHA-256 từ giá trị này). Tuỳ chọn: khi không khai báo, hệ thống
  // suy ra từ JWT_SECRET (xem TotpService) — môi trường thật NÊN đặt một
  // khoá riêng để xoay vòng độc lập với khoá ký token.
  MFA_ENCRYPTION_KEY: z.string().min(16).optional(),
  // Thời hạn của challenge token sau bước mật khẩu khi user bật MFA:
  // token này chỉ dùng được cho POST /auth/mfa/verify, không gọi API khác.
  MFA_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Đăng nhập xã hội (auth_oauth2 của Moodle): client id/secret của từng
  // issuer chỉ đọc từ biến môi trường — KHÔNG lưu vào site settings/DB vì
  // API cấu hình site trả giá trị về cho quản trị. Issuer chỉ "bật" khi cả
  // id lẫn secret đều có mặt; chưa cấu hình thì nút đăng nhập không hiện.
  OAUTH_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_GOOGLE_CLIENT_SECRET:
    z.string().min(1).optional(),
  OAUTH_FACEBOOK_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_FACEBOOK_CLIENT_SECRET:
    z.string().min(1).optional(),
  // Điểm cuối của nhà cung cấp: mặc định là URL thật trong OAuthService;
  // các biến này chỉ dùng để trỏ vào máy chủ giả lập khi kiểm thử (mock ở
  // biên HTTP của provider) hoặc khi provider đổi đường dẫn.
  OAUTH_GOOGLE_AUTHORIZE_URL: z.string().min(1).optional(),
  OAUTH_GOOGLE_TOKEN_URL: z.string().min(1).optional(),
  OAUTH_GOOGLE_USERINFO_URL: z.string().min(1).optional(),
  OAUTH_FACEBOOK_AUTHORIZE_URL: z.string().min(1).optional(),
  OAUTH_FACEBOOK_TOKEN_URL: z.string().min(1).optional(),
  OAUTH_FACEBOOK_USERINFO_URL: z.string().min(1).optional(),
  // Thời hạn của state OAuth (chống CSRF, mang trong JWT đã ký) và của mã
  // bàn giao một lần sau callback (đổi lấy cặp token ở phía SPA).
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  OAUTH_HANDOFF_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  // Origin công khai của web app để callback OAuth chuyển hướng về đúng
  // SPA sau khi hoàn tất. Trống = cùng origin với API (bản triển khai gộp
  // một tiến trình); môi trường dev tách cổng thì đặt http://localhost:5173.
  WEB_APP_URL: z.string().optional(),
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
  // Thư mục bản build tĩnh của web app. Khi được đặt và tồn tại, API
  // phục vụ luôn giao diện từ thư mục này (triển khai gộp một tiến trình
  // như Heroku); không đặt thì API chỉ phục vụ /api như thường lệ.
  WEB_DIST_DIR: z.string().optional(),
  // Files
  FILE_STORAGE_DIR: z.string().min(1).default('./data/files'),
  FILE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Better Auth (issue #7): nền authn mới dựng song song sau cờ này, mặc
  // định TẮT — chừng nào cờ tắt, instance không được dựng, handler không
  // mount, guard bỏ qua hoàn toàn và hành vi auth hiện tại không đổi một
  // chút nào. Bật cờ mà thiếu BETTER_AUTH_SECRET thì app từ chối boot
  // (fail-fast trong BetterAuthService) thay vì chạy với secret rỗng.
  BETTER_AUTH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Secret ký cookie/phiên riêng của Better Auth — KHÔNG dùng chung
  // JWT_SECRET để hai hệ xoay vòng độc lập. Chỉ bắt buộc khi cờ bật.
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  // URL công khai của chính API theo góc nhìn trình duyệt, làm baseURL +
  // origin tin cậy mặc định cho Better Auth. Trống = suy từ PORT local.
  BETTER_AUTH_URL: z.string().min(1).optional(),
  // Danh sách origin tin cậy bổ sung (phân tách bằng dấu phẩy) cho các
  // endpoint đổi trạng thái của Better Auth (kiểm tra Origin của nó).
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
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

/**
 * Tuỳ chọn TLS cho ioredis khi URL là rediss:// (Heroku Key-Value
 * Store): chứng chỉ phía addon là tự ký nên phải tắt kiểm chứng, nếu
 * không bắt tay TLS bị ngắt giữa chừng. URL redis:// thường trả rỗng.
 */
export function redisTlsFromUrl(url: string): { tls?: { rejectUnauthorized: boolean } } {
  return new URL(url).protocol === 'rediss:' ? { tls: { rejectUnauthorized: false } } : {};
}

/**
 * Cấu hình client cho @keyv/redis (dựng trên @redis/client) từ
 * REDIS_URL: với rediss:// phải khai socket TLS tắt kiểm chứng chứng
 * chỉ như redisTlsFromUrl, nếu không kết nối tới Heroku Key-Value
 * Store gãy ngay ở bước bắt tay.
 */
export function cacheRedisConfigFromUrl(url: string): {
  url: string;
  socket?: { tls: true; rejectUnauthorized: false };
} {
  if (new URL(url).protocol === 'rediss:') {
    return { url, socket: { tls: true, rejectUnauthorized: false } };
  }
  return { url };
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
