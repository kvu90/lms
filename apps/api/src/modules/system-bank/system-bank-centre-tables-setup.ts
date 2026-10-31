/**
 * Script ĐẢM BẢO 3 bảng vệ tinh của Ngân hàng hệ thống tồn tại
 * trong kho nghiệp vụ (issue #585) — chạy ở bước migrate của stack
 * triển khai (xem `compose.yaml`, service `migrate`), NGAY SAU
 * migration của kho nghiệp vụ và TRƯỚC migration của control plane:
 *
 * 1. Đích là KHO NGHIỆP VỤ: URL lấy theo đúng quy tắc của cấu hình
 *    Drizzle kho nghiệp vụ — ưu tiên `MIGRATION_DATABASE_URL` (bước
 *    migrate chạy bằng role migration, chủ sở hữu đối tượng của
 *    kho), chưa cấu hình thì dùng `DATABASE_URL`. Khi nhà cung cấp
 *    bắt buộc TLS (`DATABASE_SSL=true`) thì gắn `sslmode=no-verify`
 *    như cấu hình Drizzle.
 * 2. Chạy tuần tự các câu ensure idempotent dựng bởi
 *    `system-bank-centre-tables.ts`: database đã áp baseline TRƯỚC
 *    khi 3 bảng vệ tinh được nối vào file baseline (production,
 *    preview) nhận đủ 3 bảng ở bước này; database mới đã có đủ qua
 *    baseline nên bước này là no-op.
 *
 * Bước này KHÔNG phụ thuộc `SYSTEM_BANK_DATABASE_URL`: luồng sửa
 * câu hỏi cập nhật `system_question_imports` trong mọi transaction
 * sửa câu kể cả ở môi trường chưa kích hoạt kho ngân hàng, nên 3
 * bảng phải tồn tại ở mọi nơi chạy chuỗi migrate. Mọi câu đều
 * idempotent — chạy lại ở mỗi lần stack khởi động là an toàn và
 * không đổi dữ kiện.
 */
import { Client } from 'pg';
import { buildCentreSatelliteEnsureStatements } from './system-bank-centre-tables';

async function main(): Promise<void> {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required for the centre satellite tables setup');
  }
  const connectionString =
    process.env.DATABASE_SSL === 'true' && !databaseUrl.includes('sslmode=')
      ? `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}sslmode=no-verify`
      : databaseUrl;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const statement of buildCentreSatelliteEnsureStatements()) {
      await client.query(statement);
    }
    console.log('system-bank-centre-tables-setup: satellite tables are ensured in the business store.');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('system-bank-centre-tables-setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
