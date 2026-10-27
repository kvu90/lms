/** Các bảng của bounded context Ngân hàng đề (EB-1) — định nghĩa Drizzle do module exam-papers sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  check,
  doublePrecision,
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
import { subjects } from '../curriculum/schema';
import { question, questionBanks } from '../questions/schema';
import { examMatrices, examMatrixCells, examMatrixVersions } from '../quiz/schema';
import { tenants } from '../tenants/schema';


/**
 * Thực thể ĐỀ (feat issue #113, EB-1; research ngân hàng đề/ma trận mục
 * A.1/B.2/G.2): "giấy thi cụ thể" nằm giữa ma trận (công thức) và quiz
 * (hoạt động thi triển khai một đề vào một khoá). `exam_papers` là DANH
 * TÍNH (sống trong một bank có `bank_kind='exam'` của khuôn bank đa loại
 * — quyền neo MỘT nguồn duy nhất là bank, capability `exam:*` tại context
 * bank); nội dung tại một thời điểm nằm ở `exam_paper_versions` — sửa
 * metadata hay slots đều tạo version mới, version cũ giữ nguyên cho các
 * quiz đã ghim (cùng nguyên tắc đóng băng của question versions).
 *
 * kind: chỉ còn 'snapshot' (bản chụp câu cụ thể) — dạng recipe/công
 * thức đã bỏ hẳn theo chốt 26/10.
 * status: draft / ready / hidden như câu hỏi — hidden là rút khỏi ngân
 * hàng (không khám phá/thêm mới được; quiz đang triển khai KHÔNG vỡ vì
 * deploy đã chụp slots sang quiz_slots).
 *
 * Ý nghĩa trạng thái thống nhất cả ba thực thể ngân hàng (câu hỏi, đề,
 * ma trận) theo QUY TẮC HOÀN THIỆN: `draft` = đang soạn hoặc đang chờ
 * người duyệt, chưa được dùng; `ready` = đã hoàn thiện, dùng được
 * ngay; `hidden` = đã rút khỏi ngân hàng. Cùng một quy tắc cho ra mặc
 * định khác nhau theo hình dạng lúc ra đời của từng thực thể: câu hỏi
 * sinh ra đã hoàn chỉnh trong một lượt soạn nên vào bank ở `ready`;
 * đề (và ma trận) sinh ra rỗng và lớn dần qua nhiều lượt soạn nên bắt
 * đầu ở `draft` và được chốt sang `ready` bằng hành động chủ động;
 * thực thể vào bank ở dạng đã hoàn thiện (duyệt đóng góp đạt, sinh đề
 * từ ma trận) mang `ready`; nội dung nạp qua kênh máy (AI/MCP) luôn
 * vào `draft` chờ giáo viên duyệt.
 */
export const exams = pgTable('exams', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  /** Tenant sở hữu (TENANT-0, #168) — luôn bằng tenant_id của bank chủ; NULL khi bank là bank platform. */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
  bankId: uuid('bank_id').notNull().references(() => questionBanks.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('snapshot'),
  status: text('status').notNull().default('draft'),
  /**
   * Truy vết copy (như question.derived_from_*): đề nguồn đã copy +
   * ma trận nguồn (khi đề sinh từ ma trận) + tác giả gốc giữ nguyên qua
   * các đời copy (ghi công không tắt được). Con trỏ mềm như các con trỏ
   * truy vết xuyên module khác.
   */
  derivedFromExamId: uuid('derived_from_exam_id'),
  derivedFromMatrixId: uuid('derived_from_matrix_id'),
  originalAuthorId: uuid('original_author_id'),
  /**
   * Bank nguồn và số version của đề nguồn tại thời điểm copy (bổ
   * sung ở lát S2 của đợt đồng bộ cơ chế ngân hàng, theo đúng khuôn
   * derived_from_bank_id / derived_from_version_id của câu hỏi):
   * ghi tại lúc copy để truy vết không phụ thuộc việc đề nguồn còn
   * tồn tại hay đã chuyển bank về sau.
   */
  derivedFromBankId: uuid('derived_from_bank_id'),
  derivedFromVersionNumber: integer('derived_from_version_number'),
  createdBy: uuid('created_by').notNull(),
  /** Số version mới nhất (= số version hiện có); nội dung sống ở exam_paper_versions. */
  latestVersion: integer('latest_version').notNull().default(1),
  /** Số lượt đề này đã được copy đi (tín hiệu dùng thật như question.copy_count). */
  copyCount: integer('copy_count').notNull().default(0),
  /**
   * Truy vết lần rút khỏi ngân hàng gần nhất (ngang hàng
   * question_bank_entries): rút = chuyển status sang `hidden` qua
   * đường rút chuyên dụng với lý do BẮT BUỘC (withdrawn_reason) +
   * người rút + thời điểm; khôi phục về `ready` thì xoá cả ba cột.
   * Đề đã rút biến mất khỏi khám phá và không ghim/đóng góp mới
   * được, nhưng các version đã ghim vào khoá vẫn phục vụ bình
   * thường. Ba cột null khi đề chưa từng bị rút hoặc đã khôi phục.
   */
  withdrawnReason: text('withdrawn_reason'),
  withdrawnBy: uuid('withdrawn_by'),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exams_tenant_id_idx').on(table.tenantId),
      index('exams_bank_id_idx').on(table.bankId),
      index('exams_status_idx').on(table.status),
      index('exams_created_by_idx').on(table.createdBy),
      index('exams_derived_from_idx').on(table.derivedFromExamId),
      check('exams_kind_check', sql`${table.kind} in ('snapshot')`),
      check('exams_status_check', sql`${table.status} in ('draft', 'ready', 'hidden')`),
  ]);

/**
 * Nội dung của đề TẠI MỘT THỜI ĐIỂM (như question_versions): metadata
 * hiển thị/soạn thảo + tham chiếu ma trận nguồn kèm số version của ma
 * trận lúc chụp (matrix_version). Slots của version nằm ở
 * exam_paper_slots. Version là BẤT BIẾN sau khi tạo — mọi sửa đổi đi qua
 * version mới.
 */
export const examVersions = pgTable('exam_versions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  examId: uuid('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
  grade: integer('grade'),
  /** Loại kiểm tra theo nghiệp vụ VN: regular (thường xuyên) | midterm (giữa kỳ) | final (cuối kỳ) | mock (thi thử) | practice (ôn tập). */
  examKind: text('exam_kind'),
  totalScore: doublePrecision('total_score').notNull().default(10),
  durationMinutes: integer('duration_minutes'),
  /** Thang Đ–S chùm chụp hiệu lực cho đề (mảng 5 tỉ lệ % cho 0..4 ý đúng); null = mặc định QĐ 764. */
  tfScale: jsonb('tf_scale').$type<number[]>(),
  matrixId: uuid('matrix_id').references(() => examMatrices.id, { onDelete: 'set null' }),
  matrixVersion: integer('matrix_version'),
  /**
   * Neo FK tới ĐÚNG version bất biến của ma trận đã sinh ra version
   * đề này (exam_matrix_versions): matrix_version là số version hiển
   * thị, còn cột này là căn cứ truy được nội dung ma trận gốc bất
   * biến. Null với version đề không sinh từ ma trận hoặc sinh trước
   * khi ma trận có version bất biến.
   */
  matrixVersionId: uuid('matrix_version_id').references(() => examMatrixVersions.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_versions_paper_idx').on(table.examId),
      index('exam_versions_subject_idx').on(table.subjectId),
      index('exam_versions_matrix_idx').on(table.matrixId),
      index('exam_versions_matrix_version_idx').on(table.matrixVersionId),
      unique('exam_versions_paper_version_unique').on(table.examId, table.version),
      check('exam_versions_exam_kind_check', sql`${table.examKind} is null or ${table.examKind} in ('regular', 'midterm', 'final', 'mock', 'practice')`),
  ]);

/**
 * Một vị trí câu trong một paper version (đúng khuôn quiz_slots của
 * QB-3): question_id + version câu GHIM CỨNG (pinned_version_id +
 * pinned_version_number để hiển thị) — đề snapshot bất biến tuyệt đối:
 * câu nguồn có version mới cũng không đổi đề đã chụp. section là tên
 * phần (chia phần trong đề); cluster_id gom các slot truefalse cùng
 * chùm Đ–S như quiz_slots.
 */
export const examSlots = pgTable('exam_slots', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  examVersionId: uuid('exam_version_id').notNull().references(() => examVersions.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  section: text('section').notNull().default(''),
  questionId: uuid('question_id').notNull().references(() => question.id, { onDelete: 'cascade' }),
  pinnedVersionId: uuid('pinned_version_id'),
  pinnedVersionNumber: integer('pinned_version_number'),
  maxMark: doublePrecision('max_mark').notNull().default(1),
  clusterId: uuid('cluster_id'),
  /**
   * Ô ma trận NGUỒN của slot (EB-2, chỉ ở snapshot materialize từ
   * recipe): điểm neo cho swap-cùng-ô (câu thay phải thuộc pool của
   * ô này) và báo cáo lệch tỉ lệ theo ô. Slot soạn tay: null.
   */
  matrixCellId: uuid('matrix_cell_id').references(() => examMatrixCells.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_slots_version_idx').on(table.examVersionId),
      index('exam_slots_question_idx').on(table.questionId),
      index('exam_slots_cluster_idx').on(table.clusterId),
      index('exam_slots_matrix_cell_idx').on(table.matrixCellId),
      unique('exam_slots_version_position_unique').on(table.examVersionId, table.position),
  ]);

/**
 * Đề xuất đóng góp một ĐỀ vào bank chung — ĐƯỜNG ĐÓNG GÓP DUY NHẤT
 * của đề (khuôn QB-4 của câu hỏi, đơn vị duyệt là TOÀN BỘ đề): một
 * dòng = một đề xuất đưa đề (ở bank nguồn) vào bank đích
 * (tổ/trường/khoá). Hai mode như câu hỏi:
 *
 * - mode 'new': duyệt đạt thì COPY đề vào bank đích bằng cơ chế deep
 *   copy (danh tính mới, derived_from trỏ về đề gốc, slots giữ
 *   nguyên question + pinned version).
 * - mode 'update': đề xuất bản mới cho MỘT ĐỀ ĐÃ CÓ trong bank đích
 *   (target_exam_id); đề nguồn bắt buộc là bản sao có liên kết
 *   derived_from trỏ về chính đề đích (tầng service kiểm, lỗi
 *   `exam.contribution_not_derived` — đối xứng luật
 *   `question.contribution_not_derived` của QB-4); duyệt đạt thì tạo
 *   VERSION MỚI trên chính danh tính đề đích từ nội dung version
 *   hiện tại của đề nguồn (result_exam_id = chính đề đích).
 *
 * content_hash tính trên cấu trúc version hiện tại của đề (danh
 * sách question + pinned version + max_mark đã sắp) phục vụ chống
 * trùng hoàn toàn/gần trùng trong bank đích.
 *
 * BỘ HỒ SƠ ĐÍNH KÈM (tuỳ chọn): đóng góp cho đề kiểm tra chính thức
 * có thể mang bộ ba ghim tại lúc đề xuất — version đề + version ma
 * trận + bản đặc tả chụp (các cột dossier_*) — đúng phần việc mà
 * đường hồ sơ `exam_dossiers` từng giữ riêng; đường hồ sơ đã bị hấp
 * thụ vào đường đóng góp này (xem comment của `exam_dossiers`):
 * hồ sơ không còn là sổ đăng ký riêng để đưa đề vào bank. Khi đóng
 * góp CÓ bộ hồ sơ đính kèm và tenant của bank đích bật cấu hình
 * `exam/requireboardapproval`, duyệt cấp 1 (exam:moderate tại bank
 * đích) chỉ đưa đóng góp sang trạng thái `pending_board`; cấp duyệt
 * thứ hai (ban giám hiệu — exam:moderate tại context hệ thống)
 * duyệt mới chốt. Mọi mốc duyệt ghi vào `exam_contribution_reviews`.
 * Ngoài hai điều kiện đó, đóng góp duyệt một cấp như QB-4.
 *
 * source_dossier_id: liên kết về bộ hồ sơ gốc khi đóng góp này sinh
 * ra từ việc chuyển đổi một hồ sơ đang chờ duyệt tại thời điểm cắt
 * đường — người đóng góp và người duyệt lần theo liên kết này về
 * được hồ sơ gốc và lịch sử của nó.
 */
export const examContributions = pgTable('exam_contributions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  examId: uuid('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
  targetBankId: uuid('target_bank_id').notNull().references(() => questionBanks.id, { onDelete: 'cascade' }),
  proposerId: uuid('proposer_id').notNull(),
  note: text('note').notNull().default(''),
  /** Mode đóng góp: 'new' (đưa đề mới vào bank đích) | 'update' (bản mới cho đề đích ở target_exam_id). */
  mode: text('mode').notNull().default('new'),
  /** Đề đích trong bank đích của mode 'update' (con trỏ mềm như target_question_id của QB-4); null ở mode 'new'. */
  targetExamId: uuid('target_exam_id'),
  status: text('status').notNull().default('pending'),
  contentHash: text('content_hash').notNull().default(''),
  nearDuplicateOf: uuid('near_duplicate_of'),
  rejectReason: text('reject_reason'),
  reviewerId: uuid('reviewer_id'),
  resultExamId: uuid('result_exam_id'),
  /**
   * Bộ hồ sơ đính kèm đã GHIM tại lúc đề xuất (chỉ có khi người đề
   * xuất yêu cầu đính kèm hồ sơ cho đề chính thức): version đề được
   * duyệt theo bộ này thay vì version hiện hành tại lúc duyệt;
   * null toàn bộ ở đóng góp thường.
   */
  dossierExamVersionId: uuid('dossier_exam_version_id').references(() => examVersions.id, { onDelete: 'set null' }),
  dossierExamVersionNumber: integer('dossier_exam_version_number'),
  dossierMatrixId: uuid('dossier_matrix_id').references(() => examMatrices.id, { onDelete: 'set null' }),
  dossierMatrixVersion: integer('dossier_matrix_version'),
  /** Neo FK tới version bất biến của ma trận trong bộ hồ sơ (căn cứ lịch sử như exam_dossiers.matrix_version_id). */
  dossierMatrixVersionId: uuid('dossier_matrix_version_id').references(() => examMatrixVersions.id, { onDelete: 'set null' }),
  /** Bản đặc tả (view model MatrixSpecification) chụp tại lúc đề xuất kèm bộ hồ sơ. */
  dossierSpecSnapshot: jsonb('dossier_spec_snapshot').$type<Record<string, unknown>>(),
  /** Bộ hồ sơ gốc mà đóng góp này được chuyển đổi từ đó (null với đóng góp lập trực tiếp trên đường đóng góp). */
  sourceDossierId: uuid('source_dossier_id').references(() => examDossiers.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_contributions_target_bank_idx').on(table.targetBankId),
      index('exam_contributions_paper_idx').on(table.examId),
      index('exam_contributions_proposer_idx').on(table.proposerId),
      index('exam_contributions_status_idx').on(table.status),
      index('exam_contributions_dossier_version_idx').on(table.dossierExamVersionId),
      index('exam_contributions_dossier_matrix_idx').on(table.dossierMatrixId),
      index('exam_contributions_dossier_matrix_version_idx').on(table.dossierMatrixVersionId),
      index('exam_contributions_source_dossier_idx').on(table.sourceDossierId),
      check('exam_contributions_mode_check', sql`${table.mode} in ('new', 'update')`),
      check('exam_contributions_status_check', sql`${table.status} in ('pending', 'pending_board', 'approved', 'rejected')`),
  ]);

/**
 * Một MỐC DUYỆT của một đóng góp đề: mỗi cấp duyệt ghi một dòng độc
 * lập (level 1 = người có exam:moderate tại bank đích; level 2 =
 * ban giám hiệu, chỉ tồn tại ở đóng góp có bộ hồ sơ đính kèm khi
 * tenant bật cấu hình cấp duyệt 2) với người duyệt, quyết định và
 * lý do (bắt buộc khi từ chối — kiểm ở tầng service). Đây là sổ mốc
 * duyệt của đường đóng góp duy nhất, tổng quát hoá từ
 * `exam_dossier_reviews` của đường hồ sơ cũ: vết này là căn cứ truy
 * vết "ai duyệt đóng góp này, ở cấp nào, khi nào" ngoài các sự kiện
 * audit ở outbox. Khi chuyển đổi hồ sơ đang chờ duyệt thành đóng
 * góp, các mốc duyệt đã có của hồ sơ được sao sang bảng này để lịch
 * sử duyệt của đóng góp liền mạch từ đầu.
 */
export const examContributionReviews = pgTable('exam_contribution_reviews', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  contributionId: uuid('contribution_id').notNull().references(() => examContributions.id, { onDelete: 'cascade' }),
  level: integer('level').notNull(),
  reviewerId: uuid('reviewer_id').notNull(),
  decision: text('decision').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_contribution_reviews_contribution_idx').on(table.contributionId),
      check('exam_contribution_reviews_level_check', sql`${table.level} in (1, 2)`),
      check('exam_contribution_reviews_decision_check', sql`${table.decision} in ('approved', 'rejected')`),
  ]);

/**
 * Một BỘ HỒ SƠ duyệt đề (EB-3, issue #165 — đơn vị duyệt của đề/ma
 * trận là TOÀN BỘ tài liệu, khác câu hỏi duyệt từng câu): giáo viên
 * đóng góp bộ ba {phiên bản ma trận + phiên bản đề + bản đặc tả} vào
 * một bank đề dùng chung (tổ/trường/khoá); tổ chức duyệt theo cấp —
 * cấp 1 là người có exam:moderate tại bank đích, cấp 2 (ban giám
 * hiệu) chỉ tồn tại khi cấu hình trường bật (đọc qua một điểm seam
 * trong ExamDossiersService, mặc định TẮT).
 *
 * VAI TRÒ HIỆN TẠI — LỊCH SỬ CHỈ-ĐỌC: đường hồ sơ đã bị hấp thụ vào
 * đường đóng góp duy nhất `exam_contributions` (bộ hồ sơ thành phần
 * đính kèm tuỳ chọn của một đóng góp, cấp duyệt 2 thành trạng thái
 * `pending_board` của đóng góp). Bảng này không còn nhận hồ sơ mới
 * và không còn là đường đưa đề vào bank; nó được giữ nguyên cấu
 * trúc để xem lại lịch sử. Tại thời điểm cắt đường, hồ sơ đang ở
 * `pending`/`pending_board` được chuyển thành đóng góp mang theo bộ
 * hồ sơ đã ghim + lịch sử mốc duyệt (đóng góp trỏ về hồ sơ gốc qua
 * `exam_contributions.source_dossier_id`); hồ sơ `draft` đóng băng
 * tại chỗ kèm thông báo cho người lập; hồ sơ `approved`/`rejected`
 * giữ nguyên làm lịch sử kết quả.
 *
 * Version được GHIM TẠI LÚC NỘP (submit): paper_version_id +
 * paper_version_number, matrix_id + matrix_version; bản đặc tả được
 * CHỤP nguyên trạng vào spec_snapshot tại cùng thời điểm — hàng chờ
 * duyệt luôn cho xem đúng nội dung đã nộp, ma trận/đề có sửa về sau
 * (version mới) cũng không viết lại hồ sơ đã nộp. Duyệt đạt (qua đủ
 * các cấp hiệu lực) = copy phiên bản đề đã ghim vào bank đích
 * (result_paper_id, status ready, derived_from trỏ về đề nguồn).
 * Trạng thái: draft → pending → (pending_board) → approved/rejected.
 */
export const examDossiers = pgTable('exam_dossiers', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  examId: uuid('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
  targetBankId: uuid('target_bank_id').notNull().references(() => questionBanks.id, { onDelete: 'cascade' }),
  proposerId: uuid('proposer_id').notNull(),
  note: text('note').notNull().default(''),
  status: text('status').notNull().default('draft'),
  examVersionId: uuid('exam_version_id').references(() => examVersions.id, { onDelete: 'set null' }),
  examVersionNumber: integer('exam_version_number'),
  matrixId: uuid('matrix_id').references(() => examMatrices.id, { onDelete: 'set null' }),
  matrixVersion: integer('matrix_version'),
  /**
   * Neo FK tới version bất biến của ma trận tại thời điểm nộp: từ
   * khi ma trận có version bất biến, lịch sử của bộ hồ sơ được giữ
   * bằng neo này (nội dung ma trận tại thời điểm nộp đọc lại nguyên
   * vẹn từ version), không còn phụ thuộc vào ảnh chụp tự tạo.
   */
  matrixVersionId: uuid('matrix_version_id').references(() => examMatrixVersions.id, { onDelete: 'set null' }),
  /** Bản đặc tả (view model MatrixSpecification) chụp tại lúc nộp — giữ cho bề mặt duyệt trong hàng chờ và cho các bộ hồ sơ đã nộp từ trước; bộ hồ sơ mới đồng thời neo matrix_version_id làm căn cứ lịch sử. */
  specSnapshot: jsonb('spec_snapshot').$type<Record<string, unknown>>(),
  resultExamId: uuid('result_exam_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_dossiers_target_bank_idx').on(table.targetBankId),
      index('exam_dossiers_paper_idx').on(table.examId),
      index('exam_dossiers_paper_version_idx').on(table.examVersionId),
      index('exam_dossiers_matrix_idx').on(table.matrixId),
      index('exam_dossiers_matrix_version_idx').on(table.matrixVersionId),
      index('exam_dossiers_proposer_idx').on(table.proposerId),
      index('exam_dossiers_status_idx').on(table.status),
      check('exam_dossiers_status_check', sql`${table.status} in ('draft', 'pending', 'pending_board', 'approved', 'rejected')`),
  ]);

/**
 * Một MỐC DUYỆT của bộ hồ sơ: mỗi cấp duyệt ghi một dòng độc lập
 * (level 1 = tổ trưởng/moderate tại bank đích; level 2 = ban giám
 * hiệu) với người duyệt, quyết định và lý do (bắt buộc khi từ chối —
 * kiểm ở tầng service). Vết này là căn cứ truy vết "ai duyệt bộ này,
 * ở cấp nào, khi nào" ngoài các sự kiện audit ở outbox. Sổ mốc duyệt
 * của đường đóng góp hiện hành là `exam_contribution_reviews`; khi
 * một hồ sơ đang chờ được chuyển đổi thành đóng góp, các dòng ở đây
 * được sao sang sổ đó để lịch sử duyệt liền mạch, còn bản gốc ở đây
 * giữ nguyên phục vụ bề mặt lịch sử của hồ sơ.
 */
export const examDossierReviews = pgTable('exam_dossier_reviews', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  dossierId: uuid('dossier_id').notNull().references(() => examDossiers.id, { onDelete: 'cascade' }),
  level: integer('level').notNull(),
  reviewerId: uuid('reviewer_id').notNull(),
  decision: text('decision').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_dossier_reviews_dossier_idx').on(table.dossierId),
      check('exam_dossier_reviews_level_check', sql`${table.level} in (1, 2)`),
      check('exam_dossier_reviews_decision_check', sql`${table.decision} in ('approved', 'rejected')`),
  ]);
