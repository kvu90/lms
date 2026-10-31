import { NestFactory } from '@nestjs/core';
import { join } from 'node:path';
import { AppModule } from '../../app.module';
import { ProgramDumpService } from './program-dump.service';
import { ProgramImportService } from './program-import.service';
import { tenantAls } from '../tenants/tenant-als';

/**
 * CLI SẢN XUẤT DUMP ĐÔNG CỨNG dữ liệu chương trình (chỉ chạy ở trung
 * tâm khi sản xuất/cập nhật dữ liệu chuẩn — KHÔNG phải đường seed
 * của các môi trường; seed các môi trường chỉ restore artifact).
 *
 * Cách dùng (từ thư mục apps/api, DATABASE_URL trỏ vào DB chuẩn):
 *   node dist/modules/curriculum/export-program-dump.js [--from-datasets] [file-đích]
 * - Mặc định: xuất toàn bộ các bảng chương trình của DB chuẩn hiện
 *   tại thành artifact SQL.
 * - `--from-datasets`: nạp/patch DB chuẩn từ các dataset trong
 *   manifest trước (chạy ProgramImportService — công cụ sản xuất
 *   dump; báo cáo thay đổi của từng dataset được in ra stdout để
 *   người duyệt đối chiếu TRƯỚC khi bản dump này được commit), rồi
 *   mới xuất.
 * - File đích mặc định: artifact trong repo
 *   `src/modules/curriculum/program-data-dump/program-dump.sql`.
 *
 * Sau khi chạy: tăng PROGRAM_DUMP_VERSION trong program-dump.ts nếu
 * đây là đợt sản xuất mới, rồi commit artifact cùng thay đổi version.
 */
/**
 * Tính đường file đích của lượt xuất dump từ danh sách đối số CLI.
 *
 * @param args - Đối số sau tên script (đã bỏ `node` và đường script);
 *   đối số đầu tiên không bắt đầu bằng `--` là file đích tường minh.
 * @returns File đích tường minh nếu có; không có thì đường mặc định
 *   trỏ vào thư mục `program-data-dump` NGAY CẠNH file này. Bất biến
 *   vị trí: file CLI nằm trong chính thư mục `modules/curriculum`
 *   (ở src khi chạy từ mã nguồn, ở `dist/modules/curriculum` khi
 *   chạy bản build — bước build chép `program-data-dump` vào dist
 *   cùng vị trí tương đối), và hàm đọc artifact
 *   `loadProgramDumpSql` trong `program-dump.ts` cũng tính đường
 *   theo đúng thư mục cạnh đó; đường mặc định TUYỆT ĐỐI không nối
 *   thêm đoạn `modules/curriculum`, nối thêm là nhân đôi đoạn và
 *   đích rơi vào thư mục không tồn tại (ghi file ENOENT).
 */
export function resolveProgramDumpOutPath(args: string[]): string {
  const outArg = args.find((a) => !a.startsWith('--'));
  return outArg ?? join(__dirname, 'program-data-dump', 'program-dump.sql');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromDatasets = args.includes('--from-datasets');
  const outPath = resolveProgramDumpOutPath(args);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    // Đường ghi/đọc dữ liệu platform phải bọc ngữ cảnh platform
    // tường minh (RLS fail-closed) như đường seed vẫn làm.
    await tenantAls.run({ platform: true }, async () => {
      if (fromDatasets) {
        const importer = app.get(ProgramImportService, { strict: false });
        const results = await importer.importAllDatasetsInternal();
        for (const r of results) {
          console.log(
            `[dump] import ${r.datasetKey}: created=${r.created} updated=${r.updated} skipped=${r.skipped} ` +
            `retiredOutcomes=${r.retiredOutcomes} changes=${JSON.stringify(r.changeCounts)}`,
          );
        }
      }
      const dump = app.get(ProgramDumpService, { strict: false });
      const { version } = await dump.exportDumpToFile(outPath);
      console.log(`[dump] exported version=${version} -> ${outPath}`);
    });
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[dump] export failed', err);
    process.exit(1);
  });
}
