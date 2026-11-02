import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { sql, type CentreDB } from '@lms/db';
import { TaskLogService } from '../task-log.service';
import { tenantAls } from '../db/tenant-als';
import { SpaceDatabaseService } from '../db/routing/space-database.service';

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

/** Dòng liên kết tối thiểu mà `sweepLink` cần — đúng các cột select ở `sweep`, không phải toàn bộ dòng guardian_links. */
interface GuardianLinkRow {
  guardianUserId: string;
  studentUserId: string;
  tenantId: string;
  createdAt: Date;
}

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
 * idempotent; phần tổng hợp nội dung + gửi nằm ở nửa tiêu thụ phía
 * worker (relay outbox → hàng đợi `guardian-digest-events` →
 * `GuardianDigestHandlerService`, từ issue con #518 của #491 — trước
 * đó là consumer polling phía API) dùng đúng đường đọc đã công bố
 * của PH-1.
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
 * Xử lý job quét digest phụ huynh: chốt các lượt digest/đẩy quá hạn đến hạn và phát sự kiện outbox cho nửa tiêu thụ phía worker tổng hợp + gửi.
 */
export class GuardianDigestProcessor extends WorkerHost {
  constructor(private readonly spaceDb: SpaceDatabaseService, private readonly taskLog: TaskLogService) { super(); }

  /**
   * Xử lý một job của queue tương ứng: chốt các lượt digest/đẩy quá
   * hạn đến hạn và phát sự kiện outbox cho relay chuyển sang hàng
   * đợi xử lý phía worker. Mỗi lượt quét được ghi vào task_log qua
   * TaskLogService.
   */
  async process(_job: Job): Promise<GuardianDigestSweepResult> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(_job));
  }

  private async processInContext(_job: Job): Promise<GuardianDigestSweepResult> {
    void _job;
    return this.taskLog.run('guardian-digests', () => this.sweep(), (r) => `queued ${r.queued.length} guardian digest item(s)`);
  }

  private async sweep(): Promise<GuardianDigestSweepResult> {
    const now = new Date();
    const queued: GuardianDigestQueuedItem[] = [];

    const links = await this.spaceDb.routedKysely
      .selectFrom('guardian_links')
      .select(['guardian_user_id as guardianUserId', 'student_user_id as studentUserId', 'tenant_id as tenantId', 'created_at as createdAt'])
      .where('status', '=', 'active')
      .execute();
    if (links.length === 0) return { checkedAt: now.toISOString(), queued };

    const frequencyByPair = await this.frequencyMap(links.map((l) => l.guardianUserId));

    // TENANT-1 (#196): quét THEO TỪNG TENANT — các liên kết được gom
    // theo tenant của chúng và phần việc của mỗi tenant chạy trong
    // đúng ngữ cảnh tenant đó (RLS tự giới hạn enrol/khoá khi đọc quá
    // hạn), dedupe_key mang đoạn tenant, hàng digest + sự kiện outbox
    // đều gắn tenant_id của liên kết.
    const linksByTenant = new Map<string, typeof links>();
    for (const link of links) {
      const group = linksByTenant.get(link.tenantId) ?? [];
      group.push(link);
      linksByTenant.set(link.tenantId, group);
    }
    for (const [tenantId, tenantLinks] of linksByTenant) {
      await tenantAls.run({ tenantId }, async () => {
        for (const link of tenantLinks) {
          const frequency = frequencyByPair.get(`${link.guardianUserId}:${link.studentUserId}`) ?? 'weekly';
          await this.sweepLink(link, frequency, now, queued);
        }
      });
    }
    return { checkedAt: now.toISOString(), queued };
  }

  /** Phần việc của MỘT liên kết giám hộ trong một lượt quét (chạy trong ngữ cảnh tenant của liên kết). */
  private async sweepLink(
    link: GuardianLinkRow,
    frequency: Frequency,
    now: Date,
    queued: GuardianDigestQueuedItem[],
  ): Promise<void> {
    // Digest định kỳ cho cửa sổ đầy đủ vừa đóng theo tần suất hiện
    // hành — `off` chỉ tắt khối này. Vòng đẩy riêng quá hạn ở dưới là
    // ngoại lệ tách khỏi digest, chạy bất kể tần suất.
    if (frequency !== 'off') {
      const window = frequency === 'weekly'
        ? { start: new Date(weekStartUtc(now).getTime() - 7 * 24 * 3600_000), end: weekStartUtc(now) }
        : { start: new Date(dayStartUtc(now).getTime() - 24 * 3600_000), end: dayStartUtc(now) };
      if (link.createdAt < window.end) {
        const dedupeKey = `digest:${link.tenantId}:${link.guardianUserId}:${link.studentUserId}:${frequency}:${window.start.toISOString()}`;
        const digestId = await this.queueMark({
          guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, kind: frequency,
          windowStart: window.start, windowEnd: window.end, activityCmId: null, dedupeKey, tenantId: link.tenantId,
        });
        if (digestId) {
          await this.spaceDb.routedKysely.insertInto('outbox_events').values({
            aggregate: 'guardian', type: 'guardian_digest_due', tenant_id: link.tenantId,
            // jsonb: serialize tường minh kèm `::jsonb` theo khuôn
            // ghi jsonb của `@lms/db`; khoá payload giữ nguyên
            // camelCase như sự kiện cũ vì nửa tiêu thụ đọc đúng khoá đó.
            payload: sql<CentreDB['outbox_events']['payload']>`${JSON.stringify({
              guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, digestId, tenantId: link.tenantId,
              kind: frequency, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(),
            })}::jsonb`,
          }).execute();
          queued.push({ guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, kind: frequency, dedupeKey });
        }
      }
    }

    // Đẩy riêng quá hạn ≥7 ngày: đúng một lần cho từng hoạt động.
    for (const item of await this.longOverdueItems(link.studentUserId, now)) {
      const dedupeKey = `overdue:${link.tenantId}:${link.guardianUserId}:${link.studentUserId}:${item.cmId}`;
      const digestId = await this.queueMark({
        guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, kind: 'overdue_alert',
        windowStart: null, windowEnd: null, activityCmId: item.cmId, dedupeKey, tenantId: link.tenantId,
      });
      if (!digestId) continue;
      await this.spaceDb.routedKysely.insertInto('outbox_events').values({
        aggregate: 'guardian', type: 'guardian_overdue_alert', tenant_id: link.tenantId,
        payload: sql<CentreDB['outbox_events']['payload']>`${JSON.stringify({
          guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, digestId, tenantId: link.tenantId,
          cmId: item.cmId, activityKind: item.kind, courseId: item.courseId,
          activityName: item.name, dueAt: item.dueAt.toISOString(),
        })}::jsonb`,
      }).execute();
      queued.push({ guardianUserId: link.guardianUserId, studentUserId: link.studentUserId, kind: 'overdue_alert', dedupeKey });
    }
  }

  /** Tần suất theo từng cặp (phụ huynh, con): đọc một lượt mọi preference digest của các phụ huynh liên quan. */
  private async frequencyMap(guardianIds: string[]): Promise<Map<string, Frequency>> {
    const rows = await this.spaceDb.routedKysely
      .selectFrom('user_preferences')
      .select(['user_id as userId', 'name', 'value'])
      .where('user_id', 'in', [...new Set(guardianIds)])
      .where(sql<boolean>`${sql.ref('user_preferences.name')} like 'guardian_digest_frequency:%'`)
      .execute();
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
    tenantId: string;
  }): Promise<string | null> {
    const row = await this.spaceDb.routedKysely.insertInto('guardian_digests').values({
      guardian_user_id: input.guardianUserId, student_user_id: input.studentUserId, kind: input.kind,
      window_start: input.windowStart, window_end: input.windowEnd, activity_cm_id: input.activityCmId,
      dedupe_key: input.dedupeKey, status: 'queued', tenant_id: input.tenantId,
    }).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst();
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

    const quizRows = await this.spaceDb.routedKysely
      .selectFrom('course_modules')
      .innerJoin('exam_pins', 'exam_pins.id', 'course_modules.instance_id')
      .innerJoin('exam_versions', 'exam_versions.id', 'exam_pins.exam_version_id')
      .select([
        'course_modules.id as cmId', 'course_modules.course as courseId', 'exam_pins.id as pinId',
        sql<string>`coalesce(${sql.ref('exam_pins.name')}, ${sql.ref('exam_versions.name')})`.as('name'),
        'exam_pins.time_close as dueAt',
      ])
      .where('course_modules.course', 'in', courseIds)
      .where('course_modules.component', '=', 'mod_quiz')
      .where('course_modules.visible', '=', true)
      .where('course_modules.deletion_in_progress', '=', false)
      .where('exam_pins.time_close', 'is not', null)
      .where('exam_pins.time_close', '<=', threshold)
      .execute();
    for (const row of quizRows) {
      if (!row.dueAt) continue;
      if (await this.hasSubmittedQuiz(row.pinId, studentUserId)) continue;
      out.push({ cmId: row.cmId, courseId: row.courseId, kind: 'quiz', name: row.name, dueAt: row.dueAt });
    }

    const assignRows = await this.spaceDb.routedKysely
      .selectFrom('course_modules')
      .innerJoin('assignments', 'assignments.id', 'course_modules.instance_id')
      .leftJoin('assign_submissions', (join) => join
        .onRef('assign_submissions.assignment_id', '=', 'assignments.id')
        .on('assign_submissions.user_id', '=', studentUserId))
      .select([
        'course_modules.id as cmId', 'course_modules.course as courseId', 'assignments.name',
        'assignments.due_date as dueAt', 'assign_submissions.status as submissionStatus',
      ])
      .where('course_modules.course', 'in', courseIds)
      .where('course_modules.component', '=', 'mod_assign')
      .where('course_modules.visible', '=', true)
      .where('course_modules.deletion_in_progress', '=', false)
      .where('assignments.due_date', 'is not', null)
      .where('assignments.due_date', '<=', threshold)
      .execute();
    for (const row of assignRows) {
      if (!row.dueAt) continue;
      if (row.submissionStatus === 'submitted') continue;
      out.push({ cmId: row.cmId, courseId: row.courseId, kind: 'assignment', name: row.name, dueAt: row.dueAt });
    }
    return out;
  }

  /** Đã nộp hoạt động đề = tồn tại attempt không-preview ở trạng thái đã hoàn tất cho pin (khớp N5/PH-1). */
  private async hasSubmittedQuiz(pinId: string, studentUserId: string): Promise<boolean> {
    const row = await this.spaceDb.routedKysely
      .selectFrom('exam_attempts')
      .select('id')
      .where('pin_id', '=', pinId)
      .where('user_id', '=', studentUserId)
      .where('preview', '=', false)
      .where('state', 'in', SUBMITTED_ATTEMPT_STATES)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Các khoá học sinh đang ghi danh ACTIVE còn hiệu lực tại thời điểm quét (cùng kỷ luật N5). */
  private async enrolledCourseIds(studentUserId: string, now: Date): Promise<string[]> {
    const rows = await this.spaceDb.routedKysely
      .selectFrom('user_enrolments')
      .innerJoin('enrol', 'enrol.id', 'user_enrolments.enrol_id')
      .innerJoin('course', 'course.id', 'enrol.course_id')
      .select('enrol.course_id as courseId')
      .where('user_enrolments.user_id', '=', studentUserId)
      .where('user_enrolments.status', '=', 0)
      .where('enrol.status', '=', 0)
      .where('course.visible', '=', true)
      .where('user_enrolments.time_start', '<=', now)
      .where((eb) => eb.or([
        eb('user_enrolments.time_end', 'is', null),
        eb('user_enrolments.time_end', '>', now),
      ]))
      .execute();
    return [...new Set(rows.map((r) => r.courseId))];
  }
}
