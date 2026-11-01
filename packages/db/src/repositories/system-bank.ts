/**
 * Repository của kho NGÂN HÀNG HỆ THỐNG trên Kysely — hạng mục
 * nhân rộng G10 của chiến dịch chuyển tầng dữ liệu (issue #650),
 * chuyển từ repository Drizzle phía `apps/api` theo khuôn pilot kho
 * control plane (issue #640).
 *
 * Vai trò: mọi truy cập tới mười bảng của database kho ngân hàng
 * (câu hỏi hệ thống + phiên bản bất biến + liên kết YCCĐ của phiên
 * bản, sổ trung tâm đã nhập, nhật ký sự kiện append-only, và các
 * bảng của gói YCCĐ hệ thống) tập trung ở đây. Kho ngân hàng là kho
 * RIÊNG của platform — tách hẳn kho trung tâm: repository này chỉ
 * giữ handle của kho ngân hàng do tầng ứng dụng cấp qua
 * `SystemBankConnection` (adapter mỏng cấp pool), không bao giờ
 * chạm handle định tuyến theo không gian của kho trung tâm, và
 * phía trung tâm của module (bản chụp, vết sự kiện, bản cài gói)
 * nằm ở repository riêng `system-bank-centre.ts` trên handle kho
 * trung tâm. Hai kho không có transaction chung: các luồng nghiệp
 * vụ dùng cả hai kho (nhập bản chụp, cài gói) bảo đảm thứ tự ghi
 * lành tính ở tầng service, không gộp hai handle thành một.
 *
 * Khuôn hình dạng dữ liệu ở biên repository (như pilot):
 * - Bên trong, truy vấn viết trên interface schema sinh bằng
 *   codegen: tên bảng/cột giữ nguyên snake_case của database.
 * - Bên ngoài, repository trả/nhận hình dạng dòng camelCase như
 *   phía tiêu thụ đang dùng: cột được chọn bằng danh sách tường
 *   minh có bí danh (`source_question_id as sourceQuestionId`),
 *   giá trị ghi ánh xạ từng trường camelCase → snake_case. Kiểu
 *   dòng công khai khai ngay trong file này, KHÔNG import từ file
 *   schema Drizzle (file đó bị xoá ở hạng mục gỡ Drizzle).
 * - Giá trị `undefined` bị LOẠI khỏi values trước khi gọi builder
 *   (quy tắc T-4 đã đo ở pilot: dựa vào mặc định thư viện là đủ
 *   chạy nhưng repository loại tường minh để hành vi không phụ
 *   thuộc mặc định); mọi giá trị where là tham số bắt buộc.
 * - Mọi giá trị ghi vào cột jsonb đi qua helper `jsonbColumn`
 *   (serialize tường minh + `::jsonb`): driver `pg` hiểu MẢNG ở
 *   cấp cao nhất là mảng PostgreSQL chứ không phải tài liệu JSON
 *   (phát hiện của pilot).
 * - Chưa cấu hình (tầng ứng dụng chưa đặt
 *   `SYSTEM_BANK_DATABASE_URL`) thì handle là `null` và mọi thao
 *   tác ném lỗi chưa-cấu-hình mang mã `system_bank.not_configured`
 *   — ứng dụng vẫn khởi động, chỉ các đường kho ngân hàng báo 503.
 *   Package không phụ thuộc tầng ứng dụng nên hình dạng lỗi HTTP
 *   do tầng ứng dụng cấp qua hàm dựng lỗi lúc lắp ráp repository.
 */
import { sql, type InsertObject, type RawBuilder } from 'kysely';
import type { SystemBankPackage } from '@lms/contracts';
import type { SystemBankDb, SystemBankTx, SystemBankDB } from '../client';
import type { Json } from '../types/system-bank-db';

/** Handle giao dịch của kho ngân hàng — kiểu `Transaction<SystemBankDB>` của package. */
export type SbTx = SystemBankTx;
/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
export type SbDb = SystemBankDb | SystemBankTx;

/** Một dòng câu hỏi hệ thống (danh tính ổn định + metadata trạng thái). */
export interface SystemQuestionRow {
  id: string;
  /** multichoice | truefalse | shortanswer | essay. */
  qtype: string;
  /** published | withdrawn. */
  status: string;
  withdrawnReason: string | null;
  withdrawnBy: string | null;
  withdrawnAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng phiên bản nội dung bất biến của câu hệ thống (gói tự chứa + checksum). */
export interface SystemQuestionVersionRow {
  id: string;
  questionId: string;
  version: number;
  /** sha256 hex của JSON canonical của gói phiên bản. */
  checksum: string;
  /** Tài liệu gói phiên bản tự chứa (hình dạng `SystemBankPackage` của contracts). */
  package: unknown;
  createdAt: Date;
}

/** Một dòng liên kết phiên bản ↔ YCCĐ nguồn (mỗi liên kết mang mức độ nhận thức riêng). */
export interface SystemQuestionVersionOutcomeRow {
  id: string;
  versionId: string;
  outcomeId: string;
  /** biet | hieu | van_dung | van_dung_cao. */
  cognitiveLevel: string;
  createdAt: Date;
}

/** Một dòng ghi nhận một trung tâm đã nhập một câu hệ thống. */
export interface SystemQuestionImporterRow {
  id: string;
  sourceQuestionId: string;
  /** Slug của trung tâm đã nhập (định danh địa chỉ trong sổ đăng ký). */
  centreSlug: string;
  importedAt: Date;
  importedBy: string | null;
}

/** Một dòng nhật ký sự kiện append-only của kho ngân hàng. */
export interface SystemBankEventRow {
  id: string;
  /** question_withdrawn. */
  type: string;
  sourceQuestionId: string;
  payload: unknown;
  createdAt: Date;
}

/** Một dòng đợt phát hành gói YCCĐ phía platform. */
export interface SystemOutcomePackageRow {
  id: string;
  /** Định danh phiên bản gói, duy nhất toàn kho. */
  version: string;
  /** all | slug môn học. */
  scope: string;
  /** sha256 hex của JSON canonical của toàn bộ items trong gói. */
  checksum: string;
  outcomeCount: number;
  createdBy: string | null;
  createdAt: Date;
}

/** Một chương trình trong gói YCCĐ (id nguồn giữ nguyên qua bản cài). */
export interface SystemOutcomePackageCurriculumRow {
  id: string;
  packageId: string;
  curriculumId: string;
  subjectSlug: string;
  grade: number;
}

/** Một node cây nội dung trong gói YCCĐ (id và id cha giữ nguyên id nguồn). */
export interface SystemOutcomePackageNodeRow {
  id: string;
  packageId: string;
  nodeId: string;
  curriculumId: string;
  parentId: string | null;
  title: string;
  /** strand | topic | lesson. */
  kind: string;
  position: number;
  durationPeriods: number | null;
  durationPercent: number | null;
}

/** Một YCCĐ trong gói YCCĐ (id nguồn giữ nguyên qua bản cài). */
export interface SystemOutcomePackageOutcomeRow {
  id: string;
  packageId: string;
  outcomeId: string;
  nodeId: string;
  position: number;
  /** Tài liệu Tiptap của YCCĐ, nguyên trạng. */
  content: unknown;
  /** program | derived. */
  sourceKind: string;
  sourceRef: string | null;
}

/** Một dòng ánh xạ mã YCCĐ cũ → mới trong gói YCCĐ (thông tin tham chiếu). */
export interface SystemOutcomePackageMappingRow {
  id: string;
  packageId: string;
  fromOutcomeId: string;
  toOutcomeId: string;
  note: string;
}

/**
 * Lỗi ném ra khi repository bị gọi mà chưa có handle (kho ngân
 * hàng chưa được cấu hình). Package không phụ thuộc tầng ứng dụng
 * nên lỗi mang mã ổn định `system_bank.not_configured` dạng thuần;
 * tầng ứng dụng cấp hàm dựng lỗi riêng qua tham số khởi tạo của
 * repository để giữ đúng hình dạng lỗi HTTP 503 của nó.
 */
export class SystemBankNotConfiguredError extends Error {
  /** Mã lỗi ổn định mà phía tiêu thụ dùng để nhận diện trạng thái chưa cấu hình. */
  readonly code = 'system_bank.not_configured';

  constructor() {
    super('System bank database is not configured');
    this.name = 'SystemBankNotConfiguredError';
  }
}

/**
 * Bọc một giá trị jsonb thành biểu thức tham số JSON tường minh
 * (serialize + ép kiểu `::jsonb`) — khuôn duy nhất cho mọi đường
 * ghi jsonb của repository này, xem ghi chú ở đầu file về hành vi
 * mảng cấp cao nhất của driver `pg`.
 *
 * @param value - Giá trị nghiệp vụ sẽ nằm trong cột jsonb.
 * @returns Biểu thức Kysely mang chuỗi JSON đã serialize, giữ
 *   nguyên kiểu cột `T` ở tầng TypeScript.
 */
function jsonbColumn<T>(value: unknown): RawBuilder<T> {
  return sql<T>`${JSON.stringify(value)}::jsonb`;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng câu hỏi hệ thống. */
const SYSTEM_QUESTION_COLUMNS = [
  'id',
  'qtype',
  'status',
  'withdrawn_reason as withdrawnReason',
  'withdrawn_by as withdrawnBy',
  'withdrawn_at as withdrawnAt',
  'created_by as createdBy',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng phiên bản câu hệ thống. */
const SYSTEM_QUESTION_VERSION_COLUMNS = [
  'id',
  'question_id as questionId',
  'version',
  'checksum',
  'package',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng liên kết phiên bản ↔ YCCĐ. */
const SYSTEM_QUESTION_VERSION_OUTCOME_COLUMNS = [
  'id',
  'version_id as versionId',
  'outcome_id as outcomeId',
  'cognitive_level as cognitiveLevel',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng trung tâm đã nhập. */
const SYSTEM_QUESTION_IMPORTER_COLUMNS = [
  'id',
  'source_question_id as sourceQuestionId',
  'centre_slug as centreSlug',
  'imported_at as importedAt',
  'imported_by as importedBy',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng nhật ký sự kiện. */
const SYSTEM_BANK_EVENT_COLUMNS = [
  'id',
  'type',
  'source_question_id as sourceQuestionId',
  'payload',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng gói YCCĐ. */
const SYSTEM_OUTCOME_PACKAGE_COLUMNS = [
  'id',
  'version',
  'scope',
  'checksum',
  'outcome_count as outcomeCount',
  'created_by as createdBy',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng chương trình trong gói. */
const SYSTEM_OUTCOME_PACKAGE_CURRICULUM_COLUMNS = [
  'id',
  'package_id as packageId',
  'curriculum_id as curriculumId',
  'subject_slug as subjectSlug',
  'grade',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng node trong gói. */
const SYSTEM_OUTCOME_PACKAGE_NODE_COLUMNS = [
  'id',
  'package_id as packageId',
  'node_id as nodeId',
  'curriculum_id as curriculumId',
  'parent_id as parentId',
  'title',
  'kind',
  'position',
  'duration_periods as durationPeriods',
  'duration_percent as durationPercent',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng YCCĐ trong gói. */
const SYSTEM_OUTCOME_PACKAGE_OUTCOME_COLUMNS = [
  'id',
  'package_id as packageId',
  'outcome_id as outcomeId',
  'node_id as nodeId',
  'position',
  'content',
  'source_kind as sourceKind',
  'source_ref as sourceRef',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng ánh xạ trong gói. */
const SYSTEM_OUTCOME_PACKAGE_MAPPING_COLUMNS = [
  'id',
  'package_id as packageId',
  'from_outcome_id as fromOutcomeId',
  'to_outcome_id as toOutcomeId',
  'note',
] as const;

/**
 * Repository của kho ngân hàng hệ thống trên Kysely: mọi truy cập
 * tới database kho ngân hàng tập trung ở đây, qua đúng một handle
 * do tầng ứng dụng cấp. Handle `null` khi kho chưa cấu hình — mọi
 * thao tác khi đó ném lỗi do hàm dựng lỗi quyết định (mặc định
 * {@link SystemBankNotConfiguredError}).
 */
export class SystemBankRepository {
  constructor(
    private readonly handle: SystemBankDb | null,
    private readonly notConfiguredError: () => Error = () => new SystemBankNotConfiguredError(),
  ) {}

  /** Handle kho ngân hàng; ném lỗi chưa cấu hình khi kho chưa được cấu hình. */
  private db(): SystemBankDb {
    if (!this.handle) {
      throw this.notConfiguredError();
    }
    return this.handle;
  }

  /**
   * Tạo câu hỏi hệ thống kèm phiên bản đầu tiên trong MỘT
   * transaction kho ngân hàng: câu + version 1 + các liên kết
   * YCCĐ của gói. `id` vắng thì database sinh uuidv7 (insert bỏ
   * khoá chính); đường di trú truyền id gốc để giữ truy vết nguồn.
   */
  async createQuestionWithFirstVersion(input: {
    id?: string;
    qtype: string;
    createdBy: string | null;
    package: SystemBankPackage;
    checksum: string;
  }): Promise<{ question: SystemQuestionRow; version: SystemQuestionVersionRow }> {
    return this.db()
      .transaction()
      .execute(async (tx) => {
        const questionValues: InsertObject<SystemBankDB, 'system_questions'> = {
          qtype: input.qtype,
          status: 'published',
          created_by: input.createdBy,
        };
        // Id tường minh chỉ ghi khi bên gọi truyền (đường di trú);
        // vắng thì cột vắng mặt trong câu lệnh để DEFAULT uuidv7()
        // của database quyết định (quy tắc T-4 + phụ lục U).
        if (input.id !== undefined) questionValues.id = input.id;
        const [question] = await tx
          .insertInto('system_questions')
          .values(questionValues)
          .returning(SYSTEM_QUESTION_COLUMNS)
          .execute();
        if (!question) throw new Error('system bank: failed to insert system question');
        const [version] = await tx
          .insertInto('system_question_versions')
          .values({
            question_id: question.id,
            version: 1,
            checksum: input.checksum,
            package: jsonbColumn<Json>(input.package),
          })
          .returning(SYSTEM_QUESTION_VERSION_COLUMNS)
          .execute();
        if (!version) throw new Error('system bank: failed to insert system question version');
        if (input.package.outcomes.length > 0) {
          await tx
            .insertInto('system_question_version_outcomes')
            .values(
              input.package.outcomes.map((outcome) => ({
                version_id: version.id,
                outcome_id: outcome.outcomeId,
                cognitive_level: outcome.cognitiveLevel,
              })),
            )
            .execute();
        }
        return { question, version };
      });
  }

  /**
   * Tạo phiên bản mới cho câu đã có trong MỘT transaction: số
   * phiên bản = max hiện tại + 1 (unique theo cặp câu + số), kèm
   * các liên kết YCCĐ của gói mới. Nội dung phiên bản cũ không bị
   * chạm tới.
   */
  async createVersion(
    questionId: string,
    pkg: SystemBankPackage,
    checksum: string,
  ): Promise<SystemQuestionVersionRow> {
    return this.db()
      .transaction()
      .execute(async (tx) => {
        const latest = await tx
          .selectFrom('system_question_versions')
          .select(['version'])
          .where('question_id', '=', questionId)
          .orderBy('version', 'desc')
          .limit(1)
          .execute();
        const nextVersion = (latest[0]?.version ?? 0) + 1;
        const [version] = await tx
          .insertInto('system_question_versions')
          .values({
            question_id: questionId,
            version: nextVersion,
            checksum,
            package: jsonbColumn<Json>(pkg),
          })
          .returning(SYSTEM_QUESTION_VERSION_COLUMNS)
          .execute();
        if (!version) throw new Error('system bank: failed to insert system question version');
        if (pkg.outcomes.length > 0) {
          await tx
            .insertInto('system_question_version_outcomes')
            .values(
              pkg.outcomes.map((outcome) => ({
                version_id: version.id,
                outcome_id: outcome.outcomeId,
                cognitive_level: outcome.cognitiveLevel,
              })),
            )
            .execute();
        }
        return version;
      });
  }

  /** Đọc một câu hỏi hệ thống theo id (null khi không có). */
  async getQuestion(id: string): Promise<SystemQuestionRow | null> {
    const row = await this.db()
      .selectFrom('system_questions')
      .select(SYSTEM_QUESTION_COLUMNS)
      .where('id', '=', id)
      .limit(1)
      .executeTakeFirst();
    return row ?? null;
  }

  /** Đọc một phiên bản theo số phiên bản của câu (null khi không có). */
  async getVersionByNumber(questionId: string, version: number): Promise<SystemQuestionVersionRow | null> {
    const row = await this.db()
      .selectFrom('system_question_versions')
      .select(SYSTEM_QUESTION_VERSION_COLUMNS)
      .where('question_id', '=', questionId)
      .where('version', '=', version)
      .limit(1)
      .executeTakeFirst();
    return row ?? null;
  }

  /** Liệt kê mọi phiên bản của một câu theo thứ tự số tăng dần. */
  async listVersions(questionId: string): Promise<SystemQuestionVersionRow[]> {
    return this.db()
      .selectFrom('system_question_versions')
      .select(SYSTEM_QUESTION_VERSION_COLUMNS)
      .where('question_id', '=', questionId)
      .orderBy('version', 'asc')
      .execute();
  }

  /** Đọc phiên bản mới nhất của một câu (null khi câu chưa có phiên bản nào). */
  async getLatestVersion(questionId: string): Promise<SystemQuestionVersionRow | null> {
    const row = await this.db()
      .selectFrom('system_question_versions')
      .select(SYSTEM_QUESTION_VERSION_COLUMNS)
      .where('question_id', '=', questionId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Đánh dấu câu đã rút (metadata trạng thái, tách khỏi nội dung
   * các phiên bản — các phiên bản cũ vẫn đọc lại nguyên vẹn).
   */
  async markWithdrawn(
    id: string,
    input: { reason: string; by: string | null },
  ): Promise<SystemQuestionRow | null> {
    const rows = await this.db()
      .updateTable('system_questions')
      .set({
        status: 'withdrawn',
        withdrawn_reason: input.reason,
        withdrawn_by: input.by,
        withdrawn_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returning(SYSTEM_QUESTION_COLUMNS)
      .execute();
    return rows[0] ?? null;
  }

  /** Ghi một dòng sự kiện append-only vào nhật ký kho ngân hàng. */
  async recordEvent(input: {
    type: string;
    sourceQuestionId: string;
    payload: Record<string, unknown>;
  }): Promise<SystemBankEventRow> {
    const [event] = await this.db()
      .insertInto('system_bank_events')
      .values({
        type: input.type,
        source_question_id: input.sourceQuestionId,
        payload: jsonbColumn<Json>(input.payload),
      })
      .returning(SYSTEM_BANK_EVENT_COLUMNS)
      .execute();
    if (!event) throw new Error('system bank: failed to insert bank event');
    return event;
  }

  /**
   * Liệt kê các câu hỏi đang phát hành (kèm mọi phiên bản của mỗi
   * câu) phục vụ khám phá: lọc theo dạng câu ở SQL; lọc theo
   * YCCĐ/mức độ thực hiện trên tập id (kho ngân hàng ở quy mô
   * trăm–nghìn câu nên lọc trong bộ nhớ trên id rồi mới phân trang
   * là đủ và giữ phân trang đúng — không lọc sau phân trang).
   */
  async listPublishedQuestionsWithVersions(filters: {
    qtype?: string;
    outcomeId?: string;
    cognitiveLevel?: string;
  }): Promise<
    Array<{
      question: SystemQuestionRow;
      versions: SystemQuestionVersionRow[];
      outcomeLinks: Array<{ versionId: string; outcomeId: string; cognitiveLevel: string }>;
    }>
  > {
    const db = this.db();
    let questionsQuery = db
      .selectFrom('system_questions')
      .select(SYSTEM_QUESTION_COLUMNS)
      .where('status', '=', 'published');
    if (filters.qtype) {
      questionsQuery = questionsQuery.where('qtype', '=', filters.qtype);
    }
    const questions = await questionsQuery.execute();
    if (questions.length === 0) return [];
    const questionIds = questions.map((question) => question.id);
    const versions = await db
      .selectFrom('system_question_versions')
      .select(SYSTEM_QUESTION_VERSION_COLUMNS)
      .where('question_id', 'in', questionIds)
      .execute();
    const versionIds = versions.map((version) => version.id);
    const outcomeLinks: SystemQuestionVersionOutcomeRow[] =
      versionIds.length === 0
        ? []
        : await db
            .selectFrom('system_question_version_outcomes')
            .select(SYSTEM_QUESTION_VERSION_OUTCOME_COLUMNS)
            .where('version_id', 'in', versionIds)
            .execute();
    const versionsByQuestion = new Map<string, SystemQuestionVersionRow[]>();
    for (const version of versions) {
      const list = versionsByQuestion.get(version.questionId) ?? [];
      list.push(version);
      versionsByQuestion.set(version.questionId, list);
    }
    const result = questions
      .map((question) => ({
        question,
        versions: (versionsByQuestion.get(question.id) ?? []).sort((a, b) => a.version - b.version),
        outcomeLinks: outcomeLinks.filter((link) =>
          (versionsByQuestion.get(question.id) ?? []).some((version) => version.id === link.versionId),
        ),
      }))
      .filter((entry) => {
        if (!filters.outcomeId && !filters.cognitiveLevel) return true;
        return entry.outcomeLinks.some(
          (link) =>
            (!filters.outcomeId || link.outcomeId === filters.outcomeId) &&
            (!filters.cognitiveLevel || link.cognitiveLevel === filters.cognitiveLevel),
        );
      });
    return result;
  }

  /** Liệt kê định danh các câu một trung tâm đã nhập (căn cứ suy tập sự kiện thuộc diện giao cho trung tâm đó). */
  async listImportedQuestionIds(centreSlug: string): Promise<string[]> {
    const rows = await this.db()
      .selectFrom('system_question_importers')
      .select(['source_question_id as sourceQuestionId'])
      .where('centre_slug', '=', centreSlug)
      .execute();
    return rows.map((row) => row.sourceQuestionId);
  }

  /**
   * Liệt kê sự kiện của một tập câu theo thứ tự ghi nhận (cũ
   * trước, định danh làm khoá phụ cho thứ tự ổn định) — nguồn của
   * đường giao thông báo phía trung tâm.
   */
  async listEventsForQuestions(sourceQuestionIds: string[]): Promise<SystemBankEventRow[]> {
    if (sourceQuestionIds.length === 0) return [];
    return this.db()
      .selectFrom('system_bank_events')
      .select(SYSTEM_BANK_EVENT_COLUMNS)
      .where('source_question_id', 'in', sourceQuestionIds)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  /** Liệt kê slug các trung tâm đã nhập một câu (căn cứ phát thông báo khi rút câu). */
  async listImporterSlugs(sourceQuestionId: string): Promise<string[]> {
    const rows = await this.db()
      .selectFrom('system_question_importers')
      .select(['centre_slug as centreSlug'])
      .where('source_question_id', '=', sourceQuestionId)
      .execute();
    return rows.map((row) => row.centreSlug);
  }

  /**
   * Ghi nhận một trung tâm đã nhập (upsert idempotent theo cặp
   * câu + slug): insert-bỏ-qua-khi-trùng, nếu cặp đã có thì đọc
   * lại dòng hiện hữu — dùng ở lát nhập bản chụp.
   */
  async recordImporter(input: {
    sourceQuestionId: string;
    centreSlug: string;
    importedBy: string | null;
  }): Promise<SystemQuestionImporterRow> {
    const db = this.db();
    const [row] = await db
      .insertInto('system_question_importers')
      .values({
        source_question_id: input.sourceQuestionId,
        centre_slug: input.centreSlug,
        imported_by: input.importedBy,
      })
      .onConflict((oc) => oc.columns(['source_question_id', 'centre_slug']).doNothing())
      .returning(SYSTEM_QUESTION_IMPORTER_COLUMNS)
      .execute();
    if (row) return row;
    const existing = await db
      .selectFrom('system_question_importers')
      .select(SYSTEM_QUESTION_IMPORTER_COLUMNS)
      .where('source_question_id', '=', input.sourceQuestionId)
      .where('centre_slug', '=', input.centreSlug)
      .limit(1)
      .executeTakeFirst();
    if (!existing) throw new Error('system bank: failed to record importer');
    return existing;
  }

  /** Tạo một gói YCCĐ kèm toàn bộ items trong MỘT transaction kho ngân hàng. */
  async createPackageWithItems(input: {
    version: string;
    scope: string;
    checksum: string;
    outcomeCount: number;
    createdBy: string | null;
    curricula: Array<{ curriculumId: string; subjectSlug: string; grade: number }>;
    nodes: Array<{
      nodeId: string;
      curriculumId: string;
      parentId: string | null;
      title: string;
      kind: string;
      position: number;
      durationPeriods: number | null;
      durationPercent: number | null;
    }>;
    outcomes: Array<{
      outcomeId: string;
      nodeId: string;
      position: number;
      content: unknown;
      sourceKind: string;
      sourceRef: string | null;
    }>;
    mappings: Array<{ fromOutcomeId: string; toOutcomeId: string; note: string }>;
  }): Promise<SystemOutcomePackageRow> {
    return this.db()
      .transaction()
      .execute(async (tx) => {
        const [pkg] = await tx
          .insertInto('system_outcome_packages')
          .values({
            version: input.version,
            scope: input.scope,
            checksum: input.checksum,
            outcome_count: input.outcomeCount,
            created_by: input.createdBy,
          })
          .returning(SYSTEM_OUTCOME_PACKAGE_COLUMNS)
          .execute();
        if (!pkg) throw new Error('system bank: failed to create outcome package');
        // Các insert mảng đều được chặn mảng rỗng ở tầng TS như
        // đường cũ: `values([])` của Kysely là lỗi, và gói rỗng
        // từng phần là trạng thái hợp lệ của gói.
        if (input.curricula.length > 0) {
          await tx
            .insertInto('system_outcome_package_curricula')
            .values(
              input.curricula.map((curriculum) => ({
                package_id: pkg.id,
                curriculum_id: curriculum.curriculumId,
                subject_slug: curriculum.subjectSlug,
                grade: curriculum.grade,
              })),
            )
            .execute();
        }
        if (input.nodes.length > 0) {
          await tx
            .insertInto('system_outcome_package_nodes')
            .values(
              input.nodes.map((node) => ({
                package_id: pkg.id,
                node_id: node.nodeId,
                curriculum_id: node.curriculumId,
                parent_id: node.parentId,
                title: node.title,
                kind: node.kind,
                position: node.position,
                duration_periods: node.durationPeriods,
                duration_percent: node.durationPercent,
              })),
            )
            .execute();
        }
        if (input.outcomes.length > 0) {
          await tx
            .insertInto('system_outcome_package_outcomes')
            .values(
              input.outcomes.map((outcome) => ({
                package_id: pkg.id,
                outcome_id: outcome.outcomeId,
                node_id: outcome.nodeId,
                position: outcome.position,
                content: jsonbColumn<Json>(outcome.content),
                source_kind: outcome.sourceKind,
                source_ref: outcome.sourceRef,
              })),
            )
            .execute();
        }
        if (input.mappings.length > 0) {
          await tx
            .insertInto('system_outcome_package_mappings')
            .values(
              input.mappings.map((mapping) => ({
                package_id: pkg.id,
                from_outcome_id: mapping.fromOutcomeId,
                to_outcome_id: mapping.toOutcomeId,
                note: mapping.note,
              })),
            )
            .execute();
        }
        return pkg;
      });
  }

  /** Đọc một gói theo định danh phiên bản (null khi chưa có). */
  async getPackageByVersion(version: string): Promise<SystemOutcomePackageRow | null> {
    const row = await this.db()
      .selectFrom('system_outcome_packages')
      .select(SYSTEM_OUTCOME_PACKAGE_COLUMNS)
      .where('version', '=', version)
      .limit(1)
      .executeTakeFirst();
    return row ?? null;
  }

  /** Liệt kê các gói YCCĐ (mới nhất trước). */
  async listPackages(): Promise<SystemOutcomePackageRow[]> {
    return this.db()
      .selectFrom('system_outcome_packages')
      .select(SYSTEM_OUTCOME_PACKAGE_COLUMNS)
      .orderBy('created_at', 'desc')
      .execute();
  }

  /** Đọc toàn bộ items của một gói (để trung tâm cài đặt). */
  async getPackageItems(packageId: string): Promise<{
    curricula: SystemOutcomePackageCurriculumRow[];
    nodes: SystemOutcomePackageNodeRow[];
    outcomes: SystemOutcomePackageOutcomeRow[];
    mappings: SystemOutcomePackageMappingRow[];
  }> {
    const db = this.db();
    const [curricula, nodes, outcomes, mappings] = await Promise.all([
      db
        .selectFrom('system_outcome_package_curricula')
        .select(SYSTEM_OUTCOME_PACKAGE_CURRICULUM_COLUMNS)
        .where('package_id', '=', packageId)
        .execute(),
      db
        .selectFrom('system_outcome_package_nodes')
        .select(SYSTEM_OUTCOME_PACKAGE_NODE_COLUMNS)
        .where('package_id', '=', packageId)
        .execute(),
      db
        .selectFrom('system_outcome_package_outcomes')
        .select(SYSTEM_OUTCOME_PACKAGE_OUTCOME_COLUMNS)
        .where('package_id', '=', packageId)
        .execute(),
      db
        .selectFrom('system_outcome_package_mappings')
        .select(SYSTEM_OUTCOME_PACKAGE_MAPPING_COLUMNS)
        .where('package_id', '=', packageId)
        .execute(),
    ]);
    return { curricula, nodes, outcomes, mappings };
  }
}
