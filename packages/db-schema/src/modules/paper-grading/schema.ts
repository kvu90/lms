/** Các bảng của chấm bài giấy bằng camera (CAM-0, issue #112) — module paper-grading sở hữu; barrel của package `@lms/db-schema` tổng hợp cho Drizzle. */
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { PaperQuality, PaperReading, PaperRosterEntry, PaperSlotLayout } from '@lms/contracts';
import { examAttempts, examPins } from '../quiz/schema';

/**
 * Một lô IN phiếu trả lời (một MÃ ĐỀ) của một quiz. Layout là bản CHỤP
 * đề tại thời điểm sinh phiếu: từng slot mang question + version đã ghim
 * + thứ tự đáp án của version đó — phiếu in ra là đề thi, nên lúc ghi
 * điểm phải chấm đúng version đã in, không theo version mới nhất sau
 * này. Roster là bản chụp danh sách lớp tại thời điểm sinh lô: mã tô
 * cho phiếu dùng chung (4 số tại lớp hoặc 8 số thi thử SBD, theo
 * code_digits của lô) — roster chuyển vai từ "nguồn để in phiếu cá
 * nhân hoá" thành "nguồn để khớp" khi định danh phiếu đã chụp. Học
 * sinh ghi danh sau thời điểm sinh lô không có trong lô này (sinh lô
 * mới nếu cần thêm phiếu). exam_code là mã đề 4 số giống Bộ của
 * variant (khớp variant_code của tầng triển khai đề khi EB-2 nối
 * vào); lô in khác lô chụp — một buổi chụp gồm nhiều lô in.
 */
export const examBatches = pgTable('exam_batches', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  examPinId: uuid('exam_pin_id').notNull().references(() => examPins.id, { onDelete: 'cascade' }),
  variantCode: text('variant_code').notNull(),
  examCode: text('exam_code'),
  codeDigits: integer('code_digits').notNull().default(4),
  layout: jsonb('layout').$type<PaperSlotLayout[]>().notNull(),
  roster: jsonb('roster').$type<PaperRosterEntry[]>().notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_batches_quiz_idx').on(table.examPinId),
      unique('exam_batches_quiz_variant_unique').on(table.examPinId, table.variantCode),
      unique('exam_batches_quiz_exam_code_unique').on(table.examPinId, table.examCode),
      check('exam_batches_code_digits_check', sql`${table.codeDigits} in (4, 8)`),
  ]);

/**
 * Một phiếu đã được giáo viên chụp/tải lên và qua cổng chất lượng +
 * OMR. Ảnh gốc và ảnh đã nắn phẳng (warp về template chuẩn) là bản ghi
 * trong module files (file_id / warped_file_id — tham chiếu mềm như quy
 * ước user_id của repo); warped_file_id null khi ảnh không nắn được
 * nhưng vẫn giữ để giáo viên xem (hiếm: fiducial tìm thấy một phần ở
 * bước kiểm tra lại). readings là kết quả đọc theo từng slot (mật độ
 * mực từng ô + quyết định hai tầng); câu mơ hồ ở trạng thái ambiguous
 * cho tới khi giáo viên xác nhận — hệ thống KHÔNG tự đoán.
 *
 * Vòng đời status: needs_identity (chưa định danh chắc chắn) →
 * needs_review (còn câu mơ hồ) → ready (đủ điều kiện ghi) → recorded
 * (đã tạo attempt thi giấy, attempt_id trỏ về quiz_attempts). Điểm
 * không bao giờ tự chảy khi định danh chưa chắc chắn hoặc còn câu mơ
 * hồ chưa xác nhận. expires_at là mốc hết hạn giữ ảnh gốc theo cấu
 * hình mod_quiz/paperscanretentionmonths, vật hoá lúc tải lên.
 *
 * Lô in ↔ lô chụp: batch_id là LÔ IN phiếu thuộc về (định tuyến theo
 * mã đề đọc được hoặc QR; NULL khi chưa định tuyến được — phiếu chờ
 * giáo viên gán lô, hệ thống không đoán), session_id là LÔ CHỤP (một
 * lượt tải ảnh của một buổi; mọi phiếu trong lượt mang cùng mã).
 * variant_code_read là mã đề 4 số đọc chắc chắn từ lưới tô trên phiếu
 * (null = không đọc được chắc chắn); khi nó khác exam_code của lô in
 * thì phiếu bị chặn ghi attempt cho tới khi xử lý lại.
 */
export const examScans = pgTable('exam_scans', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  batchId: uuid('batch_id').references(() => examBatches.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id'),
  examPinId: uuid('exam_pin_id').notNull().references(() => examPins.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id').notNull(),
  warpedFileId: uuid('warped_file_id'),
  studentId: uuid('student_id'),
  identitySource: text('identity_source'),
  identityCode: text('identity_code'),
  variantCodeRead: text('variant_code_read'),
  status: text('status').notNull().default('needs_identity'),
  quality: jsonb('quality').$type<PaperQuality>(),
  readings: jsonb('readings').$type<PaperReading[]>().notNull().default([]),
  attemptId: uuid('attempt_id').references(() => examAttempts.id, { onDelete: 'set null' }),
  uploadedBy: uuid('uploaded_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_scans_quiz_idx').on(table.examPinId),
      index('exam_scans_batch_idx').on(table.batchId),
      index('exam_scans_status_idx').on(table.examPinId, table.status),
      index('exam_scans_student_idx').on(table.studentId),
      index('exam_scans_attempt_idx').on(table.attemptId),
      check('exam_scans_status_check', sql`${table.status} in ('needs_identity', 'needs_review', 'ready', 'recorded')`),
      check('exam_scans_identity_source_check', sql`${table.identitySource} is null or ${table.identitySource} in ('qr', 'bubbles', 'manual')`),
  ]);
