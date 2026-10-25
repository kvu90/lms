import { Inject, Injectable, Logger } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import type { GuardianDigestFrequency, GuardianDigestPreferenceView } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { MessagingService } from '../messaging/messaging.service';
import { UsersService } from '../users/users.service';
import { GuardianDigestRepository } from './guardian-digest.repository';
import { GUARDIAN_DIGEST_ZALO_PORT, type GuardianDigestZaloPort } from './guardian-digest-zalo.port';
import { GuardianViewRepository } from './guardian-view.repository';
import { GuardiansRepository } from './guardians.repository';
import { GuardiansService } from './guardians.service';

/** Khoá user_preferences của tần suất digest theo từng con — worker đọc đúng khoá này khi quét. */
export function guardianDigestFrequencyPreferenceName(studentUserId: string): string {
  return `guardian_digest_frequency:${studentUserId}`;
}

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
 * Nghiệp vụ digest phụ huynh (PH-2, issue #159) phía API: tổng hợp +
 * gửi cho các lượt worker đã chốt trong `guardian_digests`. Nguyên tắc
 * cứng của research phụ huynh áp ở mọi đường:
 * - Chỉ dữ liệu ĐÃ CÔNG BỐ: kết quả mới qua đúng cổng PH-0/DASH1
 *   (`publishedNewResultsFor`, lọc trong cửa sổ), thông báo lớp lọc
 *   loại `grade_updated` như bề mặt PH-1 — item chưa công bố vắng
 *   tuyệt đối khỏi digest, kể cả ở dạng số đếm suy ra được.
 * - Nội dung thông báo CHỈ là số lượng mục + link sâu tới màn PH-1
 *   của con: không điểm số, không tên việc chi tiết (trừ tên hoạt
 *   động ở đẩy quá hạn — dữ kiện học sinh tự thấy trong khoá, tiền lệ
 *   activity_due_soon), kênh ngoài nhận bản tối thiểu hoá riêng qua
 *   `externalSubject`/`externalBody` của notify().
 * - Cổng liên kết kiểm LẠI tại thời điểm gửi: liên kết đã thu hồi sau
 *   khi worker chốt lượt → lượt bị huỷ (skipped_revoked), không gửi.
 * - Mỗi lượt gửi/huỷ đều để lại vết ở guardian_digests + audit
 *   event_log qua outbox aggregate `guardian` (chỉ số đếm, không điểm).
 */
@Injectable()
export class GuardianDigestService {
  private readonly logger = new Logger(GuardianDigestService.name);

  constructor(
    private readonly repo: GuardianDigestRepository,
    private readonly viewRepo: GuardianViewRepository,
    private readonly links: GuardiansRepository,
    private readonly guardians: GuardiansService,
    private readonly dashboard: DashboardService,
    private readonly users: UsersService,
    private readonly messaging: MessagingService,
    private readonly outbox: OutboxService,
    private readonly i18n: I18nService,
    @Inject(GUARDIAN_DIGEST_ZALO_PORT) private readonly zalo: GuardianDigestZaloPort,
  ) {}

  /** Tuỳ chọn digest hiện hành của phụ huynh cho một con (qua cổng liên kết; mặc định weekly). */
  async getPreference(guardianId: string, studentId: string): Promise<GuardianDigestPreferenceView> {
    await this.guardians.requireActiveLinkOr404(guardianId, studentId);
    const raw = await this.users.getPreference(guardianId, guardianDigestFrequencyPreferenceName(studentId));
    const frequency: GuardianDigestFrequency = raw === 'daily' || raw === 'off' ? raw : 'weekly';
    return { studentId, frequency };
  }

  /** Đặt tần suất digest cho một con — hiệu lực từ cửa sổ kế tiếp (worker chỉ chốt cửa sổ chưa có vết). */
  async setPreference(guardianId: string, studentId: string, frequency: GuardianDigestFrequency): Promise<GuardianDigestPreferenceView> {
    await this.guardians.requireActiveLinkOr404(guardianId, studentId);
    await this.users.setPreference(guardianId, guardianDigestFrequencyPreferenceName(studentId), frequency);
    return { studentId, frequency };
  }

  /**
   * Xử lý một sự kiện guardian_digest_due: tổng hợp cửa sổ và gửi.
   * Idempotent theo vết lượt: lượt không còn `queued` (đã xử lý ở lần
   * phát lại trước) thì bỏ qua — consumer có tính ít-nhất-một-lần.
   */
  async processDigestDue(payload: GuardianDigestDuePayload): Promise<void> {
    const row = await this.repo.getDigest(payload.digestId);
    if (!row || row.status !== 'queued') return;
    const guardianId = payload.guardianUserId;
    const studentId = payload.studentUserId;
    const windowStart = new Date(payload.windowStart);
    const windowEnd = new Date(payload.windowEnd);

    const link = await this.links.findActiveLink(guardianId, studentId);
    if (!link) {
      await this.repo.finishDigest(row.id, { status: 'skipped_revoked' });
      return;
    }
    const guardian = await this.users.getByIdOrUndefined(guardianId);
    if (!guardian || guardian.suspended || guardian.deleted) {
      await this.repo.finishDigest(row.id, { status: 'skipped_suspended' });
      return;
    }

    const counts = await this.aggregateWindow(studentId, payload.kind, windowStart, windowEnd);
    const total = counts.newResults + counts.announcements + counts.overdue + counts.upcoming;
    if (total === 0) {
      await this.repo.finishDigest(row.id, {
        status: 'skipped_empty',
        newResultsCount: 0, announcementsCount: 0, overdueCount: 0, upcomingCount: 0,
      });
      return;
    }

    const student = await this.users.getUser(studentId);
    const studentName = `${student.lastName} ${student.firstName}`.trim();
    const deepLink = `/guardian?student=${studentId}`;
    const subject = this.t(payload.kind === 'weekly' ? 'platform.guardianDigestWeeklySubject' : 'platform.guardianDigestDailySubject', { name: studentName });
    const body = this.t('platform.guardianDigestBody', {
      results: counts.newResults, announcements: counts.announcements,
      overdue: counts.overdue, upcoming: counts.upcoming,
    });
    const result = await this.messaging.notify(guardianId, 'guardian_digest', {
      subject, body, contextUrl: deepLink,
      externalSubject: this.t('platform.guardianDigestExternalSubject'),
      externalBody: this.t('platform.guardianDigestExternalBody'),
      // TENANT-1 (#196): digest thuộc tenant của liên kết giám hộ.
      tenantId: link.tenantId,
    });
    await this.zalo.sendNotice({ guardianUserId: guardianId, studentUserId: studentId, kind: payload.kind, deepLink })
      .catch((error: Error) => this.logger.warn(`Seam Zalo (log-only) lỗi: ${error.message}`));
    await this.repo.finishDigest(row.id, {
      status: 'sent',
      newResultsCount: counts.newResults, announcementsCount: counts.announcements,
      overdueCount: counts.overdue, upcomingCount: counts.upcoming,
      notificationId: result.notificationId, sentAt: new Date(),
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'guardian', type: 'guardian_digest_sent', tenantId: link.tenantId,
      payload: {
        actorId: guardianId, userId: studentId, objectId: row.id, digestId: row.id,
        kind: payload.kind, windowStart: payload.windowStart, windowEnd: payload.windowEnd,
        newResultsCount: counts.newResults, announcementsCount: counts.announcements,
        overdueCount: counts.overdue, upcomingCount: counts.upcoming,
      },
    });
  }

  /** Xử lý một sự kiện guardian_overdue_alert: đẩy riêng quá hạn ≥7 ngày, đúng một lần (vết lượt là chốt). */
  async processOverdueAlert(payload: GuardianOverdueAlertPayload): Promise<void> {
    const row = await this.repo.getDigest(payload.digestId);
    if (!row || row.status !== 'queued') return;
    const guardianId = payload.guardianUserId;
    const studentId = payload.studentUserId;

    const link = await this.links.findActiveLink(guardianId, studentId);
    if (!link) {
      await this.repo.finishDigest(row.id, { status: 'skipped_revoked' });
      return;
    }
    const guardian = await this.users.getByIdOrUndefined(guardianId);
    if (!guardian || guardian.suspended || guardian.deleted) {
      await this.repo.finishDigest(row.id, { status: 'skipped_suspended' });
      return;
    }

    const student = await this.users.getUser(studentId);
    const studentName = `${student.lastName} ${student.firstName}`.trim();
    const deepLink = `/guardian?student=${studentId}`;
    const result = await this.messaging.notify(guardianId, 'guardian_overdue_alert', {
      subject: this.t('platform.guardianOverdueAlertSubject', { activity: payload.activityName }),
      body: this.t('platform.guardianOverdueAlertBody', { activity: payload.activityName, name: studentName }),
      contextUrl: deepLink,
      externalSubject: this.t('platform.guardianOverdueAlertExternalSubject'),
      externalBody: this.t('platform.guardianOverdueAlertExternalBody'),
      // TENANT-1 (#196): đẩy quá hạn thuộc tenant của liên kết giám hộ.
      tenantId: link.tenantId,
    });
    await this.zalo.sendNotice({ guardianUserId: guardianId, studentUserId: studentId, kind: 'overdue_alert', deepLink })
      .catch((error: Error) => this.logger.warn(`Seam Zalo (log-only) lỗi: ${error.message}`));
    await this.repo.finishDigest(row.id, { status: 'sent', notificationId: result.notificationId, sentAt: new Date() });
    await this.outbox.enqueueStandalone({
      aggregate: 'guardian', type: 'guardian_overdue_alert_sent', tenantId: link.tenantId,
      payload: {
        actorId: guardianId, userId: studentId, objectId: row.id, digestId: row.id,
        cmId: payload.cmId, activityKind: payload.activityKind, courseId: payload.courseId, dueAt: payload.dueAt,
      },
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
    const { courseIds } = await this.dashboard.enrolledCoursesFor(studentId);

    const published = await this.dashboard.publishedNewResultsFor(studentId, windowStart);
    const newResults = published.filter((r) => new Date(r.changedAt) < windowEnd).length;

    const enrolled = new Set(courseIds);
    const notificationRows = await this.repo.notificationsInWindow(studentId, windowStart, windowEnd);
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

    const quizRows = await this.viewRepo.quizDueRows(courseIds, studentId, horizon);
    const quizByCm = new Map<string, { dueAt: Date; states: (string | null)[] }>();
    for (const row of quizRows) {
      const entry = quizByCm.get(row.cmId) ?? { dueAt: row.dueAt!, states: [] };
      entry.states.push(row.attemptState);
      quizByCm.set(row.cmId, entry);
    }
    for (const entry of quizByCm.values()) {
      classify(entry.dueAt, entry.states.some((s) => s === 'finished' || s === 'needsgrading'));
    }
    const assignRows = await this.viewRepo.assignmentDueRows(courseIds, studentId, horizon);
    for (const row of assignRows) {
      classify(row.dueAt!, row.submissionStatus === 'submitted');
    }

    return { newResults, announcements, overdue, upcoming };
  }

  /** Dịch chuỗi nền cho phụ huynh: locale mặc định 'vi' như quy ước của các consumer nền (không có request context). */
  private t(key: string, args?: Record<string, unknown>): string {
    return String(this.i18n.t(key, { locale: 'vi', args }));
  }
}
