import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import {
  assignments, assignSubmissions, course, courseModules, enrol, guardianDigests, guardianLinks,
  outboxEvents, quizAttempts, quizzes, userEnrolments, userPreferences,
} from '@lms/db-schema';
import { TaskLogService } from '../task-log.service';

type Database = NodePgDatabase<typeof relations>;

/** Một lượt digest/đẩy đã được chốt trong lượt quét này. */
export interface GuardianDigestQueuedItem {
  guardianUserId: string;
  studentUserId: string;
  kind: 'weekly' | 'daily' | 'overdue_alert';
  dedupeKey: string;
}
export interface GuardianDigestSweepResult {
  checkedAt: string;
  queued: GuardianDigestQueuedItem[];
}

/** Khoá tuỳ chọn tần suất digest trong user_preferences (theo từng con) — nguồn sự thật phía API cũng đọc đúng khoá này. */
export function guardianDigestFrequencyPreferenceName(studentUserId: string): string {
  return `guardian_digest_frequency:${studentUserId}`;
}

/** Ngưỡng quá hạn để đẩy riêng: quá hạn từ 7 ngày trở lên (research phụ huynh mục 5.3.6). */
export const GUARDIAN_OVERDUE_ALERT_DAYS = 7;

/** Các trạng thái attempt tính là ĐÃ NỘP (khớp tiền lệ N5 + bề mặt PH-1). */
const SUBMITTED_ATTEMPT_STATES = ['needsgrading', 'finished'];

type Frequency = 'weekly' | 'daily' | 'off';

/** Đầu ngày UTC chứa `now`. */
function dayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Đầu tuần (Thứ Hai 00:00 UTC) chứa `now` — cùng quy ước tuần của bề mặt PH-1. */
function weekStartUtc(now: Date): Date {
  const start = dayStartUtc(now);
  const dow = start.getUTCDay(); // 0 = Chủ nhật
  start.setUTCDate(start.getUTCDate() - ((dow + 6) % 7));
  return start;
}

/**
 * Quét digest phụ huynh (PH-2, issue #159): phía PHÁT hiện của lát —
 * worker chỉ quyết "ai đến lượt digest/đẩy quá hạn" một cách bền và
 * idempotent, phần tổng hợp nội dung + gửi nằm ở consumer phía API
 * (GuardianDigestConsumer) dùng đúng đường đọc đã công bố của PH-1.
 *
 * Hai loại lượt được chốt:
 *  - Digest định kỳ: với mỗi liên kết giám hộ đang `active`, theo tần
 *    suất của chính phụ huynh cho con đó (user_preferences, mặc định
 *    weekly; `off` = tắt hẳn digest định kỳ), cửa sổ đầy
 *    đủ vừa đóng (tuần: Thứ Hai→Thứ Hai UTC; ngày: hôm qua UTC) được
 *    chốt đúng MỘT lần. Đổi tần suất hiệu lực từ cửa sổ kế tiếp: lượt
 *    quét chỉ xét tần suất hiện hành, cửa sổ đã có vết không sinh lại.
 *  - Đẩy riêng quá hạn ≥7 ngày: việc (quiz/bài tập) của con chưa nộp,
 *    hạn đã qua từ 7 ngày, được chốt đúng MỘT lần cho từng (phụ huynh,
 *    con, hoạt động) — research mục 5.3.6: đẩy chỉ trong digest, ngoại
 *    lệ duy nhất là quá hạn kéo dài được đẩy riêng một lần. Ngoại lệ
 *    này TÁCH khỏi digest nên chạy bất kể tần suất — kể cả `off`
 *    (tần suất là của digest, không chi phối đẩy ngoại lệ).
 *
 * Chống trùng bền nằm ở INSERT vào `guardian_digests` (dedupe_key
 * UNIQUE, onConflictDoNothing): chỉ khi INSERT thật sự tạo hàng mới
 * thì sự kiện outbox mới được phát — quét lại, worker khởi động lại,
 * hay quét chồng nhau đều không sinh lượt/sự kiện trùng. Liên kết tạo
 * sau khi cửa sổ đã đóng hẳn (created_at >= window_end) không nhận
 * digest cho cửa sổ đó (tiền lệ PH-1: lần đầu không dội dữ liệu cũ).
 */
@Processor('guardian-digests')
/**
 * Xử lý job quét digest phụ huynh: chốt các lượt digest/đẩy quá hạn đến hạn và phát sự kiện outbox cho phía API tổng hợp + gửi.
 */
export class GuardianDigestProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database, private readonly taskLog: TaskLogService) { super(); }

  /**
   * Xử lý một job của queue tương ứng. Mỗi lượt quét được ghi vào
   * task_log qua TaskLogService.
   */
  async process(_job: Job): Promise<GuardianDigestSweepResult> {
    void _job;
    return this.taskLog.run('guardian-digests', () => this.sweep(), (r) => `queued ${r.queued.length} guardian digest item(s)`);
  }

  private async sweep(): Promise<GuardianDigestSweepResult> {
    const now = new Date();
    const queued: GuardianDigestQueuedItem[] = [];

    const links = await this.db.select().from(guardianLinks).where(eq(guardianLinks.status, 'active'));
    if (links.length === 0) return { checkedAt: now.toISOString(), queued };

    const frequencyByPair = await this.frequencyMap(links.map((l) => l.guardianUserId));

    for (const link of links) {
      const frequency = frequencyByPair.get(`${link.guardianUserId}:${link.studentUserId}`) ?? 'weekly';

      // Digest định kỳ cho cửa sổ đầy đủ vừa đóng theo tần suất hiện
      // hành — `off` chỉ tắt khối này. Vòng đẩy riêng quá hạn ở dưới là
      // ngoại lệ tách khỏi digest, chạy bất kể tần suất.
      if (frequency !== 'off') {
        const window = frequency === 'weekly'
          ? { start: new Date(weekStartUtc(now).getTime() - 7 * 24 * 3600_000), end: weekStartUtc(now) }
          : { start: new Date(dayStartUtc(now).getTime() - 24 * 3600_000), end: dayStartUtc(now) };
        if (link.createdAt < window.end) {
          const dedupeKey = `digest:${link.guardianUserId}:${link.studentUserId}:${frequency}:${window.start.toISOString()}`;
          const digestId = await this.queueMark({
            guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, kind: frequency,
            windowStart: window.start, windowEnd: window.end, activityCmId: null, dedupeKey,
          });
          if (digestId) {
            await this.db.insert(outboxEvents).values({
              aggregate: 'guardian', type: 'guardian_digest_due',
              payload: {
                guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, digestId,
                kind: frequency, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(),
              },
            });
            queued.push({ guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, kind: frequency, dedupeKey });
          }
        }
      }

      // Đẩy riêng quá hạn ≥7 ngày: đúng một lần cho từng hoạt động.
      for (const item of await this.longOverdueItems(link.studentUserId, now)) {
        const dedupeKey = `overdue:${link.guardianUserId}:${link.studentUserId}:${item.cmId}`;
        const digestId = await this.queueMark({
          guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, kind: 'overdue_alert',
          windowStart: null, windowEnd: null, activityCmId: item.cmId, dedupeKey,
        });
        if (!digestId) continue;
        await this.db.insert(outboxEvents).values({
          aggregate: 'guardian', type: 'guardian_overdue_alert',
          payload: {
            guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, digestId,
            cmId: item.cmId, activityKind: item.kind, courseId: item.courseId,
            activityName: item.name, dueAt: item.dueAt.toISOString(),
          },
        });
        queued.push({ guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, kind: 'overdue_alert', dedupeKey });
      }
    }
    return { checkedAt: now.toISOString(), queued };
  }

  /** Tần suất theo từng cặp (phụ huynh, con): đọc một lượt mọi preference digest của các phụ huynh liên quan. */
  private async frequencyMap(guardianIds: string[]): Promise<Map<string, Frequency>> {
    const rows = await this.db.select().from(userPreferences)
      .where(and(
        inArray(userPreferences.userId, [...new Set(guardianIds)]),
        sql`${userPreferences.name} like 'guardian_digest_frequency:%'`,
      ));
    const out = new Map<string, Frequency>();
    for (const row of rows) {
      const studentUserId = row.name.slice('guardian_digest_frequency:'.length);
      const value = row.value === 'daily' || row.value === 'off' ? row.value : 'weekly';
      out.set(`${row.userId}:${studentUserId}`, value);
    }
    return out;
  }

  /**
   * Chốt một lượt vào guardian_digests: trả id khi hàng THẬT SỰ được
   * tạo mới; dedupe_key đã tồn tại (lượt quét trước/đang chồng) → null.
   */
  private async queueMark(input: {
    guardianUserId: string; studentUserId: string; kind: string;
    windowStart: Date | null; windowEnd: Date | null; activityCmId: string | null; dedupeKey: string;
  }): Promise<string | null> {
    const [row] = await this.db.insert(guardianDigests).values({
      guardianUserId: input.guardianUserId, studentUserId: input.studentUserId, kind: input.kind,
      windowStart: input.windowStart, windowEnd: input.windowEnd, activityCmId: input.activityCmId,
      dedupeKey: input.dedupeKey, status: 'queued',
    }).onConflictDoNothing().returning({ id: guardianDigests.id });
    return row?.id ?? null;
  }

  /**
   * Việc quá hạn ≥7 ngày chưa nộp của học sinh: quiz (time_close) + bài
   * tập (due_date) thuộc các khoá con đang ghi danh hiệu lực, module
   * đang hiển thị — cùng ngữ nghĩa "chưa nộp" của bề mặt PH-1 (quiz:
   * chưa có attempt finished/needsgrading không-preview; bài tập:
   * chưa có submission ở trạng thái submitted).
   */
  private async longOverdueItems(studentUserId: string, now: Date): Promise<{ cmId: string; courseId: string; kind: 'quiz' | 'assignment'; name: string; dueAt: Date }[]> {
    const courseIds = await this.enrolledCourseIds(studentUserId, now);
    if (courseIds.length === 0) return [];
    const threshold = new Date(now.getTime() - GUARDIAN_OVERDUE_ALERT_DAYS * 24 * 3600_000);
    const out: { cmId: string; courseId: string; kind: 'quiz' | 'assignment'; name: string; dueAt: Date }[] = [];

    const quizRows = await this.db.select({
      cmId: courseModules.id, courseId: courseModules.course, quizId: quizzes.id, name: quizzes.name, dueAt: quizzes.timeClose,
    }).from(courseModules)
      .innerJoin(quizzes, eq(quizzes.id, courseModules.instanceId))
      .where(and(
        inArray(courseModules.course, courseIds),
        eq(courseModules.component, 'mod_quiz'),
        eq(courseModules.visible, true),
        eq(courseModules.deletionInProgress, false),
        isNotNull(quizzes.timeClose),
        lte(quizzes.timeClose, threshold),
      ));
    for (const row of quizRows) {
      if (!row.dueAt) continue;
      if (await this.hasSubmittedQuiz(row.quizId, studentUserId)) continue;
      out.push({ cmId: row.cmId, courseId: row.courseId, kind: 'quiz', name: row.name, dueAt: row.dueAt });
    }

    const assignRows = await this.db.select({
      cmId: courseModules.id, courseId: courseModules.course, name: assignments.name, dueAt: assignments.dueDate,
      submissionStatus: assignSubmissions.status,
    }).from(courseModules)
      .innerJoin(assignments, eq(assignments.id, courseModules.instanceId))
      .leftJoin(assignSubmissions, and(
        eq(assignSubmissions.assignmentId, assignments.id),
        eq(assignSubmissions.userId, studentUserId),
      ))
      .where(and(
        inArray(courseModules.course, courseIds),
        eq(courseModules.component, 'mod_assign'),
        eq(courseModules.visible, true),
        eq(courseModules.deletionInProgress, false),
        isNotNull(assignments.dueDate),
        lte(assignments.dueDate, threshold),
      ));
    for (const row of assignRows) {
      if (!row.dueAt) continue;
      if (row.submissionStatus === 'submitted') continue;
      out.push({ cmId: row.cmId, courseId: row.courseId, kind: 'assignment', name: row.name, dueAt: row.dueAt });
    }
    return out;
  }

  /** Đã nộp quiz = tồn tại attempt không-preview ở trạng thái đã hoàn tất (khớp N5/PH-1). */
  private async hasSubmittedQuiz(quizId: string, studentUserId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: quizAttempts.id }).from(quizAttempts)
      .where(and(
        eq(quizAttempts.quizId, quizId),
        eq(quizAttempts.userId, studentUserId),
        eq(quizAttempts.preview, false),
        inArray(quizAttempts.state, SUBMITTED_ATTEMPT_STATES),
      ))
      .limit(1);
    return row !== undefined;
  }

  /** Các khoá học sinh đang ghi danh ACTIVE còn hiệu lực tại thời điểm quét (cùng kỷ luật N5). */
  private async enrolledCourseIds(studentUserId: string, now: Date): Promise<string[]> {
    const rows = await this.db.select({ courseId: enrol.courseId }).from(userEnrolments)
      .innerJoin(enrol, eq(enrol.id, userEnrolments.enrolId))
      .innerJoin(course, eq(course.id, enrol.courseId))
      .where(and(
        eq(userEnrolments.userId, studentUserId),
        eq(userEnrolments.status, 0),
        eq(enrol.status, 0),
        eq(course.visible, true),
        lte(userEnrolments.timeStart, now),
        or(isNull(userEnrolments.timeEnd), gt(userEnrolments.timeEnd, now)),
      ));
    return [...new Set(rows.map((r) => r.courseId))];
  }
}
