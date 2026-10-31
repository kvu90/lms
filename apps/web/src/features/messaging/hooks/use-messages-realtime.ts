/**
 * Hook điều phối kênh realtime của trang Tin nhắn (đợt C của issue
 * #223, lát 2; chuyển sang cache TanStack ở CN-13, issue #493): nối
 * socket một lần khi trang mở, đăng ký các handler tin mới, tin bị
 * xoá, thu hồi, đang gõ, hiện diện và nối lại, rồi ngắt khi trang
 * đóng. Mọi sự kiện mang dữ kiện máy chủ đều VÁ VÀO CACHE TanStack
 * (gộp tin vào cache chi tiết, áp sự kiện lên cache danh sách/cây
 * nhóm qua các bộ chuyển đổi của hook danh sách, áp mốc đọc lên
 * cache chi tiết, invalidate cửa sổ khi server báo dữ kiện đã đổi
 * căn bản) — không còn state bản chép nào để đồng bộ tay. Giữ
 * nguyên kỷ luật: handlers đọc state mới nhất qua ref nên không
 * phải nối lại khi state đổi; sự kiện mang seq cũ hơn seq đã áp
 * thì bỏ qua để huy hiệu và tin cuối không nhảy lùi; danh sách tự
 * sắp xếp lại theo hoạt động mới nhất như thứ tự server trả.
 *
 * @param params - `myId` để phân biệt tin của mình; `markRead`,
 * `recountUnread`, `reload` từ hook danh sách; `activeRef` và
 * `lastSeqRef` để đọc trạng thái mới nhất và mốc seq; các bộ
 * chuyển đổi ghi cache của hook danh sách và các thao tác vá cache
 * của hook hội thoại đang mở để áp sự kiện; `realtimeRef` để trang
 * giữ handle socket (mở conversation tham gia kênh, composer phát
 * tín hiệu đang nhập).
 */
import { useEffect, useRef } from 'react';
import { connectMessagingRealtime, type MessagingRealtimeHandle } from '../api/messaging-socket';
import { withTreeUnread } from '../utils/page-helpers';
import type { ConversationGroupTreeView, ConversationView, MessageView } from '../types/types';

export interface UseMessagesRealtimeParams {
  /** Id người xem hiện tại. */
  myId: string | undefined;
  /** Đánh dấu đã đọc ở server (từ hook danh sách). */
  markRead: (conversationId: string) => Promise<void>;
  /** Làm mới huy hiệu số chưa đọc của sidebar (từ hook danh sách). */
  recountUnread: () => void;
  /** Nạp lại danh sách (từ hook danh sách). */
  reload: () => Promise<void>;
  /** Ref conversation đang mở — handlers đọc mới nhất qua ref. */
  activeRef: { current: ConversationView | null };
  /** Mốc seq cao nhất đã thấy của từng conversation — trang sở hữu chung. */
  lastSeqRef: { current: Map<string, number> };
  /** Gộp tin phía server vào cache chi tiết của đúng conversation. */
  mergeServerMessages: (conversationId: string, messages: MessageView[]) => void;
  /** Áp một phép biến đổi lên mọi đoạn cửa sổ tin của một conversation trong cache. */
  patchMessages: (conversationId: string, updater: (messages: MessageView[]) => MessageView[]) => void;
  /** Áp một mốc đọc lên cache chi tiết (giữ mốc lớn nhất). */
  applyReadMarker: (conversationId: string, userId: string, lastReadSeq: number) => void;
  /** Vô hiệu hoá toàn bộ cửa sổ của một conversation trong cache. */
  invalidateConversationWindow: (conversationId: string) => void;
  /** Ghi danh sách conversation (bộ chuyển đổi ghi cache của hook danh sách). */
  setConversations: (conversations: ConversationView[] | ((prev: ConversationView[]) => ConversationView[])) => void;
  /** Ghi cây nhóm vào cache (áp số chưa đọc mới). */
  setGroupTree: (
    tree:
      ConversationGroupTreeView | null | ((prev: ConversationGroupTreeView | null) => ConversationGroupTreeView | null),
  ) => void;
  /** Ghi trạng thái đang gõ theo từng user. */
  setTypingUsers: (
    users: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>),
  ) => void;
  /** Ghi trạng thái hiện diện theo từng user. */
  setOnlineUsers: (
    users: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>),
  ) => void;
  /** Handle socket realtime — trang sở hữu chung, hook này gán vào khi nối. */
  realtimeRef: { current: MessagingRealtimeHandle | null };
  /**
   * Tạm ngắt realtime theo lựa chọn hiện diện "ngoại tuyến" của
   * chính người xem (giai đoạn 2 của vòng sửa PR #610): true thì
   * hiệu ứng KHÔNG nối socket — cleanup của lượt trước đã ngắt
   * socket cũ nên server gỡ presence và phát trạng thái ngoại
   * tuyến thật cho người xem ở mọi bề mặt. Vắng mặt (undefined)
   * nghĩa là nối bình thường.
   */
  suspendRealtime?: boolean;
}

export function useMessagesRealtime({
  myId,
  markRead,
  recountUnread,
  reload,
  activeRef,
  lastSeqRef,
  mergeServerMessages,
  patchMessages,
  applyReadMarker,
  invalidateConversationWindow,
  setConversations,
  setGroupTree,
  setTypingUsers,
  setOnlineUsers,
  realtimeRef,
  suspendRealtime,
}: UseMessagesRealtimeParams) {
  const typingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Tập user đã có sự kiện hiện diện trực tiếp kể từ ảnh chụp
  // presence gần nhất (hoặc từ lúc trang mở nếu chưa có ảnh chụp
  // nào) — căn cứ phân xử thứ tự giữa ảnh chụp và sự kiện trực
  // tiếp (xem handler onPresenceSnapshot): ảnh chụp chỉ được áp
  // cho user NGOÀI tập này. Tập được xoá mỗi khi một ảnh chụp
  // được áp (ảnh chụp đó đã "tiêu thụ" cửa sổ phân xử của nó) và
  // mỗi khi nối lại (chu kỳ nối mới sinh ảnh chụp mới, phản ánh
  // thời điểm nối mới — mới hơn mọi sự kiện của chu kỳ trước).
  // Tập KHÔNG được xoá khi hiệu ứng nối chạy lại: hiệu ứng chạy
  // lại theo nhịp render của trang, không đồng nghĩa với cửa sổ
  // ảnh chụp mới.
  const presenceLiveUsersRef = useRef<Set<string>>(new Set());

  // Kênh realtime: nối một lần khi trang mở; handlers đọc state mới
  // nhất qua ref nên không phải nối lại khi state đổi. Người xem
  // chọn hiện diện "ngoại tuyến" thì không nối (và lượt nối trước
  // đã bị cleanup ngắt) — presence thật tắt đúng nghĩa của lựa chọn.
  useEffect(() => {
    if (!myId || suspendRealtime) return;
    const noteSeq = (conversationId: string, seq: number) => {
      const seen = lastSeqRef.current.get(conversationId) ?? 0;
      if (seq > seen) lastSeqRef.current.set(conversationId, seq);
    };
    const handle = connectMessagingRealtime({
      onNewMessage: ({ conversationId, message }) => {
        noteSeq(conversationId, message.seq);
        // Gộp tin vào cache chi tiết của ĐÚNG conversation đó dù nó
        // có đang mở hay không: chi tiết của conversation không hoạt
        // động vẫn nằm trong cache và còn bị coi là tươi trong cửa
        // sổ staleTime khi mở lại — không vá tại đây thì mở lại
        // trong cửa sổ đó hiện bản cũ thiếu tin mới (vòng sửa PR
        // #530). Conversation chưa từng nạp chi tiết thì phép gộp
        // tự bỏ qua (chưa có bản cũ trong cache để vá); lần mở đầu
        // tiên tự nạp bản tươi từ server.
        mergeServerMessages(conversationId, [message]);
        if (activeRef.current?.id === conversationId) {
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
          if (!target) return prev;
          // Danh sách tự sắp xếp lại theo hoạt động mới nhất (lát M1,
          // issue #204): conversation vừa có tin mới được đưa lên đầu
          // — cùng thứ tự server trả khi tải lại (updated_at giảm
          // dần) nên realtime và reload không bao giờ lệch nhau.
          return [
            {
              ...target,
              unread: activeRef.current?.id === conversationId ? 0 : unreadCount,
              lastMessage: message,
              lastMessageSeq: message.seq,
            },
            ...prev.filter((c) => c.id !== conversationId),
          ];
        });
        recountUnread();
        // Cây nhóm cũng nhận số chưa đọc mới của conversation này để
        // huy hiệu trên các nút của tab Nhóm khớp ngay (lát MSG-T3).
        setGroupTree((prev) =>
          withTreeUnread(prev, conversationId, activeRef.current?.id === conversationId ? 0 : unreadCount),
        );
      },
      onMessageDeleted: ({ conversationId, messageId, deletedBy }) => {
        // Xoá mềm (Lớp B): vá dấu đã xoá vào cache chi tiết của ĐÚNG
        // conversation đó dù nó có đang mở hay không. Phân phối xoá
        // mềm phía server chỉ phát sự kiện này kèm
        // conversation.updated, KHÔNG phát conversation.invalidate
        // như các đường thu hồi/xoá cứng — nên sự kiện này là đường
        // duy nhất đưa dấu deletedAt vào cache chi tiết; thoát sớm
        // khi conversation không mở thì mở lại trong cửa sổ staleTime
        // vẫn hiện nguyên nội dung trước người xem không có quyền
        // kiểm duyệt (vòng sửa 2 PR #530 — cùng họ cơ chế với điểm
        // tin lỡ của vòng sửa 1). patchMessages tự bỏ qua an toàn khi
        // chi tiết chưa từng được nạp. Sau khi vá: phía học sinh
        // không còn thấy tin (lọc ở bước render), phía có thẩm quyền
        // kiểm duyệt thấy dấu vết ai đã xoá. Payload không kèm nội
        // dung nên không có đường nào nội dung bị lộ lại qua realtime.
        patchMessages(conversationId, (prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, deletedAt: new Date().toISOString(), deletedBy } : m)),
        );
      },
      onConversationInvalidate: ({ conversationId }) => {
        // Vòng đời tin nhắn theo vai (issue #33): thu hồi phát
        // message.deleted trước, invalidate sau — chỉ dữ kiện nạp
        // lại mới phân biệt được "đã thu hồi" (recalledAt, nội dung
        // rỗng) với "đã xoá", và tin bị xoá cứng mới biến mất khỏi
        // khung: vô hiệu hoá toàn bộ cửa sổ trong cache (chi tiết +
        // các trang + tìm kiếm) để các đăng ký đang mở tự nạp lại.
        // Danh sách luôn nạp lại vì tin cuối/số chưa đọc đã đổi.
        if (activeRef.current?.id === conversationId) {
          invalidateConversationWindow(conversationId);
        }
        void reload().catch(() => undefined);
      },
      onReadReceipt: ({ conversationId, userId, lastReadSeq }) => {
        if (activeRef.current?.id === conversationId) {
          applyReadMarker(conversationId, userId, lastReadSeq);
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
        // Ghi dấu user này đã có sự kiện trực tiếp kể từ ảnh chụp
        // gần nhất: từ đây trạng thái của họ do sự kiện trực tiếp
        // quyết định, ảnh chụp đang trên đường không được chạm
        // vào nữa.
        presenceLiveUsersRef.current.add(userId);
        setOnlineUsers((prev) => ({ ...prev, [userId]: online }));
      },
      onPresenceSnapshot: ({ onlineUserIds }) => {
        // Ảnh chụp chỉ liệt kê người ĐANG trực tuyến và phản ánh
        // thời điểm máy chủ đọc Redis lúc socket nối, còn sự kiện
        // trực tiếp đi theo đường riêng — hai nguồn không có thứ tự
        // chung: một sự kiện trực tiếp được xử lý TRƯỚC khi ảnh
        // chụp tới vẫn có thể mới hơn ảnh chụp (người kia ngắt nối
        // ngay sau lúc máy chủ đọc). Vì vậy ảnh chụp chỉ áp cho
        // user CHƯA có sự kiện trực tiếp nào kể từ ảnh chụp gần
        // nhất; user đã có sự kiện trực tiếp thì trạng thái của sự
        // kiện đó là quyết định cuối ở cả hai chiều và ảnh chụp
        // không ghi đè được. User chưa biết trạng thái nào vẫn được
        // ảnh chụp bổ sung bình thường; ảnh chụp không bao giờ xoá
        // trạng thái đã biết. Áp xong thì xoá tập dấu: cửa sổ phân
        // xử của chính ảnh chụp này đã đóng, các sự kiện trực tiếp
        // từ đây thuộc về cửa sổ của ảnh chụp kế tiếp.
        const liveUsers = presenceLiveUsersRef.current;
        presenceLiveUsersRef.current = new Set();
        if (!onlineUserIds.length) return;
        setOnlineUsers((prev) => {
          const next = { ...prev };
          for (const userId of onlineUserIds) {
            if (liveUsers.has(userId)) continue;
            next[userId] = true;
          }
          return next;
        });
      },
      onReconnect: () => {
        // Chu kỳ nối mới sinh ảnh chụp mới phản ánh thời điểm nối
        // mới: xoá dấu sự kiện trực tiếp của chu kỳ trước để ảnh
        // chụp sắp tới được toàn quyền bổ sung.
        presenceLiveUsersRef.current = new Set();
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
              mergeServerMessages(current.id, missed);
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
  }, [
    myId,
    markRead,
    recountUnread,
    reload,
    mergeServerMessages,
    patchMessages,
    applyReadMarker,
    invalidateConversationWindow,
    setConversations,
    setGroupTree,
    setTypingUsers,
    setOnlineUsers,
    activeRef,
    lastSeqRef,
    realtimeRef,
    suspendRealtime,
  ]);
}
