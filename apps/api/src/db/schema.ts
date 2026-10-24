/**
 * Barrel tổng hợp schema toàn hệ thống: mỗi bounded context giữ schema của
 * mình trong `src/modules/<module>/schema.ts` (hạ tầng nền tảng ở
 * `src/db/infrastructure.schema.ts`); file này chỉ re-export để
 * `drizzle.config.ts` và DrizzleModule dùng một điểm vào duy nhất.
 */
export * from './infrastructure.schema';
export * from '../modules/access/schema';
export * from '../modules/users/schema';
export * from '../modules/auth/schema';
export * from '../modules/custom-fields/schema';
export * from '../modules/files/schema';
export * from '../modules/courses/schema';
export * from '../modules/groups/schema';
export * from '../modules/enrol/schema';
export * from '../modules/completion/schema';
export * from '../modules/grades/schema';
export * from '../modules/guardians/schema';
export * from '../modules/questions/schema';
export * from '../modules/mcp/schema';
export * from '../modules/quiz/schema';
export * from '../modules/assignments/schema';
export * from '../modules/content/schema';
export * from '../modules/curriculum/schema';
export * from '../modules/books/schema';
export * from '../modules/messaging/schema';
export * from '../modules/calendar/schema';
export * from '../modules/badges/schema';
export * from '../modules/competencies/schema';
export * from '../modules/social/schema';
export * from '../modules/search/schema';
export * from '../modules/integrations/schema';
export * from '../modules/backup/schema';
export * from '../modules/analytics/schema';
export * from '../modules/reports/schema';
export * from '../modules/content-bank/schema';
export * from '../modules/payments/schema';
export * from '../modules/privacy/schema';
