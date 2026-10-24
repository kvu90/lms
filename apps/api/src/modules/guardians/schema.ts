/** Các bảng của bounded context Guardians (PH-0, issue #116) — liên kết giám hộ phụ huynh ↔ học sinh. */
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../users/schema';

/**
 * Liên kết giám hộ PH–HS (PH-0, issue #116): trường cấp theo hồ sơ giám hộ
 * đã xác minh (TT 22/2021 Đ.20.6 — thông báo riêng cho cha mẹ học sinh; NĐ
 * 13/2023 Đ.20 — quan hệ giám hộ phải được xác minh, không tự khai báo).
 * Một học sinh có nhiều người giám hộ, một phụ huynh có nhiều con. Liên kết
 * là nguồn quyền đọc duy nhất của bề mặt phụ huynh: chỉ-xem, chỉ dữ liệu
 * của con mình, chỉ dữ liệu đã công bố. Thu hồi bằng status='revoked'
 * (không xoá cứng — giữ vết cấp/thu hồi cho audit); sau thu hồi được tạo
 * lại liên kết mới cho cùng cặp (unique một phần chỉ áp khi active).
 */
export const guardianLinks = pgTable('guardian_links', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  guardianUserId: uuid('guardian_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  studentUserId: uuid('student_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Quan hệ với học sinh (cha / mẹ / ông bà / người giám hộ...) — do trường xác lập theo hồ sơ. */
  relationship: text('relationship').notNull(),
  /** active | revoked. */
  status: text('status').notNull().default('active'),
  createdBy: uuid('created_by').notNull(),
  revokedBy: uuid('revoked_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('guardian_links_guardian_user_id_idx').on(table.guardianUserId),
      index('guardian_links_student_user_id_idx').on(table.studentUserId),
      uniqueIndex('guardian_links_active_pair_unique')
        .on(table.guardianUserId, table.studentUserId)
        .where(sql`${table.status} = 'active'`),
  ]);
