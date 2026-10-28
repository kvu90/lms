import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RoleSeparationService, type RoleConflictAuditEntry } from './modules/access/role-separation.service';
import { tenantAls } from './modules/tenants/tenant-als';

/**
 * KIỂM TOÁN CHỈ ĐỌC tình trạng lẫn vai giáo viên/học viên trên dữ
 * kiện hiện có — chạy bằng `pnpm --filter @lms/api audit:role-separation`
 * sau khi build, với `DATABASE_URL` trỏ vào DB đích.
 *
 * Bối cảnh: quyết định tách vai theo ngữ cảnh cấm một tài khoản đồng
 * thời có cấp quyền giảng dạy bao phủ một khoá và ghi danh học viên
 * đang hoạt động trong chính khoá đó (hoặc lớp chứa khoá đó). Các
 * chốt chặn thi hành quyết định nằm ở tầng service và chỉ tác động
 * lên thao tác GHI MỚI; dữ kiện đã tồn tại trước khi có chốt có thể
 * đang chứa sẵn ca vi phạm. Script này là lượt rà soát chỉ đọc để
 * lượng hoá tình trạng đó trước khi vận hành quyết định xử lý riêng.
 *
 * Flow:
 * 1. Khởi động application context (không mở cổng HTTP) và lấy
 *    RoleSeparationService — định nghĩa kiểm (a)/(b) DUY NHẤT của hệ
 *    thống; script không định nghĩa lại tiêu chí nào.
 * 2. Gọi `auditRoleConflicts()` trong ngữ cảnh platform tường minh
 *    (đọc xuyên tenant có chủ đích: kiểm toán là việc của quản trị
 *    nền tảng, và các bảng nền có RLS sẽ che dữ kiện của tenant khác
 *    nếu đọc trong ngữ cảnh tenant thường).
 * 3. In báo cáo hai nhóm: NHÓM CÙNG KHOÁ/LỚP (vi phạm — kèm danh
 *    sách khoá xung đột của từng tài khoản) và NHÓM KHÁC KHOÁ (hợp
 *    lệ theo quyết định — dạy khoá này, học khoá khác).
 *
 * Script TUYỆT ĐỐI không ghi dữ kiện: tầng service chỉ chạy SELECT
 * và phân loại trong bộ nhớ. Mã thoát luôn 0 khi rà soát hoàn tất —
 * có ca vi phạm hay không là nội dung báo cáo cho vận hành quyết
 * định, không phải lỗi của lượt chạy.
 */
function printEntry(entry: RoleConflictAuditEntry): void {
  const identity = `${entry.username} <${entry.email}> (${entry.userId})`;
  if (entry.conflictingCourseIds.length) {
    console.log(`- ${identity}: xung đột tại ${entry.conflictingCourseIds.length} khoá: ${entry.conflictingCourseIds.join(', ')}`);
  } else {
    console.log(`- ${identity}: dạy ${entry.teachingOnlyCourseCount} khoá, học ${entry.learnerOnlyCourseCount} khoá khác`);
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const report = await tenantAls.run({ platform: true }, () =>
      app.get(RoleSeparationService, { strict: false }).auditRoleConflicts(),
    );
    console.log('=== Kiểm toán tách vai giáo viên/học viên (chỉ đọc) ===');
    console.log(`NHÓM CÙNG KHOÁ/LỚP (vi phạm quyết định): ${report.sameCourse.length} tài khoản`);
    for (const entry of report.sameCourse) printEntry(entry);
    console.log(`NHÓM KHÁC KHOÁ (hợp lệ — dạy khoá này, học khoá khác): ${report.crossCourse.length} tài khoản`);
    for (const entry of report.crossCourse) printEntry(entry);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[audit] role separation audit failed', err);
  process.exit(1);
});
