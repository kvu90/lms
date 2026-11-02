import { sql, type RawBuilder } from 'kysely';
import type { CentreDb, CentreTx } from '../client';
import type { Json } from '../types/centre-db';

/**
 * Kho dữ liệu khoá học trên Kysely (issue #645, nhóm G5 của chiến
 * dịch chuyển tầng dữ liệu sang Kysely): TOÀN BỘ bề mặt của
 * `CoursesRepository` cũ ở `apps/api` (Drizzle) được chuyển nguyên
 * vẹn sang đây — category (cây có path vật chất hoá), course,
 * section, course module (cm), neo khung chương trình/SGK chụp kèm
 * section, và format options.
 *
 * Khuôn truy vấn theo đúng pilot kho control plane (issue #640):
 * - Cột đọc khai tường minh kèm bí danh camelCase
 *   (`'tenant_id as tenantId'`) dùng chung cho select và returning —
 *   KHÔNG bật CamelCasePlugin (một nguồn sự thật là database thật).
 * - Ghi qua hàm ánh xạ Insert/Update loại `undefined` tường minh
 *   từng trường (thử nghiệm T-4): `undefined` = không ghi/không
 *   đổi, `null` = ghi NULL — hai nghĩa không được lẫn.
 * - Mọi ghi jsonb (`availability` của section/cm) đi qua
 *   `jsonbValue` (xâu hoá tường minh + `::jsonb`); `null` của cột
 *   jsonb nullable giữ nguyên là SQL NULL.
 * - Khoá chính `uuidv7()` do database sinh (phụ lục U của kế
 *   hoạch): insert bỏ qua `id` (trừ khi phía gọi truyền tường
 *   minh) và lấy id qua `returning`.
 * - Điểm mở giao dịch của repository là `transaction(fn)`; các
 *   phương thức nhận handle tuỳ chọn (`CoursesDb` = handle thường
 *   hoặc handle giao dịch) để phía gọi lồng thao tác vào giao dịch
 *   của mình.
 *
 * Bề mặt kiểu dòng (hàng `*Row` xuất khẩu dưới đây) giữ đúng hình
 * dạng `$inferSelect` của repository cũ để phía tiêu thụ trong
 * module courses không đổi hợp đồng: cột `availability` không có
 * `$type<>` ở schema Drizzle nên giữ là `unknown` như hợp đồng cũ.
 */

/** Handle kho trung tâm mà repository chấp nhận: thường hoặc trong giao dịch. */
export type CoursesDb = CentreDb | CentreTx;
/** Handle giao dịch kho trung tâm (tham số bắt buộc của các thao tác đa bước). */
export type CoursesTx = CentreTx;

// ---------------------------------------------------------------------------
// Kiểu dòng đọc (hợp đồng công khai — khớp `$inferSelect` của repository cũ)
// ---------------------------------------------------------------------------

/** Dòng `course_categories` (bảng này không có cột `created_at`). */
export interface CategoryRow {
  id: string;
  tenantId: string;
  name: string;
  idNumber: string | null;
  description: string;
  parent: string | null;
  sortOrder: number;
  path: string;
  depth: number;
  visible: boolean;
  updatedAt: Date;
}

/** Dòng `course`. */
export interface CourseRow {
  id: string;
  tenantId: string;
  category: string;
  classId: string | null;
  fullName: string;
  shortName: string;
  idNumber: string;
  summary: string;
  format: string;
  visible: boolean;
  startDate: Date | null;
  endDate: Date | null;
  groupMode: number;
  groupModeForce: boolean;
  sortOrder: number;
  subjectId: string | null;
  grade: number | null;
  isTemplate: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `course_sections`; `availability` là cây JSON giữ kiểu `unknown` như hợp đồng cũ. */
export interface SectionRow {
  id: string;
  course: string;
  section: number;
  name: string | null;
  summary: string;
  visible: boolean;
  availability: unknown;
  openAt: Date | null;
  updatedAt: Date;
}

/** Dòng `course_modules`; `availability` giữ kiểu `unknown` như hợp đồng cũ. */
export interface CmRow {
  id: string;
  course: string;
  section: string;
  component: string;
  instanceId: string | null;
  name: string;
  added: Date;
  visible: boolean;
  groupMode: number;
  availability: unknown;
  completion: number;
  completionView: boolean;
  completionUseGrade: boolean;
  completionManual: boolean;
  completionExpected: Date | null;
  openAt: Date | null;
  deletionInProgress: boolean;
  sortOrder: number;
}

/** Dòng `course_section_anchors` (neo khung chương trình chụp trên section). */
export interface SectionAnchorRow {
  id: string;
  sectionId: string;
  curriculumId: string | null;
  nodeId: string | null;
  nodeTitle: string;
  createdAt: Date;
}

/** Dòng `course_section_anchor_outcomes` (YCCĐ chụp kèm một neo khung). */
export interface SectionAnchorOutcomeRow {
  id: string;
  anchorId: string;
  outcomeId: string | null;
  content: string;
  position: number;
  createdAt: Date;
}

/** Dòng `course_section_book_anchors` (neo khung SGK chụp trên section). */
export interface SectionBookAnchorRow {
  id: string;
  sectionId: string;
  bookId: string | null;
  bookNodeId: string | null;
  nodeTitle: string;
  createdAt: Date;
}

/** Dòng `course_section_book_items` (mục bài SGK chụp trong một neo). */
export interface SectionBookItemRow {
  id: string;
  anchorId: string;
  bookNodeId: string | null;
  title: string;
  position: number;
  createdAt: Date;
}

/** Dòng `course_section_book_item_outcomes` (YCCĐ chụp kèm một mục bài SGK). */
export interface SectionBookItemOutcomeRow {
  id: string;
  itemId: string;
  outcomeId: string | null;
  content: string;
  position: number;
  createdAt: Date;
}

/** Dòng `course_format_options`. */
export interface CourseFormatOptionRow {
  id: string;
  courseId: string;
  format: string;
  sectionId: string | null;
  name: string;
  value: string | null;
}

// ---------------------------------------------------------------------------
// Kiểu ghi vào (khớp `$inferInsert` của repository cũ)
// ---------------------------------------------------------------------------

/** Giá trị chèn `course_categories`. */
export interface NewCategory {
  id?: string;
  tenantId: string;
  name: string;
  idNumber?: string | null;
  description?: string;
  parent?: string | null;
  sortOrder?: number;
  path?: string;
  depth?: number;
  visible?: boolean;
}

/** Giá trị chèn `course`. */
export interface NewCourse {
  id?: string;
  tenantId: string;
  category: string;
  classId?: string | null;
  fullName: string;
  shortName: string;
  idNumber?: string;
  summary?: string;
  format?: string;
  visible?: boolean;
  startDate?: Date | null;
  endDate?: Date | null;
  groupMode?: number;
  groupModeForce?: boolean;
  sortOrder?: number;
  subjectId?: string | null;
  grade?: number | null;
  isTemplate?: boolean;
}

/** Giá trị chèn `course_sections`. */
export interface NewSection {
  id?: string;
  course: string;
  section?: number;
  name?: string | null;
  summary?: string;
  visible?: boolean;
  availability?: unknown;
  openAt?: Date | null;
}

/** Giá trị chèn `course_modules`. */
export interface NewCm {
  id?: string;
  course: string;
  section: string;
  component: string;
  instanceId?: string | null;
  name?: string;
  added?: Date;
  visible?: boolean;
  groupMode?: number;
  availability?: unknown;
  completion?: number;
  completionView?: boolean;
  completionUseGrade?: boolean;
  completionManual?: boolean;
  completionExpected?: Date | null;
  openAt?: Date | null;
  deletionInProgress?: boolean;
  sortOrder?: number;
}

/** Giá trị chèn `course_section_anchors`. */
export interface NewSectionAnchor {
  id?: string;
  sectionId: string;
  curriculumId?: string | null;
  nodeId?: string | null;
  nodeTitle: string;
}

/** Giá trị chèn `course_section_anchor_outcomes`. */
export interface NewSectionAnchorOutcome {
  id?: string;
  anchorId: string;
  outcomeId?: string | null;
  content: string;
  position?: number;
}

/** Giá trị chèn `course_section_book_anchors`. */
export interface NewSectionBookAnchor {
  id?: string;
  sectionId: string;
  bookId?: string | null;
  bookNodeId?: string | null;
  nodeTitle: string;
}

/** Giá trị chèn `course_section_book_items`. */
export interface NewSectionBookItem {
  id?: string;
  anchorId: string;
  bookNodeId?: string | null;
  title: string;
  position?: number;
}

/** Giá trị chèn `course_section_book_item_outcomes`. */
export interface NewSectionBookItemOutcome {
  id?: string;
  itemId: string;
  outcomeId?: string | null;
  content: string;
  position?: number;
}

// ---------------------------------------------------------------------------
// Danh sách cột đọc (dùng chung cho select và returning)
// ---------------------------------------------------------------------------

const CATEGORY_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'name',
  'id_number as idNumber',
  'description',
  'parent',
  'sort_order as sortOrder',
  'path',
  'depth',
  'visible',
  'updated_at as updatedAt',
] as const;

const COURSE_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'category',
  'class_id as classId',
  'full_name as fullName',
  'short_name as shortName',
  'id_number as idNumber',
  'summary',
  'format',
  'visible',
  'start_date as startDate',
  'end_date as endDate',
  'group_mode as groupMode',
  'group_mode_force as groupModeForce',
  'sort_order as sortOrder',
  'subject_id as subjectId',
  'grade',
  'is_template as isTemplate',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

const SECTION_COLUMNS = [
  'id',
  'course',
  'section',
  'name',
  'summary',
  'visible',
  'availability',
  'open_at as openAt',
  'updated_at as updatedAt',
] as const;

const CM_COLUMNS = [
  'id',
  'course',
  'section',
  'component',
  'instance_id as instanceId',
  'name',
  'added',
  'visible',
  'group_mode as groupMode',
  'availability',
  'completion',
  'completion_view as completionView',
  'completion_use_grade as completionUseGrade',
  'completion_manual as completionManual',
  'completion_expected as completionExpected',
  'open_at as openAt',
  'deletion_in_progress as deletionInProgress',
  'sort_order as sortOrder',
] as const;

const ANCHOR_COLUMNS = [
  'id',
  'section_id as sectionId',
  'curriculum_id as curriculumId',
  'node_id as nodeId',
  'node_title as nodeTitle',
  'created_at as createdAt',
] as const;

const ANCHOR_OUTCOME_COLUMNS = [
  'id',
  'anchor_id as anchorId',
  'outcome_id as outcomeId',
  'content',
  'position',
  'created_at as createdAt',
] as const;

const BOOK_ANCHOR_COLUMNS = [
  'id',
  'section_id as sectionId',
  'book_id as bookId',
  'book_node_id as bookNodeId',
  'node_title as nodeTitle',
  'created_at as createdAt',
] as const;

const BOOK_ITEM_COLUMNS = [
  'id',
  'anchor_id as anchorId',
  'book_node_id as bookNodeId',
  'title',
  'position',
  'created_at as createdAt',
] as const;

const BOOK_ITEM_OUTCOME_COLUMNS = [
  'id',
  'item_id as itemId',
  'outcome_id as outcomeId',
  'content',
  'position',
  'created_at as createdAt',
] as const;

const FORMAT_OPTION_COLUMNS = [
  'id',
  'course_id as courseId',
  'format',
  'section_id as sectionId',
  'name',
  'value',
] as const;

// ---------------------------------------------------------------------------
// Ánh xạ ghi: loại `undefined` tường minh từng trường (T-4); cột jsonb
// nullable phân biệt ba trạng thái — `undefined` bỏ qua, `null` ghi SQL
// NULL, giá trị thì xâu hoá qua `jsonbValue`.
// ---------------------------------------------------------------------------

/**
 * Biểu thức tham số jsonb cho một giá trị ghi: xâu hoá tường minh
 * rồi ép `::jsonb` — pg không suy được kiểu tham số khi ghi jsonb,
 * ghi thẳng object sẽ lỗi.
 */
function jsonbValue<T>(value: T): RawBuilder<T> {
  return sql<T>`${JSON.stringify(value)}::jsonb`;
}

/**
 * Ánh xạ phần jsonb nullable cho values/set: giữ ba trạng thái như
 * ghi chú trên. Giá trị phía tiêu thụ là `unknown` (hợp đồng cũ
 * không có `$type<>` cho các cột này) nên ép về kiểu `Json` của
 * codegen tại điểm ghi — đúng kiểu cột mà Kysely kiểm chứng.
 */
function jsonbField(value: unknown): RawBuilder<Json> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return jsonbValue(value as Json);
}

function categoryInsertValues(v: NewCategory) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    tenant_id: v.tenantId,
    name: v.name,
    ...(v.idNumber !== undefined ? { id_number: v.idNumber } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
    ...(v.parent !== undefined ? { parent: v.parent } : {}),
    ...(v.sortOrder !== undefined ? { sort_order: v.sortOrder } : {}),
    ...(v.path !== undefined ? { path: v.path } : {}),
    ...(v.depth !== undefined ? { depth: v.depth } : {}),
    ...(v.visible !== undefined ? { visible: v.visible } : {}),
  };
}

function categoryUpdateValues(v: Partial<NewCategory>) {
  return {
    ...(v.tenantId !== undefined ? { tenant_id: v.tenantId } : {}),
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.idNumber !== undefined ? { id_number: v.idNumber } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
    ...(v.parent !== undefined ? { parent: v.parent } : {}),
    ...(v.sortOrder !== undefined ? { sort_order: v.sortOrder } : {}),
    ...(v.path !== undefined ? { path: v.path } : {}),
    ...(v.depth !== undefined ? { depth: v.depth } : {}),
    ...(v.visible !== undefined ? { visible: v.visible } : {}),
  };
}

function courseInsertValues(v: NewCourse) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    tenant_id: v.tenantId,
    category: v.category,
    ...(v.classId !== undefined ? { class_id: v.classId } : {}),
    full_name: v.fullName,
    short_name: v.shortName,
    ...(v.idNumber !== undefined ? { id_number: v.idNumber } : {}),
    ...(v.summary !== undefined ? { summary: v.summary } : {}),
    ...(v.format !== undefined ? { format: v.format } : {}),
    ...(v.visible !== undefined ? { visible: v.visible } : {}),
    ...(v.startDate !== undefined ? { start_date: v.startDate } : {}),
    ...(v.endDate !== undefined ? { end_date: v.endDate } : {}),
    ...(v.groupMode !== undefined ? { group_mode: v.groupMode } : {}),
    ...(v.groupModeForce !== undefined ? { group_mode_force: v.groupModeForce } : {}),
    ...(v.sortOrder !== undefined ? { sort_order: v.sortOrder } : {}),
    ...(v.subjectId !== undefined ? { subject_id: v.subjectId } : {}),
    ...(v.grade !== undefined ? { grade: v.grade } : {}),
    ...(v.isTemplate !== undefined ? { is_template: v.isTemplate } : {}),
  };
}

function courseUpdateValues(v: Partial<NewCourse>) {
  return {
    ...(v.category !== undefined ? { category: v.category } : {}),
    ...(v.classId !== undefined ? { class_id: v.classId } : {}),
    ...(v.fullName !== undefined ? { full_name: v.fullName } : {}),
    ...(v.shortName !== undefined ? { short_name: v.shortName } : {}),
    ...(v.idNumber !== undefined ? { id_number: v.idNumber } : {}),
    ...(v.summary !== undefined ? { summary: v.summary } : {}),
    ...(v.format !== undefined ? { format: v.format } : {}),
    ...(v.visible !== undefined ? { visible: v.visible } : {}),
    ...(v.startDate !== undefined ? { start_date: v.startDate } : {}),
    ...(v.endDate !== undefined ? { end_date: v.endDate } : {}),
    ...(v.groupMode !== undefined ? { group_mode: v.groupMode } : {}),
    ...(v.groupModeForce !== undefined ? { group_mode_force: v.groupModeForce } : {}),
    ...(v.sortOrder !== undefined ? { sort_order: v.sortOrder } : {}),
    ...(v.subjectId !== undefined ? { subject_id: v.subjectId } : {}),
    ...(v.grade !== undefined ? { grade: v.grade } : {}),
    ...(v.isTemplate !== undefined ? { is_template: v.isTemplate } : {}),
  };
}

function sectionInsertValues(v: NewSection) {
  const availability = jsonbField(v.availability);
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    course: v.course,
    ...(v.section !== undefined ? { section: v.section } : {}),
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.summary !== undefined ? { summary: v.summary } : {}),
    ...(v.visible !== undefined ? { visible: v.visible } : {}),
    ...(availability !== undefined ? { availability } : {}),
    ...(v.openAt !== undefined ? { open_at: v.openAt } : {}),
  };
}

function sectionUpdateValues(v: Partial<NewSection>) {
  const availability = jsonbField(v.availability);
  return {
    ...(v.course !== undefined ? { course: v.course } : {}),
    ...(v.section !== undefined ? { section: v.section } : {}),
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.summary !== undefined ? { summary: v.summary } : {}),
    ...(v.visible !== undefined ? { visible: v.visible } : {}),
    ...(availability !== undefined ? { availability } : {}),
    ...(v.openAt !== undefined ? { open_at: v.openAt } : {}),
  };
}

function cmInsertValues(v: NewCm) {
  const availability = jsonbField(v.availability);
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    course: v.course,
    section: v.section,
    component: v.component,
    ...(v.instanceId !== undefined ? { instance_id: v.instanceId } : {}),
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.added !== undefined ? { added: v.added } : {}),
    ...(v.visible !== undefined ? { visible: v.visible } : {}),
    ...(v.groupMode !== undefined ? { group_mode: v.groupMode } : {}),
    ...(availability !== undefined ? { availability } : {}),
    ...(v.completion !== undefined ? { completion: v.completion } : {}),
    ...(v.completionView !== undefined ? { completion_view: v.completionView } : {}),
    ...(v.completionUseGrade !== undefined ? { completion_use_grade: v.completionUseGrade } : {}),
    ...(v.completionManual !== undefined ? { completion_manual: v.completionManual } : {}),
    ...(v.completionExpected !== undefined ? { completion_expected: v.completionExpected } : {}),
    ...(v.openAt !== undefined ? { open_at: v.openAt } : {}),
    ...(v.deletionInProgress !== undefined ? { deletion_in_progress: v.deletionInProgress } : {}),
    ...(v.sortOrder !== undefined ? { sort_order: v.sortOrder } : {}),
  };
}

function cmUpdateValues(v: Partial<NewCm>) {
  const availability = jsonbField(v.availability);
  return {
    ...(v.course !== undefined ? { course: v.course } : {}),
    ...(v.section !== undefined ? { section: v.section } : {}),
    ...(v.component !== undefined ? { component: v.component } : {}),
    ...(v.instanceId !== undefined ? { instance_id: v.instanceId } : {}),
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.added !== undefined ? { added: v.added } : {}),
    ...(v.visible !== undefined ? { visible: v.visible } : {}),
    ...(v.groupMode !== undefined ? { group_mode: v.groupMode } : {}),
    ...(availability !== undefined ? { availability } : {}),
    ...(v.completion !== undefined ? { completion: v.completion } : {}),
    ...(v.completionView !== undefined ? { completion_view: v.completionView } : {}),
    ...(v.completionUseGrade !== undefined ? { completion_use_grade: v.completionUseGrade } : {}),
    ...(v.completionManual !== undefined ? { completion_manual: v.completionManual } : {}),
    ...(v.completionExpected !== undefined ? { completion_expected: v.completionExpected } : {}),
    ...(v.openAt !== undefined ? { open_at: v.openAt } : {}),
    ...(v.deletionInProgress !== undefined ? { deletion_in_progress: v.deletionInProgress } : {}),
    ...(v.sortOrder !== undefined ? { sort_order: v.sortOrder } : {}),
  };
}

function sectionAnchorInsertValues(v: NewSectionAnchor) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    section_id: v.sectionId,
    ...(v.curriculumId !== undefined ? { curriculum_id: v.curriculumId } : {}),
    ...(v.nodeId !== undefined ? { node_id: v.nodeId } : {}),
    node_title: v.nodeTitle,
  };
}

function sectionAnchorOutcomeInsertValues(v: NewSectionAnchorOutcome) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    anchor_id: v.anchorId,
    ...(v.outcomeId !== undefined ? { outcome_id: v.outcomeId } : {}),
    content: v.content,
    ...(v.position !== undefined ? { position: v.position } : {}),
  };
}

function sectionBookAnchorInsertValues(v: NewSectionBookAnchor) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    section_id: v.sectionId,
    ...(v.bookId !== undefined ? { book_id: v.bookId } : {}),
    ...(v.bookNodeId !== undefined ? { book_node_id: v.bookNodeId } : {}),
    node_title: v.nodeTitle,
  };
}

function sectionBookItemInsertValues(v: NewSectionBookItem) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    anchor_id: v.anchorId,
    ...(v.bookNodeId !== undefined ? { book_node_id: v.bookNodeId } : {}),
    title: v.title,
    ...(v.position !== undefined ? { position: v.position } : {}),
  };
}

function sectionBookItemOutcomeInsertValues(v: NewSectionBookItemOutcome) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    item_id: v.itemId,
    ...(v.outcomeId !== undefined ? { outcome_id: v.outcomeId } : {}),
    content: v.content,
    ...(v.position !== undefined ? { position: v.position } : {}),
  };
}

/**
 * Kho dữ liệu khoá học: category (cây có path vật chất hoá), course,
 * section, course module (cm) và format options.
 */
export class CoursesRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Mở một transaction trên kho trung tâm. */
  async transaction<T>(fn: (tx: CoursesTx) => Promise<T>): Promise<T> {
    return this.handle.transaction().execute(fn);
  }

  // categories

  /** Chèn category. */
  async insertCategory(v: NewCategory, db: CoursesDb = this.handle): Promise<CategoryRow> {
    return db
      .insertInto('course_categories')
      .values(categoryInsertValues(v))
      .returning(CATEGORY_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<CategoryRow>;
  }

  /** Lấy category theo id. */
  async getCategory(id: string): Promise<CategoryRow | undefined> {
    return this.handle
      .selectFrom('course_categories')
      .select(CATEGORY_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<CategoryRow | undefined>;
  }

  /** Liệt kê mọi category. */
  async listCategories(): Promise<CategoryRow[]> {
    return this.handle
      .selectFrom('course_categories')
      .select(CATEGORY_COLUMNS)
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc')
      .execute() as Promise<CategoryRow[]>;
  }

  /** Các category con trực tiếp của một category. */
  async childrenOf(parent: string): Promise<CategoryRow[]> {
    return this.handle
      .selectFrom('course_categories')
      .select(CATEGORY_COLUMNS)
      .where('parent', '=', parent)
      .orderBy('sort_order', 'asc')
      .execute() as Promise<CategoryRow[]>;
  }

  /** Category và mọi con cháu qua tiền tố path (path có dạng như /1/4/9). */
  async subtreeOf(cat: CategoryRow): Promise<CategoryRow[]> {
    return this.handle
      .selectFrom('course_categories')
      .select(CATEGORY_COLUMNS)
      .where((eb) => eb.or([eb('id', '=', cat.id), eb('path', 'like', `${cat.path}/%`)]))
      .execute() as Promise<CategoryRow[]>;
  }

  /** Cập nhật category. */
  async updateCategory(id: string, v: Partial<NewCategory>, db: CoursesDb = this.handle): Promise<void> {
    await db
      .updateTable('course_categories')
      .set({ ...categoryUpdateValues(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Viết lại path/depth khi di chuyển category. */
  async updateCategoryPath(id: string, path: string, depth: number): Promise<void> {
    await this.handle
      .updateTable('course_categories')
      .set({ path, depth })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá category. */
  async deleteCategory(id: string, db: CoursesDb = this.handle): Promise<void> {
    await db.deleteFrom('course_categories').where('id', '=', id).execute();
  }

  /** Số category anh em (phục vụ sortOrder). */
  async countSiblingCategories(parent: string | null): Promise<number> {
    let query = this.handle.selectFrom('course_categories').select(sql<number>`count(*)::int`.as('n'));
    query = parent === null ? query.where('parent', 'is', null) : query.where('parent', '=', parent);
    const row = await query.executeTakeFirst();
    return row?.n ?? 0;
  }

  // courses

  /** Chèn khoá học. */
  async insertCourse(v: NewCourse, db: CoursesDb = this.handle): Promise<CourseRow> {
    return db
      .insertInto('course')
      .values(courseInsertValues(v))
      .returning(COURSE_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<CourseRow>;
  }

  /** Lấy khoá học theo id. */
  async getCourse(id: string): Promise<CourseRow | undefined> {
    return this.handle
      .selectFrom('course')
      .select(COURSE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<CourseRow | undefined>;
  }

  /** Lấy khoá học theo shortName duy nhất. */
  async getCourseByShortname(shortName: string): Promise<CourseRow | undefined> {
    return this.handle
      .selectFrom('course')
      .select(COURSE_COLUMNS)
      .where('short_name', '=', shortName)
      .executeTakeFirst() as Promise<CourseRow | undefined>;
  }

  /** Liệt kê khoá học. */
  async listCourses(categoryId?: string): Promise<CourseRow[]> {
    let query = this.handle
      .selectFrom('course')
      .select(COURSE_COLUMNS)
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc');
    if (categoryId !== undefined) query = query.where('category', '=', categoryId);
    return query.execute() as Promise<CourseRow[]>;
  }

  /** Khoá học thuộc các category cho trước. */
  async listCoursesInCategories(categoryIds: string[]): Promise<CourseRow[]> {
    if (!categoryIds.length) return [];
    const rows: CourseRow[] = [];
    for (const id of categoryIds) rows.push(...(await this.listCourses(id)));
    return rows;
  }

  /** Cập nhật khoá học. */
  async updateCourse(id: string, v: Partial<NewCourse>, db: CoursesDb = this.handle): Promise<void> {
    await db
      .updateTable('course')
      .set({ ...courseUpdateValues(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá khoá học. */
  async deleteCourse(id: string, db: CoursesDb = this.handle): Promise<void> {
    await db.deleteFrom('course').where('id', '=', id).execute();
  }

  // sections

  /** Chèn section. */
  async insertSection(v: NewSection, db: CoursesDb = this.handle): Promise<SectionRow> {
    return db
      .insertInto('course_sections')
      .values(sectionInsertValues(v))
      .returning(SECTION_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<SectionRow>;
  }

  /** Lấy môn học theo id (đối chiếu neo môn × khối của khoá — K0a). */
  async getSubjectById(id: string): Promise<{ id: string } | undefined> {
    return this.handle.selectFrom('subjects').select('id').where('id', '=', id).executeTakeFirst();
  }

  /**
   * Dịch số thứ tự của các section từ `fromSection` trở đi trong một
   * khoá (phục vụ chèn khung tại vị trí): cộng `delta` vào số section —
   * lượt chèn chạy hai pass qua vùng đệm lớn để không vi phạm unique
   * (course, section) giữa chừng.
   */
  async shiftSections(tx: CoursesTx, courseId: string, fromSection: number, delta: number): Promise<void> {
    await tx
      .updateTable('course_sections')
      .set({ section: sql<number>`section + ${delta}`, updated_at: new Date() })
      .where('course', '=', courseId)
      .where('section', '>=', fromSection)
      .execute();
  }

  /** Ghi neo khung cho một section vừa tạo từ khung chương trình. */
  async insertSectionAnchor(v: NewSectionAnchor, db: CoursesDb = this.handle): Promise<SectionAnchorRow> {
    return db
      .insertInto('course_section_anchors')
      .values(sectionAnchorInsertValues(v))
      .returning(ANCHOR_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<SectionAnchorRow>;
  }

  /** Ghi các YCCĐ chụp kèm một neo khung (đúng thứ tự position truyền vào). */
  async insertSectionAnchorOutcomes(v: NewSectionAnchorOutcome[], db: CoursesDb = this.handle): Promise<void> {
    if (v.length === 0) return;
    await db.insertInto('course_section_anchor_outcomes').values(v.map(sectionAnchorOutcomeInsertValues)).execute();
  }

  /** Toàn bộ neo khung của nhiều section (dựng khung hiển thị trong nội dung khoá). */
  async listAnchorsForSections(sectionIds: string[]): Promise<SectionAnchorRow[]> {
    if (sectionIds.length === 0) return [];
    return this.handle
      .selectFrom('course_section_anchors')
      .select(ANCHOR_COLUMNS)
      .where('section_id', 'in', sectionIds)
      .execute() as Promise<SectionAnchorRow[]>;
  }

  /** Toàn bộ YCCĐ chụp của nhiều neo khung, theo position. */
  async listAnchorOutcomes(anchorIds: string[]): Promise<SectionAnchorOutcomeRow[]> {
    if (anchorIds.length === 0) return [];
    return this.handle
      .selectFrom('course_section_anchor_outcomes')
      .select(ANCHOR_OUTCOME_COLUMNS)
      .where('anchor_id', 'in', anchorIds)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute() as Promise<SectionAnchorOutcomeRow[]>;
  }

  /** Ghi neo khung SGK cho một section vừa tạo từ khung sách (K0b). */
  async insertSectionBookAnchor(v: NewSectionBookAnchor, db: CoursesDb = this.handle): Promise<SectionBookAnchorRow> {
    return db
      .insertInto('course_section_book_anchors')
      .values(sectionBookAnchorInsertValues(v))
      .returning(BOOK_ANCHOR_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<SectionBookAnchorRow>;
  }

  /** Ghi một mục bài SGK chụp trong một neo khung SGK. */
  async insertSectionBookItem(v: NewSectionBookItem, db: CoursesDb = this.handle): Promise<SectionBookItemRow> {
    return db
      .insertInto('course_section_book_items')
      .values(sectionBookItemInsertValues(v))
      .returning(BOOK_ITEM_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<SectionBookItemRow>;
  }

  /** Ghi các YCCĐ chụp kèm một mục bài SGK (đúng thứ tự position truyền vào). */
  async insertSectionBookItemOutcomes(v: NewSectionBookItemOutcome[], db: CoursesDb = this.handle): Promise<void> {
    if (v.length === 0) return;
    await db.insertInto('course_section_book_item_outcomes').values(v.map(sectionBookItemOutcomeInsertValues)).execute();
  }

  /** Toàn bộ neo khung SGK của nhiều section (dựng khung SGK hiển thị trong nội dung khoá). */
  async listBookAnchorsForSections(sectionIds: string[]): Promise<SectionBookAnchorRow[]> {
    if (sectionIds.length === 0) return [];
    return this.handle
      .selectFrom('course_section_book_anchors')
      .select(BOOK_ANCHOR_COLUMNS)
      .where('section_id', 'in', sectionIds)
      .execute() as Promise<SectionBookAnchorRow[]>;
  }

  /** Toàn bộ mục bài SGK chụp của nhiều neo, theo position. */
  async listBookItems(anchorIds: string[]): Promise<SectionBookItemRow[]> {
    if (anchorIds.length === 0) return [];
    return this.handle
      .selectFrom('course_section_book_items')
      .select(BOOK_ITEM_COLUMNS)
      .where('anchor_id', 'in', anchorIds)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute() as Promise<SectionBookItemRow[]>;
  }

  /** Toàn bộ YCCĐ chụp của nhiều mục bài SGK, theo position. */
  async listBookItemOutcomes(itemIds: string[]): Promise<SectionBookItemOutcomeRow[]> {
    if (itemIds.length === 0) return [];
    return this.handle
      .selectFrom('course_section_book_item_outcomes')
      .select(BOOK_ITEM_OUTCOME_COLUMNS)
      .where('item_id', 'in', itemIds)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute() as Promise<SectionBookItemOutcomeRow[]>;
  }

  /** Lấy section theo id. */
  async getSection(id: string): Promise<SectionRow | undefined> {
    return this.handle
      .selectFrom('course_sections')
      .select(SECTION_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<SectionRow | undefined>;
  }

  /** Liệt kê section của khoá học theo thứ tự. */
  async listSections(courseId: string): Promise<SectionRow[]> {
    return this.handle
      .selectFrom('course_sections')
      .select(SECTION_COLUMNS)
      .where('course', '=', courseId)
      .orderBy('section', 'asc')
      .execute() as Promise<SectionRow[]>;
  }

  /** Cập nhật section (tên, summary, availability JSON). */
  async updateSection(id: string, v: Partial<NewSection>): Promise<void> {
    await this.handle
      .updateTable('course_sections')
      .set({ ...sectionUpdateValues(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá section. */
  async deleteSection(id: string): Promise<void> {
    await this.handle.deleteFrom('course_sections').where('id', '=', id).execute();
  }

  // mô-đun của khoá học

  /** Chèn course module. */
  async insertCm(v: NewCm, db: CoursesDb = this.handle): Promise<CmRow> {
    return db
      .insertInto('course_modules')
      .values(cmInsertValues(v))
      .returning(CM_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<CmRow>;
  }

  /** Lấy cm theo id. */
  async getCm(id: string): Promise<CmRow | undefined> {
    return this.handle
      .selectFrom('course_modules')
      .select(CM_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<CmRow | undefined>;
  }

  /**
   * Liệt kê mọi cm của khoá học theo thứ tự outline (K1: `sortOrder`
   * tường minh, id uuidv7 làm khoá phụ giữ nguyên thứ tự tạo cho dữ
   * liệu cũ mọi sortOrder đều bằng 0).
   */
  async listCms(courseId: string): Promise<CmRow[]> {
    return this.handle
      .selectFrom('course_modules')
      .select(CM_COLUMNS)
      .where('course', '=', courseId)
      .where('deletion_in_progress', '=', false)
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc')
      .execute() as Promise<CmRow[]>;
  }

  /** Cm trong một section theo thứ tự outline (K1). */
  async listCmsInSection(sectionId: string): Promise<CmRow[]> {
    return this.handle
      .selectFrom('course_modules')
      .select(CM_COLUMNS)
      .where('section', '=', sectionId)
      .where('deletion_in_progress', '=', false)
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc')
      .execute() as Promise<CmRow[]>;
  }

  /**
   * Khoá mẫu tổ/trường (K1): các khoá `is_template` — danh sách nguồn
   * của đường 5 trong wizard tạo khoá.
   */
  async listTemplateCourses(): Promise<CourseRow[]> {
    return this.handle
      .selectFrom('course')
      .select(COURSE_COLUMNS)
      .where('is_template', '=', true)
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc')
      .execute() as Promise<CourseRow[]>;
  }

  /** Cập nhật cm. */
  async updateCm(id: string, v: Partial<NewCm>): Promise<void> {
    await this.handle.updateTable('course_modules').set(cmUpdateValues(v)).where('id', '=', id).execute();
  }

  /** Xoá cm. */
  async deleteCm(id: string, db: CoursesDb = this.handle): Promise<void> {
    await db.deleteFrom('course_modules').where('id', '=', id).execute();
  }

  // tuỳ chọn định dạng

  /** Ghi một tuỳ chọn định dạng khoá học (format option). */
  async setFormatOption(
    courseId: string,
    format: string,
    name: string,
    value: string | null,
    sectionId: string | null = null,
  ): Promise<void> {
    if (sectionId === null) {
      // sectionId NULL không tham gia unique conflict (NULL luôn khác
      // nhau trong PostgreSQL) nên upsert thủ công cho tuỳ chọn cấp
      // khoá học.
      const existing = await this.handle
        .selectFrom('course_format_options')
        .select(FORMAT_OPTION_COLUMNS)
        .where('course_id', '=', courseId)
        .where('format', '=', format)
        .where('section_id', 'is', null)
        .where('name', '=', name)
        .executeTakeFirst();
      if (existing) {
        await this.handle
          .updateTable('course_format_options')
          .set({ value })
          .where('id', '=', existing.id)
          .execute();
        return;
      }
      await this.handle
        .insertInto('course_format_options')
        .values({ course_id: courseId, format, name, value, section_id: sectionId })
        .execute();
      return;
    }
    await this.handle
      .insertInto('course_format_options')
      .values({ course_id: courseId, format, name, value, section_id: sectionId })
      .onConflict((oc) => oc.columns(['course_id', 'format', 'section_id', 'name']).doUpdateSet({ value }))
      .execute();
  }

  /** Đọc các tuỳ chọn định dạng của khoá học. */
  async listFormatOptions(courseId: string): Promise<CourseFormatOptionRow[]> {
    return this.handle
      .selectFrom('course_format_options')
      .select(FORMAT_OPTION_COLUMNS)
      .where('course_id', '=', courseId)
      .execute() as Promise<CourseFormatOptionRow[]>;
  }
}
