import { sql } from 'kysely';
import type { CentreDb, CentreTx } from '../client';
import type { EntryRow, QCategoryRow, QuestionBankRow, QuestionRow } from './questions';

/**
 * Kho dữ liệu lớp BANK của feat Ngân hàng câu hỏi chung trên Kysely
 * (issue #644, nhóm G4 của chiến dịch chuyển tầng dữ liệu sang
 * Kysely): TOÀN BỘ bề mặt của `QuestionBanksRepository` cũ ở
 * `apps/api` (Drizzle) được chuyển nguyên vẹn sang đây — bank,
 * category thuộc bank, đề xuất đóng góp, và các tra cứu tín hiệu
 * (số slot đề tham chiếu câu, đề/pin đang chứa câu, đội ngũ giáo
 * viên cho bank trường, tên hiển thị người dùng, YCCĐ theo node
 * chương trình bằng CTE đệ quy).
 *
 * Khuôn truy vấn theo đúng pilot kho control plane (issue #640) và
 * repository câu hỏi (issue #642):
 * - Cột đọc khai tường minh kèm bí danh camelCase
 *   (`'bank_id as bankId'`) dùng chung cho select và returning —
 *   KHÔNG bật CamelCasePlugin (một nguồn sự thật là database thật).
 * - Ghi qua hàm ánh xạ Insert/Update loại `undefined` tường minh
 *   từng trường (thử nghiệm T-4): `undefined` = không ghi/không
 *   đổi, `null` = ghi NULL — hai nghĩa không được lẫn; điều kiện
 *   lọc động dựng bằng cách xâu chuỗi `.where` theo khuôn T-13,
 *   không truyền `undefined` vào điều kiện.
 * - Khoá chính `uuidv7()` do database sinh (phụ lục U của kế
 *   hoạch): insert bỏ qua `id` (trừ khi phía gọi truyền tường
 *   minh, như `buildBank` cấp id trước để dựng context) và lấy
 *   dòng qua `returning`.
 * - Điểm mở giao dịch của repository là `transaction(fn)`; các
 *   phương thức nhận handle tuỳ chọn (`QuestionBanksDb` = handle
 *   thường hoặc handle giao dịch) để phía gọi lồng thao tác vào
 *   giao dịch của mình.
 * - CTE đệ quy của `listOutcomeIdsForNode` giữ NGUYÊN VĂN thân
 *   truy vấn SQL của bản Drizzle cũ, chỉ đổi đường thực thi sang
 *   `sql` của Kysely: `QueryResult.rows` đã có kiểu tường minh
 *   (MT-15) nên bỏ được lớp ép kiểu `as unknown as { rows }` của
 *   bản cũ.
 *
 * Ngoại lệ chuyển tiếp C-7 (xem CORRECTIONS.md của chiến dịch):
 * repository này giữ `insertBank` nhận handle Kysely làm điểm ghi
 * bank chuẩn phía Kysely; riêng luồng `buildBank` phía api còn mở
 * giao dịch Drizzle (bất biến nguyên tử DL-09, issue #490) vì các
 * phía còn lại trong giao dịch đó (context + override/gán vai của
 * access, dòng outbox) vẫn ở Drizzle — hai lệnh ghi của bank
 * trong luồng đó (`insertBank`, category mặc định) tạm thực thi
 * qua các điểm ghi chuyển tiếp tối thiểu phía api
 * (`QuestionBanksTransitionalRepository.insertBankTx` /
 * `insertCategoryTx`). Chủ đóng không đổi: PR merge CUỐI trong ba
 * issue #644/#651/#653 lật điểm mở giao dịch của `buildBank` sang
 * Kysely và xoá các điểm chuyển tiếp; PR này chạy trước nên KHÔNG
 * đóng C-7.
 */

export type { QuestionBankRow } from './questions';

/** Dòng `question_categories` thuộc một bank (cùng hình dạng với `QCategoryRow` của repository câu hỏi). */
export type BankCategoryRow = QCategoryRow;

/** Dòng `question_bank_contributions`. */
export interface ContributionRow {
  id: string;
  targetBankId: string;
  questionId: string;
  targetQuestionId: string | null;
  proposerId: string;
  mode: string;
  status: string;
  note: string;
  contentHash: string;
  nearDuplicateOf: string | null;
  reviewerId: string | null;
  rejectReason: string | null;
  resultQuestionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Loại món của bank (bank_kind) — 'question' là mặc định của mọi luồng QB hiện hữu. */
export const BANK_KINDS = ['question', 'exam', 'matrix'] as const;
export type BankKind = typeof BANK_KINDS[number];

/** Handle kho trung tâm mà repository chấp nhận: thường hoặc trong giao dịch. */
export type QuestionBanksDb = CentreDb | CentreTx;
/** Handle giao dịch kho trung tâm (tham số bắt buộc của các thao tác đa bước). */
export type QuestionBanksTx = CentreTx;

// ---------------------------------------------------------------------------
// Giá trị ghi (hợp đồng công khai — khớp `$inferInsert` của repository cũ)
// ---------------------------------------------------------------------------

/** Giá trị chèn `question_banks` (id do phía gọi cấp trước khi cần dựng context trỏ về bank). */
export interface NewQuestionBank {
  id?: string;
  tenantId?: string | null;
  name: string;
  bankKind?: string;
  scope: string;
  ownerId?: string | null;
  scopeRefId?: string | null;
  contextId: string;
  status?: string;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Giá trị chèn `question_bank_contributions`. */
export interface NewContribution {
  id?: string;
  targetBankId: string;
  questionId: string;
  targetQuestionId?: string | null;
  proposerId: string;
  mode?: string;
  status?: string;
  note?: string;
  contentHash?: string;
  nearDuplicateOf?: string | null;
  reviewerId?: string | null;
  rejectReason?: string | null;
  resultQuestionId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// Danh sách cột đọc: tên cột thật kèm bí danh camelCase, dùng chung cho
// select và returning của từng bảng (khuôn pilot — không CamelCasePlugin).
// ---------------------------------------------------------------------------

const QUESTION_BANK_COLUMNS = [
  'id', 'tenant_id as tenantId', 'name', 'bank_kind as bankKind', 'scope',
  'owner_id as ownerId', 'scope_ref_id as scopeRefId',
  'context_id as contextId', 'status', 'created_by as createdBy',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const BANK_CATEGORY_COLUMNS = [
  'id', 'name', 'context_id as contextId', 'bank_id as bankId', 'info',
  'parent', 'sort_order as sortOrder', 'stamp',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const CONTRIBUTION_COLUMNS = [
  'id', 'target_bank_id as targetBankId', 'question_id as questionId',
  'target_question_id as targetQuestionId', 'proposer_id as proposerId',
  'mode', 'status', 'note', 'content_hash as contentHash',
  'near_duplicate_of as nearDuplicateOf', 'reviewer_id as reviewerId',
  'reject_reason as rejectReason', 'result_question_id as resultQuestionId',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

/**
 * Cột của phép nối câu hỏi ↔ entry trong `listQuestionsWithEntryInCategories`:
 * bí danh mang tiền tố `q`/`entry` để hai bảng không đè tên cột lên
 * nhau trong dòng phẳng của Kysely; phương thức tự lắp lại hình
 * dạng lồng `{ q, entry }` của hợp đồng cũ trước khi trả.
 */
const QUESTION_WITH_ENTRY_COLUMNS = [
  'q.id as qId', 'q.category as qCategory', 'q.qtype as qQtype',
  'q.created_by as qCreatedBy', 'q.modified_by as qModifiedBy',
  'q.derived_from_question_id as qDerivedFromQuestionId',
  'q.derived_from_version_id as qDerivedFromVersionId',
  'q.derived_from_bank_id as qDerivedFromBankId',
  'q.original_author_id as qOriginalAuthorId',
  'q.source_kind as qSourceKind', 'q.source_ref as qSourceRef',
  'q.idnumber as qIdnumber', 'q.copy_count as qCopyCount',
  'q.created_at as qCreatedAt', 'q.updated_at as qUpdatedAt',
  'entry.id as entryId',
  'entry.question_category_id as entryQuestionCategoryId',
  'entry.question_id as entryQuestionId',
  'entry.latest_version as entryLatestVersion', 'entry.status as entryStatus',
  'entry.withdrawn_reason as entryWithdrawnReason',
  'entry.withdrawn_by as entryWithdrawnBy',
  'entry.withdrawn_at as entryWithdrawnAt',
  'entry.created_at as entryCreatedAt', 'entry.updated_at as entryUpdatedAt',
] as const;

// ---------------------------------------------------------------------------
// Ánh xạ ghi: loại `undefined` tường minh từng trường (T-4).
// ---------------------------------------------------------------------------

function bankInsertValues(v: NewQuestionBank) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    ...(v.tenantId !== undefined ? { tenant_id: v.tenantId } : {}),
    name: v.name,
    ...(v.bankKind !== undefined ? { bank_kind: v.bankKind } : {}),
    scope: v.scope,
    ...(v.ownerId !== undefined ? { owner_id: v.ownerId } : {}),
    ...(v.scopeRefId !== undefined ? { scope_ref_id: v.scopeRefId } : {}),
    context_id: v.contextId,
    ...(v.status !== undefined ? { status: v.status } : {}),
    created_by: v.createdBy,
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
    ...(v.updatedAt !== undefined ? { updated_at: v.updatedAt } : {}),
  };
}

function contributionInsertValues(v: NewContribution) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    target_bank_id: v.targetBankId,
    question_id: v.questionId,
    ...(v.targetQuestionId !== undefined ? { target_question_id: v.targetQuestionId } : {}),
    proposer_id: v.proposerId,
    ...(v.mode !== undefined ? { mode: v.mode } : {}),
    ...(v.status !== undefined ? { status: v.status } : {}),
    ...(v.note !== undefined ? { note: v.note } : {}),
    ...(v.contentHash !== undefined ? { content_hash: v.contentHash } : {}),
    ...(v.nearDuplicateOf !== undefined ? { near_duplicate_of: v.nearDuplicateOf } : {}),
    ...(v.reviewerId !== undefined ? { reviewer_id: v.reviewerId } : {}),
    ...(v.rejectReason !== undefined ? { reject_reason: v.rejectReason } : {}),
    ...(v.resultQuestionId !== undefined ? { result_question_id: v.resultQuestionId } : {}),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
    ...(v.updatedAt !== undefined ? { updated_at: v.updatedAt } : {}),
  };
}

/**
 * Ánh xạ patch của `question_bank_contributions`: mọi trường dòng
 * có mặt trong patch (khác `undefined`) đều được ghi như bản cũ
 * trải patch; `updated_at` luôn bị ghi đè bằng thời điểm cập nhật
 * ở cuối, đúng thứ tự trải của bản cũ.
 */
function contributionUpdateSet(patch: Partial<ContributionRow>) {
  return {
    ...(patch.id !== undefined ? { id: patch.id } : {}),
    ...(patch.targetBankId !== undefined ? { target_bank_id: patch.targetBankId } : {}),
    ...(patch.questionId !== undefined ? { question_id: patch.questionId } : {}),
    ...(patch.targetQuestionId !== undefined ? { target_question_id: patch.targetQuestionId } : {}),
    ...(patch.proposerId !== undefined ? { proposer_id: patch.proposerId } : {}),
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.contentHash !== undefined ? { content_hash: patch.contentHash } : {}),
    ...(patch.nearDuplicateOf !== undefined ? { near_duplicate_of: patch.nearDuplicateOf } : {}),
    ...(patch.reviewerId !== undefined ? { reviewer_id: patch.reviewerId } : {}),
    ...(patch.rejectReason !== undefined ? { reject_reason: patch.rejectReason } : {}),
    ...(patch.resultQuestionId !== undefined ? { result_question_id: patch.resultQuestionId } : {}),
    ...(patch.createdAt !== undefined ? { created_at: patch.createdAt } : {}),
    updated_at: new Date(),
  };
}

/** Ánh xạ patch của `question_bank_entries` — cùng quy ước trải patch + `updated_at` như trên. */
function entryUpdateSet(patch: Partial<EntryRow>) {
  return {
    ...(patch.id !== undefined ? { id: patch.id } : {}),
    ...(patch.questionCategoryId !== undefined ? { question_category_id: patch.questionCategoryId } : {}),
    ...(patch.questionId !== undefined ? { question_id: patch.questionId } : {}),
    ...(patch.latestVersion !== undefined ? { latest_version: patch.latestVersion } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.withdrawnReason !== undefined ? { withdrawn_reason: patch.withdrawnReason } : {}),
    ...(patch.withdrawnBy !== undefined ? { withdrawn_by: patch.withdrawnBy } : {}),
    ...(patch.withdrawnAt !== undefined ? { withdrawn_at: patch.withdrawnAt } : {}),
    ...(patch.createdAt !== undefined ? { created_at: patch.createdAt } : {}),
    updated_at: new Date(),
  };
}

/**
 * Kho dữ liệu lớp BANK của feat Ngân hàng câu hỏi chung (issue #70):
 * bank, category thuộc bank, đề xuất đóng góp, và các tra cứu tín
 * hiệu (use_count từ exam_slots, đội ngũ giáo viên cho bank trường,
 * tên hiển thị người dùng cho dòng ghi công).
 */
export class QuestionBanksRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Handle gốc của repository (điểm mở giao dịch + truy vấn ngoài giao dịch). */
  db(): CentreDb {
    return this.handle;
  }

  /** Mở giao dịch trên handle gốc và chạy `fn` với handle giao dịch. */
  transaction<T>(fn: (tx: QuestionBanksTx) => Promise<T>): Promise<T> {
    return this.handle.transaction().execute(fn);
  }

  // --- banks -------------------------------------------------------------------

  /** Chèn bank mới (id do service cấp trước để dựng context trỏ về bank). */
  async insertBank(v: NewQuestionBank, tx?: QuestionBanksDb): Promise<QuestionBankRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question_banks')
      .values(bankInsertValues(v))
      .returning(QUESTION_BANK_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Bank theo id. */
  async getBank(id: string, tx?: QuestionBanksDb): Promise<QuestionBankRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_banks')
      .select(QUESTION_BANK_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /**
   * Nhiều bank theo tập id trong một truy vấn (DL-04, issue #489):
   * bản theo lô của `getBank` cho phép suy bank của nhiều category;
   * thứ tự trả về không cam kết, caller tự tra theo id.
   */
  async getBanksByIds(ids: string[], tx?: QuestionBanksDb): Promise<QuestionBankRow[]> {
    if (!ids.length) return [];
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_banks')
      .select(QUESTION_BANK_COLUMNS)
      .where('id', 'in', ids)
      .execute();
  }

  /**
   * Bank trường của NHIỀU tenant trong một truy vấn (DL-04, issue
   * #489): bản theo lô của `getSchoolBank` — cùng điều kiện lọc
   * (scope school + tenant + loại món), caller lấy dòng đầu tiên theo
   * từng tenant như đường đọc lẻ lấy dòng đầu tiên của truy vấn.
   */
  async listSchoolBanksByTenantIds(tenantIds: string[], kind: BankKind = 'question', tx?: QuestionBanksDb): Promise<QuestionBankRow[]> {
    if (!tenantIds.length) return [];
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_banks')
      .select(QUESTION_BANK_COLUMNS)
      .where('scope', '=', 'school')
      .where('tenant_id', 'in', tenantIds)
      .where('bank_kind', '=', kind)
      .execute();
  }

  /**
   * Bank theo (scope, scope_ref_id) cho NHIỀU đích trong một truy
   * vấn (DL-04, issue #489): bản theo lô của `getBankByScopeRef`,
   * dùng cho phép suy bank khoá từ context của nhiều category.
   */
  async listBanksByScopeRefs(scope: string, scopeRefIds: string[], kind: BankKind = 'question', tx?: QuestionBanksDb): Promise<QuestionBankRow[]> {
    if (!scopeRefIds.length) return [];
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_banks')
      .select(QUESTION_BANK_COLUMNS)
      .where('scope', '=', scope)
      .where('scope_ref_id', 'in', scopeRefIds)
      .where('bank_kind', '=', kind)
      .execute();
  }

  /** Mọi bank (danh sách nhỏ — tầng service lọc theo quyền của từng actor). */
  async listBanks(tx?: QuestionBanksDb): Promise<QuestionBankRow[]> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_banks')
      .select(QUESTION_BANK_COLUMNS)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /** Bank cá nhân của một chủ sở hữu cho một loại món (duy nhất theo ràng buộc partial unique (owner, kind)). */
  async getPersonalBank(ownerId: string, kind: BankKind = 'question', tx?: QuestionBanksDb): Promise<QuestionBankRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_banks')
      .select(QUESTION_BANK_COLUMNS)
      .where('scope', '=', 'personal')
      .where('owner_id', '=', ownerId)
      .where('bank_kind', '=', kind)
      .executeTakeFirst();
  }

  /** Bank trường duy nhất của MỘT tenant cho một loại món (TENANT-0, #168). */
  async getSchoolBank(tenantId: string, kind: BankKind = 'question', tx?: QuestionBanksDb): Promise<QuestionBankRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_banks')
      .select(QUESTION_BANK_COLUMNS)
      .where('scope', '=', 'school')
      .where('tenant_id', '=', tenantId)
      .where('bank_kind', '=', kind)
      .executeTakeFirst();
  }

  /** Bank platform (Ngân hàng hệ thống) duy nhất cho một loại món — tenant_id NULL. */
  async getPlatformBank(kind: BankKind = 'question', tx?: QuestionBanksDb): Promise<QuestionBankRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_banks')
      .select(QUESTION_BANK_COLUMNS)
      .where('scope', '=', 'platform')
      .where('bank_kind', '=', kind)
      .executeTakeFirst();
  }

  /** Tenant sở hữu một khoá học (điểm neo tenant cho bank khoá / đề / ma trận). */
  async getCourseTenantId(courseId: string, tx?: QuestionBanksDb): Promise<string | undefined> {
    const db = tx ?? this.handle;
    const row = await db
      .selectFrom('course')
      .select('tenant_id as tenantId')
      .where('id', '=', courseId)
      .executeTakeFirst();
    return row?.tenantId;
  }

  /** Bank theo (scope, scope_ref_id, kind) — bank tổ theo cohort, bank khoá theo course. */
  async getBankByScopeRef(scope: string, scopeRefId: string, kind: BankKind = 'question', tx?: QuestionBanksDb): Promise<QuestionBankRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_banks')
      .select(QUESTION_BANK_COLUMNS)
      .where('scope', '=', scope)
      .where('scope_ref_id', '=', scopeRefId)
      .where('bank_kind', '=', kind)
      .executeTakeFirst();
  }

  // --- danh mục & câu hỏi của một bank -----------------------------------------

  /** Category thuộc bank (bank_id tường minh), thứ tự tạo. */
  async listCategoriesOfBank(bankId: string, tx?: QuestionBanksDb): Promise<BankCategoryRow[]> {
    const db = tx ?? this.handle;
    const rows = await db
      .selectFrom('question_categories')
      .select(BANK_CATEGORY_COLUMNS)
      .where('bank_id', '=', bankId)
      .execute();
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  /** Mọi câu hỏi nằm trong các category cho trước, kèm entry (trạng thái + latestVersion). */
  async listQuestionsWithEntryInCategories(categoryIds: string[], tx?: QuestionBanksDb): Promise<{ q: QuestionRow; entry: EntryRow }[]> {
    if (categoryIds.length === 0) return [];
    const db = tx ?? this.handle;
    const rows = await db
      .selectFrom('question as q')
      .innerJoin('question_bank_entries as entry', 'entry.question_id', 'q.id')
      .select(QUESTION_WITH_ENTRY_COLUMNS)
      .where('q.category', 'in', categoryIds)
      .orderBy('q.created_at')
      .orderBy('q.id')
      .execute();
    return rows.map((r) => ({
      q: {
        id: r.qId, category: r.qCategory, qtype: r.qQtype,
        createdBy: r.qCreatedBy, modifiedBy: r.qModifiedBy,
        derivedFromQuestionId: r.qDerivedFromQuestionId,
        derivedFromVersionId: r.qDerivedFromVersionId,
        derivedFromBankId: r.qDerivedFromBankId,
        originalAuthorId: r.qOriginalAuthorId, sourceKind: r.qSourceKind,
        sourceRef: r.qSourceRef, idnumber: r.qIdnumber, copyCount: r.qCopyCount,
        createdAt: r.qCreatedAt, updatedAt: r.qUpdatedAt,
      },
      entry: {
        id: r.entryId, questionCategoryId: r.entryQuestionCategoryId,
        questionId: r.entryQuestionId, latestVersion: r.entryLatestVersion,
        status: r.entryStatus, withdrawnReason: r.entryWithdrawnReason,
        withdrawnBy: r.entryWithdrawnBy, withdrawnAt: r.entryWithdrawnAt,
        createdAt: r.entryCreatedAt, updatedAt: r.entryUpdatedAt,
      },
    }));
  }

  // --- signals -------------------------------------------------------------------

  /** Số slot đề đang tham chiếu từng câu hỏi (use_count — tín hiệu QB-4; slot nay nằm trên exam version). */
  async countSlotsByQuestionIds(questionIds: string[], tx?: QuestionBanksDb): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (questionIds.length === 0) return out;
    const db = tx ?? this.handle;
    const rows = await db
      .selectFrom('exam_slots')
      .select(['question_id as questionId', sql<number>`count(*)::int`.as('n')])
      .where('question_id', 'in', questionIds)
      .groupBy('question_id')
      .execute();
    for (const r of rows) if (r.questionId) out.set(r.questionId, Number(r.n));
    return out;
  }

  /**
   * Các version đề ĐANG CHỨA một câu hỏi (truy nguồn chiều ngược
   * câu → đề): mỗi hàng là một exam version có slot trỏ tới câu —
   * một đề có nhiều version chứa câu thì có nhiều hàng, để người
   * soạn thấy đúng các bản đề bị ảnh hưởng khi sửa/rút câu.
   */
  async listContainingExams(questionId: string, tx?: QuestionBanksDb): Promise<{ examId: string; examVersionId: string; version: number; name: string }[]> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('exam_slots')
      .innerJoin('exam_versions', 'exam_versions.id', 'exam_slots.exam_version_id')
      .select([
        'exam_versions.exam_id as examId', 'exam_versions.id as examVersionId',
        'exam_versions.version as version', 'exam_versions.name as name',
      ])
      .where('exam_slots.question_id', '=', questionId)
      .orderBy('exam_versions.created_at')
      .orderBy('exam_versions.id')
      .execute();
  }

  /** Các LẦN GHIM đang dùng một câu hỏi (distinct, qua exam version của pin) — phục vụ rút câu + cấm xoá vật lý. */
  async listPinIdsUsingQuestion(questionId: string, tx?: QuestionBanksDb): Promise<string[]> {
    const db = tx ?? this.handle;
    const rows = await db
      .selectFrom('exam_slots')
      .innerJoin('exam_versions', 'exam_versions.id', 'exam_slots.exam_version_id')
      .innerJoin('exam_pins', 'exam_pins.exam_version_id', 'exam_versions.id')
      .distinct()
      .select('exam_pins.id as pinId')
      .where('exam_slots.question_id', '=', questionId)
      .execute();
    return rows.map((r) => r.pinId);
  }

  /** Số question attempt đã tồn tại cho một câu hỏi (cấm xoá vật lý khi > 0). */
  async countAttemptsOfQuestion(questionId: string, tx?: QuestionBanksDb): Promise<number> {
    const db = tx ?? this.handle;
    const row = await db
      .selectFrom('question_attempts')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('question_id', '=', questionId)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  // --- people ----------------------------------------------------------------------

  /** Tên hiển thị của người dùng (cho dòng ghi công + bộ lọc tác giả). */
  async getUserDisplayNames(userIds: string[], tx?: QuestionBanksDb): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(userIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const db = tx ?? this.handle;
    const rows = await db
      .selectFrom('users')
      .select(['id', 'first_name as firstName', 'last_name as lastName', 'username'])
      .where('id', 'in', ids)
      .execute();
    for (const r of rows) {
      const name = `${r.firstName} ${r.lastName}`.trim();
      out.set(r.id, name || r.username);
    }
    return out;
  }

  /**
   * Id mọi người dùng đang giữ ít nhất một role thuộc nhóm archetype cho
   * trước ở bất kỳ context nào — đội ngũ giáo viên cho bank trường.
   */
  async listUserIdsWithArchetypes(archetypes: string[], tx?: QuestionBanksDb): Promise<string[]> {
    const db = tx ?? this.handle;
    const rows = await db
      .selectFrom('role_assignments')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .distinct()
      .select('role_assignments.user_id as userId')
      .where('role.archetype', 'in', archetypes)
      .execute();
    return rows.map((r) => r.userId);
  }

  /** Mọi YCCĐ thuộc một node chương trình và các node con cháu của nó (CTE đệ quy trên cây node) — phục vụ lọc khám phá theo node (QB-4). */
  async listOutcomeIdsForNode(nodeId: string, tx?: QuestionBanksDb): Promise<string[]> {
    const db = tx ?? this.handle;
    const result = await sql<{ id: string }>`
      WITH RECURSIVE tree AS (
        SELECT id FROM curriculum_nodes WHERE id = ${nodeId}
        UNION ALL
        SELECT n.id FROM curriculum_nodes n JOIN tree t ON n.parent_id = t.id
      )
      SELECT id FROM learning_outcomes WHERE node_id IN (SELECT id FROM tree)
    `.execute(db);
    return result.rows.map((r) => r.id);
  }

  /** Kiểm chứng nhanh một node chương trình có tồn tại (lọc khám phá theo node). */
  async outcomeIdsOfNode(nodeId: string, tx?: QuestionBanksDb): Promise<string[]> {
    const db = tx ?? this.handle;
    const rows = await db
      .selectFrom('learning_outcomes')
      .select('id')
      .where('node_id', '=', nodeId)
      .execute();
    return rows.map((r) => r.id);
  }

  // --- contributions -----------------------------------------------------------------

  /** Chèn đề xuất đóng góp. */
  async insertContribution(v: NewContribution, tx?: QuestionBanksDb): Promise<ContributionRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question_bank_contributions')
      .values(contributionInsertValues(v))
      .returning(CONTRIBUTION_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Đề xuất theo id. */
  async getContribution(id: string, tx?: QuestionBanksDb): Promise<ContributionRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_bank_contributions')
      .select(CONTRIBUTION_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Đề xuất thuộc một bank đích, lọc tuỳ chọn theo trạng thái/người đề xuất. */
  async listContributions(filter: { targetBankId: string; status?: string; proposerId?: string }, tx?: QuestionBanksDb): Promise<ContributionRow[]> {
    const db = tx ?? this.handle;
    let query = db
      .selectFrom('question_bank_contributions')
      .select(CONTRIBUTION_COLUMNS)
      .where('target_bank_id', '=', filter.targetBankId);
    if (filter.status !== undefined) query = query.where('status', '=', filter.status);
    if (filter.proposerId !== undefined) query = query.where('proposer_id', '=', filter.proposerId);
    return query
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /** Cập nhật đề xuất (duyệt/từ chối). */
  async updateContribution(id: string, patch: Partial<ContributionRow>, tx?: QuestionBanksDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .updateTable('question_bank_contributions')
      .set(contributionUpdateSet(patch))
      .where('id', '=', id)
      .execute();
  }

  // --- misc ---------------------------------------------------------------------------

  /** Xoá vật lý một câu hỏi — FK cascade dọn entry/version/answers/options/links (chỉ gọi sau khi qua guard slot/attempt). */
  async deleteQuestionRow(questionId: string, tx?: QuestionBanksDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .deleteFrom('question')
      .where('id', '=', questionId)
      .execute();
  }

  /** Cập nhật entry (trạng thái rút câu QB-3). */
  async updateEntry(id: string, patch: Partial<EntryRow>, tx?: QuestionBanksDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .updateTable('question_bank_entries')
      .set(entryUpdateSet(patch))
      .where('id', '=', id)
      .execute();
  }
}
