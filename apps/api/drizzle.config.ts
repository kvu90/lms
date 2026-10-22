import { defineConfig } from 'drizzle-kit';

// Khi nhà cung cấp PostgreSQL bắt buộc TLS (DATABASE_SSL=true, ví dụ
// Heroku Postgres), gắn sslmode=require vào URL: pg-connection-string
// dịch nó thành ssl.rejectUnauthorized = false, khớp cấu hình kết nối
// lúc chạy của API và worker (xem databaseConnectionFromEnv).
const databaseUrl = process.env.DATABASE_URL!;
const migrateUrl =
  process.env.DATABASE_SSL === 'true' && !databaseUrl.includes('sslmode=')
    ? `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}sslmode=require`
    : databaseUrl;

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: migrateUrl },
});
