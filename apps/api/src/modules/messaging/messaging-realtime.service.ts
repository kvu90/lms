import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MESSAGING_SOCKET_EVENTS } from '@lms/contracts';
import { conversationRoom, tenantRealtimeSegment, userRoom } from '@lms/messaging';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server } from 'socket.io';
import { redisTlsFromUrl } from '../../config/env';
import { MessagingRepository } from './messaging.repository';

const PRESENCE_KEY_PREFIX = 'lms:messaging:presence:';
const TYPING_KEY_PREFIX = 'lms:messaging:typing:';
/** Mặc định của hai knob presence trong env (xem config/env.ts): TTL 600s, gia hạn mỗi 120s. */
const PRESENCE_TTL_SECONDS_DEFAULT = 600;
const PRESENCE_REFRESH_MS_DEFAULT = 120_000;
/** Cửa sổ typing: một lần phát hiệu lực 4 giây, trong cửa sổ không phát lại. */
const TYPING_TTL_SECONDS = 4;

/**
 * Tầng realtime PHÍA KẾT NỐI của messaging (issue #33, chặng A1/A2).
 *
 * Chỉ nơi này chạm vào Socket.IO server tại tiến trình API: gateway
 * lo xác thực + room theo kết nối, service này giữ adapter Redis,
 * presence/typing (sống trong Redis — tạm thời, KHÔNG xuống
 * Postgres; DB vẫn là nguồn sự thật duy nhất cho tin nhắn và mốc đã
 * đọc) và hai thao tác room theo lệnh nghiệp vụ (đẩy socket của
 * thành viên bị gỡ, nối lại room 1–1 sau bỏ chặn).
 *
 * PHÂN PHỐI sự kiện nghiệp vụ (message.new, conversation.updated,
 * message.read, message.deleted, conversation.invalidate) KHÔNG
 * còn ở đây: từ issue #521, consumer phía worker tiêu thụ sự kiện
 * outbox qua hàng đợi và phân phối qua Redis emitter theo luật ở
 * package dùng chung `@lms/messaging` (nhà duy nhất của luật phân
 * phối — cổng chặn 1–1 fail-closed và rà soát membership tại thời
 * điểm phân phối nằm ở đó). Tên room cũng lấy từ package đó để nơi
 * nối (gateway) và nơi phát (worker) không bao giờ lệch nhau.
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
  private readonly presenceTtlSeconds: number;
  private readonly presenceRefreshMs: number;
  /**
   * Sổ socket ĐANG nối tại chính tiến trình này (chủ thể presence
   * `{tenant}:{userId}` → socketId). Vòng gia hạn presence chỉ gia
   * hạn cho user có mặt trong sổ này: tiến trình chết thì sổ biến
   * mất theo, không ai gia hạn nữa và TTL trong Redis tự hết hạn —
   * giữ đúng tính chất lưới an toàn của TTL.
   */
  private readonly localPresence = new Map<string, Set<string>>();
  private presenceTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    private readonly repo: MessagingRepository,
  ) {
    this.redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.redisOptions = { maxRetriesPerRequest: null, ...redisTlsFromUrl(this.redisUrl) };
    this.presenceTtlSeconds = config.get<number>('MESSAGING_PRESENCE_TTL_SECONDS') ?? PRESENCE_TTL_SECONDS_DEFAULT;
    this.presenceRefreshMs = config.get<number>('MESSAGING_PRESENCE_REFRESH_MS') ?? PRESENCE_REFRESH_MS_DEFAULT;
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
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    this.localPresence.clear();
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

  /** Tenant của một conversation (TENANT-1, #196) — namespace cho room/khoá realtime; lỗi đọc thì rơi về null (đoạn 'platform'). */
  private async tenantIdOfConversation(conversationId: string): Promise<string | null> {
    return this.repo.getConversationTenantId(conversationId).catch(() => null);
  }

  /**
   * Nối lại room hội thoại 1–1 cho socket hiện tại của cả hai phía
   * sau khi bỏ chặn (tiếp quản PR #94): socket nối vào lúc đang chặn
   * bị handshake bỏ qua khỏi room, và socket trong room có thể đã bị
   * đẩy ra khi phân phối trong lúc chặn — không có bước nối lại thì
   * presence và các sự kiện room sau bỏ chặn mất vĩnh viễn cho tới
   * khi nối lại, trái bất biến "bỏ chặn thì mọi bề mặt hiện lại
   * nguyên trạng". Đường phụ: lỗi bị nuốt kèm log, không lan ra
   * lệnh bỏ chặn.
   */
  async rejoinDirectConversationAfterUnblock(userId: string, otherUserId: string): Promise<void> {
    if (!this.server) return;
    try {
      const conversations = await this.repo.listConversationsForUser(userId);
      for (const c of conversations) {
        if (c.type !== 1) continue;
        const members = await this.repo.listMembers(c.id);
        if (members.length === 2 && members.includes(userId) && members.includes(otherUserId)) {
          const room = conversationRoom(c.tenantId, c.id);
          await this.server.in(userRoom(c.tenantId, userId)).socketsJoin(room);
          await this.server.in(userRoom(c.tenantId, otherUserId)).socketsJoin(room);
        }
      }
    } catch (error) {
      this.logger.warn(`Không nối lại được room sau bỏ chặn cho ${userId}: ${(error as Error).message}`);
    }
  }

  /**
   * Đẩy MỌI socket của một user ra khỏi room của conversation — tầng
   * dịch vụ gọi ngay khi gỡ thành viên (đồng bộ group), để socket của
   * người bị gỡ thôi nhận mọi sự kiện của conversation (tin mới, đã
   * đọc, typing, presence) chứ không chờ tới lần phân phối kế tiếp.
   * Đi qua room riêng của user nên trúng mọi kết nối của họ trên mọi
   * tiến trình (Redis adapter).
   */
  async evictUserFromConversation(userId: string, conversationId: string): Promise<void> {
    if (!this.server) return;
    try {
      const tenantId = await this.tenantIdOfConversation(conversationId);
      await this.server.in(userRoom(tenantId, userId)).socketsLeave(conversationRoom(tenantId, conversationId));
    } catch (error) {
      this.logger.warn(`Không đẩy được socket của user ${userId} khỏi conversation ${conversationId}: ${(error as Error).message}`);
    }
  }

  // --- presence (A2): tập socket đang mở của từng user trong Redis -------

  /** Chủ thể presence trong Redis + sổ local: `{tenant}:{userId}` (TENANT-1, #196). */
  private presenceSubject(tenantId: string | null | undefined, userId: string): string {
    return `${tenantRealtimeSegment(tenantId)}:${userId}`;
  }

  /** Ghi nhận một socket vừa nối; là socket ĐẦU TIÊN của user thì phát trạng thái online. */
  async markConnected(tenantId: string | null, userId: string, socketId: string): Promise<void> {
    const subject = this.presenceSubject(tenantId, userId);
    this.trackLocalSocket(subject, socketId);
    try {
      const redis = this.state();
      const size = await redis.sadd(`${PRESENCE_KEY_PREFIX}${subject}`, socketId);
      await redis.expire(`${PRESENCE_KEY_PREFIX}${subject}`, this.presenceTtlSeconds);
      if (size === 1 && (await redis.scard(`${PRESENCE_KEY_PREFIX}${subject}`)) === 1) {
        await this.broadcastPresence(userId, true);
      }
    } catch (error) {
      this.logger.warn(`Không ghi được presence khi nối: ${(error as Error).message}`);
    }
  }

  /** Ghi nhận một socket vừa ngắt; là socket CUỐI CÙNG của user thì phát trạng thái offline. */
  async markDisconnected(tenantId: string | null, userId: string, socketId: string): Promise<void> {
    // Bỏ khỏi sổ local TRƯỚC: vòng gia hạn dừng ngay cho socket này,
    // kể cả khi thao tác Redis dưới đây lỗi.
    const subject = this.presenceSubject(tenantId, userId);
    this.untrackLocalSocket(subject, socketId);
    try {
      const redis = this.state();
      await redis.srem(`${PRESENCE_KEY_PREFIX}${subject}`, socketId);
      const remaining = await redis.scard(`${PRESENCE_KEY_PREFIX}${subject}`);
      if (remaining === 0) await this.broadcastPresence(userId, false);
    } catch (error) {
      this.logger.warn(`Không ghi được presence khi ngắt: ${(error as Error).message}`);
    }
  }

  /** Ghi socket vào sổ local và bảo đảm vòng gia hạn đang chạy. */
  private trackLocalSocket(subject: string, socketId: string): void {
    let sockets = this.localPresence.get(subject);
    if (!sockets) {
      sockets = new Set();
      this.localPresence.set(subject, sockets);
    }
    sockets.add(socketId);
    if (!this.presenceTimer) {
      this.presenceTimer = setInterval(() => { void this.refreshLocalPresence(); }, this.presenceRefreshMs);
      this.presenceTimer.unref();
    }
  }

  /** Bỏ socket khỏi sổ local; user hết socket tại tiến trình này thì vòng gia hạn không đụng tới nữa. */
  private untrackLocalSocket(subject: string, socketId: string): void {
    const sockets = this.localPresence.get(subject);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) this.localPresence.delete(subject);
  }

  /**
   * Một nhịp gia hạn presence (F2): nới lại TTL cho mọi user còn ít
   * nhất một socket đang nối tại tiến trình này. Thiếu nhịp này, TTL
   * đặt lúc nối là hạn chót duy nhất — user online quá TTL (mặc định
   * 600s) bị coi là offline dù kết nối vẫn sống. Lỗi Redis bị nuốt
   * như mọi đường phụ của presence.
   */
  private async refreshLocalPresence(): Promise<void> {
    if (this.localPresence.size === 0) return;
    try {
      const redis = this.state();
      await Promise.all([...this.localPresence.keys()].map(async (subject) => {
        await redis.expire(`${PRESENCE_KEY_PREFIX}${subject}`, this.presenceTtlSeconds);
      }));
    } catch (error) {
      this.logger.warn(`Không gia hạn được presence: ${(error as Error).message}`);
    }
  }

  /**
   * Phát `presence.changed` tới room của mọi conversation mà user là
   * thành viên — NGOẠI TRỪ room 1–1 với đối tác đang có quan hệ chặn
   * (bất kỳ chiều nào): trạng thái trực tuyến không lộ qua bề mặt 1–1
   * khi đang chặn (chuẩn app nhắn tin, issue #33). Room nhóm không đổi.
   */
  private async broadcastPresence(userId: string, online: boolean): Promise<void> {
    if (!this.server) return;
    try {
      const conversations = await this.repo.listConversationsForUser(userId);
      if (!conversations.length) return;
      const blockedCounterparts = new Set(await this.repo.listBlockedCounterpartIds(userId));
      const rooms: string[] = [];
      for (const c of conversations) {
        if (c.type === 1 && blockedCounterparts.size > 0) {
          const members = await this.repo.listMembers(c.id);
          const other = members.find((id) => id !== userId);
          if (other && blockedCounterparts.has(other)) continue;
        }
        rooms.push(conversationRoom(c.tenantId, c.id));
      }
      if (!rooms.length) return;
      this.server
        .to(rooms)
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
      const tenantId = await this.tenantIdOfConversation(conversationId);
      const set = await this.state().set(`${TYPING_KEY_PREFIX}${tenantRealtimeSegment(tenantId)}:${conversationId}:${userId}`, '1', 'EX', TYPING_TTL_SECONDS, 'NX');
      if (set !== 'OK') return;
      this.server.to(conversationRoom(tenantId, conversationId)).emit(MESSAGING_SOCKET_EVENTS.typing, { conversationId, userId });
    } catch (error) {
      this.logger.warn(`Không phát được typing: ${(error as Error).message}`);
    }
  }
}
