/**
 * Các bảng PHÍA TRUNG TÂM của kho ngân hàng hệ thống (issue #585) — nằm
 * trong kho nghiệp vụ của trung tâm (cùng database với câu hỏi, đề thi,
 * YCCĐ của trung tâm), đối ứng với kho ngân hàng riêng phía platform
 * (`system-bank.schema.ts`). Ba bảng này là bảng vệ tinh theo đúng tiền
 * lệ của `question_learning_outcomes`: không mang `tenant_id` riêng và
 * không có policy RLS riêng — chúng được bảo vệ qua thực thể chủ mà
 * chúng gắn vào (câu hỏi qua bank/category của nó, sự kiện qua slug
 * trung tâm của ngữ cảnh gọi) và qua kiểm tra capability ở tầng service.
 * Tầng service PHẢI luôn giới hạn đọc/ghi theo ngữ cảnh trung tâm hiện
 * tại, không bao giờ đọc toàn bộ bảng xuyên trung tâm.
 *
 * - `system_question_imports`: một dòng cho mỗi câu hỏi ở trung tâm mà
 *   nguồn gốc là một bản chụp từ Ngân hàng hệ thống — truy vết nguồn
 *   đầy đủ (câu nguồn, phiên bản nguồn, checksum gói lúc nhập, thời
 *   điểm nhập, người nhập) và phân loại bản ghi (nguyên trạng / phái
 *   sinh). Sửa một câu nguyên trạng tạo version mới và lật kind sang
 *   `derived` trong cùng transaction; version nguyên trạng
 *   (imported_version_number) còn nguyên và đọc lại được.
 * - `system_bank_event_receipts`: trung tâm ghi nhận đã nhận một sự kiện
 *   của kho ngân hàng (rút câu) — một dòng cho mỗi cặp (sự kiện, trung
 *   tâm); unique theo cặp để ghi nhận lặp là idempotent.
 * - `outcome_package_installs`: bản cài gói YCCĐ cục bộ của trung tâm —
 *   phiên bản gói đang cài và phiên bản trước đó, để đối chiếu cập nhật
 *   và để biết trung tâm đang gắn chuẩn theo bản cài nào.
 */
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { question } from './questions.schema';

/**
 * Truy vết nhập bản chụp từ Ngân hàng hệ thống vào kho trung tâm.
 * Một câu hỏi ở trung tâm có tối đa một dòng này (PK chính là question_id):
 * câu nhập rồi sửa vẫn giữ nguyên dòng truy vết của lần nhập — chỉ kind
 * đổi từ `pristine` sang `derived` khi có version do trung tâm tạo thêm.
 */
export const systemQuestionImports = pgTable('system_question_imports', {
  /** Câu hỏi ở kho trung tâm (bản chụp) — cũng là khoá chính của dòng truy vết. */
  questionId: uuid('question_id').primaryKey().references(() => question.id, { onDelete: 'cascade' }),
  /** Định danh câu nguồn ở kho ngân hàng (id ổn định, giữ nguyên khi di trú). */
  sourceQuestionId: uuid('source_question_id').notNull(),
  /** Định danh phiên bản nguồn đã nhập. */
  sourceVersionId: uuid('source_version_id').notNull(),
  /** Số hiệu phiên bản nguồn đã nhập. */
  sourceVersionNumber: integer('source_version_number').notNull(),
  /** sha256 của gói phiên bản lúc nhập — phải khớp checksum của gói nguồn. */
  packageChecksum: text('package_checksum').notNull(),
  /** Số hiệu version của bản chụp tại thời điểm nhập (version nguyên trạng). */
  importedVersionNumber: integer('imported_version_number').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  importedBy: uuid('imported_by'),
  /** pristine = bản nhập nguyên trạng chưa sửa; derived = đã có version do trung tâm tạo thêm. */
  kind: text('kind').notNull().default('pristine'),
},
  (table) => [
      index('system_question_imports_source_question_id_idx').on(table.sourceQuestionId),
      check('system_question_imports_kind_check', sql`${table.kind} in ('pristine', 'derived')`),
  ]);

/**
 * Ghi nhận trung tâm đã nhận một sự kiện của kho ngân hàng (hiện tại là
 * sự kiện rút câu). `centreSlug` là slug của trung tâm trong sổ đăng ký
 * — cần thiết vì ở thế giới kho chung, nhiều trung tâm còn chung một
 * database và bảng này phải phân biệt được trung tâm nào đã nhận.
 */
export const systemBankEventReceipts = pgTable('system_bank_event_receipts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  /** Id sự kiện ở kho ngân hàng (system_bank_events.id). */
  eventId: uuid('event_id').notNull(),
  /** Slug của trung tâm ghi nhận. */
  centreSlug: text('centre_slug').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('system_bank_event_receipts_centre_slug_idx').on(table.centreSlug),
      unique('system_bank_event_receipts_event_centre_unique').on(table.eventId, table.centreSlug),
  ]);

/**
 * Bản cài gói YCCĐ cục bộ của trung tâm: một dòng cho mỗi phiên bản gói
 * đã cài (upsert theo package_version khi cài lại cùng phiên bản).
 * `previousVersion` là phiên bản gói trước lần cài này (null ở lần đầu)
 * — cập nhật gói không sửa ngược các gắn chuẩn đã có vì gắn chuẩn theo
 * id YCCĐ, và bản cài upsert theo id nên id không đổi.
 */
export const outcomePackageInstalls = pgTable('outcome_package_installs', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  /** Định danh phiên bản gói đã cài (khớp system_outcome_packages.version). */
  packageVersion: text('package_version').notNull(),
  /** Phiên bản gói trước lần cài này, null ở lần cài đầu tiên. */
  previousVersion: text('previous_version'),
  /** Phạm vi gói (all | slug môn học). */
  scope: text('scope').notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  installedBy: uuid('installed_by'),
},
  (table) => [
      uniqueIndex('outcome_package_installs_package_version_unique').on(table.packageVersion),
  ]);

/** Kiểu dòng select của các bảng phía trung tâm của kho ngân hàng. */
export type SystemQuestionImportRow = typeof systemQuestionImports.$inferSelect;
export type SystemBankEventReceiptRow = typeof systemBankEventReceipts.$inferSelect;
export type OutcomePackageInstallRow = typeof outcomePackageInstalls.$inferSelect;
