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
  // Presence của messaging realtime (issue #33): TTL của khoá presence
  // trong Redis và nhịp gia hạn cho các kết nối còn sống. TTL là lưới
  // an toàn để tiến trình chết đột ngột không để lại trạng thái
  // "online" kẹt mãi; nhịp gia hạn phải nhỏ hơn TTL để một kết nối
  // còn sống không bao giờ bị coi là offline giữa chừng (F2).
  MESSAGING_PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  MESSAGING_PRESENCE_REFRESH_MS: z.coerce.number().int().positive().default(120_000),
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
  // Driver vật lý của module Files: 'local' (mặc định — ổ đĩa
  // FILE_STORAGE_DIR, hành vi hiện tại không đổi) hoặc 's3' — AWS S3 /
  // endpoint tương thích S3 (R2/B2/MinIO) qua FILE_STORAGE_S3_ENDPOINT.
  // Toàn bộ cấu hình S3 CHỈ qua env, tuyệt đối không ghi khoá vào
  // code/commit; thiếu biến bắt buộc khi driver=s3 thì adapter
  // fail-fast lúc khởi tạo (chỉ nêu tên biến, không giá trị).
  FILE_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  FILE_STORAGE_S3_ENDPOINT: z.string().min(1).optional(),
  FILE_STORAGE_S3_REGION: z.string().min(1).default('us-east-1'),
  FILE_STORAGE_S3_BUCKET: z.string().min(1).optional(),
  FILE_STORAGE_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  FILE_STORAGE_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  FILE_STORAGE_S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
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
  // Email hệ thống qua Resend (issue #7 chặng 2.5; quyết định 26/10:
  // gửi qua Resend thay SMTP): API key của Resend. Trống = mailer chạy
  // chế độ ghi log (không gửi mail thật) và app VẪN boot bình thường —
  // luồng reset mật khẩu/OTP vẫn ghi yêu cầu vào outbox đầy đủ, chỉ
  // khâu gửi cuối là bị bỏ qua có khai báo (fail-soft, xem MailModule).
  RESEND_API_KEY: z.string().min(1).optional(),
  // Địa chỉ gửi (trường From) cho mọi mail hệ thống qua Resend — phải
  // thuộc domain đã xác minh DNS trên Resend. Trống = không gửi được
  // mail nào (mailer khai báo lý do ở log, không crash).
  MAIL_FROM: z.string().min(1).optional(),
  // Đăng nhập xã hội qua Better Auth (issue #7, chặng 2.3): khác họ
  // OAUTH_* của luồng OAuth tự viết (luồng cũ gỡ ở chặng 2.7). Provider
  // chỉ đăng ký vào instance khi CẢ id lẫn secret đều có mặt; thiếu một
  // phía thì provider đó tắt êm và app vẫn boot bình thường. Tên biến
  // theo đúng hồ sơ chương trình GĐ2 (comment mở chương trình trên #7).
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  FACEBOOK_APP_ID: z.string().min(1).optional(),
  FACEBOOK_APP_SECRET: z.string().min(1).optional(),
  // Chặng cutover (GĐ2, chặng 2.7 — hai bước có cổng riêng): công tắc
  // LUỒNG CHÍNH ở mức cấu hình.
  // - 'off' (mặc định): hệ auth tự viết là luồng chính như hiện tại,
  //   Better Auth chạy song song sau BETTER_AUTH_ENABLED; tắt cờ giữa
  //   cửa sổ bake là quay về luồng cũ TRỌN VẸN (điều kiện rollback
  //   trước bước B — mật khẩu đổi qua Better Auth trong lúc bake đã
  //   đồng bộ ngược về users.password_hash, xem cửa sổ bake dưới đây).
  // - 'bake': cửa sổ bake của bước A — login-as phát phiên Better Auth
  //   qua createProgrammaticSession và đặt cookie đã ký thay cho cặp
  //   token; đổi mật khẩu qua Better Auth đồng bộ ngược hash về
  //   users.password_hash. 'bake' mà BETTER_AUTH_ENABLED tắt là cấu
  //   hình vô nghĩa: app từ chối boot (fail-fast trong
  //   BetterAuthService) thay vì chạy nửa vời.
  // Sau bước B (gỡ legacy khỏi code + baseline) cờ này bị gỡ cùng đợt
  // — không tồn tại trạng thái "primary" thứ ba để chọn.
  AUTH_CUTOVER_STAGE: z.enum(['off', 'bake']).default('off'),
  // Máy chủ OAuth (AS) cho MCP (issue #163, lát MCP-1): cờ RIÊNG với
  // BETTER_AUTH_ENABLED — bật thì instance Better Auth compose thêm
  // jwt()/mcp()/cimd() và trở thành AS phát access token cho `/mcp`
  // (không chờ cutover GĐ2 của #7). Bật mà thiếu BETTER_AUTH_SECRET
  // thì app từ chối boot như trên. Mặc định TẮT: tắt thì không có bề
  // mặt OAuth nào và MCP chạy qua cầu auth cũ như MCP-0.
  MCP_AS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Origin công khai của MCP server (PRM + aud của token). Trống = suy
  // từ BETTER_AUTH_URL/PORT như McpDepsService đã làm từ MCP-0.
  MCP_PUBLIC_BASE_URL: z.string().min(1).optional(),
  // Trần rate-limit của MCP (cửa sổ 1 giờ, đếm trong tiến trình như
  // MCP-0): đọc / tạo câu / publish — publish siết riêng 10 lần/giờ
  // theo hồ sơ 3.3 vì nó đổi trạng thái phát hành hàng loạt.
  MCP_RATE_READ_PER_HOUR: z.coerce.number().int().positive().default(300),
  MCP_RATE_CREATE_PER_HOUR: z.coerce.number().int().positive().default(120),
  MCP_RATE_PUBLISH_PER_HOUR: z.coerce.number().int().positive().default(10),
  // Webhook thanh toán (PaymentsModule, vá H1 issue #134): shared secret
  // để gateway 'manual' xác thực webhook qua header
  // `x-payment-webhook-secret`. Chỉ đọc từ biến môi trường — KHÔNG lưu
  // vào site settings/DB vì API cấu hình site trả giá trị về cho quản
  // trị (cùng lý do với secret OAuth ở trên). Tuỳ chọn ở tầng schema
  // nhưng FAIL-CLOSED ở tầng hành vi: chưa đặt secret thì
  // ManualPaymentGateway.verify luôn trả false và POST /payments/webhook
  // bị từ chối — không có đường nào bỏ qua verify khi "chưa có gateway
  // thật". Gateway thật sau này xác thực bằng chữ ký của chính gateway
  // qua cùng cổng verify này.
  PAYMENT_WEBHOOK_SECRET: z.string().min(32).optional(),
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
