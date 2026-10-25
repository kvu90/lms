import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MESSAGING_SOCKET_EVENTS,
  type LmsMessage,
  type RealtimeConversationInvalidatePayload,
  type RealtimeConversationUpdatedPayload,
  type RealtimeMessageDeletedPayload,
  type RealtimeMessageReadPayload,
  type RealtimeNewMessagePayload,
} from '@lms/contracts';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server } from 'socket.io';
import { redisTlsFromUrl } from '../../config/env';
import { blankRecalledContent, MessagingRepository, type MessageRow } from './messaging.repository';

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
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    deletedBy: row.deletedBy,
    recalledAt: row.recalledAt ? row.recalledAt.toISOString() : null,
    recalledBy: row.recalledBy,
  };
}

const PRESENCE_KEY_PREFIX = 'lms:messaging:presence:';
const TYPING_KEY_PREFIX = 'lms:messaging:typing:';
/** Mặc định của hai knob presence trong env (xem config/env.ts): TTL 600s, gia hạn mỗi 120s. */
const PRESENCE_TTL_SECONDS_DEFAULT = 600;
const PRESENCE_REFRESH_MS_DEFAULT = 120_000;
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
  private readonly presenceTtlSeconds: number;
  private readonly presenceRefreshMs: number;
  /**
   * Sổ socket ĐANG nối tại chính tiến trình này (userId → socketId).
   * Vòng gia hạn presence chỉ gia hạn cho user có mặt trong sổ này:
   * tiến trình chết thì sổ biến mất theo, không ai gia hạn nữa và TTL
   * trong Redis tự hết hạn — giữ đúng tính chất lưới an toàn của TTL.
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

  // --- phân phối sự kiện nghiệp vụ (consumer của outbox gọi) -------------

  /**
   * Phân phối một tin mới: `message.new` vào room của conversation
   * (client đang mở cuộc trò chuyện nhận ngay) + `conversation.updated`
   * vào room riêng của TỪNG thành viên kèm số chưa đọc của chính họ
   * (client cập nhật danh sách/huy hiệu không cần tải lại).
   */
  async distributeNewMessage(messageRow: MessageRow, memberIds: string[]): Promise<void> {
    if (!this.server) return;
    // Cùng cổng chặn với distributeMessageDeleted (việc nối tiếp #33,
    // vòng 3 PR #94): tin gửi sát trước lúc chặn, outbox tiêu thụ
    // muộn sau khi chặn, không được lộ sang phía bị chặn — kể cả
    // conversation.updated vào userRoom (kèm nội dung tin cuối), dù
    // message.new vào room hội thoại đã bị chặn ở tầng gateway.
    // Hội thoại nhóm không bị chạm.
    // CHỈ chặn phát, KHÔNG đẩy socket khỏi room (tiếp quản PR #94):
    // membership của room là trạng thái bền theo kết nối — socket bị
    // đẩy ra không tự nối lại khi bỏ chặn (handshake chỉ nối lúc
    // connect; join/sync từ chối room đang chặn), nên presence sau
    // bỏ chặn (phát tới room) mất vĩnh viễn cho tới khi nối lại.
    // Mọi đường phát vào room đều đã có cổng ở thời điểm phát nên
    // chặn phát là đủ; eviction chỉ dành cho gỡ thành viên thật
    // (đồng bộ group trong messaging.service.ts).
    const conversation = await this.repo.getConversation(messageRow.conversationId).catch(() => undefined);
    if (conversation?.type === 1 && memberIds.length === 2) {
      const first = memberIds[0];
      const second = memberIds[1];
      if (first === undefined || second === undefined) return;
      const blocked: string[] = await this.repo.listBlockedCounterpartIds(first).catch(() => []);
      if (blocked.includes(second)) {
        return;
      }
    }
    const wire = toWireMessage(messageRow);
    const newPayload: RealtimeNewMessagePayload = { conversationId: messageRow.conversationId, message: wire };
    // Rà soát room NGAY TRƯỚC khi phát: socket của thành viên đã bị gỡ
    // khỏi conversation (membership chốt bởi consumer tại thời điểm
    // phân phối) bị đẩy ra khỏi room, không nhận message.new này và
    // mọi sự kiện room về sau (F1 — trước đây chỉ kiểm tra membership
    // lúc bắt tay/join nên socket cũ nằm lại trong room vô hạn).
    await this.evictNonMemberSockets(messageRow.conversationId, memberIds);
    this.server.to(conversationRoom(messageRow.conversationId)).emit(MESSAGING_SOCKET_EVENTS.newMessage, newPayload);
    await Promise.all(memberIds.map(async (memberId) => {
      const unreadCount = await this.repo.countUnreadForConversation(messageRow.conversationId, memberId).catch(() => 0);
      const payload: RealtimeConversationUpdatedPayload = {
        conversationId: messageRow.conversationId, message: wire, unreadCount,
      };
      this.server!.to(userRoom(memberId)).emit(MESSAGING_SOCKET_EVENTS.conversationUpdated, payload);
    }));
  }

  /**
   * Phân phối một lần xoá mềm (Lớp B): `message.deleted` vào room của
   * conversation — payload chỉ mang id/seq/người xoá, KHÔNG kèm nội
   * dung (phía học sinh phải gỡ tin khỏi khung và không được nhận lại
   * nội dung qua kênh này) — kèm `conversation.updated` cho từng thành
   * viên với tin cuối CÒN HIỂN THỊ được (tin đã xoá không bao giờ là
   * tin cuối ở phía client) và số chưa đọc đã trừ tin đã xoá.
   */
  async distributeMessageDeleted(messageRow: MessageRow, memberIds: string[]): Promise<void> {
    if (!this.server) return;
    // Lớp phòng thủ thứ hai (việc nối tiếp #33, siết sau PR #94
    // vòng 1): đường xoá chính đã 404 trong lúc chặn nên outbox
    // `message_deleted` không sinh mới, nhưng một sự kiện tới muộn
    // (xoá trước khi chặn, outbox tiêu thụ sau khi chặn — hoặc xoá
    // bởi người kiểm duyệt ngoài cặp chặn) vẫn không được lộ tới
    // cặp đang chặn: không phát gì cả.
    // CHỈ chặn phát, KHÔNG đẩy socket khỏi room (tiếp quản PR #94):
    // lý do như cổng distributeNewMessage — socket bị đẩy ra không
    // tự nối lại khi bỏ chặn nên presence sau bỏ chặn sẽ mất; mọi
    // đường phát vào room đều đã có cổng ở thời điểm phát nên
    // chặn phát là đủ. Hội thoại nhóm không bị chạm.
    const conversation = await this.repo.getConversation(messageRow.conversationId).catch(() => undefined);
    if (conversation?.type === 1 && memberIds.length === 2) {
      const first = memberIds[0];
      const second = memberIds[1];
      if (first === undefined || second === undefined) return;
      const blocked: string[] = await this.repo.listBlockedCounterpartIds(first).catch(() => []);
      if (blocked.includes(second)) {
        return;
      }
    }
    await this.evictNonMemberSockets(messageRow.conversationId, memberIds);
    const deletedPayload: RealtimeMessageDeletedPayload = {
      conversationId: messageRow.conversationId,
      messageId: messageRow.id,
      seq: messageRow.seq,
      deletedBy: messageRow.deletedBy ?? '',
    };
    this.server.to(conversationRoom(messageRow.conversationId)).emit(MESSAGING_SOCKET_EVENTS.messageDeleted, deletedPayload);
    // Tin cuối còn hiển thị: cửa sổ đọc mặc định của repository đã lọc
    // tin đã xoá — lấy đúng 1 tin mới nhất còn sống làm xem trước mới.
    const [lastVisible] = await this.repo.listMessages(messageRow.conversationId, { limit: 1 }).catch(() => []);
    if (!lastVisible) return;
    const wire = toWireMessage(lastVisible);
    await Promise.all(memberIds.map(async (memberId) => {
      const unreadCount = await this.repo.countUnreadForConversation(messageRow.conversationId, memberId).catch(() => 0);
      const payload: RealtimeConversationUpdatedPayload = {
        conversationId: messageRow.conversationId, message: wire, unreadCount,
      };
      this.server!.to(userRoom(memberId)).emit(MESSAGING_SOCKET_EVENTS.conversationUpdated, payload);
    }));
  }

  /**
   * Cặp 1–1 đang có quan hệ chặn thì MỌI sự kiện vòng đời (thu hồi,
   * xoá cứng) đều bị nén im lặng như ở {@link distributeMessageDeleted}:
   * không phát gì. Trả true khi sự kiện đã bị nén (caller dừng phân
   * phối). CHỈ chặn phát, KHÔNG đẩy socket khỏi room (nhất quán với
   * tiếp quản PR #94): socket bị đẩy ra không tự nối lại khi bỏ chặn
   * nên presence sau bỏ chặn mất vĩnh viễn; mọi đường phát vào room
   * đều đã có cổng ở thời điểm phát nên chặn phát là đủ.
   */
  private async suppressIfBlockedDirectPair(conversationId: string, memberIds: string[]): Promise<boolean> {
    const conversation = await this.repo.getConversation(conversationId).catch(() => undefined);
    if (conversation?.type !== 1 || memberIds.length !== 2) return false;
    const first = memberIds[0];
    const second = memberIds[1];
    if (first === undefined || second === undefined) return true;
    const blocked: string[] = await this.repo.listBlockedCounterpartIds(first).catch(() => []);
    if (!blocked.includes(second)) return false;
    return true;
  }

  /** Phát `conversation.invalidate` tới room riêng của TỪNG thành viên: cache danh sách của họ phải tải lại. */
  private emitConversationInvalidate(conversationId: string, memberIds: string[]): void {
    const payload: RealtimeConversationInvalidatePayload = { conversationId };
    for (const memberId of memberIds) {
      this.server!.to(userRoom(memberId)).emit(MESSAGING_SOCKET_EVENTS.conversationInvalidate, payload);
    }
  }

  /**
   * Phân phối một lần THU HỒI (vòng đời theo vai, lớp (b)): phía nhận
   * phải gỡ nội dung NGAY — phát `message.deleted` (payload không nội
   * dung) vào room như một lần xoá, kèm `conversation.updated` với
   * xem trước đã vô hiệu nội dung nếu tin bị thu hồi chính là tin
   * cuối, và BẮT BUỘC `conversation.invalidate` tới từng thành viên
   * để cache danh sách bị vô hiệu (số chưa đọc cũng đã đổi: tin thu
   * hồi không còn đếm chưa đọc).
   */
  async distributeMessageRecalled(messageRow: MessageRow, memberIds: string[]): Promise<void> {
    if (!this.server) return;
    if (await this.suppressIfBlockedDirectPair(messageRow.conversationId, memberIds)) return;
    await this.evictNonMemberSockets(messageRow.conversationId, memberIds);
    const deletedPayload: RealtimeMessageDeletedPayload = {
      conversationId: messageRow.conversationId,
      messageId: messageRow.id,
      seq: messageRow.seq,
      deletedBy: messageRow.recalledBy ?? '',
    };
    this.server.to(conversationRoom(messageRow.conversationId)).emit(MESSAGING_SOCKET_EVENTS.messageDeleted, deletedPayload);
    const [lastVisible] = await this.repo.listMessages(messageRow.conversationId, { limit: 1 }).catch(() => []);
    if (lastVisible) {
      // Tin cuối còn hiển thị có thể CHÍNH LÀ tin vừa thu hồi: xem
      // trước gửi đi phải qua vô hiệu nội dung như mọi đường đọc.
      const wire = toWireMessage(blankRecalledContent(lastVisible));
      await Promise.all(memberIds.map(async (memberId) => {
        const unreadCount = await this.repo.countUnreadForConversation(messageRow.conversationId, memberId).catch(() => 0);
        const payload: RealtimeConversationUpdatedPayload = {
          conversationId: messageRow.conversationId, message: wire, unreadCount,
        };
        this.server!.to(userRoom(memberId)).emit(MESSAGING_SOCKET_EVENTS.conversationUpdated, payload);
      }));
    }
    this.emitConversationInvalidate(messageRow.conversationId, memberIds);
  }

  /**
   * Phân phối một lần XOÁ CỨNG (lớp (c)): dòng tin ĐÃ biến mất khỏi
   * DB nên mọi định danh đến từ BẢN CHỤP trong payload sự kiện (do
   * consumer truyền vào) — không đọc lại dòng tin được nữa. Sự kiện
   * phía client giống hệt thu hồi/xoá mềm (`message.deleted` +
   * `conversation.updated` nếu còn tin cuối hiển thị + BẮT BUỘC
   * `conversation.invalidate`): với phía nhận, một tin bị gỡ là một
   * tin biến mất, lý do kiểm duyệt không đi qua kênh này.
   */
  async distributeMessageRemoved(
    snapshot: { conversationId: string; messageId: string; seq: number; removedBy: string },
    memberIds: string[],
  ): Promise<void> {
    if (!this.server) return;
    if (await this.suppressIfBlockedDirectPair(snapshot.conversationId, memberIds)) return;
    await this.evictNonMemberSockets(snapshot.conversationId, memberIds);
    const deletedPayload: RealtimeMessageDeletedPayload = {
      conversationId: snapshot.conversationId,
      messageId: snapshot.messageId,
      seq: snapshot.seq,
      deletedBy: snapshot.removedBy,
    };
    this.server.to(conversationRoom(snapshot.conversationId)).emit(MESSAGING_SOCKET_EVENTS.messageDeleted, deletedPayload);
    const [lastVisible] = await this.repo.listMessages(snapshot.conversationId, { limit: 1 }).catch(() => []);
    if (lastVisible) {
      const wire = toWireMessage(blankRecalledContent(lastVisible));
      await Promise.all(memberIds.map(async (memberId) => {
        const unreadCount = await this.repo.countUnreadForConversation(snapshot.conversationId, memberId).catch(() => 0);
        const payload: RealtimeConversationUpdatedPayload = {
          conversationId: snapshot.conversationId, message: wire, unreadCount,
        };
        this.server!.to(userRoom(memberId)).emit(MESSAGING_SOCKET_EVENTS.conversationUpdated, payload);
      }));
    }
    this.emitConversationInvalidate(snapshot.conversationId, memberIds);
  }

  /**
   * Phân phối một lần XOÁ-PHÍA-MÌNH (lớp (a)): CHỈ người xoá được
   * biết — phát `message.deleted` + `conversation.invalidate` vào
   * room RIÊNG của chính họ để các thiết bị khác của họ đồng bộ;
   * TUYỆT ĐỐI không phát vào room conversation (phía kia không được
   * nhận bất kỳ tín hiệu nào: với họ cuộc trò chuyện không đổi).
   */
  async distributeMessageDeletedForMe(snapshot: { conversationId: string; messageId: string; seq: number; actorId: string }): Promise<void> {
    if (!this.server) return;
    const deletedPayload: RealtimeMessageDeletedPayload = {
      conversationId: snapshot.conversationId,
      messageId: snapshot.messageId,
      seq: snapshot.seq,
      deletedBy: snapshot.actorId,
    };
    this.server.to(userRoom(snapshot.actorId)).emit(MESSAGING_SOCKET_EVENTS.messageDeleted, deletedPayload);
    const invalidatePayload: RealtimeConversationInvalidatePayload = { conversationId: snapshot.conversationId };
    this.server.to(userRoom(snapshot.actorId)).emit(MESSAGING_SOCKET_EVENTS.conversationInvalidate, invalidatePayload);
  }

  /** Phân phối biên đã-đọc của một thành viên vào room của conversation. */
  async distributeReadReceipt(payload: RealtimeMessageReadPayload): Promise<void> {
    if (!this.server) return;
    // Cùng cổng chặn với distributeNewMessage/distributeMessageDeleted
    // (việc nối tiếp #33, siết sau PR #94 vòng đánh giá lại): biên
    // đã-đọc ghi outbox TRƯỚC khi chặn, consumer nhịp 500ms tiêu thụ
    // SAU khi chặn, không được lộ trạng thái đã-đọc 1–1 sang phía bị
    // chặn — kể cả khi socket phía đó vẫn nằm trong room (không còn
    // eviction ở hai cổng kia). Hội thoại nhóm không bị chạm.
    // CHỈ chặn phát, KHÔNG đẩy socket khỏi room: lý do như hai cổng
    // kia — socket bị đẩy ra không tự nối lại khi bỏ chặn.
    const conversation = await this.repo.getConversation(payload.conversationId).catch(() => undefined);
    const memberIds = await this.repo.listMembers(payload.conversationId).catch(() => null);
    if (conversation?.type === 1 && memberIds?.length === 2) {
      const other = memberIds.find((id) => id !== payload.userId);
      if (other) {
        const blocked: string[] = await this.repo.listBlockedCounterpartIds(payload.userId).catch(() => []);
        if (blocked.includes(other)) {
          return;
        }
      }
    }
    // Cùng kỷ luật F1: rà soát room theo membership hiện tại trước
    // khi phát — thành viên đã bị gỡ không nhận biên đã-đọc nữa. Đọc
    // membership lỗi thì vẫn phát như cũ (realtime là đường phụ).
    if (memberIds) await this.evictNonMemberSockets(payload.conversationId, memberIds);
    this.server.to(conversationRoom(payload.conversationId)).emit(MESSAGING_SOCKET_EVENTS.messageRead, payload);
  }

  /**
   * Đẩy khỏi room của conversation mọi socket mà user KHÔNG còn
   * trong `memberIds`. Membership của room được Socket.IO giữ theo
   * kết nối (vào room lúc bắt tay/join) nên tự nó không phản ánh việc
   * bị gỡ khỏi conversation; đây là điểm chốt lại membership tại thời
   * điểm phân phối cho mọi sự kiện phát vào room.
   */
  private async evictNonMemberSockets(conversationId: string, memberIds: string[]): Promise<void> {
    if (!this.server) return;
    try {
      const memberSet = new Set(memberIds);
      const room = conversationRoom(conversationId);
      const sockets = await this.server.in(room).fetchSockets();
      await Promise.all(sockets
        .filter((socket) => {
          const userId = (socket.data as { userId?: unknown } | undefined)?.userId;
          return typeof userId !== 'string' || !memberSet.has(userId);
        })
        .map((socket) => socket.leave(room)));
    } catch (error) {
      this.logger.warn(`Không rà soát được room của conversation ${conversationId}: ${(error as Error).message}`);
    }
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
          const room = conversationRoom(c.id);
          await this.server.in(userRoom(userId)).socketsJoin(room);
          await this.server.in(userRoom(otherUserId)).socketsJoin(room);
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
      await this.server.in(userRoom(userId)).socketsLeave(conversationRoom(conversationId));
    } catch (error) {
      this.logger.warn(`Không đẩy được socket của user ${userId} khỏi conversation ${conversationId}: ${(error as Error).message}`);
    }
  }

  // --- presence (A2): tập socket đang mở của từng user trong Redis -------

  /** Ghi nhận một socket vừa nối; là socket ĐẦU TIÊN của user thì phát trạng thái online. */
  async markConnected(userId: string, socketId: string): Promise<void> {
    this.trackLocalSocket(userId, socketId);
    try {
      const redis = this.state();
      const size = await redis.sadd(`${PRESENCE_KEY_PREFIX}${userId}`, socketId);
      await redis.expire(`${PRESENCE_KEY_PREFIX}${userId}`, this.presenceTtlSeconds);
      if (size === 1 && (await redis.scard(`${PRESENCE_KEY_PREFIX}${userId}`)) === 1) {
        await this.broadcastPresence(userId, true);
      }
    } catch (error) {
      this.logger.warn(`Không ghi được presence khi nối: ${(error as Error).message}`);
    }
  }

  /** Ghi nhận một socket vừa ngắt; là socket CUỐI CÙNG của user thì phát trạng thái offline. */
  async markDisconnected(userId: string, socketId: string): Promise<void> {
    // Bỏ khỏi sổ local TRƯỚC: vòng gia hạn dừng ngay cho socket này,
    // kể cả khi thao tác Redis dưới đây lỗi.
    this.untrackLocalSocket(userId, socketId);
    try {
      const redis = this.state();
      await redis.srem(`${PRESENCE_KEY_PREFIX}${userId}`, socketId);
      const remaining = await redis.scard(`${PRESENCE_KEY_PREFIX}${userId}`);
      if (remaining === 0) await this.broadcastPresence(userId, false);
    } catch (error) {
      this.logger.warn(`Không ghi được presence khi ngắt: ${(error as Error).message}`);
    }
  }

  /** Ghi socket vào sổ local và bảo đảm vòng gia hạn đang chạy. */
  private trackLocalSocket(userId: string, socketId: string): void {
    let sockets = this.localPresence.get(userId);
    if (!sockets) {
      sockets = new Set();
      this.localPresence.set(userId, sockets);
    }
    sockets.add(socketId);
    if (!this.presenceTimer) {
      this.presenceTimer = setInterval(() => { void this.refreshLocalPresence(); }, this.presenceRefreshMs);
      this.presenceTimer.unref();
    }
  }

  /** Bỏ socket khỏi sổ local; user hết socket tại tiến trình này thì vòng gia hạn không đụng tới nữa. */
  private untrackLocalSocket(userId: string, socketId: string): void {
    const sockets = this.localPresence.get(userId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) this.localPresence.delete(userId);
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
      await Promise.all([...this.localPresence.keys()].map(async (userId) => {
        await redis.expire(`${PRESENCE_KEY_PREFIX}${userId}`, this.presenceTtlSeconds);
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
        rooms.push(conversationRoom(c.id));
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
      const set = await this.state().set(`${TYPING_KEY_PREFIX}${conversationId}:${userId}`, '1', 'EX', TYPING_TTL_SECONDS, 'NX');
      if (set !== 'OK') return;
      this.server.to(conversationRoom(conversationId)).emit(MESSAGING_SOCKET_EVENTS.typing, { conversationId, userId });
    } catch (error) {
      this.logger.warn(`Không phát được typing: ${(error as Error).message}`);
    }
  }
}
