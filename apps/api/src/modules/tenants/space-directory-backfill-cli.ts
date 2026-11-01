/**
 * Điểm vào CLI của công cụ lấp thư mục cho không gian kho
 * riêng đã di trú (issue #587, hạng mục 3) — chạy ngoài NestJS
 * như các công cụ fleet (`node
 * dist/modules/tenants/space-directory-backfill-cli.js --slug
 * <slug>`). Logic nằm ở `space-directory-backfill.ts`; file này
 * chỉ phân tích tham số và in kết quả.
 *
 * Đầu ra: các dòng tiến trình + một dòng JSON cuối cùng
 * (`DIRECTORY_BACKFILL_RESULT`) để vận hành đọc bằng mắt hoặc
 * dùng script bắt tiếp. Va chạm mã tham gia nằm trong JSON kết
 * quả (không làm lệnh thất bại — vận hành xử lý từng va chạm),
 * còn lỗi hạ tầng (không gian chưa đăng ký, thiếu biến môi
 * trường, kho đích không có tenant) làm lệnh thoát mã 1.
 *
 * Biến môi trường cần có: `CONTROL_PLANE_DATABASE_URL` và biến
 * URL kết nối của chính không gian (theo `secretRef` trong sổ
 * đăng ký, dạng `SPACE_<SLUG>_DATABASE_URL`).
 */
import { runSpaceDirectoryBackfill } from './space-directory-backfill';

/** Phân tích tham số dạng `--khóa giá-trị` từ argv. */
function parseArgs(argv: string[]): Record<string, string | true> {
  const args: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg} (expected --key value)`);
    const key = arg.slice(2);
    if (!key) throw new Error('Empty -- flag');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/** Lấy tham số bắt buộc dạng chuỗi, lỗi rõ khi thiếu. */
function required(args: Record<string, string | true>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new Error(`Missing required --${key}`);
  return value;
}

const USAGE = `Usage:
  node dist/modules/tenants/space-directory-backfill-cli.js --slug <slug>`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const slug = required(args, 'slug');
  const result = await runSpaceDirectoryBackfill({ slug });
  console.log(`DIRECTORY_BACKFILL_RESULT ${JSON.stringify(result)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  console.error(USAGE);
  process.exit(1);
});
