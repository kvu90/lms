import { Inject, Injectable, Logger, type MessageEvent, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Observable, Subject } from 'rxjs';
import { redisTlsFromUrl } from '../../config/env';
import { MessagingRepository } from './messaging.repository';

/**
 * Kênh Redis pub/sub mang tín hiệu "số thông báo chưa đọc của một user
 * vừa thay đổi". Payload chỉ là userId — số đếm thật luôn được đọc lại
 * từ database ở phía nhận, không tin số mang theo tín hiệu.
 */
export const NOTIFICATION_UNREAD_CHANGED_CHANNEL = 'lms:notifications:unread-changed';

/** Nhịp heartbeat của stream: đủ dày để qua giới hạn idle 55 giây của Heroku router. */
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Stream thời gian thực cho số thông báo chưa đọc (SSE).
 *
 * Thông báo có thể được tạo từ bất kỳ tiến trình nào (API khi xử lý
 * request, worker khi chạy job nền như cấp huy hiệu) nên tín hiệu thay
 * đổi đi qua Redis pub/sub làm backplane: nơi thay đổi số đếm gọi
 * {@link signalUnreadCountChanged}, mọi tiến trình API đang giữ stream
 * của user đó đều nhận tín hiệu, đọc lại số thật từ DB rồi đẩy xuống.
 * Kết nối subscriber phải là một connection Redis riêng (connection đã
 * subscribe không publish được), tách khỏi connection publish.
 */
@Injectable()
export class NotificationUnreadStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationUnreadStreamService.name);
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  /** Các stream SSE đang mở trong tiến trình này, theo user. */
  private readonly streamsByUser = new Map<string, Set<Subject<MessageEvent>>>();

  constructor(
    @Inject(ConfigService) config: ConfigService,
    private readonly repo: MessagingRepository,
  ) {
    const redisUrl = config.getOrThrow<string>('REDIS_URL');
    const options = { maxRetriesPerRequest: null, ...redisTlsFromUrl(redisUrl) };
    this.publisher = new Redis(redisUrl, options);
    this.subscriber = new Redis(redisUrl, options);
  }

  async onModuleInit(): Promise<void> {
    this.subscriber.on('message', (channel: string, userId: string) => {
      if (channel === NOTIFICATION_UNREAD_CHANGED_CHANNEL) {
        void this.pushCurrentCount(userId);
      }
    });
    this.subscriber.on('error', (error: Error) => {
      this.logger.warn(`Redis subscriber của stream thông báo lỗi: ${error.message}`);
    });
    await this.subscriber.subscribe(NOTIFICATION_UNREAD_CHANGED_CHANNEL);
  }

  async onModuleDestroy(): Promise<void> {
    for (const subjects of this.streamsByUser.values()) {
      for (const subject of subjects) subject.complete();
    }
    this.streamsByUser.clear();
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }

  /**
   * Phát tín hiệu số đếm của user đã đổi. Lỗi Redis bị nuốt lặng: đẩy
   * thời gian thực là đường phụ, không bao giờ được làm hỏng nghiệp vụ
   * tạo/đánh dấu thông báo vốn đã ghi xong xuống DB.
   */
  async signalUnreadCountChanged(userId: string): Promise<void> {
    try {
      await this.publisher.publish(NOTIFICATION_UNREAD_CHANGED_CHANNEL, userId);
    } catch {
      // Bỏ qua: client vẫn còn số khởi tạo từ REST và snapshot khi nối lại.
    }
  }

  /**
   * Mở stream cho một user: sự kiện đầu tiên là snapshot số hiện tại
   * đọc từ DB (mỗi lần nối — kể cả EventSource tự nối lại — đều đồng bộ
   * lại từ đầu), sau đó là mỗi thay đổi được đẩy xuống, kẹp heartbeat
   * giữ kết nối. Ngắt kết nối thì gỡ đăng ký, không rò listener.
   */
  streamUnreadCount(userId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const subject = new Subject<MessageEvent>();
      let subjects = this.streamsByUser.get(userId);
      if (!subjects) {
        subjects = new Set();
        this.streamsByUser.set(userId, subjects);
      }
      subjects.add(subject);
      const subscription = subject.subscribe(subscriber);

      void this.repo.countUnreadNotifications(userId).then(
        (unread) => { if (!subject.closed) subject.next({ type: 'unread-count', data: { unread } }); },
        () => undefined,
      );
      const heartbeat = setInterval(() => {
        if (!subject.closed) subject.next({ type: 'heartbeat', data: '' });
      }, HEARTBEAT_INTERVAL_MS);

      return () => {
        clearInterval(heartbeat);
        subscription.unsubscribe();
        subjects.delete(subject);
        if (subjects.size === 0) this.streamsByUser.delete(userId);
        subject.complete();
      };
    });
  }

  /** Đọc số thật từ DB và đẩy xuống mọi stream đang mở của user. */
  private async pushCurrentCount(userId: string): Promise<void> {
    const subjects = this.streamsByUser.get(userId);
    if (!subjects || subjects.size === 0) return;
    try {
      const unread = await this.repo.countUnreadNotifications(userId);
      for (const subject of subjects) {
        if (!subject.closed) subject.next({ type: 'unread-count', data: { unread } });
      }
    } catch (error) {
      this.logger.warn(`Không đọc được số chưa đọc cho stream thông báo: ${(error as Error).message}`);
    }
  }
}
