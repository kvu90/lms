/**
 * Repository của BỀ MẶT PHỤ HUYNH CHỈ-XEM trên Kysely — một phần của
 * nhóm G9 trong chiến dịch chuyển tầng dữ liệu Drizzle → Kysely
 * (issue #649).
 *
 * Vai trò: mọi truy vấn đọc phục vụ bề mặt tổng quan của phụ huynh
 * (PH-1, issue #130) tập trung ở đây: mốc xem trước của phụ huynh cho
 * một con, các quiz/bài tập có hạn nộp trong tập khoá của con kèm
 * trạng thái nộp của chính con, thông báo gần nhất đã gửi cho con và
 * đếm tiến độ hoàn thành theo khoá. Mọi truy vấn đều khoá theo học
 * sinh (con) + tập khoá con ghi danh do service truyền vào SAU khi
 * đã qua cổng liên kết giám hộ — repository không tự quyết quyền.
 * Gom theo tập khoá trong một câu SQL cho mỗi nguồn, không vòng lặp
 * truy vấn theo từng khoá. Bề mặt này CHỈ ĐỌC dữ kiện nghiệp vụ
 * (ngoại trừ mốc xem trước của chính phụ huynh ở bảng
 * `guardian_view_state`): phạm vi dữ kiện được xem phải giữ nguyên
 * tuyệt đối khi chuyển đổi ORM.
 *
 * BẤT BIẾN NGỮ NGHĨA CỦA PHÉP NỐI NGOÀI (điểm nóng của nhóm, spec
 * khoá ở spec tích hợp đi kèm): ở `courseProgressRows`, điều kiện
 * `completion_state <> 0` trên bảng `course_modules_completion` nằm
 * trong mệnh đề ON của LEFT JOIN — KHÔNG được dời sang WHERE. Nằm ở
 * ON, một module chưa có dòng hoàn thành khác 0 vẫn xuất hiện trong
 * phép đếm tổng (`count(*)` phía `course_modules`) và chỉ không đóng
 * góp vào số đã hoàn thành (`count(course_modules_completion.id)`);
 * dời sang WHERE sẽ biến LEFT JOIN thành INNER JOIN trên thực tế,
 * làm các module đó biến mất khỏi cả tổng số và đổi phần trăm tiến
 * độ. Cùng khuôn: ở `quizDueRows`, điều kiện `preview = false` trên
 * `exam_attempts` cũng nằm trong ON để attempt xem trước không lọc
 * mất quiz khỏi danh sách.
 *
 * Khuôn hình dạng dữ liệu ở biên repository (khuôn của pilot kho
 * control plane, xem sổ tay trong `AGENTS.md` của package): bên
 * trong dùng tên bảng/cột snake_case của interface schema sinh bằng
 * codegen; bên ngoài trả các hình dạng camelCase như phía tiêu thụ
 * đang dùng qua bí danh cột tường minh và các mảnh `sql` giữ nguyên
 * ép kiểu `::int` cho phép đếm (kiểu runtime của `count` qua `pg` là
 * int8 — ép `::int` giữ kết quả là `number` như đường Drizzle, thử
 * nghiệm T-7). Mọi giá trị trong mệnh đề WHERE đều là tham số bắt
 * buộc; tập khoá rỗng được chặn ngay ở đầu phương thức (trả mảng
 * rỗng, không chạy truy vấn) như đường cũ. Repository không import
 * từ `apps/*`, không đọc ALS/ngữ cảnh ứng dụng, không tự mở pool.
 */
import { sql } from 'kysely';
import type { CentreDb, CentreTx } from '../client';

/** Handle đọc/ghi mà repository nhận: instance gốc hoặc transaction đang mở của kho trung tâm. */
export type GuardianViewDb = CentreDb | CentreTx;

/** Mốc xem trước của phụ huynh cho một con (một dòng cho mỗi cặp phụ huynh – học sinh). */
export interface GuardianViewStateRow {
  guardianUserId: string;
  studentUserId: string;
  /** Lần cuối phụ huynh mở bề mặt tổng quan của con này. */
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng quiz có hạn nộp trên bề mặt phụ huynh: quiz kèm trạng thái attempt của học sinh. */
export interface GuardianQuizDueRow {
  /** Id của course module chứa quiz. */
  cmId: string;
  courseId: string;
  /** Tên hiển thị: tên của pin, thiếu thì lấy tên của phiên bản đề. */
  name: string;
  /** Hạn nộp (thời điểm đóng pin); truy vấn chỉ trả dòng có hạn nộp nên phía gọi khẳng định khác null. */
  dueAt: Date | null;
  /** Trạng thái attempt thật (không phải bản xem trước) của học sinh; null khi chưa có attempt. */
  attemptState: string | null;
}

/** Một dòng bài tập có hạn nộp trên bề mặt phụ huynh: bài tập kèm trạng thái bài nộp của học sinh. */
export interface GuardianAssignmentDueRow {
  /** Id của course module chứa bài tập. */
  cmId: string;
  courseId: string;
  name: string;
  /** Hạn nộp; truy vấn chỉ trả dòng có hạn nộp nên phía gọi khẳng định khác null. */
  dueAt: Date | null;
  /** Trạng thái bài nộp hiện hành của học sinh; null khi chưa từng nộp. */
  submissionStatus: string | null;
}

/** Một dòng thông báo đã gửi cho học sinh trên bề mặt phụ huynh (chiếu tối thiểu cho danh sách). */
export interface GuardianNotificationRow {
  id: string;
  subject: string;
  fullMessage: string;
  eventType: string;
  contextUrl: string | null;
  createdAt: Date;
}

/** Đếm tiến độ hoàn thành của học sinh trong một khoá. */
export interface GuardianCourseProgressRow {
  courseId: string;
  /** Tổng số module hiển thị có theo dõi hoàn thành trong khoá. */
  total: number;
  /** Số module trong đó học sinh đã có trạng thái hoàn thành khác 0. */
  completed: number;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng mốc xem trước của phụ huynh. */
const GUARDIAN_VIEW_STATE_COLUMNS = [
  'guardian_user_id as guardianUserId',
  'student_user_id as studentUserId',
  'last_seen_at as lastSeenAt',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/**
 * Kho dữ liệu bề mặt phụ huynh chỉ-xem (PH-1, issue #130) trên
 * Kysely. Handle gốc được truyền lúc khởi tạo (facade định tuyến
 * của kho trung tâm do tầng ứng dụng cấp); mọi phương thức nhận
 * thêm handle tuỳ chọn theo khuôn chung của các repository trong
 * package.
 */
export class GuardianViewRepository {
  constructor(private readonly handle: GuardianViewDb) {}

  /** Instance gốc của repository. */
  private db(): GuardianViewDb {
    return this.handle;
  }

  /** Mở một transaction trên kho trung tâm và chạy `fn` với handle giao dịch. */
  async transaction<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.db().transaction().execute(fn);
  }

  /** Mốc xem trước của phụ huynh cho một con; undefined nếu chưa từng xem. */
  async getViewState(
    guardianUserId: string,
    studentUserId: string,
    db: GuardianViewDb = this.db(),
  ): Promise<GuardianViewStateRow | undefined> {
    return db
      .selectFrom('guardian_view_state')
      .select(GUARDIAN_VIEW_STATE_COLUMNS)
      .where('guardian_user_id', '=', guardianUserId)
      .where('student_user_id', '=', studentUserId)
      .limit(1)
      .executeTakeFirst();
  }

  /** Cập nhật (hoặc tạo) mốc xem trước của phụ huynh cho một con. */
  async touchViewState(
    guardianUserId: string,
    studentUserId: string,
    at: Date,
    db: GuardianViewDb = this.db(),
  ): Promise<void> {
    await db
      .insertInto('guardian_view_state')
      .values({ guardian_user_id: guardianUserId, student_user_id: studentUserId, last_seen_at: at })
      .onConflict((oc) =>
        oc.columns(['guardian_user_id', 'student_user_id']).doUpdateSet({
          last_seen_at: at,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  /**
   * Quiz có hạn nộp không muộn hơn `until` trong tập khoá kèm các
   * attempt của học sinh. Attempt được nối bằng LEFT JOIN với cả ba
   * điều kiện trong ON — khớp pin, đúng học sinh, và `preview =
   * false` (attempt xem trước không phải lần làm bài thật) — để quiz
   * chưa có attempt thật vẫn xuất hiện với `attemptState` null.
   */
  async quizDueRows(
    courseIds: string[],
    studentUserId: string,
    until: Date,
    db: GuardianViewDb = this.db(),
  ): Promise<GuardianQuizDueRow[]> {
    if (!courseIds.length) return [];
    return db
      .selectFrom('course_modules')
      .innerJoin('exam_pins', 'exam_pins.id', 'course_modules.instance_id')
      .innerJoin('exam_versions', 'exam_versions.id', 'exam_pins.exam_version_id')
      .leftJoin('exam_attempts', (join) =>
        join
          .onRef('exam_attempts.pin_id', '=', 'exam_pins.id')
          .on('exam_attempts.user_id', '=', studentUserId)
          .on('exam_attempts.preview', '=', false),
      )
      .select([
        'course_modules.id as cmId',
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

  /**
   * Bài tập có hạn nộp không muộn hơn `until` trong tập khoá kèm bài
   * nộp hiện hành của học sinh. Bài nộp được nối bằng LEFT JOIN với
   * điều kiện khớp bài tập + đúng học sinh trong ON, để bài tập học
   * sinh chưa nộp vẫn xuất hiện với `submissionStatus` null.
   */
  async assignmentDueRows(
    courseIds: string[],
    studentUserId: string,
    until: Date,
    db: GuardianViewDb = this.db(),
  ): Promise<GuardianAssignmentDueRow[]> {
    if (!courseIds.length) return [];
    return db
      .selectFrom('course_modules')
      .innerJoin('assignments', 'assignments.id', 'course_modules.instance_id')
      .leftJoin('assign_submissions', (join) =>
        join
          .onRef('assign_submissions.assignment_id', '=', 'assignments.id')
          .on('assign_submissions.user_id', '=', studentUserId),
      )
      .select([
        'course_modules.id as cmId',
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
   * Thông báo gần nhất đã gửi cho học sinh (mọi loại, trừ thông báo
   * điểm — loại ở service theo eventType): service lọc tiếp theo
   * khoá từ contextUrl. Chỉ ĐỌC — không bao giờ đánh dấu đã đọc thay
   * học sinh.
   */
  async recentNotificationsForStudent(
    studentUserId: string,
    limit: number,
    db: GuardianViewDb = this.db(),
  ): Promise<GuardianNotificationRow[]> {
    return db
      .selectFrom('notifications')
      .select([
        'id',
        'subject',
        'full_message as fullMessage',
        'event_type as eventType',
        'context_url as contextUrl',
        'created_at as createdAt',
      ])
      .where('user_id_to', '=', studentUserId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }

  /**
   * Đếm tiến độ theo khoá cho học sinh: tổng = module hiển thị có
   * theo dõi hoàn thành (điều kiện `completion <> 0` trên
   * `course_modules` nằm trong WHERE vì nó lọc chính bảng gốc); đã
   * xong = có trạng thái hoàn thành khác 0 — đúng ngữ nghĩa phần
   * trăm của K2 (ContentService.getMyProgress).
   *
   * Điều kiện `completion_state <> 0` trên bảng được nối PHẢI nằm
   * trong ON của LEFT JOIN (xem bất biến ở đầu file): module có dòng
   * hoàn thành ở trạng thái 0, hoặc chưa có dòng hoàn thành nào, vẫn
   * tính vào tổng và không tính vào số đã xong.
   */
  async courseProgressRows(
    courseIds: string[],
    studentUserId: string,
    db: GuardianViewDb = this.db(),
  ): Promise<GuardianCourseProgressRow[]> {
    if (!courseIds.length) return [];
    return db
      .selectFrom('course_modules')
      .leftJoin('course_modules_completion', (join) =>
        join
          .onRef('course_modules_completion.course_module_id', '=', 'course_modules.id')
          .on('course_modules_completion.user_id', '=', studentUserId)
          .on('course_modules_completion.completion_state', '<>', 0),
      )
      .select([
        'course_modules.course as courseId',
        sql<number>`count(*)::int`.as('total'),
        sql<number>`count(course_modules_completion.id)::int`.as('completed'),
      ])
      .where('course_modules.course', 'in', courseIds)
      .where('course_modules.visible', '=', true)
      .where('course_modules.deletion_in_progress', '=', false)
      .where('course_modules.completion', '<>', 0)
      .groupBy('course_modules.course')
      .execute();
  }
}
