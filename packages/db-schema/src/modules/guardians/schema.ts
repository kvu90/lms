/** Các bảng của bounded context Guardians (PH-0, issue #116) — liên kết giám hộ phụ huynh ↔ học sinh. */
import {
  index,
  pgTable,
  primaryKey,
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

/**
 * Mốc xem trước của phụ huynh cho từng con (PH-1, issue #130): `last_seen_at`
 * là mốc phía server để tính khối "kết quả mới ĐÃ CÔNG BỐ kể từ lần xem
 * trước" của bề mặt phụ huynh — tách riêng theo cặp (phụ huynh, học sinh)
 * vì mỗi phụ huynh có nhịp xem riêng cho từng con, không dùng chung mốc
 * dashboard của học sinh (`user_dashboard_state` là của chính học sinh).
 * Hàng tạo ở lần xem overview đầu tiên với mốc = thời điểm tạo (lần đầu
 * không có gì tính là mới, đúng tiền lệ DASH1).
 */
export const guardianViewState = pgTable('guardian_view_state', {
  guardianUserId: uuid('guardian_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  studentUserId: uuid('student_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      primaryKey({ columns: [table.guardianUserId, table.studentUserId] }),
      // FK student_user_id cần index dẫn đầu riêng (PK dẫn đầu là guardian_user_id).
      index('guardian_view_state_student_user_id_idx').on(table.studentUserId),
  ]);
