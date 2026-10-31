import { defineConfig } from 'drizzle-kit';

/**
 * Cấu hình Drizzle RIÊNG của database kho ngân hàng hệ thống (issue #585):
 * schema lấy từ file schema của kho ngân hàng trong `@lms/db`
 * (KHÔNG qua barrel của kho nghiệp vụ), đầu ra migration nằm ở
 * `./drizzle-system-bank` và kết nối bằng biến môi trường riêng
 * `SYSTEM_BANK_DATABASE_URL`. Ba bộ migration (nghiệp vụ ở `./drizzle`,
 * control plane ở `./drizzle-control-plane`, kho ngân hàng ở đây) không
 * bao giờ được trộn: mỗi bộ chỉ quản bảng của database của mình.
 */
const url = process.env.SYSTEM_BANK_DATABASE_URL ?? '';
// Khớp cách xử lý TLS của cấu hình control plane: URL mang sslmode rồi bị
// drizzle-kit/pg hiểu nhầm khi nhà cung cấp PostgreSQL yêu cầu TLS.
const needsSsl = url.includes('sslmode=require') || url.includes('sslmode=no-verify') || url.includes('sslmode=verify-ca');
const connectionUrl = url.replace('sslmode=require', 'sslmode=no-verify');

export default defineConfig({
  dialect: 'postgresql',
  schema: '../../packages/db/src/system-bank.schema.ts',
  out: './drizzle-system-bank',
  dbCredentials: {
    url: connectionUrl,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  },
});
