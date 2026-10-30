import { defineConfig } from 'drizzle-kit';

/**
 * Cấu hình Drizzle RIÊNG của database control plane (issue #580):
 * schema lấy từ file schema của control plane trong `@lms/db`
 * (KHÔNG qua barrel của kho nghiệp vụ), đầu ra migration nằm ở
 * `./drizzle-control-plane` và kết nối bằng biến môi trường riêng
 * `CONTROL_PLANE_DATABASE_URL`. Hai bộ migration (nghiệp vụ ở
 * `./drizzle`, control plane ở đây) không bao giờ được trộn: mỗi bộ
 * chỉ quản bảng của database của mình.
 */
const url = process.env.CONTROL_PLANE_DATABASE_URL ?? '';
// Khớp cách xử lý TLS của cấu hình nghiệp vụ: URL mang sslmode rồi bị
// drizzle-kit/pg hiểu nhầm khi nhà cung cấp PostgreSQL yêu cầu TLS.
const needsSsl = url.includes('sslmode=require') || url.includes('sslmode=no-verify') || url.includes('sslmode=verify-ca');
const connectionUrl = url.replace('sslmode=require', 'sslmode=no-verify');

export default defineConfig({
  dialect: 'postgresql',
  schema: '../../packages/db/src/control-plane.schema.ts',
  out: './drizzle-control-plane',
  dbCredentials: {
    url: connectionUrl,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  },
});
