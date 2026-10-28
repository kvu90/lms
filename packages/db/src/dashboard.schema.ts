/** Các bảng của bounded context Dashboard việc cần làm (DASH1, issue #121) — định nghĩa Drizzle do module dashboard sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { course } from './courses.schema';

/**
 * Trạng thái xem dashboard của một người dùng: `last_seen_at` là mốc "lần
 * xem trước" phía server dùng để tính điểm/phản hồi MỚI của khối tổng hợp
 * (không suy từ trạng thái đã đọc của thông báo). Mỗi user đúng một hàng;
 * hàng được tạo ở lần gọi overview đầu tiên với mốc = thời điểm tạo (lần
 * đầu không có gì tính là mới).
 */
export const userDashboardState = pgTable('user_dashboard_state', {
  userId: uuid('user_id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Tuỳ chọn thẻ khoá cá nhân theo (user, course): màu + biệt danh CHỈ chủ
 * nhân thấy — không bao giờ ghi đè `course.name`/`course` gốc; người khác
 * mở cùng khoá không thấy pref này. Xoá pref = xoá hàng.
 */
export const userCourseCardPrefs = pgTable('user_course_card_prefs', {
  userId: uuid('user_id').notNull(),
  courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
  /** Token màu thuộc danh sách COURSE_CARD_COLORS ở contracts; null = mặc định. */
  color: text('color'),
  /** Biệt danh tự đặt (đã trim, tối đa 60 ký tự); null = dùng tên gốc. */
  nickname: text('nickname'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
    primaryKey({ columns: [table.userId, table.courseId] }),
    // FK course_id cần index dẫn đầu riêng (PK dẫn đầu là user_id) —
    // test nền tảng uuidv7 (6b) bắt mọi FK đơn cột phải có index bao phủ.
    index('user_course_card_prefs_course_idx').on(table.courseId),
  ]);
