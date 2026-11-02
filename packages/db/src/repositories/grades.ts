import type { CentreDb, CentreTx } from '../client';

/**
 * Kho dữ liệu điểm theo bài trên Kysely (issue #644, nhóm G4 của
 * chiến dịch chuyển tầng dữ liệu sang Kysely): TOÀN BỘ bề mặt của
 * `GradesRepository` cũ ở `apps/api` (Drizzle) được chuyển nguyên
 * vẹn sang đây — grade item (một item = một bài/hoạt động), điểm
 * theo user, lịch sử điểm và vết công bố cấp bài.
 *
 * Khuôn truy vấn theo đúng pilot kho control plane (issue #640) và
 * repository câu hỏi (issue #642):
 * - Cột đọc khai tường minh kèm bí danh camelCase
 *   (`'item_id as itemId'`) dùng chung cho select và returning —
 *   KHÔNG bật CamelCasePlugin (một nguồn sự thật là database thật).
 * - Ghi qua hàm ánh xạ Insert/Update loại `undefined` tường minh
 *   từng trường (thử nghiệm T-4): `undefined` = không ghi/không
 *   đổi, `null` = ghi NULL. Điểm sắc nhất của nhóm nằm ở
 *   `upsertGrade`: tập trường của nhánh xung đột (composite
 *   `(item_id, user_id)`) chỉ gồm các trường phía gọi THẬT SỰ
 *   truyền — trường `undefined` bị loại khỏi cả hai nhánh
 *   insert/update như bản Drizzle cũ bỏ qua — cộng `updated_at`
 *   luôn làm mới.
 * - Khoá chính `uuidv7()` do database sinh (phụ lục U của kế
 *   hoạch): insert bỏ qua `id` và lấy dòng qua `returning`.
 * - Điểm mở giao dịch của repository là `transaction(fn)`; các
 *   phương thức nhận handle tuỳ chọn (`GradesDb` = handle thường
 *   hoặc handle giao dịch) để phía gọi lồng thao tác vào giao
 *   dịch của mình.
 *
 * Điểm chuyển tiếp phía api (cùng họ ngoại lệ C-7/C-8, xem
 * CORRECTIONS.md của chiến dịch): ba luồng ghi điểm của
 * GradesService (`setGrade`, `recordActivityGrade`, `updateGrade`)
 * phải giữ nguyên tử trọn gói — dòng điểm + dòng lịch sử + dòng
 * outbox `grade_updated` trong MỘT giao dịch — mà phía outbox vẫn
 * ở Drizzle (chủ sở hữu là đợt D1, issue #653) nên ba luồng đó TẠM
 * giữ 100% phía Drizzle qua `GradesTransitionalRepository` phía
 * api; bề mặt Kysely ở file này là điểm ghi chuẩn của chúng sau
 * khi lật. Chủ đóng: issue #653 — khi OutboxService chuyển sang
 * Kysely, ba luồng lật sang `transaction` + các phương thức ở đây
 * và file chuyển tiếp bị xoá; issue #663 đối chiếu không còn sót.
 */

/** Dòng `grade_items`. */
export interface ItemRow {
  id: string;
  courseId: string;
  itemType: string;
  itemModule: string | null;
  itemInstance: string | null;
  itemName: string;
  idNumber: string | null;
  gradeType: string;
  gradeMin: number;
  gradeMax: number;
  gradePass: number;
  hidden: boolean;
  locked: boolean;
  sortOrder: number;
  multiplicator: number;
  plusFactor: number;
  postingPolicy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `grade_grades`. */
export interface GradeRow {
  id: string;
  itemId: string;
  userId: string;
  rawGrade: number | null;
  finalGrade: number | null;
  rawGradeMax: number;
  rawGradeMin: number;
  hidden: boolean;
  locked: boolean;
  overridden: boolean;
  excluded: boolean;
  feedback: string | null;
  frozen: boolean;
  aggregationStatus: string;
  aggregationWeight: number | null;
  lockTime: Date | null;
  information: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `grade_grades_history`. */
export interface GradeHistoryRow {
  id: string;
  itemId: string;
  userId: string;
  oldId: string | null;
  action: number;
  rawGrade: number | null;
  finalGrade: number | null;
  excluded: boolean;
  frozen: boolean;
  overridden: boolean;
  source: string | null;
  loggedUser: string | null;
  updatedAt: Date;
}

/** Dòng `grade_publications`. */
export interface GradePublicationRow {
  id: string;
  courseId: string;
  itemId: string | null;
  action: string;
  scope: string;
  actorId: string;
  note: string | null;
  createdAt: Date;
}

/** Handle kho trung tâm mà repository chấp nhận: thường hoặc trong giao dịch. */
export type GradesDb = CentreDb | CentreTx;
/** Handle giao dịch kho trung tâm (tham số bắt buộc của các thao tác đa bước). */
export type GradesTx = CentreTx;

// ---------------------------------------------------------------------------
// Giá trị ghi (hợp đồng công khai — khớp `$inferInsert` của repository cũ)
// ---------------------------------------------------------------------------

/** Giá trị chèn `grade_items`. */
export interface NewGradeItem {
  id?: string;
  courseId: string;
  itemType?: string;
  itemModule?: string | null;
  itemInstance?: string | null;
  itemName?: string;
  idNumber?: string | null;
  gradeType?: string;
  gradeMin?: number;
  gradeMax?: number;
  gradePass?: number;
  hidden?: boolean;
  locked?: boolean;
  sortOrder?: number;
  multiplicator?: number;
  plusFactor?: number;
  postingPolicy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Giá trị ghi `grade_grades` qua đường upsert theo (item, user). */
export interface NewGrade {
  id?: string;
  itemId: string;
  userId: string;
  rawGrade?: number | null;
  finalGrade?: number | null;
  rawGradeMax?: number;
  rawGradeMin?: number;
  hidden?: boolean;
  locked?: boolean;
  overridden?: boolean;
  excluded?: boolean;
  feedback?: string | null;
  frozen?: boolean;
  aggregationStatus?: string;
  aggregationWeight?: number | null;
  lockTime?: Date | null;
  information?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Giá trị chèn `grade_grades_history`. */
export interface NewGradeHistory {
  id?: string;
  itemId: string;
  userId: string;
  oldId?: string | null;
  action?: number;
  rawGrade?: number | null;
  finalGrade?: number | null;
  excluded?: boolean;
  frozen?: boolean;
  overridden?: boolean;
  source?: string | null;
  loggedUser?: string | null;
  updatedAt?: Date;
}

/** Giá trị chèn `grade_publications`. */
export interface NewGradePublication {
  id?: string;
  courseId: string;
  itemId?: string | null;
  action: string;
  scope: string;
  actorId: string;
  note?: string | null;
  createdAt?: Date;
}

// ---------------------------------------------------------------------------
// Danh sách cột đọc: tên cột thật kèm bí danh camelCase, dùng chung cho
// select và returning của từng bảng (khuôn pilot — không CamelCasePlugin).
// ---------------------------------------------------------------------------

const ITEM_COLUMNS = [
  'id', 'course_id as courseId', 'item_type as itemType',
  'item_module as itemModule', 'item_instance as itemInstance',
  'item_name as itemName', 'id_number as idNumber',
  'grade_type as gradeType', 'grade_min as gradeMin',
  'grade_max as gradeMax', 'grade_pass as gradePass', 'hidden', 'locked',
  'sort_order as sortOrder', 'multiplicator', 'plus_factor as plusFactor',
  'posting_policy as postingPolicy',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const GRADE_COLUMNS = [
  'id', 'item_id as itemId', 'user_id as userId',
  'raw_grade as rawGrade', 'final_grade as finalGrade',
  'raw_grade_max as rawGradeMax', 'raw_grade_min as rawGradeMin',
  'hidden', 'locked', 'overridden', 'excluded', 'feedback', 'frozen',
  'aggregation_status as aggregationStatus',
  'aggregation_weight as aggregationWeight', 'lock_time as lockTime',
  'information', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const HISTORY_COLUMNS = [
  'id', 'item_id as itemId', 'user_id as userId', 'old_id as oldId',
  'action', 'raw_grade as rawGrade', 'final_grade as finalGrade',
  'excluded', 'frozen', 'overridden', 'source',
  'logged_user as loggedUser', 'updated_at as updatedAt',
] as const;

const PUBLICATION_COLUMNS = [
  'id', 'course_id as courseId', 'item_id as itemId', 'action', 'scope',
  'actor_id as actorId', 'note', 'created_at as createdAt',
] as const;

// ---------------------------------------------------------------------------
// Ánh xạ ghi: loại `undefined` tường minh từng trường (T-4).
// ---------------------------------------------------------------------------

function itemInsertValues(v: NewGradeItem) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    course_id: v.courseId,
    ...(v.itemType !== undefined ? { item_type: v.itemType } : {}),
    ...(v.itemModule !== undefined ? { item_module: v.itemModule } : {}),
    ...(v.itemInstance !== undefined ? { item_instance: v.itemInstance } : {}),
    ...(v.itemName !== undefined ? { item_name: v.itemName } : {}),
    ...(v.idNumber !== undefined ? { id_number: v.idNumber } : {}),
    ...(v.gradeType !== undefined ? { grade_type: v.gradeType } : {}),
    ...(v.gradeMin !== undefined ? { grade_min: v.gradeMin } : {}),
    ...(v.gradeMax !== undefined ? { grade_max: v.gradeMax } : {}),
    ...(v.gradePass !== undefined ? { grade_pass: v.gradePass } : {}),
    ...(v.hidden !== undefined ? { hidden: v.hidden } : {}),
    ...(v.locked !== undefined ? { locked: v.locked } : {}),
    ...(v.sortOrder !== undefined ? { sort_order: v.sortOrder } : {}),
    ...(v.multiplicator !== undefined ? { multiplicator: v.multiplicator } : {}),
    ...(v.plusFactor !== undefined ? { plus_factor: v.plusFactor } : {}),
    ...(v.postingPolicy !== undefined ? { posting_policy: v.postingPolicy } : {}),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
    ...(v.updatedAt !== undefined ? { updated_at: v.updatedAt } : {}),
  };
}

/** Ánh xạ patch của `grade_items`: trải patch như bản cũ, `updated_at` luôn làm mới ở cuối. */
function itemUpdateSet(patch: Partial<ItemRow>) {
  return {
    ...(patch.id !== undefined ? { id: patch.id } : {}),
    ...(patch.courseId !== undefined ? { course_id: patch.courseId } : {}),
    ...(patch.itemType !== undefined ? { item_type: patch.itemType } : {}),
    ...(patch.itemModule !== undefined ? { item_module: patch.itemModule } : {}),
    ...(patch.itemInstance !== undefined ? { item_instance: patch.itemInstance } : {}),
    ...(patch.itemName !== undefined ? { item_name: patch.itemName } : {}),
    ...(patch.idNumber !== undefined ? { id_number: patch.idNumber } : {}),
    ...(patch.gradeType !== undefined ? { grade_type: patch.gradeType } : {}),
    ...(patch.gradeMin !== undefined ? { grade_min: patch.gradeMin } : {}),
    ...(patch.gradeMax !== undefined ? { grade_max: patch.gradeMax } : {}),
    ...(patch.gradePass !== undefined ? { grade_pass: patch.gradePass } : {}),
    ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
    ...(patch.locked !== undefined ? { locked: patch.locked } : {}),
    ...(patch.sortOrder !== undefined ? { sort_order: patch.sortOrder } : {}),
    ...(patch.multiplicator !== undefined ? { multiplicator: patch.multiplicator } : {}),
    ...(patch.plusFactor !== undefined ? { plus_factor: patch.plusFactor } : {}),
    ...(patch.postingPolicy !== undefined ? { posting_policy: patch.postingPolicy } : {}),
    ...(patch.createdAt !== undefined ? { created_at: patch.createdAt } : {}),
    updated_at: new Date(),
  };
}

function gradeInsertValues(v: NewGrade) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    item_id: v.itemId,
    user_id: v.userId,
    ...(v.rawGrade !== undefined ? { raw_grade: v.rawGrade } : {}),
    ...(v.finalGrade !== undefined ? { final_grade: v.finalGrade } : {}),
    ...(v.rawGradeMax !== undefined ? { raw_grade_max: v.rawGradeMax } : {}),
    ...(v.rawGradeMin !== undefined ? { raw_grade_min: v.rawGradeMin } : {}),
    ...(v.hidden !== undefined ? { hidden: v.hidden } : {}),
    ...(v.locked !== undefined ? { locked: v.locked } : {}),
    ...(v.overridden !== undefined ? { overridden: v.overridden } : {}),
    ...(v.excluded !== undefined ? { excluded: v.excluded } : {}),
    ...(v.feedback !== undefined ? { feedback: v.feedback } : {}),
    ...(v.frozen !== undefined ? { frozen: v.frozen } : {}),
    ...(v.aggregationStatus !== undefined ? { aggregation_status: v.aggregationStatus } : {}),
    ...(v.aggregationWeight !== undefined ? { aggregation_weight: v.aggregationWeight } : {}),
    ...(v.lockTime !== undefined ? { lock_time: v.lockTime } : {}),
    ...(v.information !== undefined ? { information: v.information } : {}),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
    ...(v.updatedAt !== undefined ? { updated_at: v.updatedAt } : {}),
  };
}

/**
 * Tập trường của nhánh xung đột của `upsertGrade`: đúng mười một
 * trường nghiệp vụ của bản Drizzle cũ — trường nào phía gọi không
 * truyền (`undefined`) thì KHÔNG xuất hiện trong SET (giữ nguyên
 * giá trị đang có của dòng), `null` thì ghi NULL tường minh;
 * `updated_at` luôn làm mới (rủi ro R-G4-2 của hồ sơ chuẩn bị,
 * chốt bằng thử nghiệm T-4).
 */
function gradeConflictSet(v: NewGrade) {
  return {
    ...(v.rawGrade !== undefined ? { raw_grade: v.rawGrade } : {}),
    ...(v.finalGrade !== undefined ? { final_grade: v.finalGrade } : {}),
    ...(v.hidden !== undefined ? { hidden: v.hidden } : {}),
    ...(v.locked !== undefined ? { locked: v.locked } : {}),
    ...(v.overridden !== undefined ? { overridden: v.overridden } : {}),
    ...(v.excluded !== undefined ? { excluded: v.excluded } : {}),
    ...(v.frozen !== undefined ? { frozen: v.frozen } : {}),
    ...(v.feedback !== undefined ? { feedback: v.feedback } : {}),
    ...(v.aggregationStatus !== undefined ? { aggregation_status: v.aggregationStatus } : {}),
    ...(v.aggregationWeight !== undefined ? { aggregation_weight: v.aggregationWeight } : {}),
    ...(v.lockTime !== undefined ? { lock_time: v.lockTime } : {}),
    updated_at: new Date(),
  };
}

/** Ánh xạ patch của `grade_grades`: trải patch như bản cũ, `updated_at` luôn làm mới ở cuối. */
function gradeUpdateSet(patch: Partial<GradeRow>) {
  return {
    ...(patch.id !== undefined ? { id: patch.id } : {}),
    ...(patch.itemId !== undefined ? { item_id: patch.itemId } : {}),
    ...(patch.userId !== undefined ? { user_id: patch.userId } : {}),
    ...(patch.rawGrade !== undefined ? { raw_grade: patch.rawGrade } : {}),
    ...(patch.finalGrade !== undefined ? { final_grade: patch.finalGrade } : {}),
    ...(patch.rawGradeMax !== undefined ? { raw_grade_max: patch.rawGradeMax } : {}),
    ...(patch.rawGradeMin !== undefined ? { raw_grade_min: patch.rawGradeMin } : {}),
    ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
    ...(patch.locked !== undefined ? { locked: patch.locked } : {}),
    ...(patch.overridden !== undefined ? { overridden: patch.overridden } : {}),
    ...(patch.excluded !== undefined ? { excluded: patch.excluded } : {}),
    ...(patch.feedback !== undefined ? { feedback: patch.feedback } : {}),
    ...(patch.frozen !== undefined ? { frozen: patch.frozen } : {}),
    ...(patch.aggregationStatus !== undefined ? { aggregation_status: patch.aggregationStatus } : {}),
    ...(patch.aggregationWeight !== undefined ? { aggregation_weight: patch.aggregationWeight } : {}),
    ...(patch.lockTime !== undefined ? { lock_time: patch.lockTime } : {}),
    ...(patch.information !== undefined ? { information: patch.information } : {}),
    ...(patch.createdAt !== undefined ? { created_at: patch.createdAt } : {}),
    updated_at: new Date(),
  };
}

function historyInsertValues(v: NewGradeHistory) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    item_id: v.itemId,
    user_id: v.userId,
    ...(v.oldId !== undefined ? { old_id: v.oldId } : {}),
    ...(v.action !== undefined ? { action: v.action } : {}),
    ...(v.rawGrade !== undefined ? { raw_grade: v.rawGrade } : {}),
    ...(v.finalGrade !== undefined ? { final_grade: v.finalGrade } : {}),
    ...(v.excluded !== undefined ? { excluded: v.excluded } : {}),
    ...(v.frozen !== undefined ? { frozen: v.frozen } : {}),
    ...(v.overridden !== undefined ? { overridden: v.overridden } : {}),
    ...(v.source !== undefined ? { source: v.source } : {}),
    ...(v.loggedUser !== undefined ? { logged_user: v.loggedUser } : {}),
    ...(v.updatedAt !== undefined ? { updated_at: v.updatedAt } : {}),
  };
}

function publicationInsertValues(v: NewGradePublication) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    course_id: v.courseId,
    ...(v.itemId !== undefined ? { item_id: v.itemId } : {}),
    action: v.action,
    scope: v.scope,
    actor_id: v.actorId,
    ...(v.note !== undefined ? { note: v.note } : {}),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
  };
}

/**
 * Kho dữ liệu điểm theo bài: grade item (một item = một bài/hoạt
 * động), điểm theo user, lịch sử điểm và vết công bố cấp bài.
 */
export class GradesRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Handle gốc của repository (điểm mở giao dịch + truy vấn ngoài giao dịch). */
  db(): CentreDb {
    return this.handle;
  }

  /** Mở giao dịch trên handle gốc và chạy `fn` với handle giao dịch. */
  transaction<T>(fn: (tx: GradesTx) => Promise<T>): Promise<T> {
    return this.handle.transaction().execute(fn);
  }

  // items
  /** Chèn grade item. */
  async insertItem(v: NewGradeItem, tx?: GradesDb): Promise<ItemRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('grade_items')
      .values(itemInsertValues(v))
      .returning(ITEM_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Lấy item theo id. */
  async getItem(id: string, tx?: GradesDb): Promise<ItemRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('grade_items')
      .select(ITEM_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Item của khoá học. */
  async listItems(courseId: string, tx?: GradesDb): Promise<ItemRow[]> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('grade_items')
      .select(ITEM_COLUMNS)
      .where('course_id', '=', courseId)
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
  }

  /** Tìm item theo (itemType, itemInstance) — khoá liên kết với hoạt động nguồn. */
  async findItemByTypeInstance(courseId: string, itemType: string, itemInstance: string, tx?: GradesDb): Promise<ItemRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('grade_items')
      .select(ITEM_COLUMNS)
      .where('course_id', '=', courseId)
      .where('item_type', '=', itemType)
      .where('item_instance', '=', itemInstance)
      .executeTakeFirst();
  }

  /** Tìm item gắn với một course module. */
  async findItemForCm(courseId: string, cmId: string, tx?: GradesDb): Promise<ItemRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('grade_items')
      .select(ITEM_COLUMNS)
      .where('course_id', '=', courseId)
      .where('item_type', '=', 'mod')
      .where('item_instance', '=', cmId)
      .executeTakeFirst();
  }

  /**
   * Tìm grade item theo idNumber trong một khoá học (idNumber là định
   * danh duy nhất của item trong khoá khi không null).
   */
  async findItemByIdnumber(courseId: string, idNumber: string, tx?: GradesDb): Promise<ItemRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('grade_items')
      .select(ITEM_COLUMNS)
      .where('course_id', '=', courseId)
      .where('id_number', '=', idNumber)
      .executeTakeFirst();
  }

  /** Cập nhật item. */
  async updateItem(id: string, patch: Partial<ItemRow>, tx?: GradesDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .updateTable('grade_items')
      .set(itemUpdateSet(patch))
      .where('id', '=', id)
      .execute();
  }

  /** Xoá item. */
  async deleteItem(id: string, tx?: GradesDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .deleteFrom('grade_items')
      .where('id', '=', id)
      .execute();
  }

  // grades
  /** Điểm của user tại một item. */
  async getGrade(itemId: string, userId: string, tx?: GradesDb): Promise<GradeRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('grade_grades')
      .select(GRADE_COLUMNS)
      .where('item_id', '=', itemId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }

  /** Mọi điểm của khoá học. */
  async listGradesForCourse(courseId: string, userId?: string, tx?: GradesDb): Promise<GradeRow[]> {
    const db = tx ?? this.handle;
    const items = await this.listItems(courseId, tx);
    if (!items.length) return [];
    let query = db
      .selectFrom('grade_grades')
      .select(GRADE_COLUMNS)
      .where('item_id', 'in', items.map((i) => i.id));
    if (userId !== undefined) query = query.where('user_id', '=', userId);
    return query.execute();
  }

  /** Lấy một bản ghi điểm theo id. */
  async getGradeById(id: string, tx?: GradesDb): Promise<GradeRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('grade_grades')
      .select(GRADE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Mọi điểm tại một item. */
  async listGradesForItem(itemId: string, tx?: GradesDb): Promise<GradeRow[]> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('grade_grades')
      .select(GRADE_COLUMNS)
      .where('item_id', '=', itemId)
      .execute();
  }

  /** Ghi/cập nhật điểm (kèm ghi lịch sử ở tầng service). */
  async upsertGrade(v: NewGrade, tx?: GradesDb): Promise<GradeRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('grade_grades')
      .values(gradeInsertValues(v))
      .onConflict((oc) => oc
        .columns(['item_id', 'user_id'])
        .doUpdateSet(gradeConflictSet(v)))
      .returning(GRADE_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Cập nhật một bản ghi điểm. */
  async updateGrade(id: string, patch: Partial<GradeRow>, tx?: GradesDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .updateTable('grade_grades')
      .set(gradeUpdateSet(patch))
      .where('id', '=', id)
      .execute();
  }

  /** Ghi một dòng lịch sử thay đổi điểm. */
  async insertHistory(v: NewGradeHistory, tx?: GradesDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .insertInto('grade_grades_history')
      .values(historyInsertValues(v))
      .execute();
  }

  /** Lịch sử thay đổi điểm của một item/user. */
  async listHistory(itemId: string, userId: string, tx?: GradesDb): Promise<GradeHistoryRow[]> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('grade_grades_history')
      .select(HISTORY_COLUMNS)
      .where('item_id', '=', itemId)
      .where('user_id', '=', userId)
      .orderBy('id')
      .execute();
  }

  // publications (PH-0, issue #116)
  /** Ghi một hành động công bố/rút công bố cho một item (bảng append-only grade_publications). */
  async insertPublication(v: NewGradePublication, tx?: GradesDb): Promise<GradePublicationRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('grade_publications')
      .values(publicationInsertValues(v))
      .returning(PUBLICATION_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Mọi vết công bố của một khoá theo thứ tự thời gian tăng dần — trạng thái hiệu lực suy từ vết mới nhất của từng item. */
  async listPublications(courseId: string, tx?: GradesDb): Promise<GradePublicationRow[]> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('grade_publications')
      .select(PUBLICATION_COLUMNS)
      .where('course_id', '=', courseId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }
}
