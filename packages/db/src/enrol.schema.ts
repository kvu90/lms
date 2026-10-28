/** Các bảng của bounded context Enrol — định nghĩa Drizzle do module enrol sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { course } from './courses.schema';

/**
 * Các instance ghi danh theo từng khoá học (Moodle `enrol`). method: manual|cohort|self|guest.
 * status: 0=enabled, 1=disabled. Đối với instance cohort, custom_int1 = id của cohort,
 * custom_int2 = id của nhóm để thêm thành viên vào (0=không có), custom_text1 = chế độ đồng bộ
 * ('suspend'|'unenrol') được áp dụng khi một user rời khỏi cohort.
 */
export const enrol = pgTable('enrol', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
  enrol: text('enrol').notNull(),
  status: integer('status').notNull().default(0),
  name: text('name'),
  roleId: uuid('role_id'),
  enrolPeriod: integer('enrol_period').notNull().default(0),
  timeStart: timestamp('time_start', { withTimezone: true }),
  timeEnd: timestamp('time_end', { withTimezone: true }),
  customInt1: uuid('custom_int1'),
  customInt2: uuid('custom_int2'),
  customText1: text('custom_text1').notNull().default('suspend'),
  /** Ghi danh thu phí: chi phí tính bằng đơn vị tiền tệ nhỏ nhất (0 = miễn phí), mã ISO của đơn vị tiền, id tài khoản thanh toán. */
  cost: integer('cost').notNull().default(0),
  currency: text('currency').notNull().default(''),
  paymentAccountId: uuid('payment_account_id'),
  /**
   * Khoá ghi danh (enrolment key) của instance self (Moodle `enrol.password`):
   * null/rỗng = không yêu cầu khoá. Giá trị này là bí mật — service chỉ trả về
   * cho người có capability quản lý enrol.
   */
  enrolmentKey: text('enrolment_key'),
  /**
   * Có gửi tin nhắn chào mừng khi ghi danh thành công hay không. Mặc định lúc
   * tạo instance do service quyết theo phương thức (self = bật, manual = tắt —
   * đúng mặc định của Moodle); cột này lưu lựa chọn đã chốt của instance.
   */
  sendWelcomeMessage: boolean('send_welcome_message').notNull().default(false),
  /** Nội dung tin nhắn chào mừng tuỳ biến; null = dùng mẫu mặc định theo i18n (`platform.enrolWelcomeBody`). */
  welcomeMessage: text('welcome_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('enrol_course_id_idx').on(table.courseId),
      index('enrol_role_id_idx').on(table.roleId),
      index('enrol_custom_int1_idx').on(table.customInt1),
      index('enrol_custom_int2_idx').on(table.customInt2),
      index('enrol_payment_account_id_idx').on(table.paymentAccountId),
  ]);


/**
 * Ghi danh của user (Moodle `user_enrolments`).
 * status: 0=ACTIVE, 1=SUSPENDED, 2=WITHDRAWN (trạng thái mềm dùng khi rút ghi danh khi
 * user vẫn còn dữ liệu liên quan — grades/completion/files — phải được
 * giữ lại; dòng không bao giờ bị xoá cứng trong trường hợp đó, report §2#5).
 */
export const userEnrolments = pgTable(
  'user_enrolments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    enrolId: uuid('enrol_id').notNull().references(() => enrol.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    status: integer('status').notNull().default(0),
    timeStart: timestamp('time_start', { withTimezone: true }).notNull().defaultNow(),
    timeEnd: timestamp('time_end', { withTimezone: true }),
    modifierId: uuid('modifier_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('user_enrolments_user_id_idx').on(table.userId),
      // Index theo khoá cho các truy vấn roster/phạm vi theo khoá (issue
      // #33: trước đây mọi truy vấn theo khoá phải quét toàn bộ bảng ghi
      // danh vì không có index nào neo ở enrol_id — đội kiểm tra độc lập
      // đo đây là nghẽn gốc ở quy mô lớn).
      index('user_enrolments_enrol_id_user_id_idx').on(table.enrolId, table.userId),
      index('user_enrolments_modifier_id_idx').on(table.modifierId),unique('user_enrolments_unique').on(table.enrolId, table.userId)],
);
