import { defineConfig } from 'drizzle-kit';

// Khi nhà cung cấp PostgreSQL bắt buộc TLS (DATABASE_SSL=true, ví dụ
// Heroku Postgres), gắn sslmode=no-verify vào URL: ở nhánh mặc định
// của pg-connection-string, no-verify là giá trị duy nhất cho
// ssl.rejectUnauthorized = false (require nay bị đối xử như
// verify-full và sẽ hỏng với CA riêng của nhà cung cấp). Khớp cấu
// hình kết nối lúc chạy của API và worker (databaseConnectionFromEnv).
const databaseUrl = process.env.DATABASE_URL!;
const migrateUrl =
  process.env.DATABASE_SSL === 'true' && !databaseUrl.includes('sslmode=')
    ? `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}sslmode=no-verify`
    : databaseUrl;

export default defineConfig({
  dialect: 'postgresql',
  // Schema sống ở package dùng chung @lms/db-schema (issue #140). Trỏ thẳng
  // vào source TS của package: bước Migrate trong CI chạy trước bước Build
  // nên không thể phụ thuộc dist đã biên dịch của package.
  schema: '../../packages/db-schema/src/index.ts',
  out: './drizzle',
  dbCredentials: { url: migrateUrl },
});
