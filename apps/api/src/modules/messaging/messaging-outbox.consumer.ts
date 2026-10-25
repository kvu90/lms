import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, gt, inArray, max } from 'drizzle-orm';
import Redis from 'ioredis';
import type { Database } from '../../db/database';
import { outboxEvents } from '../../db/schema';
import { redisTlsFromUrl } from '../../config/env';
import { MessagingRealtimeService } from './messaging-realtime.service';
import { MessagingRepository } from './messaging.repository';

/** Nhịp quét outbox của consumer phân phối realtime. */
const POLL_INTERVAL_MS = 500;
/** Số sự kiện tối đa xử lý trong một nhịp quét. */
const BATCH_SIZE = 100;
/** Các loại sự kiện messaging được phân phối qua realtime. */
const DISTRIBUTED_TYPES = ['message_sent', 'message_conversation_read', 'message_deleted', 'message_recalled', 'message_removed', 'message_deleted_for_me'] as const;

/**
 * Consumer phân phối realtime cho messaging (issue #33, chặng A1) —
 * mắt xích "outbox → consumer phân phối" của kênh WebSocket.
 *
 * Vì sao một consumer riêng thay vì dùng relay sẵn có: relay của
 * worker (OutboxRelayScheduler) phát sự kiện qua EventEmitter trong
 * TIẾN TRÌNH WORKER và đóng dấu published_at, còn tiến trình API
 * không chạy relay. Consumer này chạy trong tiến trình API, quét
 * bảng `outbox_events` theo watermark `seq` của riêng nó (lưu trong
 * Redis, khoá theo tên database để các môi trường/test dùng chung
 * Redis không dẫm nhau) và phân phối hai loại sự kiện của messaging
 * qua Socket.IO. Nó KHÔNG đóng dấu published_at và không đụng vào
 * đường relay/logstore hiện hữu — hai đường đọc cùng một bảng cho
 * hai mục đích độc lập.
 *
 * Tính đúng đắn: watermark chỉ tiến sau khi một sự kiện đã phân phối
 * xong; tiến trình chết giữa chừng thì nhịp sau phân phối lại từ
 * watermark đã lưu — client chống trùng bằng id/seq của tin và mốc
 * đã-đọc (phân phối thừa vô hại). Khởi động lần đầu (hoặc sau khi DB
 * bị dựng lại — seq hiện tại nhỏ hơn watermark đã lưu) thì watermark
 * neo tại seq lớn nhất hiện có: không phát lại lịch sử cũ.
 *
 * DB bị dựng lại TRONG LÚC tiến trình vẫn chạy (reset DB production
 * không kèm restart dyno — sự cố live trong issue #125) được phát
 * hiện ở mọi nhịp không có gì phân phối: seq lớn nhất của DB nhỏ
 * hơn watermark đang giữ là điều không thể xảy ra trong một đời DB
 * (seq chỉ tăng). Khi đó watermark neo về 0 để mọi sự kiện của đời
 * DB mới được phân phối — neo tại seq hiện tại như lúc khởi động sẽ
 * bỏ sót chính các sự kiện đã ghi ngay sau reset, trước nhịp phát
 * hiện; phát lại phần lịch sử còn trong bảng là vô hại theo tính
 * chất chống trùng ở trên.
 *
 * Mọi lỗi đều bị nuốt kèm cảnh báo: DB là nguồn sự thật, client nối
 * lại luôn đồng bộ được phần thiếu qua `sync`/REST, nên consumer
 * chậm hoặc lỗi không bao giờ làm hỏng nghiệp vụ nhắn tin.
 */
@Injectable()
export class MessagingOutboxConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagingOutboxConsumer.name);
  private readonly redis: Redis;
  private readonly watermarkKey: string;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private watermark: number | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @InjectDrizzle() private readonly db: Database,
    private readonly repo: MessagingRepository,
    private readonly realtime: MessagingRealtimeService,
  ) {
    const redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, ...redisTlsFromUrl(redisUrl) });
    this.redis.on('error', (error: Error) => {
      this.logger.warn(`Redis của consumer phân phối messaging lỗi: ${error.message}`);
    });
    let databaseName = 'default';
    try {
      databaseName = new URL(config.getOrThrow<string>('DATABASE_URL')).pathname.replace(/^\//, '') || 'default';
    } catch {
      // DATABASE_URL không parse được: dùng khoá mặc định, vẫn an toàn.
    }
    this.watermarkKey = `lms:messaging:distributor:${databaseName}:seq`;
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

  /** Một nhịp quét: khởi tạo watermark nếu cần, rồi phân phối mọi sự kiện mới theo thứ tự seq. */
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
      for (const row of rows) {
        await this.distribute(row.type, row.payload as Record<string, unknown>);
        this.watermark = row.seq;
        await this.redis.set(this.watermarkKey, String(row.seq)).catch(() => undefined);
      }
    } catch (error) {
      this.logger.warn(`Nhịp phân phối realtime của messaging lỗi: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Các sự kiện phân phối được đang chờ sau watermark, theo thứ tự seq. */
  private async fetchPending() {
    return this.db.select({ seq: outboxEvents.seq, type: outboxEvents.type, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(gt(outboxEvents.seq, this.watermark!), inArray(outboxEvents.type, [...DISTRIBUTED_TYPES])))
      .orderBy(asc(outboxEvents.seq))
      .limit(BATCH_SIZE);
  }

  /**
   * Phát hiện DB đã bị dựng lại trong lúc tiến trình vẫn chạy và neo
   * lại watermark: seq chỉ tăng trong một đời DB nên seq lớn nhất
   * hiện có nhỏ hơn watermark đang giữ nghĩa là watermark thuộc về
   * đời DB trước. Neo về 0 (không phải về seq hiện tại) để các sự
   * kiện đã ghi sau reset — có thể đã nằm trong bảng trước nhịp phát
   * hiện này — vẫn được phân phối; lịch sử bị phát lại là vô hại vì
   * client chống trùng. Trả `true` khi đã neo lại để nhịp gọi quét
   * lại từ đầu.
   */
  private async reanchorIfDbReset(): Promise<boolean> {
    const [row] = await this.db.select({ value: max(outboxEvents.seq) }).from(outboxEvents);
    const dbMax = row?.value ?? 0;
    if (this.watermark === null || dbMax >= this.watermark) return false;
    this.logger.warn(
      `Phát hiện DB đã bị dựng lại trong lúc tiến trình chạy (seq lớn nhất hiện có ${dbMax} < watermark ${this.watermark}) — neo lại watermark về 0 để phân phối các sự kiện của đời DB mới.`,
    );
    this.watermark = 0;
    await this.redis.set(this.watermarkKey, '0').catch(() => undefined);
    return true;
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

  /** Phân phối một sự kiện outbox đã commit. Payload hỏng/thiếu thì bỏ qua (watermark vẫn tiến ở tầng gọi). */
  private async distribute(type: string, payload: Record<string, unknown>): Promise<void> {
    if (type === 'message_sent') {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
      if (!messageId) return;
      const message = await this.repo.getMessage(messageId);
      // Tin đã biến mất (conversation bị xoá cascade sau khi sự kiện
      // ghi) thì không còn gì để phân phối.
      if (!message) return;
      // Membership chốt TẠI THỜI ĐIỂM PHÂN PHỐI, đọc thẳng từ DB —
      // không dùng ảnh chụp lúc gửi trong payload: thành viên bị gỡ
      // khỏi conversation trong khoảng giữa hai thời điểm không còn
      // nhận conversation.updated, và danh sách này là căn cứ rà soát
      // room khi phát message.new (F1).
      const memberIds = await this.repo.listMembers(message.conversationId);
      // Tin đã bị THU HỒI trước khi sự kiện gửi được phân phối (gửi
      // rồi thu hồi ngay trong cùng nhịp quét): phân phối như một lần
      // thu hồi — phát bản tin mới ở đây sẽ lộ nội dung vừa bị vô hiệu.
      if (message.recalledAt) {
        await this.realtime.distributeMessageRecalled(message, memberIds);
        return;
      }
      await this.realtime.distributeNewMessage(message, memberIds);
      return;
    }
    if (type === 'message_conversation_read') {
      const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null;
      const userId = typeof payload.userId === 'string' ? payload.userId : null;
      const lastReadSeq = typeof payload.lastReadSeq === 'number' ? payload.lastReadSeq : null;
      if (!conversationId || !userId || lastReadSeq === null) return;
      await this.realtime.distributeReadReceipt({ conversationId, userId, lastReadSeq });
      return;
    }
    if (type === 'message_deleted') {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
      if (!messageId) return;
      // Tin xoá mềm vẫn còn dòng trong DB (chỉ bị đánh dấu) — đọc lại
      // để lấy dấu vết mới nhất, rồi phân phối theo membership HIỆN TẠI
      // như mọi sự kiện khác (kỷ luật F1).
      const message = await this.repo.getMessage(messageId);
      if (!message || !message.deletedAt) return;
      const memberIds = await this.repo.listMembers(message.conversationId);
      await this.realtime.distributeMessageDeleted(message, memberIds);
      return;
    }
    if (type === 'message_recalled') {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
      if (!messageId) return;
      // Tin thu hồi vẫn còn dòng (nội dung chỉ bị vô hiệu ở đường
      // đọc) — đọc lại dấu thu hồi mới nhất rồi phân phối; nếu dấu đã
      // mất (dòng bị xoá cứng chen giữa) thì sự kiện gỡ cứng đi sau
      // sẽ lo phần còn lại.
      const message = await this.repo.getMessage(messageId);
      if (!message || !message.recalledAt) return;
      const memberIds = await this.repo.listMembers(message.conversationId);
      await this.realtime.distributeMessageRecalled(message, memberIds);
      return;
    }
    if (type === 'message_removed') {
      // Tin đã bị XOÁ CỨNG: dòng không còn trong DB — mọi định danh
      // lấy từ BẢN CHỤP trong payload lúc xoá, membership vẫn chốt
      // tại thời điểm phân phối như mọi sự kiện (kỷ luật F1).
      const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null;
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
      const seq = typeof payload.seq === 'number' ? payload.seq : null;
      const removedBy = typeof payload.removedBy === 'string' ? payload.removedBy : null;
      if (!conversationId || !messageId || seq === null || !removedBy) return;
      const memberIds = await this.repo.listMembers(conversationId);
      await this.realtime.distributeMessageRemoved({ conversationId, messageId, seq, removedBy }, memberIds);
      return;
    }
    if (type === 'message_deleted_for_me') {
      // Xoá-phía-mình: phân phối CHỈ tới chính người xoá (realtime tự
      // giới hạn ở room riêng của họ) — membership không liên quan.
      const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null;
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
      const seq = typeof payload.seq === 'number' ? payload.seq : null;
      const actorId = typeof payload.actorId === 'string' ? payload.actorId : null;
      if (!conversationId || !messageId || seq === null || !actorId) return;
      await this.realtime.distributeMessageDeletedForMe({ conversationId, messageId, seq, actorId });
    }
  }
}
