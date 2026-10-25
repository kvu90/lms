/**
 * Barrel tổng hợp schema toàn hệ thống — NGUỒN SỰ THẬT DUY NHẤT về định
 * nghĩa bảng Drizzle cho cả apps/api và apps/worker (trước đây worker giữ
 * một bản sao subset chép tay; xem issue #140 / rà soát #134 mục 11.2).
 * Mỗi bounded context giữ schema của mình trong `src/modules/<module>/schema.ts`
 * (hạ tầng nền tảng ở `src/infrastructure.schema.ts`); file này chỉ re-export
 * để mọi phía dùng một điểm vào duy nhất.
 */
export * from './infrastructure.schema';
export * from './modules/access/schema';
export * from './modules/users/schema';
export * from './modules/tenants/schema';
export * from './modules/auth/schema';
export * from './modules/custom-fields/schema';
export * from './modules/files/schema';
export * from './modules/courses/schema';
export * from './modules/groups/schema';
export * from './modules/enrol/schema';
export * from './modules/completion/schema';
export * from './modules/grades/schema';
export * from './modules/guardians/schema';
export * from './modules/dashboard/schema';
export * from './modules/questions/schema';
export * from './modules/mcp/schema';
export * from './modules/exam-papers/schema';
export * from './modules/quiz/schema';
export * from './modules/paper-grading/schema';
export * from './modules/assignments/schema';
export * from './modules/content/schema';
export * from './modules/curriculum/schema';
export * from './modules/books/schema';
export * from './modules/messaging/schema';
export * from './modules/calendar/schema';
export * from './modules/badges/schema';
export * from './modules/competencies/schema';
export * from './modules/social/schema';
export * from './modules/search/schema';
export * from './modules/integrations/schema';
export * from './modules/backup/schema';
export * from './modules/analytics/schema';
export * from './modules/reports/schema';
export * from './modules/content-bank/schema';
export * from './modules/payments/schema';
export * from './modules/privacy/schema';
