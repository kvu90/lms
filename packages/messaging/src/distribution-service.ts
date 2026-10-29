import {
  MESSAGING_SOCKET_EVENTS,
  type RealtimeConversationInvalidatePayload,
  type RealtimeConversationUpdatedPayload,
  type RealtimeMessageDeletedPayload,
  type RealtimeMessageReadPayload,
  type RealtimeNewMessagePayload,
} from '@lms/contracts';
import { blankRecalledContent, toWireMessage, type MessageRow } from './message-wire.js';
import { conversationRoom, userRoom } from './realtime-rooms.js';
import type { MessagingDistributionStore } from './distribution-store.js';

/** Các loại sự kiện messaging được phân phối qua realtime. */
export const MESSAGING_DISTRIBUTED_EVENT_TYPES = [
  'message_sent',
  'message_conversation_read',
  'message_deleted',
  'message_recalled',
  'message_removed',
  'message_deleted_for_me',
] as const;

/**
 * Một socket ở xa nhìn từ phía phát (qua backplane Redis): chỉ hai
 * khả năng tầng phân phối cần — đọc `data.userId` đã gắn lúc bắt tay
 * và đẩy socket rời room. Phía API cài đặt bằng Socket.IO server tại
 * chỗ; phía worker cài đặt bằng Redis emitter (xem
 * `apps/worker/src/messaging-realtime-emitter.ts`).
 */
export interface RealtimeRemoteSocket {
  data: { userId?: unknown };
  leave(room: string): Promise<unknown> | unknown;
}

/**
 * Cổng phát realtime của tầng phân phối: phát một sự kiện vào một
 * room, và liệt kê các socket đang ở trong một room. Mọi phát xạ đều
 * thuộc namespace của gateway nhắn tin (`/messaging`) — phía cài đặt
 * cổng chịu trách nhiệm gắn đúng namespace đó.
 */
export interface RealtimeEmitter {
  emitToRoom(room: string, event: string, payload: unknown): Promise<void> | void;
  fetchSocketsInRoom(room: string): Promise<RealtimeRemoteSocket[]>;
}

/** Logger tối thiểu của tầng phân phối (mỗi app gắn logger của mình). */
export interface MessagingDistributionLogger {
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Tầng phân phối realtime của messaging (issue #33, chặng A1/A2;
 * chuyển sang worker ở issue #521).
 *
 * Đây là NHÀ DUY NHẤT của luật phân phối: sự kiện nghiệp vụ đã nằm
 * trong outbox được consumer phía worker tiêu thụ qua hàng đợi và
 * gọi các hàm distribute* ở đây để phát qua Socket.IO (backplane
 * Redis nối tới tiến trình API đang giữ kết nối của client).
 * Gateway phía API chỉ lo xác thực + room theo kết nối; presence và
 * typing vẫn sống phía API (trạng thái tạm trong Redis, KHÔNG xuống
 * Postgres — DB vẫn là nguồn sự thật duy nhất cho tin nhắn và mốc
 * đã đọc).
 *
 * Mọi đường phát vào room của một conversation đều qua CỔNG CHẶN
 * cặp 1–1 (fail-closed) và RÀ SOÁT MEMBERSHIP tại thời điểm phân
 * phối trong các hàm dưới đây — cấm phát realtime vòng qua tầng này.
 */
export interface MessagingDistributionService {
  /** Phân phối một sự kiện outbox đã commit theo loại của nó. Payload hỏng/thiếu thì bỏ qua. */
  distributeEvent(type: string, payload: Record<string, unknown>): Promise<void>;
  distributeNewMessage(messageRow: MessageRow, memberIds: string[]): Promise<void>;
  distributeMessageDeleted(messageRow: MessageRow, memberIds: string[]): Promise<void>;
  distributeMessageRecalled(messageRow: MessageRow, memberIds: string[]): Promise<void>;
  distributeMessageRemoved(
    snapshot: { conversationId: string; messageId: string; seq: number; removedBy: string },
    memberIds: string[],
  ): Promise<void>;
  distributeMessageDeletedForMe(
    snapshot: { conversationId: string; messageId: string; seq: number; actorId: string },
  ): Promise<void>;
  distributeReadReceipt(payload: RealtimeMessageReadPayload): Promise<void>;
}

/** Dựng tầng phân phối trên bề mặt đọc + cổng phát của app gọi. */
export function createMessagingDistributionService(deps: {
  store: MessagingDistributionStore;
  emitter: RealtimeEmitter;
  logger: MessagingDistributionLogger;
}): MessagingDistributionService {
  const { store, emitter, logger } = deps;

  /** Tenant của một conversation (TENANT-1, #196) — namespace cho room/khoá realtime; lỗi đọc thì rơi về null (đoạn 'platform'). */
  async function tenantIdOfConversation(conversationId: string): Promise<string | null> {
    return store.getConversationTenantId(conversationId).catch(() => null);
  }

  /**
   * Tra danh sách user mà `userId` đã chặn, theo kỷ luật FAIL-CLOSED
   * của cổng chặn cặp 1–1: tra cứu thành công trả danh sách (có thể
   * rỗng); tra cứu LỖI trả `null` và ghi log lỗi — phía gọi phải coi
   * `null` là "không xác minh được quan hệ chặn" và NÉN toàn bộ lượt
   * phân phối. Nuốt lỗi thành danh sách rỗng (khuôn cũ) làm cổng chặn
   * fail-open: lỗi cơ sở dữ liệu đúng lúc phân phối là tin/biên sự
   * kiện vẫn lộ sang phía đang bị chặn.
   */
  async function blockedCounterpartIdsFailClosed(userId: string): Promise<string[] | null> {
    try {
      return await store.listBlockedCounterpartIds(userId);
    } catch (error) {
      logger.error(
        `Không tra được danh sách chặn của user ${userId}, nén phân phối realtime theo kỷ luật fail-closed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Đẩy khỏi room của conversation mọi socket mà user KHÔNG còn
   * trong `memberIds`. Membership của room được Socket.IO giữ theo
   * kết nối (vào room lúc bắt tay/join) nên tự nó không phản ánh việc
   * bị gỡ khỏi conversation; đây là điểm chốt lại membership tại thời
   * điểm phân phối cho mọi sự kiện phát vào room.
   */
  async function evictNonMemberSockets(tenantId: string | null, conversationId: string, memberIds: string[]): Promise<void> {
    try {
      const memberSet = new Set(memberIds);
      const room = conversationRoom(tenantId, conversationId);
      const sockets = await emitter.fetchSocketsInRoom(room);
      await Promise.all(sockets
        .filter((socket) => {
          const userId = socket.data?.userId;
          return typeof userId !== 'string' || !memberSet.has(userId);
        })
        .map((socket) => socket.leave(room)));
    } catch (error) {
      logger.warn(`Không rà soát được room của conversation ${conversationId}: ${(error as Error).message}`);
    }
  }

  /**
   * Cặp 1–1 đang có quan hệ chặn thì MỌI sự kiện vòng đời (thu hồi,
   * xoá cứng) đều bị nén im lặng như ở {@link distributeMessageDeleted}:
   * không phát gì. Trả true khi sự kiện đã bị nén (caller dừng phân
   * phối). CHỈ chặn phát, KHÔNG đẩy socket khỏi room (tiếp quản
   * PR #94): socket bị đẩy ra không tự nối lại khi bỏ chặn nên
   * presence sau bỏ chặn mất vĩnh viễn; mọi đường phát vào room đều
   * đã có cổng ở thời điểm phát nên chặn phát là đủ.
   */
  async function suppressIfBlockedDirectPair(conversationId: string, memberIds: string[]): Promise<boolean> {
    const conversation = await store.getConversation(conversationId).catch(() => undefined);
    if (conversation?.type !== 1 || memberIds.length !== 2) return false;
    const first = memberIds[0];
    const second = memberIds[1];
    if (first === undefined || second === undefined) return true;
    // Fail-closed: không tra được danh sách chặn thì coi như phải
    // nén (trả true) — không xác minh được quan hệ chặn thì không phát.
    const blocked = await blockedCounterpartIdsFailClosed(first);
    if (blocked === null) return true;
    if (!blocked.includes(second)) return false;
    return true;
  }

  /** Phát `conversation.invalidate` tới room riêng của TỪNG thành viên: cache danh sách của họ phải tải lại. */
  async function emitConversationInvalidate(tenantId: string | null, conversationId: string, memberIds: string[]): Promise<void> {
    const payload: RealtimeConversationInvalidatePayload = { conversationId };
    await Promise.all(memberIds.map((memberId) => emitter.emitToRoom(userRoom(tenantId, memberId), MESSAGING_SOCKET_EVENTS.conversationInvalidate, payload)));
  }

  /**
   * Phân phối một tin mới: `message.new` vào room của conversation
   * (client đang mở cuộc trò chuyện nhận ngay) + `conversation.updated`
   * vào room riêng của TỪNG thành viên kèm số chưa đọc của chính họ
   * (client cập nhật danh sách/huy hiệu không cần tải lại).
   */
  async function distributeNewMessage(messageRow: MessageRow, memberIds: string[]): Promise<void> {
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
    const conversation = await store.getConversation(messageRow.conversationId).catch(() => undefined);
    if (conversation?.type === 1 && memberIds.length === 2) {
      const first = memberIds[0];
      const second = memberIds[1];
      if (first === undefined || second === undefined) return;
      // Cổng chặn fail-closed: không tra được danh sách chặn thì
      // nén luôn lượt phát này (xem blockedCounterpartIdsFailClosed).
      const blocked = await blockedCounterpartIdsFailClosed(first);
      if (blocked === null || blocked.includes(second)) {
        return;
      }
    }
    const tenantId = conversation?.tenantId ?? null;
    // Khối trích dẫn (lát M3) dựng MỘT lần cho cả room theo luật
    // người xem thường — payload message.new/conversation.updated
    // mang đủ dữ kiện để client hiện ngay, không gọi thêm. Việc cá
    // nhân hoá theo cờ xoá-phía-mình của từng người nhận chốt ở
    // đường đọc REST/sync (xem attachQuotes của bề mặt đọc).
    const [withQuote] = await store.attachQuotes([messageRow], { privileged: false });
    const wire = toWireMessage(messageRow, withQuote?.replyTo ?? null);
    const newPayload: RealtimeNewMessagePayload = { conversationId: messageRow.conversationId, message: wire };
    // Rà soát room NGAY TRƯỚC khi phát: socket của thành viên đã bị gỡ
    // khỏi conversation (membership chốt bởi consumer tại thời điểm
    // phân phối) bị đẩy ra khỏi room, không nhận message.new này và
    // mọi sự kiện room về sau (F1 — trước đây chỉ kiểm tra membership
    // lúc bắt tay/join nên socket cũ nằm lại trong room vô hạn).
    await evictNonMemberSockets(tenantId, messageRow.conversationId, memberIds);
    await emitter.emitToRoom(conversationRoom(tenantId, messageRow.conversationId), MESSAGING_SOCKET_EVENTS.newMessage, newPayload);
    await Promise.all(memberIds.map(async (memberId) => {
      const unreadCount = await store.countUnreadForConversation(messageRow.conversationId, memberId).catch(() => 0);
      const payload: RealtimeConversationUpdatedPayload = {
        conversationId: messageRow.conversationId, message: wire, unreadCount,
      };
      await emitter.emitToRoom(userRoom(tenantId, memberId), MESSAGING_SOCKET_EVENTS.conversationUpdated, payload);
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
  async function distributeMessageDeleted(messageRow: MessageRow, memberIds: string[]): Promise<void> {
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
    const conversation = await store.getConversation(messageRow.conversationId).catch(() => undefined);
    if (conversation?.type === 1 && memberIds.length === 2) {
      const first = memberIds[0];
      const second = memberIds[1];
      if (first === undefined || second === undefined) return;
      // Cổng chặn fail-closed như ở distributeNewMessage: không tra
      // được danh sách chặn thì nén luôn lượt phát này.
      const blocked = await blockedCounterpartIdsFailClosed(first);
      if (blocked === null || blocked.includes(second)) {
        return;
      }
    }
    const tenantId = conversation?.tenantId ?? null;
    await evictNonMemberSockets(tenantId, messageRow.conversationId, memberIds);
    const deletedPayload: RealtimeMessageDeletedPayload = {
      conversationId: messageRow.conversationId,
      messageId: messageRow.id,
      seq: messageRow.seq,
      deletedBy: messageRow.deletedBy ?? '',
    };
    await emitter.emitToRoom(conversationRoom(tenantId, messageRow.conversationId), MESSAGING_SOCKET_EVENTS.messageDeleted, deletedPayload);
    // Tin cuối còn hiển thị: cửa sổ đọc mặc định của bề mặt đọc đã lọc
    // tin đã xoá — lấy đúng 1 tin mới nhất còn sống làm xem trước mới.
    const [lastVisible] = await store.listMessages(messageRow.conversationId, { limit: 1 }).catch(() => []);
    if (!lastVisible) return;
    const wire = toWireMessage(lastVisible);
    await Promise.all(memberIds.map(async (memberId) => {
      const unreadCount = await store.countUnreadForConversation(messageRow.conversationId, memberId).catch(() => 0);
      const payload: RealtimeConversationUpdatedPayload = {
        conversationId: messageRow.conversationId, message: wire, unreadCount,
      };
      await emitter.emitToRoom(userRoom(tenantId, memberId), MESSAGING_SOCKET_EVENTS.conversationUpdated, payload);
    }));
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
  async function distributeMessageRecalled(messageRow: MessageRow, memberIds: string[]): Promise<void> {
    if (await suppressIfBlockedDirectPair(messageRow.conversationId, memberIds)) return;
    const tenantId = await tenantIdOfConversation(messageRow.conversationId);
    await evictNonMemberSockets(tenantId, messageRow.conversationId, memberIds);
    const deletedPayload: RealtimeMessageDeletedPayload = {
      conversationId: messageRow.conversationId,
      messageId: messageRow.id,
      seq: messageRow.seq,
      deletedBy: messageRow.recalledBy ?? '',
    };
    await emitter.emitToRoom(conversationRoom(tenantId, messageRow.conversationId), MESSAGING_SOCKET_EVENTS.messageDeleted, deletedPayload);
    const [lastVisible] = await store.listMessages(messageRow.conversationId, { limit: 1 }).catch(() => []);
    if (lastVisible) {
      // Tin cuối còn hiển thị có thể CHÍNH LÀ tin vừa thu hồi: xem
      // trước gửi đi phải qua vô hiệu nội dung như mọi đường đọc.
      const wire = toWireMessage(blankRecalledContent(lastVisible));
      await Promise.all(memberIds.map(async (memberId) => {
        const unreadCount = await store.countUnreadForConversation(messageRow.conversationId, memberId).catch(() => 0);
        const payload: RealtimeConversationUpdatedPayload = {
          conversationId: messageRow.conversationId, message: wire, unreadCount,
        };
        await emitter.emitToRoom(userRoom(tenantId, memberId), MESSAGING_SOCKET_EVENTS.conversationUpdated, payload);
      }));
    }
    await emitConversationInvalidate(tenantId, messageRow.conversationId, memberIds);
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
  async function distributeMessageRemoved(
    snapshot: { conversationId: string; messageId: string; seq: number; removedBy: string },
    memberIds: string[],
  ): Promise<void> {
    if (await suppressIfBlockedDirectPair(snapshot.conversationId, memberIds)) return;
    const tenantId = await tenantIdOfConversation(snapshot.conversationId);
    await evictNonMemberSockets(tenantId, snapshot.conversationId, memberIds);
    const deletedPayload: RealtimeMessageDeletedPayload = {
      conversationId: snapshot.conversationId,
      messageId: snapshot.messageId,
      seq: snapshot.seq,
      deletedBy: snapshot.removedBy,
    };
    await emitter.emitToRoom(conversationRoom(tenantId, snapshot.conversationId), MESSAGING_SOCKET_EVENTS.messageDeleted, deletedPayload);
    const [lastVisible] = await store.listMessages(snapshot.conversationId, { limit: 1 }).catch(() => []);
    if (lastVisible) {
      const wire = toWireMessage(blankRecalledContent(lastVisible));
      await Promise.all(memberIds.map(async (memberId) => {
        const unreadCount = await store.countUnreadForConversation(snapshot.conversationId, memberId).catch(() => 0);
        const payload: RealtimeConversationUpdatedPayload = {
          conversationId: snapshot.conversationId, message: wire, unreadCount,
        };
        await emitter.emitToRoom(userRoom(tenantId, memberId), MESSAGING_SOCKET_EVENTS.conversationUpdated, payload);
      }));
    }
    await emitConversationInvalidate(tenantId, snapshot.conversationId, memberIds);
  }

  /**
   * Phân phối một lần XOÁ-PHÍA-MÌNH (lớp (a)): CHỈ người xoá được
   * biết — phát `message.deleted` + `conversation.invalidate` vào
   * room RIÊNG của chính họ để các thiết bị khác của họ đồng bộ;
   * TUYỆT ĐỐI không phát vào room conversation (phía kia không được
   * nhận bất kỳ tín hiệu nào: với họ cuộc trò chuyện không đổi).
   */
  async function distributeMessageDeletedForMe(snapshot: { conversationId: string; messageId: string; seq: number; actorId: string }): Promise<void> {
    const tenantId = await tenantIdOfConversation(snapshot.conversationId);
    const deletedPayload: RealtimeMessageDeletedPayload = {
      conversationId: snapshot.conversationId,
      messageId: snapshot.messageId,
      seq: snapshot.seq,
      deletedBy: snapshot.actorId,
    };
    await emitter.emitToRoom(userRoom(tenantId, snapshot.actorId), MESSAGING_SOCKET_EVENTS.messageDeleted, deletedPayload);
    const invalidatePayload: RealtimeConversationInvalidatePayload = { conversationId: snapshot.conversationId };
    await emitter.emitToRoom(userRoom(tenantId, snapshot.actorId), MESSAGING_SOCKET_EVENTS.conversationInvalidate, invalidatePayload);
  }

  /** Phân phối biên đã-đọc của một thành viên vào room của conversation. */
  async function distributeReadReceipt(payload: RealtimeMessageReadPayload): Promise<void> {
    // Cùng cổng chặn với distributeNewMessage/distributeMessageDeleted
    // (việc nối tiếp #33, siết sau PR #94 vòng đánh giá lại): biên
    // đã-đọc ghi outbox TRƯỚC khi chặn, consumer tiêu thụ SAU khi chặn,
    // không được lộ trạng thái đã-đọc 1–1 sang phía bị chặn — kể cả khi
    // socket phía đó vẫn nằm trong room (không còn eviction ở hai cổng
    // kia). Hội thoại nhóm không bị chạm.
    // CHỈ chặn phát, KHÔNG đẩy socket khỏi room: lý do như hai cổng
    // kia — socket bị đẩy ra không tự nối lại khi bỏ chặn.
    const conversation = await store.getConversation(payload.conversationId).catch(() => undefined);
    const memberIds = await store.listMembers(payload.conversationId).catch(() => null);
    if (conversation?.type === 1 && memberIds?.length === 2) {
      const other = memberIds.find((id) => id !== payload.userId);
      if (other) {
        // Cổng chặn fail-closed như các đường phân phối còn lại:
        // không tra được danh sách chặn thì nén biên đã-đọc này.
        const blocked = await blockedCounterpartIdsFailClosed(payload.userId);
        if (blocked === null || blocked.includes(other)) {
          return;
        }
      }
    }
    // Cùng kỷ luật F1: rà soát room theo membership hiện tại trước
    // khi phát — thành viên đã bị gỡ không nhận biên đã-đọc nữa. Đọc
    // membership lỗi thì vẫn phát như cũ (realtime là đường phụ).
    const tenantId = conversation?.tenantId ?? null;
    if (memberIds) await evictNonMemberSockets(tenantId, payload.conversationId, memberIds);
    await emitter.emitToRoom(conversationRoom(tenantId, payload.conversationId), MESSAGING_SOCKET_EVENTS.messageRead, payload);
  }

  /** Phân phối một sự kiện outbox đã commit. Payload hỏng/thiếu thì bỏ qua (consumer coi là đã xử lý). */
  async function distributeEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    if (type === 'message_sent') {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
      if (!messageId) return;
      const message = await store.getMessage(messageId);
      // Tin đã biến mất (conversation bị xoá cascade sau khi sự kiện
      // ghi) thì không còn gì để phân phối.
      if (!message) return;
      // Membership chốt TẠI THỜI ĐIỂM PHÂN PHỐI, đọc thẳng từ DB —
      // không dùng ảnh chụp lúc gửi trong payload: thành viên bị gỡ
      // khỏi conversation trong khoảng giữa hai thời điểm không còn
      // nhận conversation.updated, và danh sách này là căn cứ rà soát
      // room khi phát message.new (F1).
      const memberIds = await store.listMembers(message.conversationId);
      // Tin đã bị THU HỒI trước khi sự kiện gửi được phân phối (gửi
      // rồi thu hồi ngay trong cùng nhịp quét): phân phối như một lần
      // thu hồi — phát bản tin mới ở đây sẽ lộ nội dung vừa bị vô hiệu.
      if (message.recalledAt) {
        await distributeMessageRecalled(message, memberIds);
        return;
      }
      await distributeNewMessage(message, memberIds);
      return;
    }
    if (type === 'message_conversation_read') {
      const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null;
      const userId = typeof payload.userId === 'string' ? payload.userId : null;
      const lastReadSeq = typeof payload.lastReadSeq === 'number' ? payload.lastReadSeq : null;
      if (!conversationId || !userId || lastReadSeq === null) return;
      await distributeReadReceipt({ conversationId, userId, lastReadSeq });
      return;
    }
    if (type === 'message_deleted') {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
      if (!messageId) return;
      // Tin xoá mềm vẫn còn dòng trong DB (chỉ bị đánh dấu) — đọc lại
      // để lấy dấu vết mới nhất, rồi phân phối theo membership HIỆN TẠI
      // như mọi sự kiện khác (kỷ luật F1).
      const message = await store.getMessage(messageId);
      if (!message || !message.deletedAt) return;
      const memberIds = await store.listMembers(message.conversationId);
      await distributeMessageDeleted(message, memberIds);
      return;
    }
    if (type === 'message_recalled') {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
      if (!messageId) return;
      // Tin thu hồi vẫn còn dòng (nội dung chỉ bị vô hiệu ở đường
      // đọc) — đọc lại dấu thu hồi mới nhất rồi phân phối; nếu dấu đã
      // mất (dòng bị xoá cứng chen giữa) thì sự kiện gỡ cứng đi sau
      // sẽ lo phần còn lại.
      const message = await store.getMessage(messageId);
      if (!message || !message.recalledAt) return;
      const memberIds = await store.listMembers(message.conversationId);
      await distributeMessageRecalled(message, memberIds);
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
      const memberIds = await store.listMembers(conversationId);
      await distributeMessageRemoved({ conversationId, messageId, seq, removedBy }, memberIds);
      return;
    }
    if (type === 'message_deleted_for_me') {
      // Xoá-phía-mình: phân phối CHỈ tới chính người xoá (tầng phân
      // phối tự giới hạn ở room riêng của họ) — membership không liên quan.
      const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null;
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
      const seq = typeof payload.seq === 'number' ? payload.seq : null;
      const actorId = typeof payload.actorId === 'string' ? payload.actorId : null;
      if (!conversationId || !messageId || seq === null || !actorId) return;
      await distributeMessageDeletedForMe({ conversationId, messageId, seq, actorId });
    }
  }

  return {
    distributeEvent,
    distributeNewMessage,
    distributeMessageDeleted,
    distributeMessageRecalled,
    distributeMessageRemoved,
    distributeMessageDeletedForMe,
    distributeReadReceipt,
  };
}
