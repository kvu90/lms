/**
 * Repository của module DASHBOARD trên Kysely — hạng mục nhóm C của
 * chiến dịch chuyển tầng dữ liệu sang `packages/db` + Kysely (issue
 * #652), chuyển từ repository Drizzle cũ ở
 * `apps/api/src/modules/dashboard/dashboard.repository.ts`.
 *
 * Vai trò: mọi truy cập dữ liệu của dashboard việc cần làm (DASH1,
 * issue #121) — tập khoá người dùng thuộc về (ghi danh hiệu lực, gán
 * vai tại context khoá), các nguồn việc đến hạn (quiz, bài tập), điểm
 * và vết công bố, hàng đợi chấm (bài nộp chờ chấm, lượt quiz chờ chấm
 * tay, phiếu giấy chờ xử lý), mốc xem dashboard và tuỳ chọn thẻ khoá
 * cá nhân. Mọi truy vấn đều GOM theo tập khoá của người dùng trong
 * một câu SQL cho mỗi nguồn — không vòng lặp truy vấn theo từng khoá.
 * Luật nghiệp vụ (lọc công bố điểm qua facade Grades, xác định đội
 * giảng dạy qua evaluator) nằm ở tầng service phía ứng dụng;
 * repository này chỉ là lớp truy cập dữ liệu thuần.
 *
 * Cổng phụ thuộc registry ngữ cảnh: định nghĩa các mức ngữ cảnh
 * (`CONTEXT_LEVELS`) là registry sống phía ứng dụng (module access)
 * và là NGUỒN ĐỊNH NGHĨA DUY NHẤT của hệ — package này cấm giữ bản
 * sao của registry (hai nguồn định nghĩa là lỗi thiết kế). Vì vậy
 * file này chỉ khai HÌNH DẠNG của registry: danh sách khoá
 * (`CONTEXT_LEVEL_KEYS`) và kiểu ánh xạ khoá → số mức
 * (`ContextLevels`). Giá trị số thật của từng mức do phía ứng dụng
 * cấp qua tham số constructor (điểm tiêm là DI token trong module
 * dashboard phía `apps/api`, implementation trỏ thẳng tới registry
 * hiện hành). Tại thời điểm chuyển đổi, repository chỉ tiêu thụ đúng
 * một khoá qua cổng: `COURSE` (lọc gán vai tại context khoá).
 *
 * Khuôn hình dạng dữ liệu ở biên repository — cùng khuôn pilot kho
 * control plane (xem mục "Sổ tay chuyển đổi repository sang Kysely"
 * trong `AGENTS.md` của package): bên trong dùng tên cột snake_case
 * của interface schema codegen; bên ngoài giữ nguyên hợp đồng dòng
 * camelCase của repository Drizzle cũ qua danh sách cột tường minh
 * có bí danh; các hàm ánh xạ ghi loại `undefined` từng trường (thử
 * nghiệm T-4); mọi giá trị where là tham số bắt buộc. Module này
 * không tham gia transaction nào (kiểm kê tại file cũ: 0 điểm mở
 * transaction, phía service gọi từng method độc lập) nên repository
 * không nhận handle giao dịch — cấm giao dịch lai vì vậy không có
 * bề mặt để vi phạm.
 *
 * Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh ứng
 * dụng, không tự mở pool, không đọc biến môi trường.
 */
import { sql } from 'kysely';
import type { CentreDb } from '../client';

/**
 * Danh sách khoá của registry mức ngữ cảnh — HÌNH DẠNG của registry,
 * không phải giá trị của nó: hằng này chỉ nêu các khoá tồn tại trong
 * registry phía ứng dụng, tuyệt đối không mang số mức của bất kỳ
 * khoá nào. Đổi hình dạng registry (thêm/bớt khoá) thì sửa hằng này
 * cùng interface `ContextLevels` ở lượt chạm tương ứng; đổi GIÁ TRỊ
 * số mức chỉ sửa ở registry phía ứng dụng, package không phải chạm.
 */
export const CONTEXT_LEVEL_KEYS = [
  'SYSTEM',
  'TENANT',
  'USER',
  'COURSECAT',
  'CLASS',
  'COURSE',
  'MODULE',
  'BLOCK',
] as const;

/** Một khoá của registry mức ngữ cảnh (phần tử của `CONTEXT_LEVEL_KEYS`). */
export type ContextLevelKey = (typeof CONTEXT_LEVEL_KEYS)[number];

/**
 * Cổng phụ thuộc tới registry mức ngữ cảnh: ánh xạ mỗi khoá của
 * registry sang số mức của nó. Đây là interface cổng duy nhất mà
 * package cần từ registry — phía ứng dụng cấp object registry thật
 * (đúng hình dạng này) qua điểm tiêm; package không biết và không
 * giữ giá trị cụ thể nào.
 */
export interface ContextLevels {
  /** Mức ngữ cảnh hệ thống. */
  readonly SYSTEM: number;
  /** Mức ngữ cảnh trung tâm (tenant). */
  readonly TENANT: number;
  /** Mức ngữ cảnh người dùng. */
  readonly USER: number;
  /** Mức ngữ cảnh danh mục khoá. */
  readonly COURSECAT: number;
  /** Mức ngữ cảnh lớp. */
  readonly CLASS: number;
  /** Mức ngữ cảnh khoá học — khoá duy nhất repository này tiêu thụ. */
  readonly COURSE: number;
  /** Mức ngữ cảnh module hoạt động trong khoá. */
  readonly MODULE: number;
  /** Mức ngữ cảnh khối trong module. */
  readonly BLOCK: number;
}

/** Handle truy vấn kho trung tâm mà repository giữ: facade định tuyến theo không gian do phía ứng dụng cấp. */
export type DashboardDb = CentreDb;

/** Một dòng mốc xem dashboard của một người dùng (bảng `user_dashboard_state`). */
export interface DashboardStateRow {
  /** Người dùng sở hữu mốc xem. */
  userId: string;
  /** Mốc "lần xem trước" phía server dùng để tính điểm/phản hồi mới. */
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng tuỳ chọn thẻ khoá cá nhân (bảng `user_course_card_prefs`). */
export interface CardPrefRow {
  userId: string;
  courseId: string;
  /** Token màu thuộc danh sách màu thẻ khoá ở contracts; null = mặc định. */
  color: string | null;
  /** Biệt danh tự đặt; null = dùng tên gốc của khoá. */
  nickname: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng quiz có hạn nộp kèm trạng thái attempt của chính người dùng. */
export interface DashboardQuizDueRow {
  /** Id bản ghi module trong khoá (`course_modules`). */
  cmId: string;
  /** Id pin bài kiểm tra (instance của module); null khi module chưa gắn instance. */
  activityId: string | null;
  courseId: string;
  /** Tên hiển thị: tên pin nếu có, không thì tên phiên bản đề. */
  name: string;
  /** Hạn nộp; luôn khác null theo điều kiện truy vấn. */
  dueAt: Date | null;
  /** Trạng thái attempt của chính người dùng; null = chưa có attempt thật nào. */
  attemptState: string | null;
}

/** Một dòng bài tập có hạn nộp kèm trạng thái bài nộp hiện hành của chính người dùng. */
export interface DashboardAssignmentDueRow {
  cmId: string;
  activityId: string | null;
  courseId: string;
  name: string;
  /** Hạn nộp; luôn khác null theo điều kiện truy vấn. */
  dueAt: Date | null;
  /** Trạng thái bài nộp của chính người dùng; null = chưa từng nộp. */
  submissionStatus: string | null;
}

/** Một dòng điểm của chính người dùng trên một item lá của khoá. */
export interface DashboardGradeRow {
  gradeId: string;
  courseId: string;
  itemId: string;
  itemName: string;
  itemType: string;
  finalGrade: number | null;
  gradeMax: number;
  feedback: string | null;
  updatedAt: Date;
}

/** Một vết công bố điểm phạm vi item (bảng `grade_publications`). */
export interface DashboardGradePublicationRow {
  id: string;
  courseId: string;
  /** Item được công bố; null ở các vết không gắn item cụ thể. */
  itemId: string | null;
  scope: string;
  action: string;
  actorId: string;
  note: string | null;
  createdAt: Date;
}

/** Một bài nộp đang chờ chấm kèm trạng thái gói chấm của đúng attempt hiện tại. */
export interface DashboardAssignmentPendingRow {
  courseId: string;
  submittedAt: Date | null;
  /** Trạng thái gói chấm của attempt hiện tại; null = chưa có gói chấm. */
  gradeStatus: string | null;
}

/** Một lượt quiz đã nộp còn câu chờ chấm tay. */
export interface DashboardQuizPendingRow {
  courseId: string;
  timeFinish: Date | null;
  timeStart: Date;
}

/** Một phiếu giấy đang chờ giáo viên xử lý (chỉ hai trạng thái chờ). */
export interface DashboardPaperPendingRow {
  courseId: string;
  /** Pin bài kiểm tra đích để deep-link tới hàng đợi phiếu của quiz đó. */
  pinId: string;
  createdAt: Date;
}

/** Danh sách cột của `user_dashboard_state` với bí danh camelCase — dùng chung cho select và returning của bảng. */
const STATE_COLUMNS = [
  'user_id as userId',
  'last_seen_at as lastSeenAt',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột của `user_course_card_prefs` với bí danh camelCase — dùng chung cho select và returning của bảng. */
const PREF_COLUMNS = [
  'user_id as userId',
  'course_id as courseId',
  'color',
  'nickname',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột của `grade_publications` với bí danh camelCase. */
const PUBLICATION_COLUMNS = [
  'id',
  'course_id as courseId',
  'item_id as itemId',
  'scope',
  'action',
  'actor_id as actorId',
  'note',
  'created_at as createdAt',
] as const;

/** Danh sách cột của phép nối điểm ↔ item, dùng chung cho hai method đọc điểm của chính người dùng. */
const GRADE_COLUMNS = [
  'grade_grades.id as gradeId',
  'grade_items.course_id as courseId',
  'grade_grades.item_id as itemId',
  'grade_items.item_name as itemName',
  'grade_items.item_type as itemType',
  'grade_grades.final_grade as finalGrade',
  'grade_items.grade_max as gradeMax',
  'grade_grades.feedback as feedback',
  'grade_grades.updated_at as updatedAt',
] as const;

/**
 * Ánh xạ ghi cho `user_dashboard_state` (khuôn T-4): từng trường
 * camelCase → snake_case tường minh. Cả hai trường đều bắt buộc ở
 * điểm gọi nên không có `undefined` nào cần loại; hàm này là điểm
 * duy nhất dựng values của bảng để hình dạng ghi không rải rác.
 */
function stateInsertValues(userId: string, at: Date) {
  return { user_id: userId, last_seen_at: at };
}

/**
 * Ánh xạ ghi cho `user_course_card_prefs` (khuôn T-4): `color` và
 * `nickname` mang kiểu `string | null` tường minh ở chữ ký — null là
 * giá trị nghiệp vụ (xoá màu/biệt danh) nên được ghi thẳng thành
 * NULL, không bao giờ là `undefined`.
 */
function prefInsertValues(userId: string, courseId: string, color: string | null, nickname: string | null) {
  return { user_id: userId, course_id: courseId, color, nickname };
}

/**
 * Kho dữ liệu Dashboard việc cần làm (DASH1, issue #121): mọi truy
 * vấn đều GOM theo tập khoá của người dùng trong một câu SQL cho mỗi
 * nguồn — không vòng lặp truy vấn theo từng khoá.
 */
export class DashboardRepository {
  /**
   * @param handle - Handle Kysely kho trung tâm (facade định tuyến theo không gian do phía ứng dụng cấp).
   * @param contextLevels - Implementation của cổng registry mức ngữ cảnh do phía ứng dụng cấp từ registry hiện hành; repository chỉ đọc khoá `COURSE` qua cổng này.
   */
  constructor(
    private readonly handle: CentreDb,
    private readonly contextLevels: ContextLevels,
  ) {}

  /** Instance gốc của repository. */
  private db(): CentreDb {
    return this.handle;
  }

  /** Khoá user đang ghi danh hiệu lực (user_enrolments active, chưa hết hạn). */
  async enrolledCourseIds(userId: string, now: Date): Promise<string[]> {
    const rows = await this.db()
      .selectFrom('user_enrolments')
      .innerJoin('enrol', 'enrol.id', 'user_enrolments.enrol_id')
      .select('enrol.course_id as courseId')
      .distinct()
      .where('user_enrolments.user_id', '=', userId)
      .where('user_enrolments.status', '=', 0)
      .where((eb) =>
        eb.or([
          eb('user_enrolments.time_end', 'is', null),
          eb('user_enrolments.time_end', '>', now),
        ]),
      )
      .execute();
    return rows.map((r) => r.courseId);
  }

  /** Khoá user có gán vai trực tiếp tại context khoá (ứng viên đội giảng dạy). */
  async roleAssignedCourseIds(userId: string): Promise<string[]> {
    const rows = await this.db()
      .selectFrom('role_assignments')
      .innerJoin('context', 'context.id', 'role_assignments.context_id')
      .select('context.instance_id as courseId')
      .distinct()
      .where('role_assignments.user_id', '=', userId)
      .where('context.context_level', '=', this.contextLevels.COURSE)
      .where('context.instance_id', 'is not', null)
      .execute();
    return rows.map((r) => r.courseId!).filter(Boolean);
  }

  /** Tên hiển thị của một tập khoá: courseId → fullName. */
  async courseNames(courseIds: string[]): Promise<Map<string, string>> {
    if (!courseIds.length) return new Map();
    const rows = await this.db()
      .selectFrom('course')
      .select(['id', 'full_name as fullName'])
      .where('id', 'in', courseIds)
      .execute();
    return new Map(rows.map((r) => [r.id, r.fullName]));
  }

  /** Quiz có hạn nộp trong tập khoá kèm các attempt của chính user. */
  async quizDueRows(courseIds: string[], userId: string, until: Date): Promise<DashboardQuizDueRow[]> {
    if (!courseIds.length) return [];
    return this.db()
      .selectFrom('course_modules')
      .innerJoin('exam_pins', 'exam_pins.id', 'course_modules.instance_id')
      .innerJoin('exam_versions', 'exam_versions.id', 'exam_pins.exam_version_id')
      .leftJoin('exam_attempts', (join) =>
        join
          .onRef('exam_attempts.pin_id', '=', 'exam_pins.id')
          .on('exam_attempts.user_id', '=', userId)
          .on('exam_attempts.preview', '=', false),
      )
      .select([
        'course_modules.id as cmId',
        'course_modules.instance_id as activityId',
        'course_modules.course as courseId',
        sql<string>`coalesce(exam_pins.name, exam_versions.name)`.as('name'),
        'exam_pins.time_close as dueAt',
        'exam_attempts.state as attemptState',
      ])
      .where('course_modules.course', 'in', courseIds)
      .where('course_modules.component', '=', 'mod_quiz')
      .where('course_modules.visible', '=', true)
      .where('course_modules.deletion_in_progress', '=', false)
      .where('exam_pins.time_close', 'is not', null)
      .where('exam_pins.time_close', '<=', until)
      .orderBy('exam_pins.time_close', 'asc')
      .execute();
  }

  /** Bài tập C2 có hạn nộp trong tập khoá kèm bài nộp hiện hành của chính user. */
  async assignmentDueRows(courseIds: string[], userId: string, until: Date): Promise<DashboardAssignmentDueRow[]> {
    if (!courseIds.length) return [];
    return this.db()
      .selectFrom('course_modules')
      .innerJoin('assignments', 'assignments.id', 'course_modules.instance_id')
      .leftJoin('assign_submissions', (join) =>
        join
          .onRef('assign_submissions.assignment_id', '=', 'assignments.id')
          .on('assign_submissions.user_id', '=', userId),
      )
      .select([
        'course_modules.id as cmId',
        'course_modules.instance_id as activityId',
        'course_modules.course as courseId',
        'assignments.name as name',
        'assignments.due_date as dueAt',
        'assign_submissions.status as submissionStatus',
      ])
      .where('course_modules.course', 'in', courseIds)
      .where('course_modules.component', '=', 'mod_assign')
      .where('course_modules.visible', '=', true)
      .where('course_modules.deletion_in_progress', '=', false)
      .where('assignments.due_date', 'is not', null)
      .where('assignments.due_date', '<=', until)
      .orderBy('assignments.due_date', 'asc')
      .execute();
  }

  /**
   * Phép nối điểm ↔ item dùng chung cho hai method đọc điểm: điểm
   * của chính user, item thuộc khoá, và chỉ dòng CÓ nội dung hiển
   * thị (điểm đã nhập hoặc phản hồi khác rỗng) — điều kiện boolean
   * ghép bằng expression builder, cùng cây điều kiện với mảnh SQL
   * của đường cũ.
   */
  private gradeRowsQuery() {
    return this.db()
      .selectFrom('grade_grades')
      .innerJoin('grade_items', 'grade_items.id', 'grade_grades.item_id')
      .select(GRADE_COLUMNS)
      .where((eb) =>
        eb.or([
          eb('grade_grades.final_grade', 'is not', null),
          eb.and([
            eb('grade_grades.feedback', 'is not', null),
            eb('grade_grades.feedback', '<>', ''),
          ]),
        ]),
      );
  }

  /** Điểm của chính user thay đổi sau mốc (chưa lọc công bố — service lọc bằng GradesService). */
  async gradeRowsSince(courseIds: string[], userId: string, since: Date): Promise<DashboardGradeRow[]> {
    if (!courseIds.length) return [];
    return this.gradeRowsQuery()
      .where('grade_grades.user_id', '=', userId)
      .where('grade_items.course_id', 'in', courseIds)
      .where('grade_grades.updated_at', '>', since)
      .orderBy('grade_grades.updated_at', 'asc')
      .execute();
  }

  /**
   * Mọi vết công bố scope item trong tập khoá — service suy ra: (a) hiệu
   * lực công bố hiện tại theo vết mới nhất, (b) ứng viên "mới": điểm chấm
   * TRƯỚC mốc nhưng chỉ được CÔNG BỐ sau mốc thì thời điểm trở nên hiển
   * thị là thời điểm công bố, không phải thời điểm chấm.
   */
  async itemPublications(courseIds: string[]): Promise<DashboardGradePublicationRow[]> {
    if (!courseIds.length) return [];
    return this.db()
      .selectFrom('grade_publications')
      .select(PUBLICATION_COLUMNS)
      .where('grade_publications.course_id', 'in', courseIds)
      .where('grade_publications.scope', '=', 'item')
      .orderBy('grade_publications.created_at', 'asc')
      .execute();
  }

  /** Điểm của chính user trên một tập item cụ thể (ứng viên từ vết công bố sau mốc). */
  async gradeRowsForItems(itemIds: string[], userId: string): Promise<DashboardGradeRow[]> {
    if (!itemIds.length) return [];
    return this.gradeRowsQuery()
      .where('grade_grades.user_id', '=', userId)
      .where('grade_grades.item_id', 'in', itemIds)
      .execute();
  }

  /** Bài nộp C2 đang chờ chấm trong tập khoá kèm trạng thái gói chấm của đúng attempt hiện tại. */
  async assignmentPendingRows(courseIds: string[]): Promise<DashboardAssignmentPendingRow[]> {
    if (!courseIds.length) return [];
    return this.db()
      .selectFrom('assign_submissions')
      .innerJoin('assignments', 'assignments.id', 'assign_submissions.assignment_id')
      .leftJoin('assign_grades', (join) =>
        join
          .onRef('assign_grades.assignment_id', '=', 'assign_submissions.assignment_id')
          .onRef('assign_grades.user_id', '=', 'assign_submissions.user_id')
          .onRef('assign_grades.attempt_number', '=', 'assign_submissions.attempt_number'),
      )
      .select([
        'assignments.course as courseId',
        'assign_submissions.submitted_at as submittedAt',
        'assign_grades.status as gradeStatus',
      ])
      .where('assignments.course', 'in', courseIds)
      .where('assign_submissions.status', '=', 'submitted')
      .execute();
  }

  /** Lượt quiz đã nộp còn câu chờ chấm tay trong tập khoá. */
  async quizPendingRows(courseIds: string[]): Promise<DashboardQuizPendingRow[]> {
    if (!courseIds.length) return [];
    return this.db()
      .selectFrom('exam_attempts')
      .innerJoin('exam_pins', 'exam_pins.id', 'exam_attempts.pin_id')
      .select([
        'exam_pins.course_id as courseId',
        'exam_attempts.time_finish as timeFinish',
        'exam_attempts.time_start as timeStart',
      ])
      .where('exam_pins.course_id', 'in', courseIds)
      .where('exam_attempts.state', '=', 'needsgrading')
      .where('exam_attempts.preview', '=', false)
      .execute();
  }

  /**
   * Phiếu giấy CAM-0 đang chờ xử lý trong tập khoá (chỉ hai trạng thái chờ
   * giáo viên: needs_identity + needs_review; ready/recorded KHÔNG tính —
   * ready là đã đủ điều kiện ghi, recorded là đã xong). Trả từng phiếu để
   * service gom số đếm + mốc chờ lâu nhất + quiz đích deep-link.
   */
  async paperPendingRows(courseIds: string[]): Promise<DashboardPaperPendingRow[]> {
    if (!courseIds.length) return [];
    return this.db()
      .selectFrom('exam_scans')
      .innerJoin('exam_pins', 'exam_pins.id', 'exam_scans.exam_pin_id')
      .select([
        'exam_pins.course_id as courseId',
        'exam_scans.exam_pin_id as pinId',
        'exam_scans.created_at as createdAt',
      ])
      .where('exam_pins.course_id', 'in', courseIds)
      .where('exam_scans.status', 'in', ['needs_identity', 'needs_review'])
      .execute();
  }

  /** Mốc xem trước hiện tại của user; undefined nếu chưa từng xem. */
  async getState(userId: string): Promise<DashboardStateRow | undefined> {
    return this.db()
      .selectFrom('user_dashboard_state')
      .select(STATE_COLUMNS)
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }

  /** Cập nhật (hoặc tạo) mốc xem trước = thời điểm vừa xem xong. */
  async touchState(userId: string, at: Date): Promise<void> {
    await this.db()
      .insertInto('user_dashboard_state')
      .values(stateInsertValues(userId, at))
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ last_seen_at: at, updated_at: new Date() }),
      )
      .execute();
  }

  /** Mọi pref thẻ khoá của chính user. */
  async listPrefs(userId: string): Promise<CardPrefRow[]> {
    return this.db()
      .selectFrom('user_course_card_prefs')
      .select(PREF_COLUMNS)
      .where('user_id', '=', userId)
      .orderBy('course_id', 'asc')
      .execute();
  }

  /** Upsert pref thẻ khoá của chính user cho một khoá. */
  async upsertPref(
    userId: string,
    courseId: string,
    color: string | null,
    nickname: string | null,
  ): Promise<CardPrefRow> {
    const rows = await this.db()
      .insertInto('user_course_card_prefs')
      .values(prefInsertValues(userId, courseId, color, nickname))
      .onConflict((oc) =>
        oc.columns(['user_id', 'course_id']).doUpdateSet({
          color,
          nickname,
          updated_at: new Date(),
        }),
      )
      .returning(PREF_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Xoá pref thẻ khoá (khi cả màu lẫn biệt danh đều trống). */
  async deletePref(userId: string, courseId: string): Promise<void> {
    await this.db()
      .deleteFrom('user_course_card_prefs')
      .where('user_id', '=', userId)
      .where('course_id', '=', courseId)
      .execute();
  }
}
