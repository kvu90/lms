import { io, type Socket } from 'socket.io-client';
import {
  MESSAGING_SOCKET_EVENTS,
  type MessagingSyncRequest,
  type MessagingSyncResult,
  type RealtimeConversationInvalidatePayload,
  type RealtimeConversationUpdatedPayload,
  type RealtimeMessageDeletedPayload,
  type RealtimeMessageReadPayload,
  type RealtimeNewMessagePayload,
  type RealtimePresencePayload,
  type RealtimePresenceSnapshotPayload,
  type RealtimeTypingPayload,
} from '@lms/contracts';

/**
 * Kênh realtime của tin nhắn (issue #33, chặng A1): Socket.IO namespace
 * `/messaging`. Đây là điểm chạm duy nhất của web với socket — trang
 * tin nhắn chỉ biết interface handlers/handle dưới đây.
 *
 * Xác thực hai đường (GĐ5 của issue #7): phía client gửi cookie
 * phiên Better Auth cùng nguồn nhờ `withCredentials` — server ưu
 * tiên phiên cookie như chuỗi guard HTTP. Đường dự phòng còn lại
 * là access token ở phía server (gateway vẫn chấp nhận token từ
 * handshake cho client chưa chạy cookie, cho tới cutover); phía web
 * từ GĐ2 (#257) không còn tokenStore/access token nên không gửi
 * token nữa — không dựng lại đường token ở client.
 *
 * Sự kiện nghiệp vụ (tin mới/đã đọc) đến từ server qua đường outbox →
 * consumer phân phối — client chỉ việc áp vào state, chống trùng bằng
 * id/clientMessageId/seq. Mất nối: Socket.IO tự nối lại, và mỗi lần
 * nối lại (trừ lần đầu) `onReconnect` được gọi để trang đồng bộ phần
 * thiếu theo seq (xem `sync`).
 */
export interface MessagingRealtimeHandlers {
  onNewMessage(payload: RealtimeNewMessagePayload): void;
  onConversationUpdated(payload: RealtimeConversationUpdatedPayload): void;
  onReadReceipt(payload: RealtimeMessageReadPayload): void;
  /** Một tin bị xoá mềm (Lớp B): payload không kèm nội dung — trang gỡ/đánh dấu tin theo tầm nhìn của user. */
  onMessageDeleted(payload: RealtimeMessageDeletedPayload): void;
  /**
   * Cache danh sách conversation đã cũ sau một thao tác vòng đời
   * (thu hồi/xoá cứng/xoá-phía-mình, issue #33): trang PHẢI tải lại
   * danh sách và, nếu conversation đó đang mở, tải lại cả cửa sổ tin
   * (tin bị thu hồi hiện dòng đã thu hồi, tin bị xoá cứng biến mất).
   */
  onConversationInvalidate(payload: RealtimeConversationInvalidatePayload): void;
  onTyping(payload: RealtimeTypingPayload): void;
  onPresence(payload: RealtimePresencePayload): void;
  /**
   * Ảnh chụp presence lúc nối: server phát cho chính socket vừa nối
   * danh sách người đang trực tuyến trong quan hệ hội thoại chung —
   * lấp khoảng trống của onPresence (chỉ phát khi trạng thái thay
   * đổi, nên người trực tuyến từ trước lúc mở trang không có sự kiện).
   */
  onPresenceSnapshot(payload: RealtimePresenceSnapshotPayload): void;
  /** Gọi mỗi lần nối lại thành công sau rớt mạng (không gọi ở lần nối đầu tiên). */
  onReconnect(): void;
}

export interface MessagingRealtimeHandle {
  /** Xin các tin còn thiếu theo mốc seq của từng conversation; kết quả qua promise ack. */
  sync(lastSeqByConversation: MessagingSyncRequest): Promise<MessagingSyncResult>;
  /** Xin vào room của một conversation mới (server kiểm tra tư cách thành viên). */
  joinConversation(conversationId: string): void;
  /** Phát tín hiệu đang nhập (server đã throttle theo cửa sổ 4 giây). */
  typing(conversationId: string): void;
  disconnect(): void;
}

/** Mở kết nối realtime cho trang tin nhắn; trả handle điều khiển + đăng ký handlers. */
export function connectMessagingRealtime(handlers: MessagingRealtimeHandlers): MessagingRealtimeHandle {
  const socket: Socket = io('/messaging', {
    withCredentials: true,
    transports: ['websocket', 'polling'],
  });
  let connectedOnce = false;
  socket.on('connect', () => {
    if (connectedOnce) handlers.onReconnect();
    connectedOnce = true;
  });
  socket.on(MESSAGING_SOCKET_EVENTS.newMessage, (payload: RealtimeNewMessagePayload) => handlers.onNewMessage(payload));
  socket.on(MESSAGING_SOCKET_EVENTS.conversationUpdated, (payload: RealtimeConversationUpdatedPayload) => handlers.onConversationUpdated(payload));
  socket.on(MESSAGING_SOCKET_EVENTS.messageRead, (payload: RealtimeMessageReadPayload) => handlers.onReadReceipt(payload));
  socket.on(MESSAGING_SOCKET_EVENTS.messageDeleted, (payload: RealtimeMessageDeletedPayload) => handlers.onMessageDeleted(payload));
  socket.on(MESSAGING_SOCKET_EVENTS.conversationInvalidate, (payload: RealtimeConversationInvalidatePayload) => handlers.onConversationInvalidate(payload));
  socket.on(MESSAGING_SOCKET_EVENTS.typing, (payload: RealtimeTypingPayload) => handlers.onTyping(payload));
  socket.on(MESSAGING_SOCKET_EVENTS.presenceChanged, (payload: RealtimePresencePayload) => handlers.onPresence(payload));
  socket.on(MESSAGING_SOCKET_EVENTS.presenceSnapshot, (payload: RealtimePresenceSnapshotPayload) => handlers.onPresenceSnapshot(payload));

  return {
    async sync(lastSeqByConversation: MessagingSyncRequest): Promise<MessagingSyncResult> {
      if (!socket.connected) return {};
      try {
        return (await socket.emitWithAck(MESSAGING_SOCKET_EVENTS.sync, lastSeqByConversation)) as MessagingSyncResult;
      } catch {
        return {};
      }
    },
    joinConversation(conversationId: string): void {
      if (socket.connected) void socket.emitWithAck(MESSAGING_SOCKET_EVENTS.joinConversation, { conversationId }).catch(() => undefined);
    },
    typing(conversationId: string): void {
      if (socket.connected) void socket.emitWithAck(MESSAGING_SOCKET_EVENTS.typing, { conversationId }).catch(() => undefined);
    },
    disconnect(): void {
      socket.disconnect();
    },
  };
}
