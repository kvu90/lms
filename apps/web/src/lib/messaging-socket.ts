import { io, type Socket } from 'socket.io-client';
import {
  MESSAGING_SOCKET_EVENTS,
  type MessagingSyncRequest,
  type MessagingSyncResult,
  type RealtimeConversationUpdatedPayload,
  type RealtimeMessageDeletedPayload,
  type RealtimeMessageReadPayload,
  type RealtimeNewMessagePayload,
  type RealtimePresencePayload,
  type RealtimeTypingPayload,
} from '@lms/contracts';
import { tokenStore } from './api';

/**
 * Kênh realtime của tin nhắn (issue #33, chặng A1): Socket.IO namespace
 * `/messaging`. Đây là điểm chạm duy nhất của web với socket — trang
 * tin nhắn chỉ biết interface handlers/handle dưới đây.
 *
 * Xác thực bằng access token đăng nhập hiện tại: `auth` dạng callback
 * nên mỗi lần (tự) nối lại đều lấy token mới nhất từ tokenStore (sau
 * refresh token không bị kẹt token cũ). Server ngắt ngay kết nối
 * không xác thực được.
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
  onTyping(payload: RealtimeTypingPayload): void;
  onPresence(payload: RealtimePresencePayload): void;
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
    auth: (callback) => callback({ token: tokenStore.access ?? '' }),
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
  socket.on(MESSAGING_SOCKET_EVENTS.typing, (payload: RealtimeTypingPayload) => handlers.onTyping(payload));
  socket.on(MESSAGING_SOCKET_EVENTS.presenceChanged, (payload: RealtimePresencePayload) => handlers.onPresence(payload));

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
