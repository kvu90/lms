import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ExamDossiersService } from './modules/exams/exam-dossiers.service';
import { tenantAls } from './modules/tenants/tenant-als';

/**
 * CLI CHUYỂN ĐỔI HỒ SƠ TREO sang đường đóng góp duy nhất của đề
 * (issue #228, lát S4 — chạy MỘT LẦN khi cắt đường hồ sơ, không phải
 * đường seed của các môi trường).
 *
 * Cách dùng (từ thư mục apps/api, DATABASE_URL trỏ vào DB cần
 * chuyển đổi):
 *   node dist/convert-dossiers.js
 *
 * Quy tắc chuyển đổi nằm ở
 * `ExamDossiersService.convertLegacyDossiers`: hồ sơ
 * pending/pending_board thành đóng góp mang bộ hồ sơ + lịch sử
 * duyệt (idempotent theo source_dossier_id — chạy lại không nhân
 * đôi dữ liệu), hồ sơ draft đóng băng kèm thông báo cho người lập,
 * hồ sơ approved/rejected giữ nguyên làm lịch sử. Báo cáo đếm
 * trước/sau in ra stdout để vận hành đối chiếu.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    // Đợt chuyển đổi quét mọi tenant — bọc ngữ cảnh platform tường
    // minh (RLS fail-closed) như các CLI vận hành khác vẫn làm.
    await tenantAls.run({ platform: true }, async () => {
      const dossiers = app.get(ExamDossiersService, { strict: false });
      const report = await dossiers.convertLegacyDossiers();
      console.log(
        `[convert-dossiers] before=${JSON.stringify(report.before)} converted=${report.converted} ` +
        `alreadyConverted=${report.alreadyConverted} draftsFrozen=${report.draftsFrozen}`,
      );
    });
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[convert-dossiers] failed', err);
  process.exit(1);
});
