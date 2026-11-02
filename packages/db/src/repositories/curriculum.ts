/**
 * Repository của cụm CHƯƠNG TRÌNH trên Kysely — chuyển đổi từ
 * repository Drizzle của module curriculum phía `apps/api` (issue
 * #646, nhóm G6 của chiến dịch chuyển tầng dữ liệu sang Kysely).
 *
 * Vai trò: mọi truy cập tới năm bảng chương trình của kho trung tâm
 * (subjects → curricula → curriculum_nodes dạng cây →
 * learning_outcomes, và sổ đăng ký nạp dữ liệu chuẩn
 * curriculum_program_records) tập trung ở đây, cộng các truy vấn đếm
 * liên kết chỉ-đọc sang bảng của cụm câu hỏi/SGK (question,
 * question_bank_entries, question_learning_outcomes, book_mappings,
 * exam_matrix_cells) mà repository cũ đã thực hiện. Repository
 * không chứa luật nghiệp vụ — gác quyền, thuật toán diff của
 * importer và giao dịch nhiều bảng nằm ở tầng service phía ứng
 * dụng; repository chỉ nhận handle (instance gốc hoặc transaction
 * đang mở) để phía gọi ghép nhiều thao tác vào một transaction khi
 * cần.
 *
 * Khuôn hình dạng dữ liệu ở biên repository (theo playbook chuyển
 * đổi của package, đúc từ pilot kho control plane):
 * - Bên trong repository, truy vấn viết trên interface schema sinh
 *   bằng codegen: tên bảng/cột giữ nguyên snake_case của database.
 * - Bên ngoài, repository trả/nhận các hình dạng dòng camelCase như
 *   phía tiêu thụ đang dùng (khớp `$inferSelect`/`$inferInsert` của
 *   repository Drizzle cũ): cột được chọn bằng danh sách tường minh
 *   có bí danh (`context_id as contextId`), giá trị ghi được ánh xạ
 *   từng trường từ camelCase sang snake_case ở các hàm
 *   `*InsertValues`/`*UpdateSet` trong file này. Kiểu dòng công
 *   khai khai ngay trong file này, không import từ file schema
 *   Drizzle (các file schema đó bị xoá ở hạng mục gỡ Drizzle).
 * - Giá trị `undefined` bị LOẠI khỏi values/set trước khi gọi
 *   builder (thử nghiệm T-4 đã chốt ở pilot: `undefined` lọt vào
 *   mệnh đề WHERE sẽ lặng lẽ thành so sánh với NULL và trả 0 dòng —
 *   vì vậy mọi giá trị where trong repository đều là tham số bắt
 *   buộc).
 * - Cột jsonb khi ghi (`learning_outcomes.content`,
 *   `curriculum_program_records.source`) đi qua helper serialize
 *   tường minh + ép kiểu `::jsonb` ({@link jsonbValue}): driver
 *   `pg` hiểu MẢNG ở cấp cao nhất là mảng PostgreSQL thay vì JSON.
 * - Ghép điều kiện động (thử nghiệm T-13 đã chốt): mảng điều kiện
 *   dựng trong callback `where` rồi gộp bằng `eb.and(...)` /
 *   `eb.or(...)`; cấm chép nguyên khuôn `where(undefined)` của
 *   Drizzle.
 * - Chiếu toàn bảng trong select (thử nghiệm T-14, chốt tại issue
 *   này): Kysely không có hình chiếu lồng "cả bảng dưới một khoá"
 *   như `select({ outcome: learningOutcomes, … })` của Drizzle —
 *   tương đương là chọn tường minh từng cột của bảng với bí danh
 *   tiền tố riêng rồi LỒNG LẠI thành object ở biên repository;
 *   hình dạng trả ra khớp sâu với hình dạng cũ (ca
 *   {@link CurriculumRepository.searchOutcomes}, có spec tích hợp
 *   khoá hình dạng).
 */
import { sql, type InsertObject, type RawBuilder, type UpdateObject } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';
import type { LearningOutcomeDoc } from '../curriculum.schema';
import type { JsonValue } from '../types/centre-db';

/** Handle giao dịch của kho trung tâm — kiểu `Transaction<CentreDB>` của package. */
export type CurriculumTx = CentreTx;
/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
type Db = CentreDb | CentreTx;

/** Một dòng môn học (hình dạng camelCase phía tiêu thụ dùng, khớp `$inferSelect` cũ). */
export interface SubjectRow {
  id: string;
  contextId: string;
  name: string;
  slug: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một môn học mới (khớp `$inferInsert` cũ: trường có default ở DB thì tuỳ chọn). */
export interface NewSubject {
  id?: string;
  contextId: string;
  name: string;
  slug: string;
  position?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Một dòng chương trình của một môn ở một khối lớp. */
export interface CurriculumRow {
  id: string;
  subjectId: string;
  grade: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một chương trình mới. */
export interface NewCurriculum {
  id?: string;
  subjectId: string;
  grade: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Một node trong cây nội dung của một chương trình. */
export interface CurriculumNodeRow {
  id: string;
  curriculumId: string;
  parentId: string | null;
  title: string;
  kind: string;
  position: number;
  durationPeriods: number | null;
  durationPercent: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một node nội dung mới. */
export interface NewCurriculumNode {
  id?: string;
  curriculumId: string;
  parentId?: string | null;
  title: string;
  kind?: string;
  position?: number;
  durationPeriods?: number | null;
  durationPercent?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Một dòng yêu cầu cần đạt (YCCĐ). `content` là tài liệu Tiptap
 * (jsonb có override kiểu `LearningOutcomeDoc` ở codegen — cùng
 * hình dạng với tài liệu dataset phía ứng dụng).
 */
export interface LearningOutcomeRow {
  id: string;
  tenantId: string | null;
  nodeId: string;
  content: LearningOutcomeDoc;
  position: number;
  sourceKind: string;
  sourceRef: string | null;
  derivedFromId: string | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một YCCĐ mới. */
export interface NewLearningOutcome {
  id?: string;
  tenantId?: string | null;
  nodeId: string;
  content: LearningOutcomeDoc;
  position?: number;
  sourceKind?: string;
  sourceRef?: string | null;
  derivedFromId?: string | null;
  retiredAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Một dòng sổ đăng ký nạp dữ liệu chương trình chuẩn; `source` là đối tượng truy vết nguồn của dataset (jsonb không gắn kiểu nghiệp vụ). */
export interface ProgramRecordRow {
  id: string;
  datasetKey: string;
  recordId: string;
  subjectId: string;
  curriculumId: string;
  nodeId: string;
  contentHash: string;
  source: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một dòng sổ đăng ký mới. */
export interface NewProgramRecord {
  id?: string;
  datasetKey: string;
  recordId: string;
  subjectId: string;
  curriculumId: string;
  nodeId: string;
  contentHash: string;
  source: unknown;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Bọc một giá trị jsonb thành biểu thức tham số JSON tường minh
 * (khuôn của pilot): serialize + ép kiểu `::jsonb` cho MỌI giá trị
 * jsonb khi ghi, vì driver `pg` hiểu mảng ở cấp cao nhất là mảng
 * PostgreSQL và cột jsonb sẽ lỗi `invalid input syntax for type
 * json`.
 *
 * @param value - Giá trị nghiệp vụ sẽ nằm trong cột jsonb.
 * @returns Biểu thức Kysely mang chuỗi JSON đã serialize, giữ
 *   nguyên kiểu `T` ở tầng TypeScript.
 */
function jsonbValue<T>(value: T): RawBuilder<T> {
  return sql<T>`${JSON.stringify(value)}::jsonb`;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng subjects (dùng cho cả select lẫn returning). */
const SUBJECT_COLUMNS = [
  'id',
  'context_id as contextId',
  'name',
  'slug',
  'position',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng curricula. */
const CURRICULUM_COLUMNS = [
  'id',
  'subject_id as subjectId',
  'grade',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng curriculum_nodes. */
const CURRICULUM_NODE_COLUMNS = [
  'id',
  'curriculum_id as curriculumId',
  'parent_id as parentId',
  'title',
  'kind',
  'position',
  'duration_periods as durationPeriods',
  'duration_percent as durationPercent',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng learning_outcomes. */
const LEARNING_OUTCOME_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'node_id as nodeId',
  'content',
  'position',
  'source_kind as sourceKind',
  'source_ref as sourceRef',
  'derived_from_id as derivedFromId',
  'retired_at as retiredAt',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng curriculum_program_records. */
const PROGRAM_RECORD_COLUMNS = [
  'id',
  'dataset_key as datasetKey',
  'record_id as recordId',
  'subject_id as subjectId',
  'curriculum_id as curriculumId',
  'node_id as nodeId',
  'content_hash as contentHash',
  'source',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/**
 * Ánh xạ dữ kiện ghi môn học (camelCase) sang values insert
 * (snake_case), LOẠI mọi trường mang `undefined` (quy tắc T-4:
 * trường vắng mặt để default của database quyết định).
 */
function subjectInsertValues(values: NewSubject): InsertObject<CentreDB, 'subjects'> {
  const row: InsertObject<CentreDB, 'subjects'> = {
    context_id: values.contextId,
    name: values.name,
    slug: values.slug,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.position !== undefined) row.position = values.position;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ một patch môn học sang set update (snake_case), loại `undefined` từng trường (quy tắc T-4). */
function subjectUpdateSet(patch: Partial<NewSubject>): UpdateObject<CentreDB, 'subjects'> {
  const set: UpdateObject<CentreDB, 'subjects'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.contextId !== undefined) set.context_id = patch.contextId;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.slug !== undefined) set.slug = patch.slug;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;
  return set;
}

/** Ánh xạ dữ kiện ghi chương trình sang values insert (snake_case), loại `undefined` (quy tắc T-4). */
function curriculumInsertValues(values: NewCurriculum): InsertObject<CentreDB, 'curricula'> {
  const row: InsertObject<CentreDB, 'curricula'> = {
    subject_id: values.subjectId,
    grade: values.grade,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ một patch chương trình sang set update (snake_case), loại `undefined` từng trường (quy tắc T-4). */
function curriculumUpdateSet(patch: Partial<NewCurriculum>): UpdateObject<CentreDB, 'curricula'> {
  const set: UpdateObject<CentreDB, 'curricula'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.subjectId !== undefined) set.subject_id = patch.subjectId;
  if (patch.grade !== undefined) set.grade = patch.grade;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;
  return set;
}

/** Ánh xạ dữ kiện ghi node nội dung sang values insert (snake_case), loại `undefined` (quy tắc T-4). */
function curriculumNodeInsertValues(values: NewCurriculumNode): InsertObject<CentreDB, 'curriculum_nodes'> {
  const row: InsertObject<CentreDB, 'curriculum_nodes'> = {
    curriculum_id: values.curriculumId,
    title: values.title,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.parentId !== undefined) row.parent_id = values.parentId;
  if (values.kind !== undefined) row.kind = values.kind;
  if (values.position !== undefined) row.position = values.position;
  if (values.durationPeriods !== undefined) row.duration_periods = values.durationPeriods;
  if (values.durationPercent !== undefined) row.duration_percent = values.durationPercent;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ một patch node nội dung sang set update (snake_case), loại `undefined` từng trường (quy tắc T-4). */
function curriculumNodeUpdateSet(patch: Partial<NewCurriculumNode>): UpdateObject<CentreDB, 'curriculum_nodes'> {
  const set: UpdateObject<CentreDB, 'curriculum_nodes'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.curriculumId !== undefined) set.curriculum_id = patch.curriculumId;
  if (patch.parentId !== undefined) set.parent_id = patch.parentId;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.durationPeriods !== undefined) set.duration_periods = patch.durationPeriods;
  if (patch.durationPercent !== undefined) set.duration_percent = patch.durationPercent;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;
  return set;
}

/**
 * Ánh xạ dữ kiện ghi YCCĐ sang values insert (snake_case), loại
 * `undefined` (quy tắc T-4); cột `content` là jsonb nên đi qua
 * {@link jsonbValue}.
 */
function learningOutcomeInsertValues(values: NewLearningOutcome): InsertObject<CentreDB, 'learning_outcomes'> {
  const row: InsertObject<CentreDB, 'learning_outcomes'> = {
    node_id: values.nodeId,
    content: jsonbValue(values.content),
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.tenantId !== undefined) row.tenant_id = values.tenantId;
  if (values.position !== undefined) row.position = values.position;
  if (values.sourceKind !== undefined) row.source_kind = values.sourceKind;
  if (values.sourceRef !== undefined) row.source_ref = values.sourceRef;
  if (values.derivedFromId !== undefined) row.derived_from_id = values.derivedFromId;
  if (values.retiredAt !== undefined) row.retired_at = values.retiredAt;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ một patch YCCĐ sang set update (snake_case), loại `undefined` từng trường; `content` qua {@link jsonbValue}. */
function learningOutcomeUpdateSet(patch: Partial<NewLearningOutcome>): UpdateObject<CentreDB, 'learning_outcomes'> {
  const set: UpdateObject<CentreDB, 'learning_outcomes'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.tenantId !== undefined) set.tenant_id = patch.tenantId;
  if (patch.nodeId !== undefined) set.node_id = patch.nodeId;
  if (patch.content !== undefined) set.content = jsonbValue(patch.content);
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.sourceKind !== undefined) set.source_kind = patch.sourceKind;
  if (patch.sourceRef !== undefined) set.source_ref = patch.sourceRef;
  if (patch.derivedFromId !== undefined) set.derived_from_id = patch.derivedFromId;
  if (patch.retiredAt !== undefined) set.retired_at = patch.retiredAt;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;
  return set;
}

/**
 * Ánh xạ dữ kiện ghi dòng sổ đăng ký sang values insert
 * (snake_case), loại `undefined` (quy tắc T-4); cột `source` là
 * jsonb nên đi qua {@link jsonbValue}.
 */
function programRecordInsertValues(values: NewProgramRecord): InsertObject<CentreDB, 'curriculum_program_records'> {
  const row: InsertObject<CentreDB, 'curriculum_program_records'> = {
    dataset_key: values.datasetKey,
    record_id: values.recordId,
    subject_id: values.subjectId,
    curriculum_id: values.curriculumId,
    node_id: values.nodeId,
    content_hash: values.contentHash,
    source: jsonbValue<JsonValue>(values.source as JsonValue),
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ một patch dòng sổ đăng ký sang set update (snake_case), loại `undefined` từng trường; `source` qua {@link jsonbValue}. */
function programRecordUpdateSet(patch: Partial<NewProgramRecord>): UpdateObject<CentreDB, 'curriculum_program_records'> {
  const set: UpdateObject<CentreDB, 'curriculum_program_records'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.datasetKey !== undefined) set.dataset_key = patch.datasetKey;
  if (patch.recordId !== undefined) set.record_id = patch.recordId;
  if (patch.subjectId !== undefined) set.subject_id = patch.subjectId;
  if (patch.curriculumId !== undefined) set.curriculum_id = patch.curriculumId;
  if (patch.nodeId !== undefined) set.node_id = patch.nodeId;
  if (patch.contentHash !== undefined) set.content_hash = patch.contentHash;
  if (patch.source !== undefined) set.source = jsonbValue<JsonValue>(patch.source as JsonValue);
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;
  return set;
}

/**
 * Kho dữ liệu Curriculum: subjects → curricula → curriculum_nodes
 * (cây) → learning_outcomes. Thứ tự hiển thị luôn là position tăng
 * dần, rồi thời gian tạo để ổn định khi trùng position.
 */
export class CurriculumRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Instance gốc của repository. */
  private db(): CentreDb {
    return this.handle;
  }

  /** Handle DB gốc — tầng service mở transaction khi cần ghi nguyên tử nhiều bảng (nạp dataset). */
  get dbHandle(): CentreDb {
    return this.db();
  }

  /** Mở một transaction trên kho trung tâm và chạy `fn` với handle giao dịch. */
  async transaction<T>(fn: (tx: CurriculumTx) => Promise<T>): Promise<T> {
    return this.db().transaction().execute(fn);
  }

  // --- subjects -------------------------------------------------------------

  /** Chèn môn học. */
  async insertSubject(v: NewSubject, db: Db = this.db()): Promise<SubjectRow> {
    const rows = await db
      .insertInto('subjects')
      .values(subjectInsertValues(v))
      .returning(SUBJECT_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy môn học theo slug (định danh đường dẫn duy nhất toàn hệ). */
  async getSubjectBySlug(slug: string, db: Db = this.db()): Promise<SubjectRow | undefined> {
    const row = await db
      .selectFrom('subjects')
      .select(SUBJECT_COLUMNS)
      .where('slug', '=', slug)
      .executeTakeFirst();
    return row;
  }

  /** Lấy môn học theo id. */
  async getSubject(id: string, db: Db = this.db()): Promise<SubjectRow | undefined> {
    const row = await db
      .selectFrom('subjects')
      .select(SUBJECT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row;
  }

  /** Liệt kê môn học trong một context. */
  async listSubjects(contextId: string, db: Db = this.db()): Promise<SubjectRow[]> {
    return db
      .selectFrom('subjects')
      .select(SUBJECT_COLUMNS)
      .where('context_id', '=', contextId)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** Sửa môn học (đã lọc trường ở tầng service). */
  async updateSubject(id: string, v: Partial<NewSubject>, db: Db = this.db()): Promise<void> {
    await db
      .updateTable('subjects')
      .set({ ...subjectUpdateSet(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá môn học; curricula/nodes/outcomes con bị xoá theo cascade. */
  async deleteSubject(id: string, db: Db = this.db()): Promise<void> {
    await db.deleteFrom('subjects').where('id', '=', id).execute();
  }

  // --- curricula --------------------------------------------------------------

  /** Chèn chương trình (môn + khối). */
  async insertCurriculum(v: NewCurriculum, db: Db = this.db()): Promise<CurriculumRow> {
    const rows = await db
      .insertInto('curricula')
      .values(curriculumInsertValues(v))
      .returning(CURRICULUM_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy chương trình theo id. */
  async getCurriculum(id: string, db: Db = this.db()): Promise<CurriculumRow | undefined> {
    const row = await db
      .selectFrom('curricula')
      .select(CURRICULUM_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row;
  }

  /** Liệt kê chương trình của một môn, theo khối tăng dần. */
  async listCurricula(subjectId: string, db: Db = this.db()): Promise<CurriculumRow[]> {
    return db
      .selectFrom('curricula')
      .select(CURRICULUM_COLUMNS)
      .where('subject_id', '=', subjectId)
      .orderBy('grade', 'asc')
      .execute();
  }

  /** Sửa chương trình. */
  async updateCurriculum(id: string, v: Partial<NewCurriculum>, db: Db = this.db()): Promise<void> {
    await db
      .updateTable('curricula')
      .set({ ...curriculumUpdateSet(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá chương trình; cây node và outcomes bị xoá theo cascade. */
  async deleteCurriculum(id: string, db: Db = this.db()): Promise<void> {
    await db.deleteFrom('curricula').where('id', '=', id).execute();
  }

  // --- nodes ------------------------------------------------------------------

  /** Chèn node nội dung. */
  async insertNode(v: NewCurriculumNode, db: Db = this.db()): Promise<CurriculumNodeRow> {
    const rows = await db
      .insertInto('curriculum_nodes')
      .values(curriculumNodeInsertValues(v))
      .returning(CURRICULUM_NODE_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy node theo id. */
  async getNode(id: string, db: Db = this.db()): Promise<CurriculumNodeRow | undefined> {
    const row = await db
      .selectFrom('curriculum_nodes')
      .select(CURRICULUM_NODE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row;
  }

  /** Toàn bộ node của một chương trình, phẳng, theo position. */
  async listNodes(curriculumId: string, db: Db = this.db()): Promise<CurriculumNodeRow[]> {
    return db
      .selectFrom('curriculum_nodes')
      .select(CURRICULUM_NODE_COLUMNS)
      .where('curriculum_id', '=', curriculumId)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** Sửa node. */
  async updateNode(id: string, v: Partial<NewCurriculumNode>, db: Db = this.db()): Promise<void> {
    await db
      .updateTable('curriculum_nodes')
      .set({ ...curriculumNodeUpdateSet(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá node; node con và outcomes bị xoá theo cascade. */
  async deleteNode(id: string, db: Db = this.db()): Promise<void> {
    await db.deleteFrom('curriculum_nodes').where('id', '=', id).execute();
  }

  // --- outcomes -----------------------------------------------------------------

  /** Chèn yêu cầu cần đạt. */
  async insertOutcome(v: NewLearningOutcome, db: Db = this.db()): Promise<LearningOutcomeRow> {
    const rows = await db
      .insertInto('learning_outcomes')
      .values(learningOutcomeInsertValues(v))
      .returning(LEARNING_OUTCOME_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy yêu cầu cần đạt theo id. */
  async getOutcome(id: string, db: Db = this.db()): Promise<LearningOutcomeRow | undefined> {
    const row = await db
      .selectFrom('learning_outcomes')
      .select(LEARNING_OUTCOME_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row;
  }

  /**
   * Liệt kê yêu cầu cần đạt HIỆN HÀNH của một node — ĐIỂM LỌC DUY
   * NHẤT của trạng thái rút (đợt neo lại định danh, issue #161): mặc
   * định loại các dòng đã rút (`retired_at` khác NULL); mọi bề mặt
   * "chương trình hiện hành" (cây quản trị, bản đặc tả qua tầng
   * service, khung nạp vào khoá) đều kế thừa mặc định này. Chỉ đường
   * nội bộ cần thấy cả dòng đã rút (gác xoá node, importer) mới
   * truyền `includeRetired: true`. Tra cứu đích danh theo id
   * (getOutcome) KHÔNG lọc — id là địa chỉ lịch sử hợp lệ.
   */
  async listOutcomes(
    nodeId: string,
    opts?: { includeRetired?: boolean },
    db: Db = this.db(),
  ): Promise<LearningOutcomeRow[]> {
    return db
      .selectFrom('learning_outcomes')
      .select(LEARNING_OUTCOME_COLUMNS)
      .where((eb) =>
        eb.and([
          eb('node_id', '=', nodeId),
          ...(opts?.includeRetired ? [] : [eb('retired_at', 'is', null)]),
        ]),
      )
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** Toàn bộ outcomes hiện hành của nhiều node (dựng cây của một chương trình); `includeRetired` như listOutcomes. */
  async listOutcomesForNodes(
    nodeIds: string[],
    opts?: { includeRetired?: boolean },
    db: Db = this.db(),
  ): Promise<LearningOutcomeRow[]> {
    if (nodeIds.length === 0) return [];
    return db
      .selectFrom('learning_outcomes')
      .select(LEARNING_OUTCOME_COLUMNS)
      .where((eb) =>
        eb.and([
          eb('node_id', 'in', nodeIds),
          ...(opts?.includeRetired ? [] : [eb('retired_at', 'is', null)]),
        ]),
      )
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  }

  /**
   * Toàn bộ dòng YCCĐ thuộc DIỆN DATASET QUẢN của một node — đường
   * đọc riêng của importer: `source_kind = 'program'` VÀ `source_ref`
   * khác NULL (dòng dataset luôn ghi kèm source_ref của bản ghi; dòng
   * program do admin tạo tay có source_ref NULL nên không thuộc diện
   * quản, importer không bao giờ đụng), GỒM CẢ dòng đã rút để thuật
   * toán diff ghép cặp phân hai tập hiện hành / đã rút. Dòng `derived`
   * không nằm trong diện này.
   */
  async listDatasetManagedOutcomes(nodeId: string, db: Db = this.db()): Promise<LearningOutcomeRow[]> {
    return db
      .selectFrom('learning_outcomes')
      .select(LEARNING_OUTCOME_COLUMNS)
      .where((eb) =>
        eb.and([
          eb('node_id', '=', nodeId),
          eb('source_kind', '=', 'program'),
          sql<boolean>`learning_outcomes.source_ref is not null`,
        ]),
      )
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  }

  /**
   * Đếm liên kết đang trỏ vào từng YCCĐ trong một tập (gắn câu hỏi +
   * ánh xạ sách theo outcome) — số liệu importer ghi vào báo cáo thay
   * đổi cho các ca rút dòng/sửa chữ để người duyệt thấy ảnh hưởng.
   * Trả Map theo outcomeId; id không có liên kết nào thì vắng khỏi Map.
   */
  async countOutcomeLinks(
    outcomeIds: string[],
    db: Db = this.db(),
  ): Promise<Map<string, { questions: number; bookMappings: number }>> {
    const out = new Map<string, { questions: number; bookMappings: number }>();
    if (outcomeIds.length === 0) return out;
    const linkRows = await db
      .selectFrom('question_learning_outcomes')
      .select([
        'question_learning_outcomes.learning_outcome_id as outcomeId',
        sql<number>`count(*)::int`.as('n'),
      ])
      .where('question_learning_outcomes.learning_outcome_id', 'in', outcomeIds)
      .groupBy('question_learning_outcomes.learning_outcome_id')
      .execute();
    for (const row of linkRows) {
      out.set(row.outcomeId, { questions: row.n, bookMappings: 0 });
    }
    const mappingRows = await db
      .selectFrom('book_mappings')
      .select([
        'book_mappings.learning_outcome_id as outcomeId',
        sql<number>`count(*)::int`.as('n'),
      ])
      .where('book_mappings.learning_outcome_id', 'in', outcomeIds)
      .groupBy('book_mappings.learning_outcome_id')
      .execute();
    for (const row of mappingRows) {
      if (row.outcomeId === null) continue;
      const entry = out.get(row.outcomeId) ?? { questions: 0, bookMappings: 0 };
      entry.bookMappings = row.n;
      out.set(row.outcomeId, entry);
    }
    return out;
  }

  /** Tổng số dòng YCCĐ đang ở trạng thái đã rút của một dataset (đọc từ sổ: node của các bản ghi thuộc dataset). */
  async countRetiredOutcomesForDataset(datasetKey: string, db: Db = this.db()): Promise<number> {
    const row = await db
      .selectFrom('learning_outcomes')
      .innerJoin('curriculum_program_records', 'curriculum_program_records.node_id', 'learning_outcomes.node_id')
      .select(sql<number>`count(*)::int`.as('n'))
      .where((eb) =>
        eb.and([
          eb('curriculum_program_records.dataset_key', '=', datasetKey),
          eb('learning_outcomes.source_kind', '=', 'program'),
          sql<boolean>`learning_outcomes.source_ref is not null`,
          sql<boolean>`learning_outcomes.retired_at is not null`,
        ]),
      )
      .executeTakeFirst();
    return row?.n ?? 0;
  }

  /** Sửa yêu cầu cần đạt (đường nạp truyền tx để diff commit nguyên tử cùng node + dòng sổ). */
  async updateOutcome(id: string, v: Partial<NewLearningOutcome>, db: Db = this.db()): Promise<void> {
    await db
      .updateTable('learning_outcomes')
      .set({ ...learningOutcomeUpdateSet(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Đếm các tham chiếu "cứng" đang trỏ vào một tập node + YCCĐ từ các
   * bề mặt khác (ánh xạ sách, ô ma trận đề, gắn câu hỏi): đây là các
   * FK đã đổi từ cascade sang restrict (GDPT-SEED) — bề mặt quản trị
   * xoá phải hỏi hàm này trước và từ chối bằng lỗi nghiệp vụ rõ ràng
   * thay vì để lỗi FK thô của Postgres lộ ra.
   *
   * Ghép điều kiện theo khuôn T-13 đã chốt: điều kiện của bảng ánh
   * xạ sách dựng trong callback `where` — một điều kiện thì dùng
   * thẳng, hai điều kiện thì gộp `eb.or(...)`; cả hai tập đều rỗng
   * thì không chạy truy vấn của bảng đó (số đếm giữ 0 như cũ).
   */
  async countGuardedReferences(
    nodeIds: string[],
    outcomeIds: string[],
    db: Db = this.db(),
  ): Promise<{ bookMappings: number; examMatrixCells: number; questionOutcomes: number }> {
    let bookMappingsCount = 0;
    if (nodeIds.length > 0 || outcomeIds.length > 0) {
      const row = await db
        .selectFrom('book_mappings')
        .select(sql<number>`count(*)::int`.as('n'))
        .where((eb) => {
          const conditions = [
            ...(nodeIds.length > 0 ? [eb('book_mappings.curriculum_node_id', 'in', nodeIds)] : []),
            ...(outcomeIds.length > 0 ? [eb('book_mappings.learning_outcome_id', 'in', outcomeIds)] : []),
          ];
          return conditions.length === 1 ? conditions[0]! : eb.or(conditions);
        })
        .executeTakeFirst();
      bookMappingsCount = row?.n ?? 0;
    }
    let examMatrixCellsCount = 0;
    let questionOutcomesCount = 0;
    // Ô ma trận neo NODE (issue #249 — không còn neo YCCĐ): đếm theo
    // tập node sắp xoá, độc lập với tập YCCĐ.
    if (nodeIds.length > 0) {
      const cells = await db
        .selectFrom('exam_matrix_cells')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('exam_matrix_cells.curriculum_node_id', 'in', nodeIds)
        .executeTakeFirst();
      examMatrixCellsCount = cells?.n ?? 0;
    }
    if (outcomeIds.length > 0) {
      const links = await db
        .selectFrom('question_learning_outcomes')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('question_learning_outcomes.learning_outcome_id', 'in', outcomeIds)
        .executeTakeFirst();
      questionOutcomesCount = links?.n ?? 0;
    }
    return { bookMappings: bookMappingsCount, examMatrixCells: examMatrixCellsCount, questionOutcomes: questionOutcomesCount };
  }

  /**
   * Tìm YCCĐ theo từ khoá trong nội dung (không phân biệt hoa thường),
   * kèm ngữ cảnh hiển thị (tên node, khối, môn + context của môn để
   * tầng service gác quyền đọc). Lọc cứng theo môn/khối khi caller
   * truyền; trần `limit` chặn ở SQL — tầng service còn lọc quyền theo
   * từng môn rồi mới cắt theo hạn mức của caller.
   *
   * Hình chiếu toàn bảng của dòng YCCĐ (thử nghiệm T-14, chốt tại
   * issue này): Drizzle cũ chọn `outcome: learningOutcomes` (cả
   * bảng lồng dưới khoá `outcome`); Kysely không có hình chiếu lồng
   * tương đương nên ở đây chọn tường minh từng cột của bảng YCCĐ
   * với bí danh tiền tố `outcome…` rồi lồng lại thành object
   * `outcome` ở biên — hình dạng trả ra khớp sâu với hình dạng cũ.
   */
  async searchOutcomes(
    input: { query: string; subjectId?: string; grade?: number; limit: number },
    db: Db = this.db(),
  ): Promise<{
    outcome: LearningOutcomeRow;
    nodeTitle: string;
    grade: number;
    subjectId: string;
    subjectName: string;
    subjectContextId: string;
  }[]> {
    // Tìm kiếm là đường đọc "chương trình hiện hành": dòng đã rút
    // (retired_at khác NULL) không được xuất hiện — cùng luật với
    // listOutcomes, áp ngay tại truy vấn này vì nó không qua listOutcomes.
    // Cột content nay là jsonb (tài liệu Tiptap) nên không ILIKE trực
    // tiếp được: ép sang text để khớp trên văn bản trong tài liệu.
    // Khớp có thể chạm cả cú pháp JSON của tài liệu, nhưng từ khoá
    // tìm kiếm là văn bản YCCĐ nên kết quả thực tế vẫn là các dòng
    // chứa từ khoá đó; tầng service vẫn trả text canonical trích
    // từ tài liệu, không trả JSON thô.
    const rows = await db
      .selectFrom('learning_outcomes')
      .innerJoin('curriculum_nodes', 'curriculum_nodes.id', 'learning_outcomes.node_id')
      .innerJoin('curricula', 'curricula.id', 'curriculum_nodes.curriculum_id')
      .innerJoin('subjects', 'subjects.id', 'curricula.subject_id')
      .select([
        'learning_outcomes.id as outcomeId',
        'learning_outcomes.tenant_id as outcomeTenantId',
        'learning_outcomes.node_id as outcomeNodeId',
        'learning_outcomes.content as outcomeContent',
        'learning_outcomes.position as outcomePosition',
        'learning_outcomes.source_kind as outcomeSourceKind',
        'learning_outcomes.source_ref as outcomeSourceRef',
        'learning_outcomes.derived_from_id as outcomeDerivedFromId',
        'learning_outcomes.retired_at as outcomeRetiredAt',
        'learning_outcomes.created_at as outcomeCreatedAt',
        'learning_outcomes.updated_at as outcomeUpdatedAt',
        'curriculum_nodes.title as nodeTitle',
        'curricula.grade as grade',
        'subjects.id as subjectId',
        'subjects.name as subjectName',
        'subjects.context_id as subjectContextId',
      ])
      .where((eb) =>
        eb.and([
          sql<boolean>`learning_outcomes.content::text ILIKE ${`%${input.query}%`}`,
          eb('learning_outcomes.retired_at', 'is', null),
          ...(input.subjectId ? [eb('subjects.id', '=', input.subjectId)] : []),
          ...(input.grade !== undefined ? [eb('curricula.grade', '=', input.grade)] : []),
        ]),
      )
      .orderBy('subjects.position', 'asc')
      .orderBy('curricula.grade', 'asc')
      .orderBy('curriculum_nodes.position', 'asc')
      .orderBy('learning_outcomes.position', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map((row) => ({
      outcome: {
        id: row.outcomeId,
        tenantId: row.outcomeTenantId,
        nodeId: row.outcomeNodeId,
        content: row.outcomeContent,
        position: row.outcomePosition,
        sourceKind: row.outcomeSourceKind,
        sourceRef: row.outcomeSourceRef,
        derivedFromId: row.outcomeDerivedFromId,
        retiredAt: row.outcomeRetiredAt,
        createdAt: row.outcomeCreatedAt,
        updatedAt: row.outcomeUpdatedAt,
      },
      nodeTitle: row.nodeTitle,
      grade: row.grade,
      subjectId: row.subjectId,
      subjectName: row.subjectName,
      subjectContextId: row.subjectContextId,
    }));
  }

  /**
   * Đếm câu hỏi sẵn sàng đã gắn vào một YCCĐ, nhóm theo (mức × dạng câu).
   * "Sẵn sàng" = trạng thái ready ở cấp danh tính câu hỏi
   * (question_bank_entries.status) — nền cho đếm ứng viên ma trận (A.6).
   */
  async countReadyQuestionsForOutcome(
    outcomeId: string,
    db: Db = this.db(),
  ): Promise<{ cognitiveLevel: string; qtype: string; count: number }[]> {
    return db
      .selectFrom('question_learning_outcomes')
      .innerJoin('question', 'question.id', 'question_learning_outcomes.question_id')
      .innerJoin('question_bank_entries', 'question_bank_entries.question_id', 'question.id')
      .select([
        'question_learning_outcomes.cognitive_level as cognitiveLevel',
        'question.qtype as qtype',
        sql<number>`count(distinct question_learning_outcomes.question_id)::int`.as('count'),
      ])
      .where(
        sql<boolean>`question_learning_outcomes.learning_outcome_id = ${outcomeId} and question_bank_entries.status = 'ready'`,
      )
      .groupBy(['question_learning_outcomes.cognitive_level', 'question.qtype'])
      .orderBy('question_learning_outcomes.cognitive_level', 'asc')
      .orderBy('question.qtype', 'asc')
      .execute();
  }

  /** Xoá yêu cầu cần đạt. */
  async deleteOutcome(id: string, db: Db = this.db()): Promise<void> {
    await db.deleteFrom('learning_outcomes').where('id', '=', id).execute();
  }

  // --- sổ đăng ký nạp dữ liệu chuẩn (K0a) --------------------------------

  /** Tổng số dòng sổ đăng ký — căn cứ xét "DB đã có dữ liệu chương trình chưa" cho đường restore dump khi seed. */
  async countProgramRecords(db: Db = this.db()): Promise<number> {
    const row = await db
      .selectFrom('curriculum_program_records')
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirst();
    return row?.n ?? 0;
  }

  /** Tra một bản ghi đã nạp theo định danh ổn định (dataset, mã bản ghi). */
  async getProgramRecord(datasetKey: string, recordId: string, db: Db = this.db()): Promise<ProgramRecordRow | undefined> {
    const row = await db
      .selectFrom('curriculum_program_records')
      .select(PROGRAM_RECORD_COLUMNS)
      .where((eb) => eb.and([eb('dataset_key', '=', datasetKey), eb('record_id', '=', recordId)]))
      .executeTakeFirst();
    return row;
  }

  /** Tra dòng sổ theo node nội dung — phục vụ suy mã bản ghi (mã YCCĐ vị trí) cho một node thuộc dataset. */
  async getProgramRecordByNodeId(nodeId: string, db: Db = this.db()): Promise<ProgramRecordRow | undefined> {
    const row = await db
      .selectFrom('curriculum_program_records')
      .select(PROGRAM_RECORD_COLUMNS)
      .where('node_id', '=', nodeId)
      .executeTakeFirst();
    return row;
  }

  /** Toàn bộ dòng sổ của một dataset (phục vụ trạng thái nạp + đối chiếu). */
  async listProgramRecords(datasetKey: string, db: Db = this.db()): Promise<ProgramRecordRow[]> {
    return db
      .selectFrom('curriculum_program_records')
      .select(PROGRAM_RECORD_COLUMNS)
      .where('dataset_key', '=', datasetKey)
      .orderBy('record_id', 'asc')
      .execute();
  }

  /** Ghi một dòng sổ khi nạp mới một bản ghi. */
  async insertProgramRecord(v: NewProgramRecord, db: Db = this.db()): Promise<ProgramRecordRow> {
    const rows = await db
      .insertInto('curriculum_program_records')
      .values(programRecordInsertValues(v))
      .returning(PROGRAM_RECORD_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Cập nhật một dòng sổ khi bản ghi được nạp lại sau đính chính nguồn. */
  async updateProgramRecord(id: string, v: Partial<NewProgramRecord>, db: Db = this.db()): Promise<void> {
    await db
      .updateTable('curriculum_program_records')
      .set({ ...programRecordUpdateSet(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Toàn bộ dòng sổ của một môn (mọi dataset) — tầng SGK (K0b) truy vết mã bản ghi theo node đích của ánh xạ. */
  async listProgramRecordsBySubject(subjectId: string, db: Db = this.db()): Promise<ProgramRecordRow[]> {
    return db
      .selectFrom('curriculum_program_records')
      .select(PROGRAM_RECORD_COLUMNS)
      .where('subject_id', '=', subjectId)
      .orderBy('record_id', 'asc')
      .execute();
  }
}
