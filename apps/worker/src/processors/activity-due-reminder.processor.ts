import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { assignments, assignSubmissions, course, courseModules, enrol, outboxEvents, quizAttempts, quizzes, userEnrolments } from '@lms/db-schema';
import { TaskLogService } from '../task-log.service';
import { tenantAls } from '../db/tenant-als';

type Database = NodePgDatabase<typeof relations>;

export interface ActivityDueReminderPair { userId: string; quizId?: string; assignmentId?: string }
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
 * khi lát Bài tập landing): quiz theo `quizzes.time_close`, bài tập
 * theo `assignments.due_date`. Sự kiện mang `activityType` ('quiz' |
 * 'assign') + id của đúng loại đó (quizId | assignmentId) để consumer
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
      quizId: quizzes.id, quizName: quizzes.name, timeClose: quizzes.timeClose, courseId: quizzes.course,
      cmVisible: courseModules.visible, cmDeletionInProgress: courseModules.deletionInProgress,
    }).from(quizzes)
      .innerJoin(course, eq(course.id, quizzes.course))
      .leftJoin(courseModules, eq(courseModules.id, quizzes.cmId))
      .where(and(
        eq(course.visible, true),
        gt(quizzes.timeClose, now),
        lte(quizzes.timeClose, windowEnd),
      ));
    const reminded: ActivityDueReminderPair[] = [];
    for (const row of due) {
      if (!row.timeClose) continue;
      // Module bị ẩn hoặc đang xoá: học sinh không thấy/không vào
      // được hoạt động — nhắc cũng vô ích (cmId null = quiz không gắn
      // module thì coi như hiện, theo cột cm_id chỉ là bản sao tra cứu).
      if (row.cmVisible === false || row.cmDeletionInProgress === true) continue;
      const students = await this.enrolledStudentIds(row.courseId, now);
      for (const userId of students) {
        if (await this.hasSubmitted(row.quizId, userId)) continue;
        if (await this.alreadyReminded(userId, row.quizId, row.timeClose)) continue;
        await this.db.insert(outboxEvents).values({
          aggregate: 'activity', type: 'activity_due_reminder',
          payload: {
            userId, courseId: row.courseId, quizId: row.quizId,
            activityType: 'quiz', activityName: row.quizName,
            timeClose: row.timeClose.toISOString(),
          },
        });
        reminded.push({ userId, quizId: row.quizId });
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
      const students = await this.enrolledStudentIds(row.courseId, now);
      for (const userId of students) {
        if (await this.hasSubmittedAssignment(row.assignmentId, userId)) continue;
        if (await this.alreadyRemindedAssignment(userId, row.assignmentId, row.dueDate)) continue;
        await this.db.insert(outboxEvents).values({
          aggregate: 'activity', type: 'activity_due_reminder',
          payload: {
            userId, courseId: row.courseId, assignmentId: row.assignmentId,
            activityType: 'assign', activityName: row.assignmentName,
            timeClose: row.dueDate.toISOString(),
          },
        });
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

  /** Đã nộp = tồn tại attempt không-preview ở trạng thái đã hoàn tất cho (quiz, học sinh). */
  private async hasSubmitted(quizId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: quizAttempts.id }).from(quizAttempts)
      .where(and(
        eq(quizAttempts.quizId, quizId),
        eq(quizAttempts.userId, userId),
        eq(quizAttempts.preview, false),
        inArray(quizAttempts.state, SUBMITTED_ATTEMPT_STATES),
      ))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Chống trùng bền: sự kiện nhắc cho đúng (userId, quizId, timeClose)
   * đã tồn tại trong outbox thì không phát lại — job chạy lại sau 5
   * phút hay worker khởi động lại đều không spam; mốc hạn đổi thì bộ
   * ba khác đi và được nhắc lại.
   */
  private async alreadyReminded(userId: string, quizId: string, timeClose: Date): Promise<boolean> {
    const [row] = await this.db.select({ id: outboxEvents.id }).from(outboxEvents)
      .where(and(
        eq(outboxEvents.type, 'activity_due_reminder'),
        sql`${outboxEvents.payload}->>'userId' = ${userId}`,
        sql`${outboxEvents.payload}->>'quizId' = ${quizId}`,
        sql`${outboxEvents.payload}->>'timeClose' = ${timeClose.toISOString()}`,
      ))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Đã nộp bài tập = tồn tại bản nộp hiện hành ở trạng thái
   * 'submitted' cho (assignment, học sinh); bản nháp ('draft' — chưa
   * chốt nộp hoặc đã mở lại) tính là CHƯA nộp.
   */
  private async hasSubmittedAssignment(assignmentId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: assignSubmissions.id }).from(assignSubmissions)
      .where(and(
        eq(assignSubmissions.assignmentId, assignmentId),
        eq(assignSubmissions.userId, userId),
        eq(assignSubmissions.status, 'submitted'),
      ))
      .limit(1);
    return row !== undefined;
  }

  /** Chống trùng bền cho bài tập: đúng khuôn bản quiz, khoá theo (userId, assignmentId, mốc hạn). */
  private async alreadyRemindedAssignment(userId: string, assignmentId: string, dueDate: Date): Promise<boolean> {
    const [row] = await this.db.select({ id: outboxEvents.id }).from(outboxEvents)
      .where(and(
        eq(outboxEvents.type, 'activity_due_reminder'),
        sql`${outboxEvents.payload}->>'userId' = ${userId}`,
        sql`${outboxEvents.payload}->>'assignmentId' = ${assignmentId}`,
        sql`${outboxEvents.payload}->>'timeClose' = ${dueDate.toISOString()}`,
      ))
      .limit(1);
    return row !== undefined;
  }
}
