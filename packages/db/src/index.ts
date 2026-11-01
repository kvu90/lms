/**
 * Barrel tổng hợp schema toàn hệ thống — NGUỒN SỰ THẬT DUY NHẤT về định
 * nghĩa bảng Drizzle cho cả apps/api và apps/worker (trước đây worker giữ
 * một bản sao subset chép tay; xem issue #140 / rà soát #134 mục 11.2).
 * Mỗi bounded context giữ schema của mình trong `src/<module>.schema.ts`
 * (hạ tầng nền tảng ở `src/infrastructure.schema.ts`); file này chỉ re-export
 * để mọi phía dùng một điểm vào duy nhất.
 */
export * from './infrastructure.schema';
export * from './access.schema';
export * from './users.schema';
export * from './tenants.schema';
export * from './auth.schema';
export * from './custom-fields.schema';
export * from './files.schema';
export * from './courses.schema';
export * from './groups.schema';
export * from './classes.schema';
export * from './enrol.schema';
export * from './completion.schema';
export * from './grades.schema';
export * from './guardians.schema';
export * from './dashboard.schema';
export * from './questions.schema';
export * from './mcp.schema';
export * from './exams.schema';
export * from './quiz.schema';
export * from './paper-grading.schema';
export * from './assignments.schema';
export * from './content.schema';
export * from './curriculum.schema';
export * from './books.schema';
export * from './messaging.schema';
export * from './calendar.schema';
export * from './badges.schema';
export * from './competencies.schema';
export * from './social.schema';
export * from './search.schema';
export * from './integrations.schema';
export * from './backup.schema';
export * from './analytics.schema';
export * from './reports.schema';
export * from './content-bank.schema';
export * from './centre.schema';
export * from './payments.schema';
export * from './privacy.schema';
export * from './system-bank-centre.schema';
export { createCentreKysely, type CentreDB, type CentreDb, type CentreTx } from './client';
/**
 * Hàm đọc nhật ký migration tương thích cho fleet/provision (issue
 * #639): đọc tập tên/phiên bản đã áp của một database qua
 * `pg.Client`, ưu tiên nhật ký Kysely sau adoption, dự phòng nhật
 * ký Drizzle trong cửa sổ cùng tồn tại. Phần ghi của bộ máy
 * migration (provider carrier, bước cấy, runner) được tiêu thụ qua
 * điểm vào file `dist/migrate/run.js`, không qua barrel này.
 */
export {
  getAppliedMigrations,
  getLatestAppliedMigration,
  type MigrationJournalClient,
} from './migrate/journal';
/**
 * Re-export `sql` của Kysely qua barrel của package: các app tiêu
 * thụ (api, worker) phụ thuộc `@lms/db`, không phụ thuộc trực tiếp
 * package `kysely` — mọi bề mặt Kysely mà app cần (kể cả mẫu SQL
 * thô để gắn GUC trong transaction) đều đi qua điểm vào này, giữ
 * nguyên kỷ luật phụ thuộc đã chốt ở PR-N1.
 */
export { sql } from 'kysely';
