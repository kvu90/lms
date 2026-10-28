import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, gt, inArray, max } from 'drizzle-orm';
import Redis from 'ioredis';
import { I18nService } from '@nestjs/i18n';
import type { Database } from '../../db/database';
import { outboxEvents } from '../../db/schema';
import { redisTlsFromUrl } from '../../config/env';
import { MessagingRepository } from './messaging.repository';
import { MessagingService, displayNameOf } from './messaging.service';
import { UsersService } from '../users/users.service';
import { tenantAls } from '../tenants/tenant-als';

/** Nhịp quét outbox của consumer thông báo (khớp nhịp consumer realtime). */
const POLL_INTERVAL_MS = 500;
/** Số sự kiện tối đa xử lý trong một nhịp quét. */
const BATCH_SIZE = 100;
/**
 * Các loại sự kiện nghiệp vụ được biến thành NOTIFICATION qua consumer
 * này: bộ đầu của lát N1 (issue #49) — grade_updated /
 * course_completed / enrol_expiry_warning + tin nhắn mới
 * (message_new) + nhắc hạn nộp (activity_due_soon, lát N5 issue #50) —
 * và bộ vòng đời Bài tập/Đề của NB-1 (issue #174): assignment_created /
 * assignment_submitted / assignment_returned / exam_pinned (hợp nhất
 * quiz_created + exam_paper_deployed sau feat gộp Đề #226) /
 * quiz_attempt_finished. Sự kiện do CẢ API lẫn worker phát (chấm lại
 * điểm, quét hết hạn ghi danh chạy ở worker) nên đường nối phải đọc
 * outbox đã commit thay vì lắng nghe EventEmitter trong một tiến trình.
 */
const HANDLED_TYPES = ['grade_updated', 'course_completed', 'enrol_expiry_warning', 'message_sent', 'activity_due_reminder', 'assignment_created', 'assignment_submitted', 'assignment_returned', 'exam_pinned', 'quiz_attempt_finished'] as const;

/** Các loại grade item KHÔNG sinh thông báo điểm: tổng khoá, tổng hạng mục, item công thức (điểm thành phần đã báo riêng). */
const NON_NOTIFIED_ITEM_TYPES = new Set(['course', 'category', 'calculated']);

/**
 * Consumer nối dây thông báo (issue #49, lát N1) — mắt xích
 * "sự kiện nghiệp vụ/outbox → MessagingService.notify()" cho các
 * provider không có caller đồng bộ:
 *
 *  - `grade_updated` (grades phát ở API + worker chấm lại): chỉ báo
 *    cho item thành phần (không báo tổng), điểm chưa bị ẩn với học
 *    sinh, finalGrade khác null; trong một lô, nhiều sự kiện trùng
 *    (user, item) chỉ giữ sự kiện cuối. Nội dung KHÔNG chứa điểm số
 *    ở bất kỳ kênh nào (chuẩn Canvas — điểm chỉ xem trong trang điểm).
 *  - `course_completed` (completion phát khi trạng thái lật sang
 *    hoàn thành — sự kiện vốn chỉ phát đúng một lần mỗi lần lật).
 *  - `enrol_expiry_warning` (worker enrol-expiry phát khi ghi danh
 *    lọt vào cửa sổ sắp hết hạn, đã chống trùng ở phía phát).
 *  - `message_sent` (messaging phát khi gửi tin): báo cho mọi thành
 *    viên hiện tại trừ người gửi và người đã chặn người gửi; GỘP theo
 *    conversation — còn một thông báo message_new chưa đọc của
 *    conversation đó thì không sinh thêm. Nội dung tin nhắn không
 *    bao giờ nằm trong thông báo.
 *  - `activity_due_reminder` (worker activity-due-reminders phát khi
 *    một hoạt động lọt vào cửa sổ 24 giờ trước hạn nộp, lát N5 issue
 *    #50; đã chống trùng ở phía phát theo (học sinh, hoạt động, mốc
 *    hạn)) → thông báo `activity_due_soon`.
 *  - Vòng đời Bài tập/Quiz hai chiều (NB-1, issue #174 — các sự kiện
 *    do assignments/quiz phát, payload chỉ mang id + ngữ cảnh, nội
 *    dung tra từ DB tại thời điểm xử lý):
 *    `assignment_created` → `assignment_assigned` cho học sinh đang
 *    ghi danh (trừ người tạo; cổng hiển thị như worker nhắc hạn:
 *    khoá hiện + module không ẩn/không đang xoá);
 *    `assignment_submitted` → xác nhận đã nộp cho chính học sinh +
 *    bản GỘP `assignment_submitted` cho giáo viên phụ trách (P5: còn
 *    bản chưa đọc của cùng bài tập thì CẬP NHẬT số lượng chờ chấm
 *    trong bản đó, không sinh bản mới);
 *    `assignment_returned` → `assignment_returned` cho học sinh sở
 *    hữu bài nộp (nội dung không chứa điểm/mức — điểm đi đường
 *    grade_updated riêng, contextUrl khác nhau để không trùng hiển
 *    thị: trả bài trỏ về trang bài tập, điểm trỏ về trang điểm);
 *    `exam_pinned` → `quiz_available` cho học sinh đang ghi danh
 *    (cùng cổng hiển thị): MỘT sự kiện duy nhất khi ghim đề vào khoá
 *    (feat gộp Đề #226 hợp nhất quiz_created + exam_paper_deployed);
 *    loại thông báo phía người dùng vẫn tên `quiz_available`;
 *    `quiz_attempt_finished` → bản GỘP `quiz_attempt_finished` cho
 *    giáo viên khi lượt làm cần chấm tay (needsGrading, không phải
 *    preview) — gộp theo quiz như P5.
 *
 * Cơ chế quét/watermark theo đúng tiền lệ MessagingOutboxConsumer:
 * watermark riêng lưu Redis (khoá theo tên database), chỉ tiến sau
 * khi sự kiện đã xử lý xong, khởi động neo tại seq hiện tại (không
 * phát lại lịch sử). Consumer này KHÔNG đóng dấu published_at và
 * không đụng đường relay/logstore.
 *
 * DB bị dựng lại TRONG LÚC tiến trình vẫn chạy (reset DB production
 * không kèm khởi động lại tiến trình — sự cố live trong issue #125;
 * bản sửa cho MessagingOutboxConsumer ở PR #126, áp cùng nguyên lý
 * tại đây) được phát hiện ở mọi nhịp không có gì xử lý: seq lớn nhất
 * của DB nhỏ
 * hơn watermark đang giữ là điều không thể xảy ra trong một đời DB
 * (seq chỉ tăng). Khi đó watermark neo về 0 để mọi sự kiện của đời
 * DB mới được xử lý — neo tại seq hiện tại như lúc khởi động sẽ bỏ
 * sót chính các sự kiện đã ghi ngay sau reset, trước nhịp phát hiện;
 * phát lại phần lịch sử còn trong bảng là vô hại theo tính chất
 * ít-nhất-một-lần đã có của consumer (mọi handler được viết để an
 * toàn khi chạy lại: dedupe trong lô, gộp theo chưa-đọc, completion
 * chỉ phát khi lật trạng thái).
 *
 * Mọi lỗi đều bị nuốt kèm cảnh báo:
 * thông báo là kênh phụ, hỏng consumer không được làm hỏng nghiệp vụ
 * gốc; đổi lại tính chất phân phối là ít-nhất-một-lần — xử lý từng
 * sự kiện được viết để an toàn khi chạy lại (dedupe theo lô, gộp
 * theo chưa-đọc, completion chỉ phát khi lật trạng thái).
 */
@Injectable()
export class NotificationEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationEventsConsumer.name);
  private readonly redis: Redis;
  private readonly watermarkKey: string;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private watermark: number | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @InjectDrizzle() private readonly db: Database,
    private readonly repo: MessagingRepository,
    private readonly messaging: MessagingService,
    private readonly users: UsersService,
    private readonly i18n: I18nService,
  ) {
    const redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, ...redisTlsFromUrl(redisUrl) });
    this.redis.on('error', (error: Error) => {
      this.logger.warn(`Redis của consumer thông báo lỗi: ${error.message}`);
    });
    let databaseName = 'default';
    try {
      databaseName = new URL(config.getOrThrow<string>('DATABASE_URL')).pathname.replace(/^\//, '') || 'default';
    } catch {
      // DATABASE_URL không parse được: dùng khoá mặc định, vẫn an toàn.
    }
    this.watermarkKey = `lms:messaging:notifications:${databaseName}:seq`;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.redis.quit().catch(() => undefined);
  }

  /**
   * Một nhịp quét: khởi tạo watermark nếu cần, rồi xử lý mọi sự kiện
   * mới theo thứ tự seq.
   *
   * TENANT-1 (#196): consumer quét outbox XUYÊN tenant nên toàn nhịp
   * chạy trong ngữ cảnh platform tường minh — pool gắn GUC theo ALS ở
   * mọi checkout, RLS fail-closed không làm mù sự kiện của các tenant.
   * Tenant của từng thông báo được gắn ở điểm tạo (MessagingService).
   */
  private async tick(): Promise<void> {
    return tenantAls.run({ platform: true }, () => this.tickInContext());
  }

  private async tickInContext(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.watermark === null) this.watermark = await this.initialWatermark();
      let rows = await this.fetchPending();
      // Nhịp trống có thể là im lặng giả: DB đã bị dựng lại trong lúc
      // tiến trình vẫn chạy nên sự kiện mới mang seq nhỏ hơn
      // watermark cũ và không bao giờ lọt qua bộ lọc seq > watermark.
      // Kiểm tra dấu hiệu đó và neo lại trước khi kết luận "không có
      // gì mới" — nếu không, consumer no-op vĩnh viễn mà không lỗi.
      if (rows.length === 0 && (await this.reanchorIfDbReset())) {
        rows = await this.fetchPending();
      }
      // Chống dội trong lô cho điểm: nhiều sự kiện grade_updated của
      // cùng (user, item) trong một nhịp quét (chấm + tính lại) chỉ
      // sinh MỘT thông báo — giữ vị trí của sự kiện cuối.
      const superseded = this.supersededGradeSeqs(rows);
      for (const row of rows) {
        if (!superseded.has(row.seq)) {
          await this.handle(row.type, row.payload as Record<string, unknown>);
        }
        this.watermark = row.seq;
        await this.redis.set(this.watermarkKey, String(row.seq)).catch(() => undefined);
      }
    } catch (error) {
      this.logger.warn(`Nhịp nối dây thông báo lỗi: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Các sự kiện consumer này xử lý được đang chờ sau watermark, theo thứ tự seq. */
  private async fetchPending() {
    return this.db.select({ seq: outboxEvents.seq, type: outboxEvents.type, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(gt(outboxEvents.seq, this.watermark!), inArray(outboxEvents.type, [...HANDLED_TYPES])))
      .orderBy(asc(outboxEvents.seq))
      .limit(BATCH_SIZE);
  }

  /**
   * Phát hiện DB đã bị dựng lại trong lúc tiến trình vẫn chạy và neo
   * lại watermark: seq chỉ tăng trong một đời DB nên seq lớn nhất
   * hiện có nhỏ hơn watermark đang giữ nghĩa là watermark thuộc về
   * đời DB trước. Neo về 0 (không phải về seq hiện tại) để các sự
   * kiện đã ghi sau reset — có thể đã nằm trong bảng trước nhịp phát
   * hiện này — vẫn được xử lý; lịch sử bị phát lại là vô hại vì mọi
   * handler an toàn khi chạy lại. Trả `true` khi đã neo lại để nhịp
   * gọi quét lại từ đầu.
   */
  private async reanchorIfDbReset(): Promise<boolean> {
    const [row] = await this.db.select({ value: max(outboxEvents.seq) }).from(outboxEvents);
    const dbMax = row?.value ?? 0;
    if (this.watermark === null || dbMax >= this.watermark) return false;
    this.logger.warn(
      `Phát hiện DB đã bị dựng lại trong lúc tiến trình chạy (seq lớn nhất hiện có ${dbMax} < watermark ${this.watermark}) — neo lại watermark về 0 để xử lý các sự kiện của đời DB mới.`,
    );
    this.watermark = 0;
    await this.redis.set(this.watermarkKey, '0').catch(() => undefined);
    return true;
  }

  /** Seq của các sự kiện grade_updated bị sự kiện sau cùng (user, item) trong cùng lô thay thế. */
  private supersededGradeSeqs(rows: { seq: number; type: string; payload: unknown }[]): Set<number> {
    const lastSeqByKey = new Map<string, number>();
    for (const row of rows) {
      if (row.type !== 'grade_updated') continue;
      const payload = row.payload as Record<string, unknown>;
      if (typeof payload.userId === 'string' && typeof payload.itemId === 'string') {
        lastSeqByKey.set(`${payload.userId}:${payload.itemId}`, row.seq);
      }
    }
    const superseded = new Set<number>();
    for (const row of rows) {
      if (row.type !== 'grade_updated') continue;
      const payload = row.payload as Record<string, unknown>;
      if (typeof payload.userId === 'string' && typeof payload.itemId === 'string'
        && lastSeqByKey.get(`${payload.userId}:${payload.itemId}`) !== row.seq) {
        superseded.add(row.seq);
      }
    }
    return superseded;
  }

  /**
   * Watermark khởi tạo: lấy giá trị đã lưu trong Redis nếu nó không
   * vượt quá seq lớn nhất hiện có trong DB (vượt quá = DB đã bị dựng
   * lại, neo lại tại hiện tại); chưa từng lưu thì neo tại hiện tại —
   * không phát lại lịch sử.
   */
  private async initialWatermark(): Promise<number> {
    const [row] = await this.db.select({ value: max(outboxEvents.seq) }).from(outboxEvents);
    const dbMax = row?.value ?? 0;
    const storedRaw = await this.redis.get(this.watermarkKey).catch(() => null);
    const stored = storedRaw === null ? null : Number(storedRaw);
    const start = stored !== null && Number.isFinite(stored) && stored <= dbMax ? stored : dbMax;
    await this.redis.set(this.watermarkKey, String(start)).catch(() => undefined);
    return start;
  }

  /** Xử lý một sự kiện outbox đã commit. Payload hỏng/thiếu thì bỏ qua (watermark vẫn tiến ở tầng gọi). */
  private async handle(type: string, payload: Record<string, unknown>): Promise<void> {
    if (type === 'grade_updated') return this.handleGradeUpdated(payload);
    if (type === 'course_completed') return this.handleCourseCompleted(payload);
    if (type === 'enrol_expiry_warning') return this.handleEnrolExpiryWarning(payload);
    if (type === 'message_sent') return this.handleMessageSent(payload);
    if (type === 'activity_due_reminder') return this.handleActivityDueReminder(payload);
    if (type === 'assignment_created') return this.handleAssignmentCreated(payload);
    if (type === 'assignment_submitted') return this.handleAssignmentSubmitted(payload);
    if (type === 'assignment_returned') return this.handleAssignmentReturned(payload);
    if (type === 'exam_pinned') return this.handlePinCreated(payload);
    if (type === 'quiz_attempt_finished') return this.handleQuizAttemptFinished(payload);
  }

  private async handleGradeUpdated(payload: Record<string, unknown>): Promise<void> {
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const itemId = typeof payload.itemId === 'string' ? payload.itemId : null;
    const finalGrade = typeof payload.finalGrade === 'number' ? payload.finalGrade : null;
    if (!userId || !itemId || finalGrade === null) return;
    const item = await this.repo.getGradeItemNotifyInfo(itemId);
    // Item đã biến mất, là tổng/công thức, hoặc bị ẩn ở cấp item:
    // không có "điểm mới" nào để học sinh xem.
    if (!item || item.hidden || NON_NOTIFIED_ITEM_TYPES.has(item.itemType)) return;
    if (await this.repo.isGradeHiddenForUser(itemId, userId)) return;
    const courseName = (await this.repo.getCourseFullName(item.courseId)) ?? '';
    const itemName = item.itemName || courseName;
    // Nội dung tuyệt đối không chứa điểm số — kể cả trong app (chuẩn
    // Canvas): thông báo chỉ nói "có điểm mới", điểm xem ở trang điểm.
    await this.messaging.notify(userId, 'grade_updated', {
      subject: this.t('platform.gradeUpdatedSubject', { course: courseName }),
      body: this.t('platform.gradeUpdatedBody', { course: courseName, item: itemName }),
      contextUrl: `/courses/${item.courseId}/grades`,
      courseId: item.courseId,
      tenantId: await this.tenantIdOf(payload, item.courseId),
    });
  }

  private async handleCourseCompleted(payload: Record<string, unknown>): Promise<void> {
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    if (!userId || !courseId) return;
    const courseName = (await this.repo.getCourseFullName(courseId)) ?? '';
    await this.messaging.notify(userId, 'course_completed', {
      subject: this.t('platform.courseCompletedSubject', { course: courseName }),
      body: this.t('platform.courseCompletedBody', { course: courseName }),
      contextUrl: `/courses/${courseId}`,
      courseId,
      tenantId: await this.tenantIdOf(payload, courseId),
    });
  }

  private async handleEnrolExpiryWarning(payload: Record<string, unknown>): Promise<void> {
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const timeEnd = typeof payload.timeEnd === 'string' ? payload.timeEnd : null;
    if (!userId || !courseId || !timeEnd) return;
    const courseName = (await this.repo.getCourseFullName(courseId)) ?? '';
    const date = new Date(timeEnd);
    const dateText = Number.isNaN(date.getTime()) ? timeEnd : date.toLocaleDateString('vi-VN');
    await this.messaging.notify(userId, 'enrol_expiry_warning', {
      subject: this.t('platform.enrolExpiryWarningSubject', { course: courseName }),
      body: this.t('platform.enrolExpiryWarningBody', { course: courseName, date: dateText }),
      contextUrl: `/courses/${courseId}`,
      courseId,
      tenantId: await this.tenantIdOf(payload, courseId),
    });
  }

  private async handleActivityDueReminder(payload: Record<string, unknown>): Promise<void> {
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const timeClose = typeof payload.timeClose === 'string' ? payload.timeClose : null;
    if (!userId || !courseId || !timeClose) return;
    // Hai loại hoạt động dùng chung sự kiện (NB-1, issue #174): hoạt
    // động đề mang pinId (sau gộp Đề #226), bài tập mang assignmentId
    // + activityType 'assign'; sự kiện không có activityType thì hiểu
    // là hoạt động đề.
    const isAssign = payload.activityType === 'assign';
    const pinId = typeof payload.pinId === 'string' ? payload.pinId : null;
    const assignmentId = typeof payload.assignmentId === 'string' ? payload.assignmentId : null;
    if (!isAssign && !pinId) return;
    if (isAssign && !assignmentId) return;
    const courseName = (await this.repo.getCourseFullName(courseId)) ?? '';
    const activityName = typeof payload.activityName === 'string' && payload.activityName ? payload.activityName : courseName;
    const date = new Date(timeClose);
    const dateText = Number.isNaN(date.getTime()) ? timeClose : date.toLocaleString('vi-VN');
    // Nội dung chỉ gồm tên hoạt động + khoá + mốc hạn (dữ kiện học
    // sinh tự thấy trong khoá) — an toàn cho mọi kênh như tiền lệ
    // enrol_expiry_warning, không cần bản tối thiểu hoá riêng.
    await this.messaging.notify(userId, 'activity_due_soon', {
      subject: this.t('platform.activityDueSoonSubject', { activity: activityName }),
      body: this.t('platform.activityDueSoonBody', { activity: activityName, course: courseName, datetime: dateText }),
      contextUrl: isAssign
        ? `/courses/${courseId}/assignments/${assignmentId}`
        : `/courses/${courseId}/exams/${pinId}`,
      courseId,
      tenantId: await this.tenantIdOf(payload, courseId),
    });
  }

  // --- NB-1 (issue #174): vòng đời Bài tập/Quiz hai chiều ---------------------

  /**
   * Hoạt động có đang HIỆN với học sinh không: khoá hiện và module
   * không bị ẩn/không đang xoá (module null = hoạt động không gắn
   * module thì coi như hiện) — cùng ngữ nghĩa cổng phát của worker
   * nhắc hạn. Chỉ áp cho các thông báo "hoạt động mới" hướng học
   * sinh; thông báo cho giáo viên và xác nhận/trả bài không qua cổng
   * này (đối tượng đã tương tác trực tiếp với hoạt động).
   */
  private isVisibleToStudents(info: { courseVisible: boolean; cmVisible: boolean | null; cmDeletionInProgress: boolean | null }): boolean {
    return info.courseVisible && info.cmVisible !== false && info.cmDeletionInProgress !== true;
  }

  /**
   * Phát thông báo KIỂU GỘP theo (người nhận, provider, contextUrl):
   * còn một bản chưa đọc của cùng ngữ cảnh thì CẬP NHẬT nội dung của
   * bản đó (số lượng chờ chấm mới nhất) thay vì sinh bản mới; đã đọc
   * hết thì lần phát sau sinh bản mới như thường. Đây là mẫu gộp của
   * message_new mở rộng cho NB-1 (P5) — đồng thời làm mọi handler
   * NB-1 an toàn khi sự kiện bị phát lại (tính ít-nhất-một-lần của
   * consumer): phát lại khi bản gộp còn chưa đọc là no-op về số bản.
   */
  private async notifyGrouped(userId: string, provider: string, contextUrl: string, subject: string, body: string, courseId: string): Promise<void> {
    const existing = await this.repo.getUnreadNotification(userId, provider, contextUrl);
    if (existing) {
      if (existing.subject !== subject || existing.fullMessage !== body) {
        await this.repo.updateNotificationContent(existing.id, subject, body);
      }
      return;
    }
    // courseId đi vào notify() để ghi đè tắt tiếng theo khoá (NB-4)
    // áp ở đúng một điểm — bản gộp bị mute thì notify() tự ghi
    // dispatch log 'skipped-course-mute' và không sinh bản mới.
    await this.messaging.notify(userId, provider, { subject, body, contextUrl, courseId });
  }

  private async handleAssignmentCreated(payload: Record<string, unknown>): Promise<void> {
    const assignmentId = typeof payload.assignmentId === 'string' ? payload.assignmentId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : null;
    if (!assignmentId || !courseId) return;
    const info = await this.repo.getAssignmentNotifyInfo(assignmentId);
    if (!info || !this.isVisibleToStudents(info)) return;
    const courseName = (await this.repo.getCourseFullName(courseId)) ?? '';
    const contextUrl = `/courses/${courseId}/assignments/${assignmentId}`;
    const studentIds = await this.repo.listActiveEnrolledUserIds(courseId);
    for (const studentId of studentIds) {
      if (studentId === actorId) continue;
      await this.notifyGrouped(studentId, 'assignment_assigned', contextUrl,
        this.t('platform.assignmentAssignedSubject', { assignment: info.name }),
        this.t('platform.assignmentAssignedBody', { assignment: info.name, course: courseName }), courseId);
    }
  }

  private async handleAssignmentSubmitted(payload: Record<string, unknown>): Promise<void> {
    const assignmentId = typeof payload.assignmentId === 'string' ? payload.assignmentId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    if (!assignmentId || !courseId || !userId) return;
    const info = await this.repo.getAssignmentNotifyInfo(assignmentId);
    if (!info) return;
    const courseName = (await this.repo.getCourseFullName(courseId)) ?? '';
    const contextUrl = `/courses/${courseId}/assignments/${assignmentId}`;
    // (a) Xác nhận đã nộp cho chính học sinh vừa chốt nộp.
    await this.notifyGrouped(userId, 'assignment_submitted', contextUrl,
      this.t('platform.assignmentSubmitReceiptSubject', { assignment: info.name }),
      this.t('platform.assignmentSubmitReceiptBody', { assignment: info.name, course: courseName }), courseId);
    // (b) Bản gộp cho giáo viên phụ trách: số bài nộp đang chờ chấm
    // của bài tập này (P5) — nhiều học sinh nộp liên tiếp chỉ cập
    // nhật con số trong cùng một bản chưa đọc.
    const awaiting = await this.repo.countAssignmentSubmissionsAwaitingGrading(assignmentId);
    const staffIds = await this.repo.listCourseStaffUserIds(courseId);
    for (const staffId of staffIds) {
      if (staffId === userId) continue;
      await this.notifyGrouped(staffId, 'assignment_submitted', contextUrl,
        this.t('platform.assignmentSubmittedSubject', { assignment: info.name }),
        this.t('platform.assignmentSubmittedBody', { assignment: info.name, course: courseName, count: awaiting }), courseId);
    }
  }

  private async handleAssignmentReturned(payload: Record<string, unknown>): Promise<void> {
    const assignmentId = typeof payload.assignmentId === 'string' ? payload.assignmentId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    if (!assignmentId || !courseId || !userId) return;
    const info = await this.repo.getAssignmentNotifyInfo(assignmentId);
    if (!info) return;
    const courseName = (await this.repo.getCourseFullName(courseId)) ?? '';
    // Nội dung tuyệt đối không chứa điểm số/mức (payload có grade/
    // level nhưng KHÔNG đưa vào thông báo — cùng luật grade_updated):
    // học sinh xem kết quả ở trang bài tập; điểm mới đi đường
    // grade_updated với contextUrl trang điểm, không trùng hiển thị.
    await this.notifyGrouped(userId, 'assignment_returned', `/courses/${courseId}/assignments/${assignmentId}`,
      this.t('platform.assignmentReturnedSubject', { assignment: info.name }),
      this.t('platform.assignmentReturnedBody', { assignment: info.name, course: courseName }), courseId);
  }

  private async handlePinCreated(payload: Record<string, unknown>): Promise<void> {
    const pinId = typeof payload.pinId === 'string' ? payload.pinId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : null;
    if (!pinId || !courseId) return;
    const info = await this.repo.getPinNotifyInfo(pinId);
    if (!info || !this.isVisibleToStudents(info)) return;
    const courseName = (await this.repo.getCourseFullName(courseId)) ?? '';
    const contextUrl = `/courses/${courseId}/exams/${pinId}`;
    const studentIds = await this.repo.listActiveEnrolledUserIds(courseId);
    for (const studentId of studentIds) {
      if (studentId === actorId) continue;
      await this.notifyGrouped(studentId, 'quiz_available', contextUrl,
        this.t('platform.quizAvailableSubject', { quiz: info.name }),
        this.t('platform.quizAvailableBody', { quiz: info.name, course: courseName }), courseId);
    }
  }

  private async handleQuizAttemptFinished(payload: Record<string, unknown>): Promise<void> {
    const pinId = typeof payload.pinId === 'string' ? payload.pinId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    // Chỉ báo khi lượt làm kết thúc ở trạng thái CẦN CHẤM TAY và
    // không phải lượt preview của giáo viên — lượt tự chấm hết thì
    // học sinh đã có điểm qua grade_updated, giáo viên không việc gì.
    if (!pinId || !courseId) return;
    if (payload.needsGrading !== true || payload.preview === true) return;
    const info = await this.repo.getPinNotifyInfo(pinId);
    if (!info) return;
    const courseName = (await this.repo.getCourseFullName(courseId)) ?? '';
    const contextUrl = `/courses/${courseId}/exams/${pinId}/results`;
    const awaiting = await this.repo.countPinAttemptsNeedingGrading(pinId);
    const staffIds = await this.repo.listCourseStaffUserIds(courseId);
    for (const staffId of staffIds) {
      if (staffId === userId) continue;
      await this.notifyGrouped(staffId, 'quiz_attempt_finished', contextUrl,
        this.t('platform.quizAttemptFinishedSubject', { quiz: info.name }),
        this.t('platform.quizAttemptFinishedBody', { quiz: info.name, course: courseName, count: awaiting }), courseId);
    }
  }

  private async handleMessageSent(payload: Record<string, unknown>): Promise<void> {
    const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
    if (!messageId) return;
    const message = await this.repo.getMessage(messageId);
    // Tin đã biến mất hoặc đã bị xoá mềm thì không còn gì để báo.
    if (!message || message.deletedAt) return;
    const sender = await this.users.getByIdOrUndefined(message.userIdFrom);
    const senderName = sender ? displayNameOf(sender) : '';
    const contextUrl = `/messages?conversation=${message.conversationId}`;
    const tenantId = (typeof payload.tenantId === 'string' ? payload.tenantId : null)
      ?? await this.repo.getConversationTenantId(message.conversationId);
    // Membership chốt TẠI THỜI ĐIỂM XỬ LÝ (kỷ luật F1 như consumer
    // realtime): thành viên đã rời conversation không nhận thông báo.
    const memberIds = await this.repo.listMembers(message.conversationId);
    // Lát M5 (issue #240): thành viên đã TẮT TIẾNG conversation này
    // thì KHÔNG sinh thông báo message_new cho họ — kiểm cờ tại đây,
    // TRƯỚC khi notify, đúng một điểm như luật tắt tiếng theo khoá.
    const mutedMemberIds = new Set(await this.repo.listMutedMemberIds(message.conversationId));
    for (const memberId of memberIds) {
      if (memberId === message.userIdFrom) continue;
      if (mutedMemberIds.has(memberId)) continue;
      // Người nhận đã chặn người gửi thì không bị làm phiền bởi tin
      // của người đó (gửi vốn đã bị cổng chặn; đây là lớp bảo vệ phụ
      // cho các tin phát trước khi chặn).
      if (await this.repo.isBlocked(memberId, message.userIdFrom)) continue;
      // Gộp theo conversation: còn một bản chưa đọc thì bản đó đã đại
      // diện cho mọi tin mới — không sinh thêm (chuẩn app nhắn tin).
      if (await this.repo.hasUnreadNotification(memberId, 'message_new', contextUrl)) continue;
      // NB-4 KHÔNG truyền courseId ở đây: tắt tiếng theo conversation
      // là nhà #33 — khi #33 chốt cơ chế ghi đè của conversation,
      // đường này đọc cùng họ khoá `notif.course.*` tại điểm notify()
      // (notify đã nhận sẵn tham số courseId). Ghi rõ để đội #33 biết.
      await this.messaging.notify(memberId, 'message_new', {
        subject: this.t('platform.messageNewSubject', { name: senderName }),
        body: this.t('platform.messageNewBody'),
        contextUrl,
        fromUserId: message.userIdFrom,
        tenantId,
      });
    }
  }

  /**
   * Tenant của một sự kiện gắn khoá học (TENANT-1, #196): ưu tiên
   * tenantId đã gương trong payload lúc phát; sự kiện cũ chưa có thì
   * tra từ khoá học nguồn.
   */
  private async tenantIdOf(payload: Record<string, unknown>, courseId: string): Promise<string | null> {
    if (typeof payload.tenantId === 'string') return payload.tenantId;
    return this.repo.getCourseTenantId(courseId);
  }

  /**
   * Dịch chuỗi thông báo cho người nhận ở kênh nền: không có request
   * context nên dùng locale mặc định 'vi' như quy ước của các
   * processor nền tảng phía worker (recipientLocale).
   */
  private t(key: string, args?: Record<string, unknown>): string {
    return String(this.i18n.t(key, { locale: 'vi', args }));
  }
}
