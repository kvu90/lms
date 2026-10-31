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
