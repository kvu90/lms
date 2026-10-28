/** Các bảng của bounded context Classes — LỚP HỌC HẠNG NHẤT (issue #184, CLASS-0; hồ sơ classroom-first-architecture-research-2026-10-25 mục 2). */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { cohort } from './groups.schema';
import { paymentAccounts } from './payments.schema';
import { tenants } from './tenants.schema';
import { users } from './users.schema';

/** Chế độ khi học sinh rời lớp: `suspend` = đình chỉ ghi danh mọi khoá (giữ dữ liệu — mặc định) | `unenrol` = rút hẳn theo luật withdrawn sẵn có. Áp lên `custom_text1` của các instance cohort của lớp. */
export const CLASS_ON_LEAVE_MODES = ['suspend', 'unenrol'] as const;

/** Trạng thái lớp: `active` | `archived` (lưu trữ cuối năm: đóng băng ghi danh mới + tạo khoá mới, giữ đọc). */
export const CLASS_STATUSES = ['active', 'archived'] as const;

/** Trạng thái một yêu cầu tự báo danh vào lớp: `pending` (đang chờ duyệt) | `approved` | `rejected`. */
export const CLASS_JOIN_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;

/**
 * Hàng chờ duyệt tự báo danh của lớp (CLASS-1, issue #184): một dòng cho
 * mỗi lần học sinh xin vào lớp bằng `join_code` mà không được vào thẳng
 * (lớp đã có học sinh và chưa bật tự duyệt). Duyệt = thêm vào backing
 * cohort qua đúng đường roster; từ chối chỉ đóng yêu cầu, không đụng
 * roster. Một học sinh chỉ có tối đa MỘT yêu cầu đang chờ cho một lớp
 * (unique từng phần theo status = 'pending'). `tenant_id` + RLS theo
 * khuôn `classes`.
 */
export const classJoinRequests = pgTable('class_join_requests', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  status: text('status').notNull().default('pending'),
  /** Người duyệt/từ chối (NULL khi đang chờ hoặc khi yêu cầu được hệ đóng theo đường khác). */
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('class_join_requests_tenant_id_idx').on(table.tenantId),
      index('class_join_requests_class_id_idx').on(table.classId),
      index('class_join_requests_user_id_idx').on(table.userId),
      index('class_join_requests_decided_by_idx').on(table.decidedBy),
      uniqueIndex('class_join_requests_pending_unique').on(table.classId, table.userId).where(sql`${table.status} = 'pending'`),
  ]);

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
 * Học phí theo lớp (`fee_*`, CLASS-3): gói lớp bán qua đúng seam
 * thanh toán sẵn có — payment mang `component = 'class_fee'`,
 * `item_id = classes.id`; thanh toán thành công thì người mua vào
 * roster (backing cohort), hoàn tiền toàn bộ thì đình chỉ khỏi lớp.
 * `fee_cost` chính là công tắc thu phí: NULL/0 = lớp không thu học
 * phí qua hệ thống. Tài khoản nhận tiền tuân luật hai dòng tiền tách
 * bạch của sổ quyết định (mục E): lớp của trung tâm thu về tài khoản
 * của CHÍNH trung tâm, lớp của GV tự do ở trang chính (tenant nền
 * tảng) thu về tài khoản platform — `fee_payment_account_id` là chỉ
 * định riêng theo lớp, NULL thì rơi về tài khoản mặc định của tenant
 * sở hữu lớp, platform không thu hộ trung tâm.
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
  /** Tự duyệt tự báo danh (CLASS-1): true = xin vào qua mã là vào thẳng roster kể cả khi lớp đã có học sinh; false = vào hàng chờ duyệt khi lớp đã có học sinh (lớp trống vẫn vào thẳng — luật chốt ở hồ sơ mục 7.1). */
  joinAutoApprove: boolean('join_auto_approve').notNull().default(false),
  /** Mã tham gia cho link tự báo danh; bí mật như `enrolment_key` — chỉ chủ lớp/người có quyền quản roster mới thấy giá trị thật. */
  joinCode: text('join_code'),
  onLeave: text('on_leave').notNull().default('suspend'),
  status: text('status').notNull().default('active'),
  description: text('description').notNull().default(''),
  /** Học phí gói lớp (CLASS-3): số nguyên đơn vị nhỏ nhất (không float, cùng bất biến của payments); NULL hoặc 0 = lớp không thu học phí qua hệ thống — đây là công tắc thu phí, không có cờ bật/tắt riêng. */
  feeCost: integer('fee_cost'),
  /** Đơn vị tiền của học phí gói lớp; mặc định VND theo luật thanh toán nội địa (VietQR/SePay, sổ quyết định mục E). */
  feeCurrency: text('fee_currency').notNull().default('VND'),
  /** Tài khoản nhận học phí chỉ định riêng cho lớp; NULL = dùng tài khoản mặc định của tenant sở hữu lớp. FK RESTRICT: tài khoản đang được lớp trỏ tới không bị xoá mất dấu vết dòng tiền. */
  feePaymentAccountId: uuid('fee_payment_account_id').references(() => paymentAccounts.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('classes_tenant_id_idx').on(table.tenantId),
      index('classes_owner_id_idx').on(table.ownerId),
      index('classes_fee_payment_account_id_idx').on(table.feePaymentAccountId),
      uniqueIndex('classes_tenant_code_unique').on(table.tenantId, table.code).where(sql`${table.code} is not null`),
      uniqueIndex('classes_join_code_unique').on(table.joinCode).where(sql`${table.joinCode} is not null`),
  ]);
