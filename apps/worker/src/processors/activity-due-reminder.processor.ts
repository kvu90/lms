import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { assignments, assignSubmissions, course, courseModules, enrol, examAttempts, examPins, examVersions, outboxEvents, userEnrolments } from '@lms/db';
import { TaskLogService } from '../task-log.service';
import { tenantAls } from '../db/tenant-als';

type Database = NodePgDatabase<typeof relations>;

export interface ActivityDueReminderPair { userId: string; pinId?: string; assignmentId?: string }
export interface ActivityDueReminderResult { checkedAt: string; reminded: ActivityDueReminderPair[] }

/**
 * Cửa sổ nhắc hạn nộp (giờ): hoạt động có hạn nộp rơi vào
 * (hiện tại, hiện tại + cửa sổ] được nhắc MỘT lần cho từng học sinh
 * chưa nộp — lát N5 (issue #50), mô hình nhắc hạn tự động của Google
 * Classroom/Canvas (hồ sơ chuẩn thông báo 2026-10-24, mục B.9/D.3).
 */
export const ACTIVITY_DUE_REMINDER_WINDOW_HOURS = 24;

/** Các trạng thái attempt tính là ĐÃ NỘP (inprogress = đang làm dở, chưa nộp). */
const SUBMITTED_ATTEMPT_STATES = ['needsgrading', 'finished'];

/**
 * Activity due-soon reminders: mỗi lượt quét (định kỳ 5 phút) tìm các
 * hoạt động sắp đến hạn trong cửa sổ 24 giờ và phát MỘT sự kiện
 * outbox `activity_due_reminder` cho từng (học sinh, hoạt động) chưa
 * nộp — phía API (NotificationEventsConsumer, lát N1) biến sự kiện
 * thành thông báo `activity_due_soon`. Chống trùng bền ngay tại phía
 * phát, cùng kỷ luật warnExpiring của enrol-expiry: đã có sự kiện
 * cho (userId, hoạt động, mốc hạn) thì không phát lại; giáo viên DỜI
 * HẠN thì mốc hạn mới được nhắc lại như một hạn mới.
 *
 * Hai loại hoạt động có hạn nộp (NB-1, issue #174 — trước đây chỉ có
 * Quiz, docblock cũ giữ tiền đề "mod_assign chưa tồn tại" đã sai từ
 * khi lát Bài tập landing): hoạt động đề theo `exam_pins.time_close`
 * (sau gộp Đề #226, pin mang vai trò của quiz), bài tập theo
 * `assignments.due_date`. Sự kiện mang `activityType` ('quiz' |
 * 'assign') + id của đúng loại đó (pinId | assignmentId) để consumer
 * rẽ nhánh contextUrl theo loại.
 *
 * "Chưa nộp": quiz = chưa có attempt hoàn tất (needsgrading/finished,
 * không tính attempt preview của giáo viên; attempt inprogress vẫn
 * được nhắc); bài tập = chưa có bản nộp ở trạng thái submitted (bản
 * nháp hoặc đã mở lại về nháp đều tính là chưa nộp). Đối tượng nhắc:
 * ghi danh ACTIVE còn hiệu lực của khoá chứa hoạt động; bỏ qua khoá
 * đang ẩn và course module bị ẩn/đang xoá.
 */
@Processor('activity-due-reminders')
/**
 * Xử lý job nhắc hạn nộp: quét các quiz sắp đóng và phát sự kiện nhắc cho học sinh chưa nộp.
 */
export class ActivityDueReminderProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database, private readonly taskLog: TaskLogService) { super(); }

  /**
   * Xử lý một job của queue tương ứng: quét các quiz sắp đóng + bài
   * tập sắp đến hạn và phát sự kiện nhắc cho học sinh chưa nộp. Mỗi
   * lượt quét được ghi vào task_log qua TaskLogService.
   */
  async process(_job: Job): Promise<ActivityDueReminderResult> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(_job));
  }

  private async processInContext(_job: Job): Promise<ActivityDueReminderResult> {
    void _job;
    return this.taskLog.run('activity-due-reminders', () => this.sweep(), (r) => `reminded ${r.reminded.length} (student, activity) pair(s)`);
  }

  private async sweep(): Promise<ActivityDueReminderResult> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + ACTIVITY_DUE_REMINDER_WINDOW_HOURS * 3600_000);
    const due = await this.db.select({
      pinId: examPins.id, pinName: sql<string>`coalesce(${examPins.name}, ${examVersions.name})`, timeClose: examPins.timeClose, courseId: examPins.courseId,
      tenantId: course.tenantId,
      cmVisible: courseModules.visible, cmDeletionInProgress: courseModules.deletionInProgress,
    }).from(examPins)
      .innerJoin(examVersions, eq(examVersions.id, examPins.examVersionId))
      .innerJoin(course, eq(course.id, examPins.courseId))
      .leftJoin(courseModules, eq(courseModules.id, examPins.cmId))
      .where(and(
        eq(course.visible, true),
        gt(examPins.timeClose, now),
        lte(examPins.timeClose, windowEnd),
      ));
    const reminded: ActivityDueReminderPair[] = [];
    // Nạp theo lô thay cho kiểm tra từng cặp (học sinh × hoạt động):
    // học sinh của một khoá chỉ nạp một lần cho cả lượt quét (nhiều
    // hoạt động cùng khoá dùng chung), tập đã-nộp và tập đã-nhắc của
    // một hoạt động cũng nạp một lần bằng một truy vấn rồi đối chiếu
    // trong bộ nhớ — điều kiện phát nhắc giữ nguyên chính xác như
    // khi kiểm tra từng cặp.
    const studentsByCourse = new Map<string, Promise<string[]>>();
    const studentsOf = (courseId: string): Promise<string[]> => {
      let cached = studentsByCourse.get(courseId);
      if (!cached) {
        cached = this.enrolledStudentIds(courseId, now);
        studentsByCourse.set(courseId, cached);
      }
      return cached;
    };
    for (const row of due) {
      if (!row.timeClose) continue;
      // Module bị ẩn hoặc đang xoá: học sinh không thấy/không vào
      // được hoạt động — nhắc cũng vô ích (cmId null = pin không gắn
      // module thì coi như hiện, theo cột cm_id chỉ là bản sao tra cứu).
      if (row.cmVisible === false || row.cmDeletionInProgress === true) continue;
      const students = await studentsOf(row.courseId);
      if (students.length === 0) continue;
      const submitted = await this.submittedUserIdsForPin(row.pinId, students);
      const remindedKeys = await this.remindedKeysForPin(row.pinId);
      const timeCloseIso = row.timeClose.toISOString();
      for (const userId of students) {
        if (submitted.has(userId)) continue;
        const remindedKey = `${userId}|${timeCloseIso}`;
        if (remindedKeys.has(remindedKey)) continue;
        await this.db.insert(outboxEvents).values({
          aggregate: 'activity', type: 'activity_due_reminder', tenantId: row.tenantId,
          payload: {
            userId, courseId: row.courseId, pinId: row.pinId, tenantId: row.tenantId,
            activityType: 'quiz', activityName: row.pinName,
            timeClose: timeCloseIso,
          },
        });
        remindedKeys.add(remindedKey);
        reminded.push({ userId, pinId: row.pinId });
      }
    }
    // Bài tập (NB-1, issue #174): cùng cửa sổ/dedupe theo
    // (userId, assignmentId, dueDate), "chưa nộp" theo trạng thái
    // bản nộp hiện hành của học sinh.
    const dueAssignments = await this.db.select({
      assignmentId: assignments.id, assignmentName: assignments.name, dueDate: assignments.dueDate, courseId: assignments.course,
      cmVisible: courseModules.visible, cmDeletionInProgress: courseModules.deletionInProgress,
    }).from(assignments)
      .innerJoin(course, eq(course.id, assignments.course))
      .leftJoin(courseModules, eq(courseModules.id, assignments.cmId))
      .where(and(
        eq(course.visible, true),
        gt(assignments.dueDate, now),
        lte(assignments.dueDate, windowEnd),
      ));
    for (const row of dueAssignments) {
      if (!row.dueDate) continue;
      if (row.cmVisible === false || row.cmDeletionInProgress === true) continue;
      const students = await studentsOf(row.courseId);
      if (students.length === 0) continue;
      const submitted = await this.submittedUserIdsForAssignment(row.assignmentId, students);
      const remindedKeys = await this.remindedKeysForAssignment(row.assignmentId);
      const dueDateIso = row.dueDate.toISOString();
      for (const userId of students) {
        if (submitted.has(userId)) continue;
        const remindedKey = `${userId}|${dueDateIso}`;
        if (remindedKeys.has(remindedKey)) continue;
        await this.db.insert(outboxEvents).values({
          aggregate: 'activity', type: 'activity_due_reminder',
          payload: {
            userId, courseId: row.courseId, assignmentId: row.assignmentId,
            activityType: 'assign', activityName: row.assignmentName,
            timeClose: dueDateIso,
          },
        });
        remindedKeys.add(remindedKey);
        reminded.push({ userId, assignmentId: row.assignmentId });
      }
    }
    return { checkedAt: now.toISOString(), reminded };
  }

  /**
   * Học sinh thuộc diện nhắc của một khoá: user có ghi danh ACTIVE
   * (status 0) còn hiệu lực tại thời điểm quét — đã bắt đầu
   * (timeStart <= now) và chưa hết hạn (timeEnd trống hoặc > now) —
   * qua mọi instance ghi danh đang bật của khoá.
   */
  private async enrolledStudentIds(courseId: string, now: Date): Promise<string[]> {
    const instances = await this.db.select({ id: enrol.id }).from(enrol)
      .where(and(eq(enrol.courseId, courseId), eq(enrol.status, 0)));
    if (instances.length === 0) return [];
    const rows = await this.db.select({ userId: userEnrolments.userId }).from(userEnrolments)
      .where(and(
        inArray(userEnrolments.enrolId, instances.map((i) => i.id)),
        eq(userEnrolments.status, 0),
        lte(userEnrolments.timeStart, now),
        or(isNull(userEnrolments.timeEnd), gt(userEnrolments.timeEnd, now)),
      ));
    return [...new Set(rows.map((r) => r.userId))];
  }

  /**
   * Tập học sinh ĐÃ NỘP của một pin, nạp một lần cho cả hoạt động:
   * đã nộp = tồn tại attempt không-preview ở trạng thái đã hoàn tất
   * cho (pin, học sinh) — cùng điều kiện với phép kiểm tra từng cặp
   * trước đây.
   */
  private async submittedUserIdsForPin(pinId: string, studentIds: string[]): Promise<Set<string>> {
    const rows = await this.db.select({ userId: examAttempts.userId }).from(examAttempts)
      .where(and(
        eq(examAttempts.pinId, pinId),
        inArray(examAttempts.userId, studentIds),
        eq(examAttempts.preview, false),
        inArray(examAttempts.state, SUBMITTED_ATTEMPT_STATES),
      ));
    return new Set(rows.map((r) => r.userId));
  }

  /**
   * Tập khoá "đã nhắc" của một pin, nạp một lần cho cả hoạt động:
   * mỗi sự kiện nhắc đã có trong outbox đóng góp một khoá
   * `<userId>|<timeClose ISO>` — đối chiếu trong bộ nhớ theo đúng bộ
   * ba (userId, pinId, timeClose) của phép kiểm tra từng cặp trước
   * đây. Chống trùng bền giữ nguyên: sự kiện nhắc cho đúng bộ ba đã
   * tồn tại thì không phát lại — job chạy lại sau 5 phút hay worker
   * khởi động lại đều không spam; mốc hạn đổi thì khoá khác đi và
   * được nhắc lại.
   */
  private async remindedKeysForPin(pinId: string): Promise<Set<string>> {
    const rows = await this.db.select({ payload: outboxEvents.payload }).from(outboxEvents)
      .where(and(
        eq(outboxEvents.type, 'activity_due_reminder'),
        sql`${outboxEvents.payload}->>'pinId' = ${pinId}`,
      ));
    return new Set(rows.map((r) => remindedKeyOf(r.payload)));
  }

  /**
   * Tập học sinh ĐÃ NỘP của một bài tập, nạp một lần cho cả hoạt
   * động: đã nộp = tồn tại bản nộp hiện hành ở trạng thái 'submitted'
   * cho (assignment, học sinh); bản nháp ('draft' — chưa chốt nộp
   * hoặc đã mở lại) tính là CHƯA nộp.
   */
  private async submittedUserIdsForAssignment(assignmentId: string, studentIds: string[]): Promise<Set<string>> {
    const rows = await this.db.select({ userId: assignSubmissions.userId }).from(assignSubmissions)
      .where(and(
        eq(assignSubmissions.assignmentId, assignmentId),
        inArray(assignSubmissions.userId, studentIds),
        eq(assignSubmissions.status, 'submitted'),
      ));
    return new Set(rows.map((r) => r.userId));
  }

  /** Tập khoá "đã nhắc" của một bài tập: đúng khuôn bản quiz, khoá theo (userId, assignmentId, mốc hạn). */
  private async remindedKeysForAssignment(assignmentId: string): Promise<Set<string>> {
    const rows = await this.db.select({ payload: outboxEvents.payload }).from(outboxEvents)
      .where(and(
        eq(outboxEvents.type, 'activity_due_reminder'),
        sql`${outboxEvents.payload}->>'assignmentId' = ${assignmentId}`,
      ));
    return new Set(rows.map((r) => remindedKeyOf(r.payload)));
  }
}

/**
 * Khoá đối chiếu "đã nhắc" từ payload của một sự kiện nhắc đã phát:
 * `<userId>|<timeClose>` — payload do chính processor này ghi nên hai
 * trường luôn là chuỗi; sự kiện lạ thiếu trường cho khoá không khớp
 * được với bất kỳ cặp nào đang xét (đúng như phép kiểm tra từng cặp
 * bằng SQL trước đây, vốn đòi khớp cả ba trường).
 */
function remindedKeyOf(payload: unknown): string {
  const p = (payload ?? {}) as { userId?: unknown; timeClose?: unknown };
  return `${typeof p.userId === 'string' ? p.userId : ''}|${typeof p.timeClose === 'string' ? p.timeClose : ''}`;
}
