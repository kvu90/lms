import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MESSAGING_SOCKET_EVENTS,
  type LmsMessage,
  type RealtimeConversationUpdatedPayload,
  type RealtimeMessageReadPayload,
  type RealtimeNewMessagePayload,
} from '@lms/contracts';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server } from 'socket.io';
import { redisTlsFromUrl } from '../../config/env';
import { MessagingRepository, type MessageRow } from './messaging.repository';

/** Room của một conversation: mọi thành viên đang nối đều ở trong room này. */
export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/** Room riêng của một user: nhận cập nhật theo từng người (số chưa đọc của chính họ). */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** Dạng wire của một tin nhắn (khớp `messageSchema` của contracts; createdAt là chuỗi ISO). */
export function toWireMessage(row: MessageRow): LmsMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    userIdFrom: row.userIdFrom,
    subject: row.subject,
    fullMessage: row.fullMessage,
    createdAt: row.createdAt.toISOString(),
    seq: row.seq,
    clientMessageId: row.clientMessageId,
  };
}

const PRESENCE_KEY_PREFIX = 'lms:messaging:presence:';
const TYPING_KEY_PREFIX = 'lms:messaging:typing:';
/** TTL an toàn cho presence: tiến trình chết đột ngột thì trạng thái tự hết hạn thay vì kẹt "online" mãi. */
const PRESENCE_TTL_SECONDS = 600;
/** Cửa sổ typing: một lần phát hiệu lực 4 giây, trong cửa sổ không phát lại. */
const TYPING_TTL_SECONDS = 4;

/**
 * Tầng phân phối realtime của messaging (issue #33, chặng A1/A2).
 *
 * Chỉ nơi này chạm vào Socket.IO server: gateway lo xác thực + room
 * theo kết nối, consumer của outbox gọi các hàm distribute* ở đây sau
 * khi sự kiện nghiệp vụ đã nằm trong outbox. Redis adapter làm
 * backplane để nhiều tiến trình API cùng phân phối được; presence và
 * typing sống trong Redis (tạm thời, KHÔNG xuống Postgres — DB vẫn là
 * nguồn sự thật duy nhất cho tin nhắn và mốc đã đọc).
 *
 * Mọi lỗi Redis ở các đường phụ (presence/typing) đều bị nuốt kèm log
 * cảnh báo: realtime là đường phụ, không được làm hỏng nghiệp vụ.
 */
@Injectable()
export class MessagingRealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(MessagingRealtimeService.name);
  private readonly redisUrl: string;
  private readonly redisOptions: Record<string, unknown>;
  private server: Server | null = null;
  private adapterClients: Redis[] = [];
  private stateClient: Redis | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    private readonly repo: MessagingRepository,
  ) {
    this.redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.redisOptions = { maxRetriesPerRequest: null, ...redisTlsFromUrl(this.redisUrl) };
  }

  /**
   * Gateway gắn server Socket.IO vào đây khi khởi tạo: tạo Redis
   * adapter (hai connection pub/sub riêng). Redis lỗi lúc khởi động
   * thì giữ adapter in-memory mặc định + cảnh báo — một tiến trình
   * vẫn phân phối nội bộ được, không chặn app boot.
   */
  attachServer(server: Server): void {
    this.server = server;
    try {
      const pub = new Redis(this.redisUrl, this.redisOptions);
      const sub = pub.duplicate();
      pub.on('error', (error: Error) => this.logger.warn(`Redis adapter (pub) của messaging lỗi: ${error.message}`));
      sub.on('error', (error: Error) => this.logger.warn(`Redis adapter (sub) của messaging lỗi: ${error.message}`));
      this.adapterClients = [pub, sub];
      server.adapter(createAdapter(pub, sub) as never);
    } catch (error) {
      this.logger.warn(`Không gắn được Redis adapter cho messaging, dùng adapter in-memory: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      ...this.adapterClients.map((c) => c.quit()),
      ...(this.stateClient ? [this.stateClient.quit()] : []),
    ]);
    this.adapterClients = [];
    this.stateClient = null;
    this.server = null;
  }

  /** Connection Redis cho presence/typing (tách khỏi cặp adapter). */
  private state(): Redis {
    if (!this.stateClient) {
      this.stateClient = new Redis(this.redisUrl, this.redisOptions);
      this.stateClient.on('error', (error: Error) => {
        this.logger.warn(`Redis trạng thái (presence/typing) của messaging lỗi: ${error.message}`);
      });
    }
    return this.stateClient;
  }

  // --- phân phối sự kiện nghiệp vụ (consumer của outbox gọi) -------------

  /**
   * Phân phối một tin mới: `message.new` vào room của conversation
   * (client đang mở cuộc trò chuyện nhận ngay) + `conversation.updated`
   * vào room riêng của TỪNG thành viên kèm số chưa đọc của chính họ
   * (client cập nhật danh sách/huy hiệu không cần tải lại).
   */
  async distributeNewMessage(messageRow: MessageRow, memberIds: string[]): Promise<void> {
    if (!this.server) return;
    const wire = toWireMessage(messageRow);
    const newPayload: RealtimeNewMessagePayload = { conversationId: messageRow.conversationId, message: wire };
    this.server.to(conversationRoom(messageRow.conversationId)).emit(MESSAGING_SOCKET_EVENTS.newMessage, newPayload);
    await Promise.all(memberIds.map(async (memberId) => {
      const unreadCount = await this.repo.countUnreadForConversation(messageRow.conversationId, memberId).catch(() => 0);
      const payload: RealtimeConversationUpdatedPayload = {
        conversationId: messageRow.conversationId, message: wire, unreadCount,
      };
      this.server!.to(userRoom(memberId)).emit(MESSAGING_SOCKET_EVENTS.conversationUpdated, payload);
    }));
  }

  /** Phân phối biên đã-đọc của một thành viên vào room của conversation. */
  distributeReadReceipt(payload: RealtimeMessageReadPayload): void {
    if (!this.server) return;
    this.server.to(conversationRoom(payload.conversationId)).emit(MESSAGING_SOCKET_EVENTS.messageRead, payload);
  }

  // --- presence (A2): tập socket đang mở của từng user trong Redis -------

  /** Ghi nhận một socket vừa nối; là socket ĐẦU TIÊN của user thì phát trạng thái online. */
  async markConnected(userId: string, socketId: string): Promise<void> {
    try {
      const redis = this.state();
      const size = await redis.sadd(`${PRESENCE_KEY_PREFIX}${userId}`, socketId);
      await redis.expire(`${PRESENCE_KEY_PREFIX}${userId}`, PRESENCE_TTL_SECONDS);
      if (size === 1 && (await redis.scard(`${PRESENCE_KEY_PREFIX}${userId}`)) === 1) {
        await this.broadcastPresence(userId, true);
      }
    } catch (error) {
      this.logger.warn(`Không ghi được presence khi nối: ${(error as Error).message}`);
    }
  }

  /** Ghi nhận một socket vừa ngắt; là socket CUỐI CÙNG của user thì phát trạng thái offline. */
  async markDisconnected(userId: string, socketId: string): Promise<void> {
    try {
      const redis = this.state();
      await redis.srem(`${PRESENCE_KEY_PREFIX}${userId}`, socketId);
      const remaining = await redis.scard(`${PRESENCE_KEY_PREFIX}${userId}`);
      if (remaining === 0) await this.broadcastPresence(userId, false);
    } catch (error) {
      this.logger.warn(`Không ghi được presence khi ngắt: ${(error as Error).message}`);
    }
  }

  /** Phát `presence.changed` tới room của mọi conversation mà user là thành viên. */
  private async broadcastPresence(userId: string, online: boolean): Promise<void> {
    if (!this.server) return;
    try {
      const conversations = await this.repo.listConversationsForUser(userId);
      if (!conversations.length) return;
      this.server
        .to(conversations.map((c) => conversationRoom(c.id)))
        .emit(MESSAGING_SOCKET_EVENTS.presenceChanged, { userId, online });
    } catch (error) {
      this.logger.warn(`Không phát được presence: ${(error as Error).message}`);
    }
  }

  // --- typing (A2): tín hiệu thoáng qua trong Redis, không xuống DB ------

  /**
   * Ghi nhận "đang nhập" và phát vào room của conversation — tối đa
   * một lần mỗi cửa sổ TTL cho mỗi (conversation, user); client tự hết
   * hạn hiển thị sau cửa sổ đó nếu không có tín hiệu mới.
   */
  async noteTyping(conversationId: string, userId: string): Promise<void> {
    if (!this.server) return;
    try {
      const set = await this.state().set(`${TYPING_KEY_PREFIX}${conversationId}:${userId}`, '1', 'EX', TYPING_TTL_SECONDS, 'NX');
      if (set !== 'OK') return;
      this.server.to(conversationRoom(conversationId)).emit(MESSAGING_SOCKET_EVENTS.typing, { conversationId, userId });
    } catch (error) {
      this.logger.warn(`Không phát được typing: ${(error as Error).message}`);
    }
  }
}
