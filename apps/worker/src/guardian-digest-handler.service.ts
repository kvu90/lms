import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { I18nService } from '@nestjs/i18n';
import { and, asc, eq, gt, gte, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from './db/relations';
import {
  assignments, assignSubmissions, courseModules, enrol, examAttempts, examPins, examVersions,
  gradeGrades, gradeItems, gradePublications, guardianDigests, guardianLinks, notifications,
  outboxEvents, userEnrolments, users,
} from '@lms/db';
import { NotificationDeliveryService } from './notification-delivery.service';

type Database = NodePgDatabase<typeof relations>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sự kiện worker phát khi một lượt digest định kỳ đến hạn (payload của outbox guardian_digest_due). */
export interface GuardianDigestDuePayload {
  guardianUserId: string;
  studentUserId: string;
  digestId: string;
  kind: 'weekly' | 'daily';
  windowStart: string;
  windowEnd: string;
}

/** Sự kiện worker phát khi một việc quá hạn ≥7 ngày cần đẩy riêng (payload của outbox guardian_overdue_alert). */
export interface GuardianOverdueAlertPayload {
  guardianUserId: string;
  studentUserId: string;
  digestId: string;
  cmId: string;
  activityKind: 'quiz' | 'assignment';
  courseId: string;
  activityName: string;
  dueAt: string;
}

/**
 * Nửa TIÊU THỤ của digest phụ huynh (PH-2, issue #159) — đã chuyển từ
 * phía API sang worker ở issue con #518 của #491: trước đây
 * `GuardianDigestService.processDigestDue/processOverdueAlert` phía
 * API được nuôi bởi consumer polling `GuardianDigestConsumer` đọc
 * `outbox_events` mỗi 500 ms bằng watermark riêng; nay relay outbox
 * duy nhất của worker định tuyến hai loại sự kiện này vào hàng đợi
 * `guardian-digest-events` (bảng `OUTBOX_EVENT_QUEUE_ROUTES`) và
 * `GuardianDigestEventsProcessor` gọi thẳng hai hàm xử lý ở đây. Mọi
 * luật nghiệp vụ giữ nguyên văn như bản phía API; các truy vấn vốn đi
 * qua service/repository phía API (dashboard/grades/guardians/users)
 * được viết lại bằng Drizzle trực tiếp trên cùng các bảng — khuôn
 * mẫu đã có của phía worker (processor quét digest đọc thẳng DB).
 *
 * Nguyên tắc cứng của research phụ huynh áp ở mọi đường:
 * - Chỉ dữ liệu ĐÃ CÔNG BỐ: kết quả mới qua đúng cổng PH-0/DASH1
 *   (đếm kết quả đã công bố trong cửa sổ — bản đếm của
 *   `publishedNewResultsFor` phía API), thông báo lớp lọc loại
 *   `grade_updated` như bề mặt PH-1 — item chưa công bố vắng tuyệt
 *   đối khỏi digest, kể cả ở dạng số đếm suy ra được.
 * - Nội dung thông báo CHỈ là số lượng mục + link sâu tới màn PH-1
 *   của con: không điểm số, không tên việc chi tiết (trừ tên hoạt
 *   động ở đẩy quá hạn — dữ kiện học sinh tự thấy trong khoá, tiền lệ
 *   activity_due_soon), kênh ngoài nhận bản tối thiểu hoá riêng qua
 *   `externalSubject`/`externalBody` của notify().
 * - Cổng liên kết kiểm LẠI tại thời điểm gửi: liên kết đã thu hồi sau
 *   khi lượt quét chốt lượt → lượt bị huỷ (skipped_revoked), không
 *   gửi.
 * - Mỗi lượt gửi/huỷ đều để lại vết ở guardian_digests + audit
 *   event_log qua outbox aggregate `guardian` (chỉ số đếm, không
 *   điểm): sự kiện audit ghi vào `outbox_events` như
 *   `OutboxService.enqueueStandalone` phía API vẫn làm, relay duy
 *   nhất đóng dấu và phản chiếu sang event_log ở nhịp kế tiếp.
 *
 * Đường phát thông báo đi qua bề mặt dùng chung của worker
 * (`NotificationDeliveryService.notify` — dựng ở chính issue này cho
 * cả đợt chuyển consumer; issue #520 dùng lại): trọn luật notify()
 * phía API gồm kênh trong-app + job email vào hàng đợi
 * `notification-dispatch` + sự kiện `notification_created`.
 *
 * Idempotent theo vết lượt: lượt không còn `queued` (đã xử lý ở lần
 * phát trước) thì bỏ qua — cùng chốt bền mà consumer phía API dựa
 * vào; kết hợp khoá jobId = outboxId của relay, một sự kiện phát lại
 * không bao giờ sinh thông báo thứ hai.
 */
@Injectable()
export class GuardianDigestHandlerService {
  private readonly logger = new Logger(GuardianDigestHandlerService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly delivery: NotificationDeliveryService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Xử lý một sự kiện guardian_digest_due: tổng hợp cửa sổ và gửi.
   * Idempotent theo vết lượt: lượt không còn `queued` (đã xử lý ở lần
   * phát lại trước) thì bỏ qua — đường phát có tính ít-nhất-một-lần.
   */
  async processDigestDue(payload: GuardianDigestDuePayload): Promise<void> {
    const row = await this.getDigest(payload.digestId);
    if (!row || row.status !== 'queued') return;
    const guardianId = payload.guardianUserId;
    const studentId = payload.studentUserId;
    const windowStart = new Date(payload.windowStart);
    const windowEnd = new Date(payload.windowEnd);

    const link = await this.findActiveLink(guardianId, studentId);
    if (!link) {
      await this.finishDigest(row.id, { status: 'skipped_revoked' });
      return;
    }
    const guardian = await this.getUserBasics(guardianId);
    if (!guardian || guardian.suspended || guardian.deleted) {
      await this.finishDigest(row.id, { status: 'skipped_suspended' });
      return;
    }

    const counts = await this.aggregateWindow(studentId, payload.kind, windowStart, windowEnd);
    const total = counts.newResults + counts.announcements + counts.overdue + counts.upcoming;
    if (total === 0) {
      await this.finishDigest(row.id, {
        status: 'skipped_empty',
        newResultsCount: 0, announcementsCount: 0, overdueCount: 0, upcomingCount: 0,
      });
      return;
    }

    const studentName = await this.studentDisplayName(studentId);
    // Link sâu trỏ thẳng path theo con của khu vực phụ huynh (chuẩn
    // đường dẫn #221, lát R2); thông báo đã phát trước đây mang dạng
    // cũ /guardian?student= vẫn tới được nhờ lớp redirect phía web.
    const deepLink = `/guardian/students/${studentId}`;
    const subject = this.t(payload.kind === 'weekly' ? 'platform.guardianDigestWeeklySubject' : 'platform.guardianDigestDailySubject', { name: studentName });
    const body = this.t('platform.guardianDigestBody', {
      results: counts.newResults, announcements: counts.announcements,
      overdue: counts.overdue, upcoming: counts.upcoming,
    });
    const result = await this.delivery.notify(guardianId, 'guardian_digest', {
      subject, body, contextUrl: deepLink,
      externalSubject: this.t('platform.guardianDigestExternalSubject'),
      externalBody: this.t('platform.guardianDigestExternalBody'),
      // TENANT-1 (#196): digest thuộc tenant của liên kết giám hộ.
      tenantId: link.tenantId,
    });
    await this.sendZaloNotice({ guardianUserId: guardianId, studentUserId: studentId, kind: payload.kind, deepLink })
      .catch((error: Error) => this.logger.warn(`Seam Zalo (log-only) lỗi: ${error.message}`));
    await this.finishDigest(row.id, {
      status: 'sent',
      newResultsCount: counts.newResults, announcementsCount: counts.announcements,
      overdueCount: counts.overdue, upcomingCount: counts.upcoming,
      notificationId: result.notificationId, sentAt: new Date(),
    });
    await this.enqueueAuditEvent('guardian_digest_sent', link.tenantId, {
      actorId: guardianId, userId: studentId, objectId: row.id, digestId: row.id,
      kind: payload.kind, windowStart: payload.windowStart, windowEnd: payload.windowEnd,
      newResultsCount: counts.newResults, announcementsCount: counts.announcements,
      overdueCount: counts.overdue, upcomingCount: counts.upcoming,
    });
  }

  /** Xử lý một sự kiện guardian_overdue_alert: đẩy riêng quá hạn ≥7 ngày, đúng một lần (vết lượt là chốt). */
  async processOverdueAlert(payload: GuardianOverdueAlertPayload): Promise<void> {
    const row = await this.getDigest(payload.digestId);
    if (!row || row.status !== 'queued') return;
    const guardianId = payload.guardianUserId;
    const studentId = payload.studentUserId;

    const link = await this.findActiveLink(guardianId, studentId);
    if (!link) {
      await this.finishDigest(row.id, { status: 'skipped_revoked' });
      return;
    }
    const guardian = await this.getUserBasics(guardianId);
    if (!guardian || guardian.suspended || guardian.deleted) {
      await this.finishDigest(row.id, { status: 'skipped_suspended' });
      return;
    }

    const studentName = await this.studentDisplayName(studentId);
    // Link sâu trỏ thẳng path theo con (chuẩn đường dẫn #221, lát
    // R2) — cùng quy ước với link digest ở trên.
    const deepLink = `/guardian/students/${studentId}`;
    const result = await this.delivery.notify(guardianId, 'guardian_overdue_alert', {
      subject: this.t('platform.guardianOverdueAlertSubject', { activity: payload.activityName }),
      body: this.t('platform.guardianOverdueAlertBody', { activity: payload.activityName, name: studentName }),
      contextUrl: deepLink,
      externalSubject: this.t('platform.guardianOverdueAlertExternalSubject'),
      externalBody: this.t('platform.guardianOverdueAlertExternalBody'),
      // TENANT-1 (#196): đẩy quá hạn thuộc tenant của liên kết giám hộ.
      tenantId: link.tenantId,
    });
    await this.sendZaloNotice({ guardianUserId: guardianId, studentUserId: studentId, kind: 'overdue_alert', deepLink })
      .catch((error: Error) => this.logger.warn(`Seam Zalo (log-only) lỗi: ${error.message}`));
    await this.finishDigest(row.id, { status: 'sent', notificationId: result.notificationId, sentAt: new Date() });
    await this.enqueueAuditEvent('guardian_overdue_alert_sent', link.tenantId, {
      actorId: guardianId, userId: studentId, objectId: row.id, digestId: row.id,
      cmId: payload.cmId, activityKind: payload.activityKind, courseId: payload.courseId, dueAt: payload.dueAt,
    });
  }

  /**
   * Tổng hợp bốn con số của một cửa sổ digest cho một học sinh:
   * kết quả mới ĐÃ CÔNG BỐ trong cửa sổ (cổng PH-0 qua DASH1), thông
   * báo lớp trong cửa sổ (quy tắc PH-1), việc quá hạn chưa nộp ở thời
   * điểm gửi, việc sắp đến hạn trong cửa sổ kế tiếp (tuần tới / ngày
   * mai theo loại digest). Chỉ trả SỐ ĐẾM — nội dung chi tiết của con
   * sống ở bề mặt PH-1 phía sau link sâu.
   */
  private async aggregateWindow(
    studentId: string,
    kind: 'weekly' | 'daily',
    windowStart: Date,
    windowEnd: Date,
  ): Promise<{ newResults: number; announcements: number; overdue: number; upcoming: number }> {
    const courseIds = await this.enrolledCourseIds(studentId, new Date());

    const newResults = await this.countPublishedNewResults(studentId, courseIds, windowStart, windowEnd);

    const enrolled = new Set(courseIds);
    const notificationRows = await this.notificationsInWindow(studentId, windowStart, windowEnd);
    let announcements = 0;
    for (const n of notificationRows) {
      if (n.eventType === 'grade_updated') continue;
      const match = n.contextUrl?.match(/^\/courses\/([0-9a-fA-F-]{36})(?:\/|$)/);
      if (!match) continue;
      if (!enrolled.has(match[1]!)) continue;
      announcements += 1;
    }

    const now = new Date();
    const span = (kind === 'weekly' ? 7 : 1) * DAY_MS;
    const horizon = new Date(windowEnd.getTime() + span);
    let overdue = 0;
    let upcoming = 0;
    const classify = (dueAt: Date, submitted: boolean) => {
      if (submitted) return;
      if (dueAt < now) overdue += 1;
      else if (dueAt >= windowEnd && dueAt < horizon) upcoming += 1;
    };

    const quizRows = await this.quizDueRows(courseIds, studentId, horizon);
    const quizByCm = new Map<string, { dueAt: Date; states: (string | null)[] }>();
    for (const row of quizRows) {
      const entry = quizByCm.get(row.cmId) ?? { dueAt: row.dueAt!, states: [] };
      entry.states.push(row.attemptState);
      quizByCm.set(row.cmId, entry);
    }
    for (const entry of quizByCm.values()) {
      classify(entry.dueAt, entry.states.some((s) => s === 'finished' || s === 'needsgrading'));
    }
    const assignRows = await this.assignmentDueRows(courseIds, studentId, horizon);
    for (const row of assignRows) {
      classify(row.dueAt!, row.submissionStatus === 'submitted');
    }

    return { newResults, announcements, overdue, upcoming };
  }

  /**
   * ĐẾM kết quả đã công bố mới của học sinh trong cửa sổ — bản phía
   * worker của `publishedNewResultsFor` + bộ lọc cửa sổ của digest
   * phía API (`DashboardService.buildNewResults`): ứng viên là điểm
   * đổi sau mốc HOẶC item chỉ được công bố sau mốc; qua cổng công bố
   * PH-0 theo trạng thái hiệu lực của từng khoá; thời điểm hiệu lực
   * là max(lần sửa điểm, lần công bố) và phải nằm trong
   * (windowStart, windowEnd). Digest chỉ cần số đếm nên truy vấn chỉ
   * lấy các cột luật cần (điều kiện "có điểm hoặc phản hồi" giữ
   * nguyên trong mệnh đề WHERE như bản phía API).
   */
  private async countPublishedNewResults(studentId: string, courseIds: string[], windowStart: Date, windowEnd: Date): Promise<number> {
    if (!courseIds.length) return 0;

    // Vết công bố theo item: vết mới nhất quyết định hiệu lực hiện tại
    // và, với item manual, thời điểm điểm TRỞ NÊN hiển thị.
    const itemPubs = await this.db.select().from(gradePublications)
      .where(and(inArray(gradePublications.courseId, courseIds), eq(gradePublications.scope, 'item')))
      .orderBy(asc(gradePublications.createdAt));
    const latestPubByItem = new Map<string, (typeof itemPubs)[number]>();
    for (const p of itemPubs) {
      if (p.itemId) latestPubByItem.set(p.itemId, p); // rows tăng dần theo createdAt → cuối là mới nhất
    }
    // Ứng viên từ công bố: item có vết publish hiệu lực nằm sau mốc.
    const publishedAfterSince = new Set<string>();
    for (const [itemId, p] of latestPubByItem) {
      if (p.action === 'publish' && p.createdAt > windowStart) publishedAfterSince.add(itemId);
    }

    const gradeCandidate = {
      gradeId: gradeGrades.id,
      courseId: gradeItems.courseId,
      itemId: gradeItems.id,
      itemType: gradeItems.itemType,
      updatedAt: gradeGrades.updatedAt,
    };
    type GradeCandidate = { gradeId: string; courseId: string; itemId: string; itemType: string; updatedAt: Date };
    const nonEmptyGrade = sql`(${gradeGrades.finalGrade} is not null or (${gradeGrades.feedback} is not null and ${gradeGrades.feedback} <> ''))`;
    const candidateByGradeId = new Map<string, GradeCandidate>();
    const rowsSince = await this.db.select(gradeCandidate).from(gradeGrades)
      .innerJoin(gradeItems, eq(gradeItems.id, gradeGrades.itemId))
      .where(and(
        eq(gradeGrades.userId, studentId),
        inArray(gradeItems.courseId, courseIds),
        gt(gradeGrades.updatedAt, windowStart),
        nonEmptyGrade,
      ))
      .orderBy(asc(gradeGrades.updatedAt));
    for (const row of rowsSince) candidateByGradeId.set(row.gradeId, row);
    if (publishedAfterSince.size) {
      const rowsForItems = await this.db.select(gradeCandidate).from(gradeGrades)
        .innerJoin(gradeItems, eq(gradeItems.id, gradeGrades.itemId))
        .where(and(
          eq(gradeGrades.userId, studentId),
          inArray(gradeGrades.itemId, [...publishedAfterSince]),
          nonEmptyGrade,
        ));
      for (const row of rowsForItems) candidateByGradeId.set(row.gradeId, row);
    }

    const rowsByCourse = new Map<string, GradeCandidate[]>();
    for (const row of candidateByGradeId.values()) {
      if (row.itemType !== 'mod' && row.itemType !== 'manual') continue; // chỉ item lá, bỏ total/category
      const list = rowsByCourse.get(row.courseId) ?? [];
      list.push(row);
      rowsByCourse.set(row.courseId, list);
    }
    let count = 0;
    for (const [courseId, rows] of rowsByCourse) {
      const states = await this.publicationStatesForCourse(courseId);
      for (const row of rows) {
        // Cổng công bố PH-0: chưa công bố thì loại hoàn toàn khỏi số đếm.
        if (!(states.get(row.itemId)?.published ?? true)) continue;
        // Thời điểm hiệu lực: item manual lấy mốc công bố nếu công bố
        // muộn hơn lần sửa điểm (điểm chấm trước, công bố sau vẫn là
        // mới tại thời điểm công bố).
        const pub = latestPubByItem.get(row.itemId);
        const effectiveAt = pub && pub.action === 'publish' && pub.createdAt > row.updatedAt
          ? pub.createdAt
          : row.updatedAt;
        if (effectiveAt <= windowStart) continue;
        if (effectiveAt >= windowEnd) continue; // bộ lọc cửa sổ của digest: changedAt < windowEnd
        count += 1;
      }
    }
    return count;
  }

  /**
   * Trạng thái công bố hiệu lực của mọi item trong một khoá — bản
   * phía worker của `GradesService.publicationStatesForCourse` phía
   * API (PH-0): item 'auto' luôn coi là đã công bố (điểm hiện ngay
   * khi chấm); item 'manual' chỉ hiện khi vết mới nhất trong
   * grade_publications (scope item) là 'publish'.
   */
  private async publicationStatesForCourse(courseId: string): Promise<Map<string, { published: boolean }>> {
    const items = await this.db.select({ id: gradeItems.id, postingPolicy: gradeItems.postingPolicy })
      .from(gradeItems).where(eq(gradeItems.courseId, courseId));
    const publications = await this.db.select().from(gradePublications)
      .where(eq(gradePublications.courseId, courseId))
      .orderBy(asc(gradePublications.createdAt), asc(gradePublications.id));
    const latestByItem = new Map<string, string>();
    for (const p of publications) {
      if (p.scope === 'item' && p.itemId) latestByItem.set(p.itemId, p.action);
    }
    const states = new Map<string, { published: boolean }>();
    for (const item of items) {
      const policy = item.postingPolicy === 'manual' ? 'manual' : 'auto';
      states.set(item.id, { published: policy === 'auto' ? true : latestByItem.get(item.id) === 'publish' });
    }
    return states;
  }

  /** Khoá học sinh đang ghi danh hiệu lực (user_enrolments active, chưa hết hạn) — bản phía worker của `DashboardRepository.enrolledCourseIds` phía API. */
  private async enrolledCourseIds(userId: string, now: Date): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ courseId: enrol.courseId })
      .from(userEnrolments)
      .innerJoin(enrol, eq(enrol.id, userEnrolments.enrolId))
      .where(and(
        eq(userEnrolments.userId, userId),
        eq(userEnrolments.status, 0),
        or(sql`${userEnrolments.timeEnd} is null`, gt(userEnrolments.timeEnd, now)),
      ));
    return rows.map((r) => r.courseId);
  }

  /** Quiz có hạn nộp không muộn hơn `until` trong tập khoá kèm các attempt của học sinh — bản phía worker của `GuardianViewRepository.quizDueRows` phía API. */
  private async quizDueRows(courseIds: string[], studentUserId: string, until: Date) {
    if (!courseIds.length) return [];
    return this.db
      .select({
        cmId: courseModules.id,
        courseId: courseModules.course,
        name: sql<string>`coalesce(${examPins.name}, ${examVersions.name})`,
        dueAt: examPins.timeClose,
        attemptState: examAttempts.state,
      })
      .from(courseModules)
      .innerJoin(examPins, eq(examPins.id, courseModules.instanceId))
      .innerJoin(examVersions, eq(examVersions.id, examPins.examVersionId))
      .leftJoin(examAttempts, and(
        eq(examAttempts.pinId, examPins.id),
        eq(examAttempts.userId, studentUserId),
        eq(examAttempts.preview, false),
      ))
      .where(and(
        inArray(courseModules.course, courseIds),
        eq(courseModules.component, 'mod_quiz'),
        eq(courseModules.visible, true),
        eq(courseModules.deletionInProgress, false),
        isNotNull(examPins.timeClose),
        lte(examPins.timeClose, until),
      ))
      .orderBy(asc(examPins.timeClose));
  }

  /** Bài tập C2 có hạn nộp không muộn hơn `until` trong tập khoá kèm bài nộp hiện hành của học sinh — bản phía worker của `GuardianViewRepository.assignmentDueRows` phía API. */
  private async assignmentDueRows(courseIds: string[], studentUserId: string, until: Date) {
    if (!courseIds.length) return [];
    return this.db
      .select({
        cmId: courseModules.id,
        courseId: courseModules.course,
        name: assignments.name,
        dueAt: assignments.dueDate,
        submissionStatus: assignSubmissions.status,
      })
      .from(courseModules)
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
        lte(assignments.dueDate, until),
      ))
      .orderBy(asc(assignments.dueDate));
  }

  /** Vết lượt digest theo id (lượt quét đã chốt khi phát sự kiện) — bản phía worker của `GuardianDigestRepository.getDigest` phía API. */
  private async getDigest(id: string) {
    const [row] = await this.db.select().from(guardianDigests).where(eq(guardianDigests.id, id));
    return row;
  }

  /** Chốt kết quả một lượt digest: trạng thái + số đếm tóm tắt + notification đã sinh — bản phía worker của `GuardianDigestRepository.finishDigest` phía API. */
  private async finishDigest(id: string, patch: {
    status: string;
    newResultsCount?: number;
    announcementsCount?: number;
    overdueCount?: number;
    upcomingCount?: number;
    notificationId?: string | null;
    sentAt?: Date | null;
  }): Promise<void> {
    await this.db.update(guardianDigests)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(guardianDigests.id, id));
  }

  /**
   * Thông báo đã gửi cho học sinh trong cửa sổ [start, end) — nguyên
   * liệu khối thông báo lớp của digest; handler lọc tiếp theo khoá/loại
   * đúng quy tắc PH-1 (loại thông báo điểm).
   */
  private async notificationsInWindow(studentUserId: string, start: Date, end: Date) {
    return this.db
      .select({
        id: notifications.id,
        eventType: notifications.eventType,
        contextUrl: notifications.contextUrl,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(and(
        eq(notifications.userIdTo, studentUserId),
        gte(notifications.createdAt, start),
        lt(notifications.createdAt, end),
      ));
  }

  /** Liên kết giám hộ ĐANG hiệu lực của cặp (phụ huynh, con) — cổng kiểm lại tại thời điểm gửi; không có → undefined. */
  private async findActiveLink(guardianUserId: string, studentUserId: string) {
    const [row] = await this.db.select().from(guardianLinks).where(and(
      eq(guardianLinks.guardianUserId, guardianUserId),
      eq(guardianLinks.studentUserId, studentUserId),
      eq(guardianLinks.status, 'active'),
    ));
    return row;
  }

  /** Các trường trạng thái tài khoản của một user (đình chỉ/đã xoá) — cổng người nhận của lượt gửi. */
  private async getUserBasics(userId: string) {
    const [row] = await this.db.select({ id: users.id, suspended: users.suspended, deleted: users.deleted })
      .from(users).where(eq(users.id, userId));
    return row;
  }

  /**
   * Tên hiển thị của học sinh cho nội dung digest (họ + tên như phía
   * API vẫn dựng). Học sinh không còn tồn tại là lỗi dữ liệu: ném lỗi
   * để processor ghi vết và lượt giữ nguyên `queued`, như hành vi
   * phía API khi `getUser` không tìm thấy.
   */
  private async studentDisplayName(studentId: string): Promise<string> {
    const [row] = await this.db.select({ firstName: users.firstName, lastName: users.lastName })
      .from(users).where(eq(users.id, studentId));
    if (!row) throw new Error(`Không tìm thấy học sinh ${studentId} của lượt digest`);
    return `${row.lastName} ${row.firstName}`.trim();
  }

  /**
   * Ghi một sự kiện audit digest vào outbox — bản phía worker của
   * `OutboxService.enqueueStandalone` phía API cho aggregate
   * `guardian`: hàng chờ relay duy nhất đóng dấu + phản chiếu sang
   * event_log. Payload của hai sự kiện audit digest không mang sẵn
   * khoá tenantId nên tenantId luôn được phản chiếu vào payload, đúng
   * luật phản chiếu của enqueue phía API.
   */
  private async enqueueAuditEvent(type: string, tenantId: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.insert(outboxEvents).values({
      aggregate: 'guardian', type, tenantId,
      payload: { ...payload, tenantId },
    });
  }

  /**
   * Seam Zalo OA cho digest phụ huynh — BẢN LOG-ONLY chuyển nguyên
   * từ phía API: chưa có hạ tầng Zalo OA nên "gửi" chỉ là một dòng
   * log giữ chỗ cho tích hợp thật sau này; KHÔNG có hàng đợi, KHÔNG
   * có dispatch log, KHÔNG chạm dữ liệu học tập của con. Lỗi của
   * seam không bao giờ được làm hỏng lượt digest (nơi gọi nuốt lỗi
   * như phía API).
   */
  private async sendZaloNotice(input: { guardianUserId: string; studentUserId: string; kind: string; deepLink: string }): Promise<void> {
    this.logger.log(
      `Zalo OA (log-only, chưa có hạ tầng): nhắc digest ${input.kind} cho phụ huynh ${input.guardianUserId}, con ${input.studentUserId}, link sâu ${input.deepLink}`,
    );
  }

  /** Dịch chuỗi nền cho phụ huynh: locale mặc định 'vi' như quy ước của các consumer nền (không có request context). */
  private t(key: string, args?: Record<string, unknown>): string {
    return String(this.i18n.t(key, { locale: 'vi', args }));
  }
}
