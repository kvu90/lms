/**
 * Repository của cụm HOÀN THÀNH (completion) trên Kysely — một phần
 * của nhóm G9 trong chiến dịch chuyển tầng dữ liệu Drizzle → Kysely
 * (issue #649).
 *
 * Vai trò: mọi truy cập tới bốn bảng của miền hoàn thành tập trung
 * ở đây:
 * - `course_modules_completion` — trạng thái hoàn thành đã lưu của
 *   từng course module theo từng học viên (nguồn sự thật mà bề mặt
 *   tiến độ, tổng hợp khoá học và bề mặt phụ huynh đọc).
 * - `course_completion_criteria` — bộ tiêu chí hoàn thành của một
 *   khoá học (tám loại tiêu chí; mỗi khoá một bộ, thay thế toàn bộ
 *   khi cấu hình lại).
 * - `course_completion_crit_compl` — dấu hoàn thành thủ công cho các
 *   tiêu chí loại self/role (có dòng = tiêu chí đã đạt).
 * - `course_completion_settings` — cấu hình tổng hợp của khoá
 *   (phương thức ALL/ANY), một dòng cho mỗi khoá.
 * - `course_completions` — bản ghi hoàn thành khoá học của học viên,
 *   được tổng hợp lại từ bộ tiêu chí; cột `re_aggregate` là mốc gắn
 *   cờ "cần tổng hợp lại".
 *
 * Ba thao tác ghi dạng ghi/đè (upsert) khoá theo khoá duy nhất tự
 * nhiên của bảng và CHỈ cập nhật đúng các cột mà đường Drizzle trước
 * đây cập nhật khi trùng khoá — các cột còn lại của dòng đã có (ví
 * dụ `time_enrolled` của bản ghi hoàn thành khoá học) giữ nguyên khi
 * ghi đè. Repository không chứa luật nghiệp vụ: tính trạng thái, gác
 * capability và phát sự kiện nằm ở tầng service phía ứng dụng.
 * Service sở hữu hai giao dịch ghép "ghi trạng thái hoàn thành + ghi
 * sự kiện outbox" — chúng mở qua phương thức `transaction` của
 * repository này để cả hai ghi cùng nằm trong MỘT giao dịch Kysely,
 * không bao giờ lai với giao dịch của ORM còn lại.
 *
 * Khuôn hình dạng dữ liệu ở biên repository (khuôn của pilot kho
 * control plane, xem sổ tay trong `AGENTS.md` của package): bên
 * trong dùng tên bảng/cột snake_case của interface schema sinh bằng
 * codegen; bên ngoài trả/nhận hình dạng camelCase như phía tiêu thụ
 * đang dùng qua danh sách cột tường minh có bí danh và các hàm ánh
 * xạ ghi `*InsertValues`/`*UpdateSet`. Giá trị `undefined` bị LOẠI
 * khỏi values/set trong các hàm ánh xạ và trong các set của nhánh
 * cập nhật-khi-trùng (thử nghiệm T-4 đã đo ở pilot) — trường vắng
 * mặt phải để default của database quyết định ở nhánh chèn, và giữ
 * nguyên giá trị đã có ở nhánh cập nhật; mọi giá trị trong mệnh đề
 * WHERE đều là tham số bắt buộc, không bao giờ `undefined`.
 * Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh ứng
 * dụng, không tự mở pool.
 */
import type { Insertable, Updateable } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';

/** Handle đọc/ghi mà repository nhận: instance gốc hoặc transaction đang mở của kho trung tâm. */
export type CompletionDb = CentreDb | CentreTx;

/** Một dòng trạng thái hoàn thành của một course module theo một học viên. */
export interface CmCompletionRow {
  id: string;
  courseModuleId: string;
  userId: string;
  /** 0 chưa hoàn thành; 1 hoàn thành; 2 hoàn thành đạt; 3 hoàn thành không đạt. */
  completionState: number;
  /** Học viên đã xem module hay chưa (điều kiện hoàn thành theo lượt xem). */
  viewed: boolean;
  /** Người ghi đè thủ công trạng thái; null khi trạng thái do hệ thống suy ra. */
  overrideBy: string | null;
  updatedAt: Date;
}

/** Một dòng tiêu chí hoàn thành khoá học. */
export interface CriteriaRow {
  id: string;
  /** Khoá học sở hữu tiêu chí. */
  course: string;
  /** module | date | grade | self | course | duration | role | unenrol. */
  criteriaType: string;
  /** Course module đích của tiêu chí loại module; các loại khác để null. */
  moduleInstance: string | null;
  /** Mốc ngày của tiêu chí loại date; các loại khác để null. */
  date: Date | null;
  /** Khoá tiên quyết của tiêu chí loại course; các loại khác để null. */
  courseInstance: string | null;
  /** Số ngày ghi danh của tiêu chí loại duration; các loại khác để null. */
  enrolPeriodDays: number | null;
  /** Vai trò của tiêu chí loại role; các loại khác để null. */
  roleId: string | null;
  /** Thứ tự đánh giá/hiển thị trong bộ tiêu chí. */
  sortOrder: number;
  createdAt: Date;
}

/** Một dòng dấu hoàn thành thủ công của một tiêu chí cho một học viên. */
export interface CritComplRow {
  id: string;
  criteriaId: string;
  userId: string;
  /** Người đánh dấu (chính học viên với tiêu chí self, người có quyền với tiêu chí role). */
  markedBy: string | null;
  timeCompleted: Date;
}

/** Một dòng bản ghi hoàn thành khoá học của một học viên. */
export interface CourseCompletionRow {
  id: string;
  userId: string;
  course: string;
  /** not_started | in_progress | complete. */
  status: string;
  timeEnrolled: Date;
  timeStarted: Date | null;
  timeCompleted: Date | null;
  /** Mốc gắn cờ cần tổng hợp lại gần nhất. */
  reAggregate: Date;
}

/** Dữ kiện ghi trạng thái hoàn thành của một course module cho một học viên. */
export interface NewCmCompletion {
  id?: string;
  courseModuleId: string;
  userId: string;
  completionState?: number;
  viewed?: boolean;
  overrideBy?: string | null;
  updatedAt?: Date;
}

/** Dữ kiện ghi một tiêu chí hoàn thành khoá học. */
export interface NewCriteria {
  id?: string;
  course: string;
  criteriaType: string;
  moduleInstance?: string | null;
  date?: Date | null;
  courseInstance?: string | null;
  enrolPeriodDays?: number | null;
  roleId?: string | null;
  sortOrder?: number;
  createdAt?: Date;
}

/** Dữ kiện ghi một dấu hoàn thành thủ công. */
export interface NewCritCompl {
  id?: string;
  criteriaId: string;
  userId: string;
  markedBy?: string | null;
  timeCompleted?: Date;
}

/** Dữ kiện ghi một bản ghi hoàn thành khoá học. */
export interface NewCourseCompletion {
  id?: string;
  userId: string;
  course: string;
  status?: string;
  timeEnrolled?: Date;
  timeStarted?: Date | null;
  timeCompleted?: Date | null;
  reAggregate?: Date;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng trạng thái hoàn thành của course module. */
const CM_COMPLETION_COLUMNS = [
  'id',
  'course_module_id as courseModuleId',
  'user_id as userId',
  'completion_state as completionState',
  'viewed',
  'override_by as overrideBy',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng tiêu chí hoàn thành khoá học. */
const CRITERIA_COLUMNS = [
  'id',
  'course',
  'criteria_type as criteriaType',
  'module_instance as moduleInstance',
  'date',
  'course_instance as courseInstance',
  'enrol_period_days as enrolPeriodDays',
  'role_id as roleId',
  'sort_order as sortOrder',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng dấu hoàn thành thủ công. */
const CRIT_COMPL_COLUMNS = [
  'id',
  'criteria_id as criteriaId',
  'user_id as userId',
  'marked_by as markedBy',
  'time_completed as timeCompleted',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng bản ghi hoàn thành khoá học. */
const COURSE_COMPLETION_COLUMNS = [
  'id',
  'user_id as userId',
  'course',
  'status',
  'time_enrolled as timeEnrolled',
  'time_started as timeStarted',
  'time_completed as timeCompleted',
  're_aggregate as reAggregate',
] as const;

/**
 * Ánh xạ dữ kiện ghi trạng thái hoàn thành cm (camelCase) sang
 * values insert (snake_case), LOẠI mọi trường `undefined` (quy tắc
 * T-4 trong sổ tay của package).
 */
function cmCompletionInsertValues(values: NewCmCompletion): Insertable<CentreDB['course_modules_completion']> {
  const row: Insertable<CentreDB['course_modules_completion']> = {
    course_module_id: values.courseModuleId,
    user_id: values.userId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.completionState !== undefined) row.completion_state = values.completionState;
  if (values.viewed !== undefined) row.viewed = values.viewed;
  if (values.overrideBy !== undefined) row.override_by = values.overrideBy;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/**
 * Ánh xạ dữ kiện ghi tiêu chí (camelCase) sang values insert
 * (snake_case), LOẠI mọi trường `undefined` (quy tắc T-4).
 */
function criteriaInsertValues(values: NewCriteria): Insertable<CentreDB['course_completion_criteria']> {
  const row: Insertable<CentreDB['course_completion_criteria']> = {
    course: values.course,
    criteria_type: values.criteriaType,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.moduleInstance !== undefined) row.module_instance = values.moduleInstance;
  if (values.date !== undefined) row.date = values.date;
  if (values.courseInstance !== undefined) row.course_instance = values.courseInstance;
  if (values.enrolPeriodDays !== undefined) row.enrol_period_days = values.enrolPeriodDays;
  if (values.roleId !== undefined) row.role_id = values.roleId;
  if (values.sortOrder !== undefined) row.sort_order = values.sortOrder;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/**
 * Ánh xạ dữ kiện ghi dấu hoàn thành thủ công (camelCase) sang values
 * insert (snake_case), LOẠI mọi trường `undefined` (quy tắc T-4).
 */
function critComplInsertValues(values: NewCritCompl): Insertable<CentreDB['course_completion_crit_compl']> {
  const row: Insertable<CentreDB['course_completion_crit_compl']> = {
    criteria_id: values.criteriaId,
    user_id: values.userId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.markedBy !== undefined) row.marked_by = values.markedBy;
  if (values.timeCompleted !== undefined) row.time_completed = values.timeCompleted;
  return row;
}

/**
 * Ánh xạ dữ kiện ghi bản ghi hoàn thành khoá học (camelCase) sang
 * values insert (snake_case), LOẠI mọi trường `undefined` (quy tắc
 * T-4).
 */
function courseCompletionInsertValues(values: NewCourseCompletion): Insertable<CentreDB['course_completions']> {
  const row: Insertable<CentreDB['course_completions']> = {
    user_id: values.userId,
    course: values.course,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.status !== undefined) row.status = values.status;
  if (values.timeEnrolled !== undefined) row.time_enrolled = values.timeEnrolled;
  if (values.timeStarted !== undefined) row.time_started = values.timeStarted;
  if (values.timeCompleted !== undefined) row.time_completed = values.timeCompleted;
  if (values.reAggregate !== undefined) row.re_aggregate = values.reAggregate;
  return row;
}

/**
 * Kho dữ liệu hoàn thành trên Kysely: trạng thái completion của cm
 * theo user, tiêu chí hoàn thành khoá học, cấu hình và bản ghi hoàn
 * thành khoá học.
 *
 * Handle gốc được truyền lúc khởi tạo (facade định tuyến của kho
 * trung tâm do tầng ứng dụng cấp); mọi phương thức nhận thêm handle
 * tuỳ chọn để phía gọi ghép thao tác vào transaction đang mở của
 * chúng — repository không tự mở transaction ngoài phương thức
 * `transaction` tường minh.
 */
export class CompletionRepository {
  constructor(private readonly handle: CompletionDb) {}

  /** Instance gốc của repository. */
  private db(): CompletionDb {
    return this.handle;
  }

  /** Mở một transaction trên kho trung tâm và chạy `fn` với handle giao dịch. */
  async transaction<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.db().transaction().execute(fn);
  }

  /** Trạng thái hoàn thành một cm của một user. */
  async getCmCompletion(cmid: string, userId: string, db: CompletionDb = this.db()): Promise<CmCompletionRow | undefined> {
    return db
      .selectFrom('course_modules_completion')
      .select(CM_COMPLETION_COLUMNS)
      .where('course_module_id', '=', cmid)
      .where('user_id', '=', userId)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Ghi/cập nhật trạng thái hoàn thành cm. Khi dòng đã có (trùng
   * khoá duy nhất cặp cm + user), chỉ các cột trạng thái đổi: trạng
   * thái, cờ đã xem và người ghi đè (trường nào vắng mặt trong dữ
   * kiện ghi thì giữ nguyên giá trị đã có), kèm mốc cập nhật hiện
   * tại — đúng tập cột của nhánh cập nhật ở đường Drizzle trước đây.
   */
  async upsertCmCompletion(v: NewCmCompletion, db: CompletionDb = this.db()): Promise<CmCompletionRow> {
    const set: Updateable<CentreDB['course_modules_completion']> = { updated_at: new Date() };
    if (v.completionState !== undefined) set.completion_state = v.completionState;
    if (v.viewed !== undefined) set.viewed = v.viewed;
    if (v.overrideBy !== undefined) set.override_by = v.overrideBy;
    const rows = await db
      .insertInto('course_modules_completion')
      .values(cmCompletionInsertValues(v))
      .onConflict((oc) => oc.columns(['course_module_id', 'user_id']).doUpdateSet(set))
      .returning(CM_COMPLETION_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Mọi trạng thái hoàn thành cm của user trong khoá học. */
  async listCmCompletionsForUser(
    userId: string,
    cmIds: string[],
    db: CompletionDb = this.db(),
  ): Promise<CmCompletionRow[]> {
    if (!cmIds.length) return [];
    return db
      .selectFrom('course_modules_completion')
      .select(CM_COMPLETION_COLUMNS)
      .where('user_id', '=', userId)
      .where('course_module_id', 'in', cmIds)
      .execute();
  }

  /** Mọi trạng thái hoàn thành của một cm. */
  async listCmCompletionsForCm(cmid: string, db: CompletionDb = this.db()): Promise<CmCompletionRow[]> {
    return db
      .selectFrom('course_modules_completion')
      .select(CM_COMPLETION_COLUMNS)
      .where('course_module_id', '=', cmid)
      .execute();
  }

  /** Xoá trạng thái hoàn thành khi cm bị xoá; trả về số dòng đã xoá. */
  async deleteCmCompletionsForCm(cmid: string, db: CompletionDb = this.db()): Promise<number> {
    const deleted = await db
      .deleteFrom('course_modules_completion')
      .where('course_module_id', '=', cmid)
      .returning(['id'])
      .execute();
    return deleted.length;
  }

  /** Cm đã có bất kỳ bản ghi hoàn thành nào chưa (probe dữ liệu liên quan). */
  async hasAnyCmCompletion(userId: string, cmIds: string[], db: CompletionDb = this.db()): Promise<boolean> {
    const rows = await this.listCmCompletionsForUser(userId, cmIds, db);
    return rows.length > 0;
  }

  /** Thêm một tiêu chí hoàn thành khoá học. */
  async insertCriteria(v: NewCriteria, db: CompletionDb = this.db()): Promise<CriteriaRow> {
    const rows = await db
      .insertInto('course_completion_criteria')
      .values(criteriaInsertValues(v))
      .returning(CRITERIA_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Tiêu chí của khoá học, theo thứ tự đã khai (sortOrder rồi id). */
  async listCriteria(courseId: string, db: CompletionDb = this.db()): Promise<CriteriaRow[]> {
    return db
      .selectFrom('course_completion_criteria')
      .select(CRITERIA_COLUMNS)
      .where('course', '=', courseId)
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  /** Xoá một tiêu chí theo id (khi đặt lại bộ tiêu chí, service xoá từng tiêu chí cũ). */
  async deleteCriteria(id: string, db: CompletionDb = this.db()): Promise<void> {
    await db.deleteFrom('course_completion_criteria').where('id', '=', id).execute();
  }

  /** Một tiêu chí theo id (kèm kiểm tra thuộc khoá học ở tầng nghiệp vụ). */
  async getCriteria(id: string, db: CompletionDb = this.db()): Promise<CriteriaRow | undefined> {
    return db
      .selectFrom('course_completion_criteria')
      .select(CRITERIA_COLUMNS)
      .where('id', '=', id)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Các khoá học có tiêu chí 'course' trỏ vào khoá học này (khoá phụ
   * thuộc vào khoá tiên quyết) — dùng để đánh giá lại khi khoá tiên
   * quyết hoàn thành. Một khoá phụ thuộc xuất hiện đúng một lần dù
   * có nhiều tiêu chí cùng trỏ vào cùng khoá tiên quyết.
   */
  async listDependentCourseIds(prerequisiteCourseId: string, db: CompletionDb = this.db()): Promise<string[]> {
    const rows = await db
      .selectFrom('course_completion_criteria')
      .select(['course'])
      .where('criteria_type', '=', 'course')
      .where('course_instance', '=', prerequisiteCourseId)
      .execute();
    return [...new Set(rows.map((r) => r.course))];
  }

  /**
   * Dấu hoàn thành thủ công (crit_compl) của một tiêu chí cho một
   * user: có dòng = tiêu chí thủ công (self/role) đã đạt.
   */
  async getCritCompl(criteriaId: string, userId: string, db: CompletionDb = this.db()): Promise<CritComplRow | undefined> {
    return db
      .selectFrom('course_completion_crit_compl')
      .select(CRIT_COMPL_COLUMNS)
      .where('criteria_id', '=', criteriaId)
      .where('user_id', '=', userId)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Mọi dấu hoàn thành thủ công của user trong tập tiêu chí cho
   * trước (nạp một lần cho tầng đánh giá).
   */
  async listCritComplForUser(criteriaIds: string[], userId: string, db: CompletionDb = this.db()): Promise<CritComplRow[]> {
    if (!criteriaIds.length) return [];
    return db
      .selectFrom('course_completion_crit_compl')
      .select(CRIT_COMPL_COLUMNS)
      .where('user_id', '=', userId)
      .where('criteria_id', 'in', criteriaIds)
      .execute();
  }

  /**
   * Ghi dấu hoàn thành thủ công cho một tiêu chí (ghi lại thì cập
   * nhật người đánh dấu và thời điểm).
   */
  async upsertCritCompl(v: NewCritCompl, db: CompletionDb = this.db()): Promise<CritComplRow> {
    const set: Updateable<CentreDB['course_completion_crit_compl']> = { time_completed: new Date() };
    if (v.markedBy !== undefined) set.marked_by = v.markedBy;
    const rows = await db
      .insertInto('course_completion_crit_compl')
      .values(critComplInsertValues(v))
      .onConflict((oc) => oc.columns(['criteria_id', 'user_id']).doUpdateSet(set))
      .returning(CRIT_COMPL_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Xoá dấu hoàn thành thủ công (bỏ đánh dấu). */
  async deleteCritCompl(criteriaId: string, userId: string, db: CompletionDb = this.db()): Promise<void> {
    await db
      .deleteFrom('course_completion_crit_compl')
      .where('criteria_id', '=', criteriaId)
      .where('user_id', '=', userId)
      .execute();
  }

  /**
   * Cấu hình completion của khoá học; khoá chưa từng cấu hình thì
   * trả cấu hình mặc định `{ method: 1 }` (tổng hợp ALL) như đường
   * cũ — không tự ghi dòng cấu hình khi đọc.
   */
  async getSettings(courseId: string, db: CompletionDb = this.db()): Promise<{ method: number }> {
    const row = await db
      .selectFrom('course_completion_settings')
      .select(['method'])
      .where('course', '=', courseId)
      .limit(1)
      .executeTakeFirst();
    return row ?? { method: 1 };
  }

  /** Ghi cấu hình completion (một dòng duy nhất theo khoá học; ghi lại thì đổi phương thức). */
  async setSettings(courseId: string, method: number, db: CompletionDb = this.db()): Promise<void> {
    await db
      .insertInto('course_completion_settings')
      .values({ course: courseId, method })
      .onConflict((oc) => oc.column('course').doUpdateSet({ method }))
      .execute();
  }

  /** Bản ghi hoàn thành khoá học của user. */
  async getCourseCompletion(
    userId: string,
    courseId: string,
    db: CompletionDb = this.db(),
  ): Promise<CourseCompletionRow | undefined> {
    return db
      .selectFrom('course_completions')
      .select(COURSE_COMPLETION_COLUMNS)
      .where('user_id', '=', userId)
      .where('course', '=', courseId)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Ghi/cập nhật bản ghi hoàn thành khoá học. Khi dòng đã có (trùng
   * khoá duy nhất cặp user + khoá), chỉ trạng thái và các mốc bắt
   * đầu/hoàn thành đổi theo dữ kiện ghi (trường vắng mặt thì giữ
   * nguyên), mốc gắn cờ tổng hợp lại luôn lấy thời điểm ghi — cột
   * `time_enrolled` không nằm trong nhánh cập nhật nên giữ nguyên
   * như đường Drizzle trước đây.
   */
  async upsertCourseCompletion(v: NewCourseCompletion, db: CompletionDb = this.db()): Promise<CourseCompletionRow> {
    const set: Updateable<CentreDB['course_completions']> = { re_aggregate: new Date() };
    if (v.status !== undefined) set.status = v.status;
    if (v.timeStarted !== undefined) set.time_started = v.timeStarted;
    if (v.timeCompleted !== undefined) set.time_completed = v.timeCompleted;
    const rows = await db
      .insertInto('course_completions')
      .values(courseCompletionInsertValues(v))
      .returning(COURSE_COMPLETION_COLUMNS)
      .onConflict((oc) => oc.columns(['user_id', 'course']).doUpdateSet(set))
      .execute();
    return rows[0]!;
  }

  /** Mọi bản ghi hoàn thành của khoá học. */
  async listCourseCompletions(courseId: string, db: CompletionDb = this.db()): Promise<CourseCompletionRow[]> {
    return db
      .selectFrom('course_completions')
      .select(COURSE_COMPLETION_COLUMNS)
      .where('course', '=', courseId)
      .execute();
  }
}
