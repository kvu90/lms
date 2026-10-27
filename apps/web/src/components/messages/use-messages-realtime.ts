/**
 * Hook điều phối kênh realtime của trang Tin nhắn (đợt C của issue
 * #223, lát 2): nối socket một lần khi trang mở, đăng ký các handler
 * tin mới, tin bị xoá, thu hồi, đang gõ, hiện diện và nối lại, rồi
 * ngắt khi trang đóng. Di chuyển từ `pages/messages.tsx` (hiệu ứng
 * dòng 743–866), giữ nguyên kỷ luật: handlers đọc state mới nhất qua
 * ref nên không phải nối lại khi state đổi; sự kiện mang seq cũ hơn
 * seq đã áp thì bỏ qua để huy hiệu và tin cuối không nhảy lùi; danh
 * sách tự sắp xếp lại theo hoạt động mới nhất như thứ tự server trả.
 *
 * @param params - `myId` để phân biệt tin của mình; `markRead`,
 * `recountUnread`, `reload` từ hook danh sách; `activeRef` và
 * `lastSeqRef` để đọc trạng thái mới nhất và mốc seq; các setter của
 * hook danh sách và hook hội thoại đang mở để áp sự kiện;
 * `realtimeRef` để trang giữ handle socket (mở conversation tham
 * gia kênh, composer phát tín hiệu đang nhập).
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { conversationDetailQueryOptions } from '#lib/messaging-data';
import { connectMessagingRealtime, type MessagingRealtimeHandle } from '#lib/messaging-socket';
import { withTreeUnread } from './page-helpers';
import { mergeMessages } from './utils';
import type { ConversationGroupTreeView, ConversationView, MessageView } from './types';

export interface UseMessagesRealtimeParams {
  /** Id người xem hiện tại. */
  myId: string | undefined;
  /** Đánh dấu đã đọc ở server (từ hook danh sách). */
  markRead: (conversationId: string) => Promise<void>;
  /** Đếm lại số chưa đọc (từ hook danh sách). */
  recountUnread: (list: ConversationView[]) => void;
  /** Nạp lại danh sách (từ hook danh sách). */
  reload: () => Promise<void>;
  /** Ref conversation đang mở — handlers đọc mới nhất qua ref. */
  activeRef: { current: ConversationView | null };
  /** Mốc seq cao nhất đã thấy của từng conversation — trang sở hữu chung. */
  lastSeqRef: { current: Map<string, number> };
  /** Ghi cửa sổ tin của conversation đang mở. */
  setMessages: (messages: MessageView[] | ((prev: MessageView[]) => MessageView[])) => void;
  /** Ghi danh sách conversation. */
  setConversations: (conversations: ConversationView[] | ((prev: ConversationView[]) => ConversationView[])) => void;
  /** Ghi cây nhóm (áp số chưa đọc mới). */
  setGroupTree: (
    tree:
      ConversationGroupTreeView | null | ((prev: ConversationGroupTreeView | null) => ConversationGroupTreeView | null),
  ) => void;
  /** Ghi mốc đọc theo từng thành viên. */
  setReadMarkers: (
    markers: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>),
  ) => void;
  /** Ghi trạng thái đang gõ theo từng user. */
  setTypingUsers: (
    users: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>),
  ) => void;
  /** Ghi trạng thái hiện diện theo từng user. */
  setOnlineUsers: (
    users: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>),
  ) => void;
  /** Ghi cờ còn tin cũ hơn phía trước. */
  setHasMoreBefore: (value: boolean) => void;
  /** Handle socket realtime — trang sở hữu chung, hook này gán vào khi nối. */
  realtimeRef: { current: MessagingRealtimeHandle | null };
}

export function useMessagesRealtime({
  myId,
  markRead,
  recountUnread,
  reload,
  activeRef,
  lastSeqRef,
  setMessages,
  setConversations,
  setGroupTree,
  setReadMarkers,
  setTypingUsers,
  setOnlineUsers,
  setHasMoreBefore,
  realtimeRef,
}: UseMessagesRealtimeParams) {
  const queryClient = useQueryClient();
  const typingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Kênh realtime: nối một lần khi trang mở; handlers đọc state mới
  // nhất qua ref nên không phải nối lại khi state đổi.
  useEffect(() => {
    if (!myId) return;
    const noteSeq = (conversationId: string, seq: number) => {
      const seen = lastSeqRef.current.get(conversationId) ?? 0;
      if (seq > seen) lastSeqRef.current.set(conversationId, seq);
    };
    const handle = connectMessagingRealtime({
      onNewMessage: ({ conversationId, message }) => {
        noteSeq(conversationId, message.seq);
        if (activeRef.current?.id === conversationId) {
          setMessages((prev) => mergeMessages(prev, [message]));
          // Đang mở cuộc trò chuyện thì tin của người khác được đọc ngay.
          if (message.userIdFrom !== myId) void markRead(conversationId);
        }
      },
      onConversationUpdated: ({ conversationId, message, unreadCount }) => {
        // Sự kiện mang seq CŨ hơn seq đã áp cho conversation này (một
        // sự kiện outbox trước bị consumer phân phối muộn hơn sự kiện
        // sau): bỏ qua để huy hiệu chưa đọc và tin cuối không nhảy lùi
        // theo số của thời điểm cũ — số đúng luôn có qua REST (quan sát
        // nhẹ của review Lớp A). Sự kiện trùng seq là phân phối lại của
        // cùng một sự kiện, vẫn áp như thường và vô hại.
        if (message.seq < (lastSeqRef.current.get(conversationId) ?? 0)) return;
        noteSeq(conversationId, message.seq);
        setConversations((prev) => {
          const target = prev.find((c) => c.id === conversationId);
          if (!target) {
            recountUnread(prev);
            return prev;
          }
          // Danh sách tự sắp xếp lại theo hoạt động mới nhất (lát M1,
          // issue #204): conversation vừa có tin mới được đưa lên đầu
          // — cùng thứ tự server trả khi tải lại (updated_at giảm
          // dần) nên realtime và reload không bao giờ lệch nhau.
          const next = [
            {
              ...target,
              unread: activeRef.current?.id === conversationId ? 0 : unreadCount,
              lastMessage: message,
              lastMessageSeq: message.seq,
            },
            ...prev.filter((c) => c.id !== conversationId),
          ];
          recountUnread(next);
          return next;
        });
        // Cây nhóm cũng nhận số chưa đọc mới của conversation này để
        // huy hiệu trên các nút của tab Nhóm khớp ngay (lát MSG-T3).
        setGroupTree((prev) =>
          withTreeUnread(prev, conversationId, activeRef.current?.id === conversationId ? 0 : unreadCount),
        );
      },
      onMessageDeleted: ({ conversationId, messageId, deletedBy }) => {
        if (activeRef.current?.id !== conversationId) return;
        // Xoá mềm (Lớp B): đánh dấu ngay trong khung — phía học sinh
        // không còn thấy tin (lọc ở bước render), phía có thẩm quyền
        // kiểm duyệt thấy dấu vết ai đã xoá. Payload không kèm nội
        // dung nên không có đường nào nội dung bị lộ lại qua realtime.
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, deletedAt: new Date().toISOString(), deletedBy } : m)),
        );
      },
      onConversationInvalidate: ({ conversationId }) => {
        // Vòng đời tin nhắn theo vai (issue #33): thu hồi phát
        // message.deleted trước, invalidate sau — chỉ tải lại cửa sổ
        // tin mới phân biệt được "đã thu hồi" (recalledAt, nội dung
        // rỗng) với "đã xoá", và tin bị xoá cứng mới biến mất khỏi
        // khung. Danh sách luôn tải lại vì tin cuối/số chưa đọc đã đổi.
        if (activeRef.current?.id === conversationId) {
          void (async () => {
            try {
              const detail = await queryClient.fetchQuery(conversationDetailQueryOptions(conversationId));
              setMessages(detail.messages);
              setHasMoreBefore(detail.hasMoreBefore ?? false);
              const markers: Record<string, number> = {};
              for (const marker of detail.memberReadMarkers ?? []) markers[marker.userId] = marker.lastReadSeq;
              setReadMarkers(markers);
            } catch {
              // Giữ khung cũ; lần tải lại sau sẽ đồng bộ.
            }
          })();
        }
        void reload().catch(() => undefined);
      },
      onReadReceipt: ({ conversationId, userId, lastReadSeq }) => {
        if (activeRef.current?.id === conversationId) {
          setReadMarkers((prev) => ({ ...prev, [userId]: Math.max(prev[userId] ?? 0, lastReadSeq) }));
        }
      },
      onTyping: ({ conversationId, userId }) => {
        if (activeRef.current?.id !== conversationId || userId === myId) return;
        setTypingUsers((prev) => ({ ...prev, [userId]: true }));
        const timeouts = typingTimeoutsRef.current;
        const existing = timeouts.get(userId);
        if (existing) clearTimeout(existing);
        timeouts.set(
          userId,
          setTimeout(() => {
            setTypingUsers((prev) => {
              const next = { ...prev };
              delete next[userId];
              return next;
            });
          }, 4500),
        );
      },
      onPresence: ({ userId, online }) => {
        setOnlineUsers((prev) => ({ ...prev, [userId]: online }));
      },
      onReconnect: () => {
        // Nối lại: danh sách lấy tươi bằng REST (truy vấn tổng hợp đã
        // rẻ), conversation đang mở xin đúng phần thiếu theo seq.
        void reload().catch(() => undefined);
        const current = activeRef.current;
        if (current) {
          const lastSeq = lastSeqRef.current.get(current.id) ?? 0;
          void handle.sync({ [current.id]: lastSeq }).then((missing) => {
            const missed = missing[current.id];
            if (missed && missed.length) {
              for (const m of missed) noteSeq(current.id, m.seq);
              setMessages((prev) => mergeMessages(prev, missed));
            }
          });
        }
      },
    });
    realtimeRef.current = handle;
    return () => {
      handle.disconnect();
      realtimeRef.current = null;
      for (const timeout of typingTimeoutsRef.current.values()) clearTimeout(timeout);
      typingTimeoutsRef.current.clear();
    };
  }, [myId, markRead, recountUnread, reload]);
}
