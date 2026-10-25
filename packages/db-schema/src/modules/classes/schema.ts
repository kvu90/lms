/** Các bảng của bounded context Classes — LỚP HỌC HẠNG NHẤT (issue #184, CLASS-0; hồ sơ classroom-first-architecture-research-2026-10-25 mục 2). */
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { cohort } from '../groups/schema';
import { tenants } from '../tenants/schema';
import { users } from '../users/schema';

/** Chế độ khi học sinh rời lớp: `suspend` = đình chỉ ghi danh mọi khoá (giữ dữ liệu — mặc định) | `unenrol` = rút hẳn theo luật withdrawn sẵn có. Áp lên `custom_text1` của các instance cohort của lớp. */
export const CLASS_ON_LEAVE_MODES = ['suspend', 'unenrol'] as const;

/** Trạng thái lớp: `active` | `archived` (lưu trữ cuối năm: đóng băng ghi danh mới + tạo khoá mới, giữ đọc). */
export const CLASS_STATUSES = ['active', 'archived'] as const;

/**
 * Lớp học (thực thể hạng nhất — tạo TRƯỚC, khoá học nằm bên trong lớp).
 *
 * Chỉ `name` là bắt buộc khi tạo (khuôn Azota). Danh sách học sinh của
 * lớp KHÔNG có bảng riêng: roster ≡ `cohort_members` của backing cohort
 * (`cohort_id`, mỗi lớp đúng một cohort do hệ quản, `component = 'class'`)
 * — cohort sync vật chất hoá roster xuống từng khoá của lớp qua enrol
 * instance kiểu `cohort`. `tenant_id` + RLS theo khuôn TENANT-0 (#168):
 * GV tự do sinh hoạt ở tenant-zero (trang chính), lớp của trung tâm nằm
 * trong tenant của trung tâm.
 *
 * Học phí theo lớp (`fee_*`) KHÔNG nằm ở lát nền này — thuộc CLASS-3.
 */
export const classes = pgTable('classes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  /** Mã lớp tuỳ chọn (vd `10A1-2526`); duy nhất trong tenant khi có đặt. */
  code: text('code'),
  /** Nhãn năm học hiển thị kiểu Azota (vd `2025–2026`) — không phải thực thể năm học riêng. */
  schoolYear: text('school_year'),
  /** Chủ lớp: người tạo; người duy nhất được xoá lớp / chuyển quyền chủ (kiểm ở service). */
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  /** Backing cohort — roster của lớp. Duy nhất: một cohort chỉ hậu thuẫn một lớp. */
  cohortId: uuid('cohort_id').notNull().unique().references(() => cohort.id, { onDelete: 'restrict' }),
  /** Công tắc tự báo danh kiểu Azota: học sinh tự xin vào qua link kèm `join_code`. */
  allowSelfReport: boolean('allow_self_report').notNull().default(false),
  /** Mã tham gia cho link tự báo danh; bí mật như `enrolment_key` — chỉ chủ lớp/người có quyền quản roster mới thấy giá trị thật. */
  joinCode: text('join_code'),
  onLeave: text('on_leave').notNull().default('suspend'),
  status: text('status').notNull().default('active'),
  description: text('description').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('classes_tenant_id_idx').on(table.tenantId),
      index('classes_owner_id_idx').on(table.ownerId),
      uniqueIndex('classes_tenant_code_unique').on(table.tenantId, table.code).where(sql`${table.code} is not null`),
      uniqueIndex('classes_join_code_unique').on(table.joinCode).where(sql`${table.joinCode} is not null`),
  ]);
