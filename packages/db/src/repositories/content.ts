/**
 * Repository của cụm HỌC LIỆU trên Kysely — chuyển đổi từ
 * repository Drizzle của module content phía `apps/api` (issue
 * #646, nhóm G6 của chiến dịch chuyển tầng dữ liệu sang Kysely).
 *
 * Vai trò: mọi truy cập tới các bảng học liệu của kho trung tâm
 * (pages — trang đọc mod_page, resources — tài nguyên mod_resource,
 * course_last_access — dấu vết mở học gần nhất,
 * course_module_progress — tiến độ xem theo mục, learning_records
 * — hồ sơ hoàn thành) tập trung ở đây. Repository không chứa luật
 * nghiệp vụ — tính "percent chỉ tăng", cổng truy cập và tổng hợp
 * tiến độ nằm ở tầng service phía ứng dụng. Repository này không
 * mở transaction nào (mọi phương thức chạy trên handle gốc), đúng
 * bề mặt của repository cũ.
 *
 * Khuôn hình dạng dữ liệu ở biên repository (theo playbook chuyển
 * đổi của package, đúc từ pilot kho control plane):
 * - Bên trong repository, truy vấn viết trên interface schema sinh
 *   bằng codegen: tên bảng/cột giữ nguyên snake_case của database
 *   (riêng bảng pages/resources, cột khoá ngoại tên là `course`
 *   trong database nên hình dạng camelCase phía tiêu thụ cũng giữ
 *   nguyên tên `course`).
 * - Bên ngoài, repository trả/nhận các hình dạng dòng camelCase như
 *   phía tiêu thụ đang dùng (khớp `$inferSelect`/`$inferInsert` của
 *   repository Drizzle cũ): cột được chọn bằng danh sách tường minh
 *   có bí danh, giá trị ghi được ánh xạ từng trường ở các hàm
 *   `*InsertValues`/`*UpdateSet` trong file này.
 * - Giá trị `undefined` bị LOẠI khỏi values/set trước khi gọi
 *   builder (quy tắc T-4 đã chốt ở pilot); mọi giá trị where là
 *   tham số bắt buộc.
 * - `onConflict` theo khoá phức hợp: last-access neo cặp
 *   (user, course), module-progress neo cặp (user, cm),
 *   learning-records `doNothing()` trên cặp (user, cm) — lần hoàn
 *   thành đầu tiên là bản ghi duy nhất.
 * - Hai đường đọc giữ nguyên hành vi lọc tại tầng JS của repository
 *   cũ: `getLastAccess` đọc theo user rồi khớp course trong bộ nhớ,
 *   `getModuleProgress` đọc theo cm rồi đối chiếu user trong bộ
 *   nhớ — không đổi thành điều kiện SQL để hành vi (và thứ tự dòng
 *   đầu tiên) giữ nguyên.
 */
import type { InsertObject, UpdateObject } from 'kysely';
import type { CentreDb, CentreDB } from '../client';

/** Một dòng trang đọc (mod_page). */
export interface PageRow {
  id: string;
  course: string;
  cmId: string | null;
  name: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một trang đọc mới (khớp `$inferInsert` cũ). */
export interface NewPage {
  id?: string;
  course: string;
  cmId?: string | null;
  name: string;
  content?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Một dòng tài nguyên (mod_resource). */
export interface ResourceRow {
  id: string;
  course: string;
  cmId: string | null;
  name: string;
  kind: string;
  fileId: string | null;
  url: string | null;
  transcript: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một tài nguyên mới (khớp `$inferInsert` cũ). */
export interface NewResource {
  id?: string;
  course: string;
  cmId?: string | null;
  name: string;
  kind?: string;
  fileId?: string | null;
  url?: string | null;
  transcript?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Một dòng dấu vết mở học gần nhất của một học sinh trong một khoá. */
export interface LastAccessRow {
  id: string;
  userId: string;
  courseId: string;
  cmId: string;
  accessedAt: Date;
}

/** Một dòng tiến độ xem một mục của một học sinh. */
export interface ModuleProgressRow {
  id: string;
  userId: string;
  courseId: string;
  cmId: string;
  percent: number;
  positionSeconds: number | null;
  page: number | null;
  updatedAt: Date;
}

/** Một dòng hồ sơ hoàn thành (chụp tên mục tại thời điểm hoàn thành). */
export interface LearningRecordRow {
  id: string;
  userId: string;
  courseId: string;
  cmId: string;
  cmName: string;
  component: string;
  completedAt: Date;
}

/** Dữ kiện ghi một hồ sơ hoàn thành mới (khớp `$inferInsert` cũ). */
export interface NewLearningRecord {
  id?: string;
  userId: string;
  courseId: string;
  cmId: string;
  cmName?: string;
  component?: string;
  completedAt?: Date;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng pages (dùng cho cả select lẫn returning). */
const PAGE_COLUMNS = [
  'id',
  'course',
  'cm_id as cmId',
  'name',
  'content',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng resources. */
const RESOURCE_COLUMNS = [
  'id',
  'course',
  'cm_id as cmId',
  'name',
  'kind',
  'file_id as fileId',
  'url',
  'transcript',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng course_last_access. */
const LAST_ACCESS_COLUMNS = [
  'id',
  'user_id as userId',
  'course_id as courseId',
  'cm_id as cmId',
  'accessed_at as accessedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng course_module_progress. */
const MODULE_PROGRESS_COLUMNS = [
  'id',
  'user_id as userId',
  'course_id as courseId',
  'cm_id as cmId',
  'percent',
  'position_seconds as positionSeconds',
  'page',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng learning_records. */
const LEARNING_RECORD_COLUMNS = [
  'id',
  'user_id as userId',
  'course_id as courseId',
  'cm_id as cmId',
  'cm_name as cmName',
  'component',
  'completed_at as completedAt',
] as const;

/** Ánh xạ dữ kiện ghi trang đọc sang values insert (snake_case), loại `undefined` (quy tắc T-4). */
function pageInsertValues(values: NewPage): InsertObject<CentreDB, 'pages'> {
  const row: InsertObject<CentreDB, 'pages'> = {
    course: values.course,
    name: values.name,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.cmId !== undefined) row.cm_id = values.cmId;
  if (values.content !== undefined) row.content = values.content;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ một patch trang đọc sang set update (snake_case), loại `undefined` từng trường (quy tắc T-4). */
function pageUpdateSet(patch: Partial<NewPage>): UpdateObject<CentreDB, 'pages'> {
  const set: UpdateObject<CentreDB, 'pages'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.course !== undefined) set.course = patch.course;
  if (patch.cmId !== undefined) set.cm_id = patch.cmId;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.content !== undefined) set.content = patch.content;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;
  return set;
}

/** Ánh xạ dữ kiện ghi tài nguyên sang values insert (snake_case), loại `undefined` (quy tắc T-4). */
function resourceInsertValues(values: NewResource): InsertObject<CentreDB, 'resources'> {
  const row: InsertObject<CentreDB, 'resources'> = {
    course: values.course,
    name: values.name,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.cmId !== undefined) row.cm_id = values.cmId;
  if (values.kind !== undefined) row.kind = values.kind;
  if (values.fileId !== undefined) row.file_id = values.fileId;
  if (values.url !== undefined) row.url = values.url;
  if (values.transcript !== undefined) row.transcript = values.transcript;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ một patch tài nguyên sang set update (snake_case), loại `undefined` từng trường (quy tắc T-4). */
function resourceUpdateSet(patch: Partial<NewResource>): UpdateObject<CentreDB, 'resources'> {
  const set: UpdateObject<CentreDB, 'resources'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.course !== undefined) set.course = patch.course;
  if (patch.cmId !== undefined) set.cm_id = patch.cmId;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.fileId !== undefined) set.file_id = patch.fileId;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.transcript !== undefined) set.transcript = patch.transcript;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;
  return set;
}

/** Ánh xạ dữ kiện ghi hồ sơ hoàn thành sang values insert (snake_case), loại `undefined` (quy tắc T-4). */
function learningRecordInsertValues(values: NewLearningRecord): InsertObject<CentreDB, 'learning_records'> {
  const row: InsertObject<CentreDB, 'learning_records'> = {
    user_id: values.userId,
    course_id: values.courseId,
    cm_id: values.cmId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.cmName !== undefined) row.cm_name = values.cmName;
  if (values.component !== undefined) row.component = values.component;
  if (values.completedAt !== undefined) row.completed_at = values.completedAt;
  return row;
}

/**
 * Kho dữ liệu học liệu: trang đọc (mod_page), tài nguyên
 * (mod_resource) và dấu vết mở học gần nhất (last-access) của học
 * sinh trong khoá.
 */
export class ContentRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Instance gốc của repository. */
  private db(): CentreDb {
    return this.handle;
  }

  /** Handle DB gốc — tầng service đọc handle để chạy các truy vấn tổng hợp tiến độ thuộc bảng của cụm khác. */
  get dbHandle(): CentreDb {
    return this.db();
  }

  /** Chèn trang đọc. */
  async insertPage(v: NewPage): Promise<PageRow> {
    const rows = await this.db()
      .insertInto('pages')
      .values(pageInsertValues(v))
      .returning(PAGE_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy trang đọc theo id. */
  async getPage(id: string): Promise<PageRow | undefined> {
    const row = await this.db()
      .selectFrom('pages')
      .select(PAGE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row;
  }

  /** Liệt kê trang đọc của khoá học. */
  async listPages(courseId: string): Promise<PageRow[]> {
    return this.db()
      .selectFrom('pages')
      .select(PAGE_COLUMNS)
      .where('course', '=', courseId)
      .orderBy('id', 'asc')
      .execute();
  }

  /** Cập nhật trang đọc. */
  async updatePage(id: string, v: Partial<NewPage>): Promise<void> {
    await this.db()
      .updateTable('pages')
      .set({ ...pageUpdateSet(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá trang đọc. */
  async deletePage(id: string): Promise<void> {
    await this.db().deleteFrom('pages').where('id', '=', id).execute();
  }

  /** Xoá trang đọc theo cm (dọn dẹp khi course module bị xoá). */
  async deletePageByCm(cmId: string): Promise<void> {
    await this.db().deleteFrom('pages').where('cm_id', '=', cmId).execute();
  }

  /** Chèn tài nguyên. */
  async insertResource(v: NewResource): Promise<ResourceRow> {
    const rows = await this.db()
      .insertInto('resources')
      .values(resourceInsertValues(v))
      .returning(RESOURCE_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy tài nguyên theo id. */
  async getResource(id: string): Promise<ResourceRow | undefined> {
    const row = await this.db()
      .selectFrom('resources')
      .select(RESOURCE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row;
  }

  /** Liệt kê tài nguyên của khoá học. */
  async listResources(courseId: string): Promise<ResourceRow[]> {
    return this.db()
      .selectFrom('resources')
      .select(RESOURCE_COLUMNS)
      .where('course', '=', courseId)
      .orderBy('id', 'asc')
      .execute();
  }

  /** Cập nhật tài nguyên. */
  async updateResource(id: string, v: Partial<NewResource>): Promise<void> {
    await this.db()
      .updateTable('resources')
      .set({ ...resourceUpdateSet(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá tài nguyên. */
  async deleteResource(id: string): Promise<void> {
    await this.db().deleteFrom('resources').where('id', '=', id).execute();
  }

  /** Xoá tài nguyên theo cm (dọn dẹp khi course module bị xoá). */
  async deleteResourceByCm(cmId: string): Promise<void> {
    await this.db().deleteFrom('resources').where('cm_id', '=', cmId).execute();
  }

  /** Ghi/ghi đè dấu vết mở học gần nhất của một học sinh trong một khoá. */
  async upsertLastAccess(userId: string, courseId: string, cmId: string): Promise<LastAccessRow> {
    const rows = await this.db()
      .insertInto('course_last_access')
      .values({ user_id: userId, course_id: courseId, cm_id: cmId, accessed_at: new Date() })
      .onConflict((oc) =>
        oc.columns(['user_id', 'course_id']).doUpdateSet({ cm_id: cmId, accessed_at: new Date() }),
      )
      .returning(LAST_ACCESS_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Đọc dấu vết mở học gần nhất của một học sinh trong một khoá (khớp course trong bộ nhớ như repository cũ). */
  async getLastAccess(userId: string, courseId: string): Promise<LastAccessRow | undefined> {
    const rows = await this.db()
      .selectFrom('course_last_access')
      .select(LAST_ACCESS_COLUMNS)
      .where('user_id', '=', userId)
      .execute();
    return rows.find((r) => r.courseId === courseId);
  }

  /**
   * Ghi tiến độ xem một mục: percent chỉ TĂNG (giữ giá trị cao nhất đã
   * đạt — ôn lại không bị phạt), vị trí dở dang lấy theo lần báo mới
   * nhất.
   */
  async upsertModuleProgress(
    userId: string,
    courseId: string,
    cmId: string,
    patch: { percent?: number; positionSeconds?: number; page?: number },
  ): Promise<ModuleProgressRow> {
    const existing = await this.getModuleProgress(userId, cmId);
    const percent = Math.max(existing?.percent ?? 0, patch.percent ?? 0);
    const positionSeconds = patch.positionSeconds ?? existing?.positionSeconds ?? null;
    const page = patch.page ?? existing?.page ?? null;
    const rows = await this.db()
      .insertInto('course_module_progress')
      .values({
        user_id: userId,
        course_id: courseId,
        cm_id: cmId,
        percent,
        position_seconds: positionSeconds,
        page,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(['user_id', 'cm_id']).doUpdateSet({
          percent,
          position_seconds: positionSeconds,
          page,
          updated_at: new Date(),
        }),
      )
      .returning(MODULE_PROGRESS_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Đọc tiến độ xem một mục của một học sinh (đối chiếu user trong bộ nhớ như repository cũ). */
  async getModuleProgress(userId: string, cmId: string): Promise<ModuleProgressRow | undefined> {
    const row = await this.db()
      .selectFrom('course_module_progress')
      .select(MODULE_PROGRESS_COLUMNS)
      .where('cm_id', '=', cmId)
      .executeTakeFirst();
    return row && row.userId === userId ? row : undefined;
  }

  /**
   * Ghi bản ghi hồ sơ hoàn thành (chụp tên mục tại thời điểm hoàn
   * thành). Idempotent: lần hoàn thành đầu tiên của mỗi (HS, mục) là
   * bản ghi duy nhất — các lần hoàn thành sau không ghi đè.
   */
  async insertLearningRecord(v: NewLearningRecord): Promise<void> {
    await this.db()
      .insertInto('learning_records')
      .values(learningRecordInsertValues(v))
      .onConflict((oc) => oc.columns(['user_id', 'cm_id']).doNothing())
      .execute();
  }

  /** Liệt kê bản ghi hồ sơ hoàn thành của một khoá (cho báo cáo giáo viên). */
  async listLearningRecords(courseId: string): Promise<LearningRecordRow[]> {
    return this.db()
      .selectFrom('learning_records')
      .select(LEARNING_RECORD_COLUMNS)
      .where('course_id', '=', courseId)
      .execute();
  }
}
