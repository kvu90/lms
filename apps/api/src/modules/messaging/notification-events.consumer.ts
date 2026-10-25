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

/** Nhịp quét outbox của consumer thông báo (khớp nhịp consumer realtime). */
const POLL_INTERVAL_MS = 500;
/** Số sự kiện tối đa xử lý trong một nhịp quét. */
const BATCH_SIZE = 100;
/**
 * Các loại sự kiện nghiệp vụ được biến thành NOTIFICATION qua consumer
 * này (lát N1, issue #49): ba provider từng là công tắc giả
 * (grade_updated / course_completed / enrol_expiry_warning) + tin nhắn
 * mới (message_new) + nhắc hạn nộp (activity_due_soon, lát N5 issue
 * #50). Sự kiện do CẢ API lẫn worker phát (chấm lại điểm,
 * quét hết hạn ghi danh chạy ở worker) nên đường nối phải đọc outbox
 * đã commit thay vì lắng nghe EventEmitter trong một tiến trình.
 */
const HANDLED_TYPES = ['grade_updated', 'course_completed', 'enrol_expiry_warning', 'message_sent', 'activity_due_reminder'] as const;

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
 *
 * Cơ chế quét/watermark theo đúng tiền lệ MessagingOutboxConsumer:
 * watermark riêng lưu Redis (khoá theo tên database), chỉ tiến sau
 * khi sự kiện đã xử lý xong, khởi động neo tại seq hiện tại (không
 * phát lại lịch sử). Consumer này KHÔNG đóng dấu published_at và
 * không đụng đường relay/logstore.
 *
 * DB bị dựng lại TRONG LÚC tiến trình vẫn chạy (reset DB production
 * không kèm restart dyno — sự cố live trong issue #125, bản sửa cho
 * MessagingOutboxConsumer ở PR #126, áp cùng nguyên lý tại đây) được
 * phát hiện ở mọi nhịp không có gì xử lý: seq lớn nhất của DB nhỏ
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

  /** Một nhịp quét: khởi tạo watermark nếu cần, rồi xử lý mọi sự kiện mới theo thứ tự seq. */
  private async tick(): Promise<void> {
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
    });
  }

  private async handleActivityDueReminder(payload: Record<string, unknown>): Promise<void> {
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const quizId = typeof payload.quizId === 'string' ? payload.quizId : null;
    const timeClose = typeof payload.timeClose === 'string' ? payload.timeClose : null;
    if (!userId || !courseId || !quizId || !timeClose) return;
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
      contextUrl: `/courses/${courseId}/quizzes/${quizId}`,
    });
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
    // Membership chốt TẠI THỜI ĐIỂM XỬ LÝ (kỷ luật F1 như consumer
    // realtime): thành viên đã rời conversation không nhận thông báo.
    const memberIds = await this.repo.listMembers(message.conversationId);
    for (const memberId of memberIds) {
      if (memberId === message.userIdFrom) continue;
      // Người nhận đã chặn người gửi thì không bị làm phiền bởi tin
      // của người đó (gửi vốn đã bị cổng chặn; đây là lớp bảo vệ phụ
      // cho các tin phát trước khi chặn).
      if (await this.repo.isBlocked(memberId, message.userIdFrom)) continue;
      // Gộp theo conversation: còn một bản chưa đọc thì bản đó đã đại
      // diện cho mọi tin mới — không sinh thêm (chuẩn app nhắn tin).
      if (await this.repo.hasUnreadNotification(memberId, 'message_new', contextUrl)) continue;
      await this.messaging.notify(memberId, 'message_new', {
        subject: this.t('platform.messageNewSubject', { name: senderName }),
        body: this.t('platform.messageNewBody'),
        contextUrl,
        fromUserId: message.userIdFrom,
      });
    }
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
