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
import { examMatrices, examMatrixCells } from '../quiz/schema';

/** Một ô trong bản chụp cấu trúc của đề recipe (EB-2): tiêu chí rút + số câu + điểm của ô tại đúng matrix version đã ghim. */
export interface RecipeCellSpec {
  /** Ô nguồn trong exam_matrix_cells (truy vết + điểm neo swap-cùng-ô khi materialize). */
  sourceCellId: string;
  learningOutcomeId: string;
  cognitiveLevel: string;
  qtype: string;
  /** Số ĐƠN VỊ rút (ô truefalse đếm theo chùm 4 câu). */
  questionCount: number;
  cellScore: number;
  minutes: number | null;
  tfScale: number[] | null;
}

/**
 * Công thức của một đề RECIPE tại một paper version (EB-2, điểm A.1/
 * D.2): cấu trúc ô CHỤP CỨNG tại thời điểm sinh đề từ matrix version
 * đã ghim — ma trận bị sửa về sau (version mới) không đổi cấu trúc
 * của recipe này; bộ câu thì rút lại tại từng lần triển khai/attempt
 * theo pool của các ô nguồn.
 */
export interface RecipeSpec {
  drawMode: 'fixed' | 'per_student';
  /** Scope của bank nguồn của ma trận tại thời điểm sinh đề (pool rút theo scope này lúc triển khai). */
  sourceBankScope: string | null;
  sourceBankId: string | null;
  cells: RecipeCellSpec[];
}

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
 * kind: 'snapshot' (bản chụp câu cụ thể — lát EB-1) | 'recipe' (công
 * thức theo ma trận — lát EB-2, chỉ khai báo enum ở lát này).
 * status: draft / ready / hidden như câu hỏi — hidden là rút khỏi ngân
 * hàng (không khám phá/thêm mới được; quiz đang triển khai KHÔNG vỡ vì
 * deploy đã chụp slots sang quiz_slots).
 */
export const examPapers = pgTable('exam_papers', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  bankId: uuid('bank_id').notNull().references(() => questionBanks.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('snapshot'),
  status: text('status').notNull().default('draft'),
  /**
   * Truy vết copy (như question.derived_from_*): đề nguồn đã copy +
   * ma trận nguồn (khi đề sinh từ ma trận) + tác giả gốc giữ nguyên qua
   * các đời copy (ghi công không tắt được). Con trỏ mềm như các con trỏ
   * truy vết xuyên module khác.
   */
  derivedFromPaperId: uuid('derived_from_paper_id'),
  derivedFromMatrixId: uuid('derived_from_matrix_id'),
  originalAuthorId: uuid('original_author_id'),
  createdBy: uuid('created_by').notNull(),
  /** Số version mới nhất (= số version hiện có); nội dung sống ở exam_paper_versions. */
  latestVersion: integer('latest_version').notNull().default(1),
  /** Số lượt đề này đã được copy đi (tín hiệu dùng thật như question.copy_count). */
  copyCount: integer('copy_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_papers_bank_id_idx').on(table.bankId),
      index('exam_papers_status_idx').on(table.status),
      index('exam_papers_created_by_idx').on(table.createdBy),
      index('exam_papers_derived_from_idx').on(table.derivedFromPaperId),
      check('exam_papers_kind_check', sql`${table.kind} in ('snapshot', 'recipe')`),
      check('exam_papers_status_check', sql`${table.status} in ('draft', 'ready', 'hidden')`),
  ]);

/**
 * Nội dung của đề TẠI MỘT THỜI ĐIỂM (như question_versions): metadata
 * hiển thị/soạn thảo + tham chiếu ma trận nguồn kèm số version của ma
 * trận lúc chụp (matrix_version). Slots của version nằm ở
 * exam_paper_slots. Version là BẤT BIẾN sau khi tạo — mọi sửa đổi đi qua
 * version mới.
 */
export const examPaperVersions = pgTable('exam_paper_versions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  paperId: uuid('paper_id').notNull().references(() => examPapers.id, { onDelete: 'cascade' }),
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
   * Công thức recipe (EB-2): chỉ có ở paper version của đề kind=
   * 'recipe' (và bản chụp snapshot materialize từ recipe — giữ để báo
   * cáo lệch tỉ lệ theo ô + swap-cùng-ô biết pool nguồn). Snapshot
   * thường: null.
   */
  recipeSpec: jsonb('recipe_spec').$type<RecipeSpec>(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_paper_versions_paper_idx').on(table.paperId),
      index('exam_paper_versions_subject_idx').on(table.subjectId),
      index('exam_paper_versions_matrix_idx').on(table.matrixId),
      unique('exam_paper_versions_paper_version_unique').on(table.paperId, table.version),
      check('exam_paper_versions_exam_kind_check', sql`${table.examKind} is null or ${table.examKind} in ('regular', 'midterm', 'final', 'mock', 'practice')`),
  ]);

/**
 * Một vị trí câu trong một paper version (đúng khuôn quiz_slots của
 * QB-3): question_id + version câu GHIM CỨNG (pinned_version_id +
 * pinned_version_number để hiển thị) — đề snapshot bất biến tuyệt đối:
 * câu nguồn có version mới cũng không đổi đề đã chụp. section là tên
 * phần (chia phần trong đề); cluster_id gom các slot truefalse cùng
 * chùm Đ–S như quiz_slots.
 */
export const examPaperSlots = pgTable('exam_paper_slots', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  paperVersionId: uuid('paper_version_id').notNull().references(() => examPaperVersions.id, { onDelete: 'cascade' }),
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
      index('exam_paper_slots_version_idx').on(table.paperVersionId),
      index('exam_paper_slots_question_idx').on(table.questionId),
      index('exam_paper_slots_cluster_idx').on(table.clusterId),
      unique('exam_paper_slots_version_position_unique').on(table.paperVersionId, table.position),
  ]);

/**
 * Đề xuất đóng góp một ĐỀ vào bank chung (khuôn QB-4 của câu hỏi, đơn
 * vị duyệt là TOÀN BỘ đề): một dòng = một đề xuất đưa đề (ở bank nguồn)
 * vào bank đích (tổ/trường/khoá). Chỉ mode 'new' ở EB-1: duyệt đạt thì
 * COPY đề vào bank đích bằng cơ chế deep copy (danh tính mới,
 * derived_from trỏ về đề gốc, slots giữ nguyên question + pinned
 * version). content_hash tính trên cấu trúc version hiện tại của đề
 * (danh sách question + pinned version + max_mark đã sắp) phục vụ
 * chống trùng hoàn toàn/gần trùng trong bank đích.
 */
export const examPaperContributions = pgTable('exam_paper_contributions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  paperId: uuid('paper_id').notNull().references(() => examPapers.id, { onDelete: 'cascade' }),
  targetBankId: uuid('target_bank_id').notNull().references(() => questionBanks.id, { onDelete: 'cascade' }),
  proposerId: uuid('proposer_id').notNull(),
  note: text('note').notNull().default(''),
  status: text('status').notNull().default('pending'),
  contentHash: text('content_hash').notNull().default(''),
  nearDuplicateOf: uuid('near_duplicate_of'),
  rejectReason: text('reject_reason'),
  reviewerId: uuid('reviewer_id'),
  resultPaperId: uuid('result_paper_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_paper_contributions_target_bank_idx').on(table.targetBankId),
      index('exam_paper_contributions_paper_idx').on(table.paperId),
      index('exam_paper_contributions_proposer_idx').on(table.proposerId),
      index('exam_paper_contributions_status_idx').on(table.status),
  ]);

/** Một biến thể mã đề của một lần triển khai: mã in trên đề + seed hoán vị thứ tự câu/đáp án khi in. */
export interface ExamVariant {
  code: string;
  seed: number;
}

/**
 * Một LẦN TRIỂN KHAI một paper version vào một quiz (EB-2, điểm E-5):
 * MÃ ĐỀ sống ở tầng này, KHÔNG ở đề — cùng một đề triển khai nhiều
 * lần/mã là các dòng khác nhau. variants: danh sách mã 001, 002… kèm
 * seed hoán vị của từng mã (in đề snapshot theo mã thì dùng đúng seed
 * đó để thứ tự in khớp với bản chấm). quiz_id là con trỏ mềm (bảng
 * quizzes thuộc module quiz; xoá quiz không được vỡ sổ triển khai).
 */
export const examDeployments = pgTable('exam_deployments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  paperId: uuid('paper_id').notNull().references(() => examPapers.id, { onDelete: 'cascade' }),
  paperVersionId: uuid('paper_version_id').notNull().references(() => examPaperVersions.id, { onDelete: 'cascade' }),
  quizId: uuid('quiz_id').notNull(),
  variantCount: integer('variant_count').notNull().default(1),
  variants: jsonb('variants').$type<ExamVariant[]>().notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_deployments_paper_idx').on(table.paperId),
      index('exam_deployments_quiz_idx').on(table.quizId),
  ]);
