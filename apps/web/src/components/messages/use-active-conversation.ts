/**
 * Hook điều phối hội thoại đang mở của trang Tin nhắn (đợt C của
 * issue #223, lát 2; chuyển sang cache TanStack ở CN-13, issue
 * #493): cửa sổ tin của hội thoại đang mở SUY RA từ cache — cửa sổ
 * gần nhất là trường `messages` của cache chi tiết, các cửa sổ cũ
 * hơn/jump là các cache trang theo mốc seq đã nạp, cộng tin lạc
 * quan của chính client giữ ở state theo từng conversation (dữ
 * kiện chỉ-client, không có bản phía server để đồng bộ). Mốc đọc
 * suy ra từ `memberReadMarkers` của cache chi tiết. Hook phơi các
 * thao tác vá cache (`mergeServerMessages`, `patchMessages`,
 * `applyReadMarker`, `invalidateConversationWindow`) cho các hook
 * tiêu thụ (soạn tin, realtime, kiểm duyệt, tìm kiếm) thay cho các
 * setter state trước đây. State cục bộ chỉ còn: id hội thoại đang
 * mở + bản tóm tắt được truyền vào lúc mở (mồi hiển thị đầu tiên,
 * bị chi tiết trong cache thay thế ngay khi có), tập mốc seq các
 * trang đã nạp (tiến độ nạp, không phải dữ kiện), tin lạc quan và
 * trạng thái đang gõ/hiện diện (dữ kiện phù du của socket).
 * Chi tiết mang theo enabled + thẩm quyền của chính user được gộp
 * vào conversation đang mở để header/khung soạn biết đường hiển
 * thị; tin mới nhất đặt mốc seq cho lần đồng bộ nối lại.
 *
 * @param params - `mergePeople` gom tên hiển thị từ chi tiết;
 * `markRead` đánh dấu đã đọc sau khi mở; `myId` phục vụ giá trị
 * suy ra "đã xem"; `lastSeqRef` là mốc seq dùng chung do trang sở
 * hữu; `realtimeRef` để báo socket tham gia conversation vừa mở.
 * @returns Trạng thái hội thoại đang mở và handler cho trang lắp ghép.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { conversationDetailQueryOptions, conversationMessagesPageQueryOptions } from '#lib/messaging-data';
import { queryKeys } from '#lib/query-keys';
import type { MessagingRealtimeHandle } from '#lib/messaging-socket';
import { storeConversationId } from './page-helpers';
import { mergeMessages } from './utils';
import type { ConversationDetailView, ConversationView, MessageView, PersonSummary } from './types';

export interface UseActiveConversationParams {
  /** Gom tên hiển thị từ chi tiết conversation vào bản đồ tên chung. */
  mergePeople: (profiles: Record<string, PersonSummary> | undefined) => void;
  /** Đánh dấu đã đọc ở server sau khi mở conversation. */
  markRead: (conversationId: string) => Promise<void>;
  /** Id người xem hiện tại (phục vụ giá trị suy ra "đã xem"). */
  myId: string | undefined;
  /** Mốc seq cao nhất đã thấy của từng conversation — trang sở hữu chung. */
  lastSeqRef: { current: Map<string, number> };
  /** Handle socket realtime — trang sở hữu chung, hook realtime gán vào. */
  realtimeRef: { current: MessagingRealtimeHandle | null };
}

export function useActiveConversation({
  mergePeople,
  markRead,
  myId,
  lastSeqRef,
  realtimeRef,
}: UseActiveConversationParams) {
  const queryClient = useQueryClient();
  /** Id hội thoại đang mở (null khi chưa chọn). */
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * Bản tóm tắt hội thoại được truyền vào lúc mở — chỉ là mồi hiển
   * thị đầu tiên cho các hội thoại chưa có mặt trong cache danh
   * sách (ensure từ lớp/khoá/nhóm); ngay khi cache chi tiết có dữ
   * kiện, phần chi tiết (trừ cửa sổ tin) phủ lên bản tóm tắt này.
   */
  const [openedSummary, setOpenedSummary] = useState<ConversationView | null>(null);
  /**
   * Tiến độ nạp cửa sổ tin: các mốc beforeSeq của những trang tin
   * cũ hơn/nhảy-tới đã nạp cho hội thoại đang mở. Chỉ là tiến độ —
   * dữ kiện của từng trang nằm trong cache theo khoá trang.
   */
  const [loadedPages, setLoadedPages] = useState<{ conversationId: string; seqs: number[] } | null>(null);
  /**
   * Tin LẠC QUAN theo từng conversation (bản tạm `localStatus`
   * đang gửi/đã lỗi): dữ kiện chỉ sinh ở client, chưa có bản phía
   * server nên không thuộc cache; khi bản thật về qua cache chi
   * tiết, bước suy ra cửa sổ tự loại bản tạm theo clientMessageId
   * (luật của `mergeMessages`).
   */
  const [localMessages, setLocalMessages] = useState<Record<string, MessageView[]>>({});
  const [typingUsers, setTypingUsers] = useState<Record<string, boolean>>({});
  const [onlineUsers, setOnlineUsers] = useState<Record<string, boolean>>({});

  // Cửa sổ gần nhất: cache chi tiết của hội thoại đang mở.
  const detailQuery = useQuery({
    ...conversationDetailQueryOptions(activeId ?? ''),
    enabled: !!activeId,
  });
  const detail = detailQuery.data;
  // Các cửa sổ cũ hơn/nhảy-tới đã nạp: cache trang theo từng mốc seq.
  const loadedSeqs = loadedPages && loadedPages.conversationId === activeId ? loadedPages.seqs : [];
  const pageQueries = useQueries({
    queries: loadedSeqs.map((seq) => conversationMessagesPageQueryOptions(activeId ?? '', seq)),
  });

  /** Hội thoại đang mở: bản tóm tắt lúc mở phủ bởi chi tiết trong cache (trừ cửa sổ tin) ngay khi có. */
  const active = useMemo<ConversationView | null>(() => {
    if (!activeId) return null;
    const summary = openedSummary && openedSummary.id === activeId ? openedSummary : null;
    if (!detail) return summary;
    const { messages: _detailMessages, ...detailView } = detail;
    return { ...(summary ?? {}), ...detailView } as ConversationView;
  }, [activeId, detail, openedSummary]);
  const activeRef = useRef<ConversationView | null>(null);
  activeRef.current = active;

  /**
   * Cửa sổ tin đang hiển thị: gộp các trang cũ hơn vào cửa sổ chi
   * tiết (chống trùng theo id ở `mergeMessages`), rồi gộp tin lạc
   * quan của conversation này lên trên — bản tạm có bản thật tương
   * ứng trong phần server tự bị loại theo clientMessageId. Tính
   * thẳng mỗi lần render như các giá trị suy ra khác của hook (cửa
   * sổ tối đa vài trăm tin, chi phí gộp không đáng kể).
   */
  let serverWindow: MessageView[] = detail?.messages ?? [];
  for (const pageQuery of pageQueries) {
    if (pageQuery.data) serverWindow = mergeMessages(pageQuery.data.messages, serverWindow);
  }
  const activeLocals = activeId ? (localMessages[activeId] ?? []) : [];
  const messages = activeLocals.length ? mergeMessages(activeLocals, serverWindow) : serverWindow;

  /** Còn tin cũ hơn phía trước hay không: trang đã nạp có mốc nhỏ nhất quyết định, chưa nạp trang nào thì lấy cờ của chi tiết. */
  const loadedPageFlags: { seq: number; hasMoreBefore: boolean }[] = [];
  loadedSeqs.forEach((seq, index) => {
    const data = pageQueries[index]?.data;
    if (data) loadedPageFlags.push({ seq, hasMoreBefore: data.hasMoreBefore });
  });
  loadedPageFlags.sort((a, b) => a.seq - b.seq);
  const hasMoreBefore = loadedPageFlags.length ? loadedPageFlags[0]!.hasMoreBefore : (detail?.hasMoreBefore ?? false);

  /** Mốc đọc theo từng thành viên — suy ra từ cache chi tiết. */
  const readMarkers = useMemo<Record<string, number>>(() => {
    const markers: Record<string, number> = {};
    for (const marker of detail?.memberReadMarkers ?? []) markers[marker.userId] = marker.lastReadSeq;
    return markers;
  }, [detail]);

  /** Đóng hội thoại đang mở — nút quay lại ở mobile (issue #256); ở desktop khung phải về trạng thái trống. */
  function closeConversation() {
    setActiveId(null);
    setOpenedSummary(null);
    // Đóng hẳn là rời ngữ cảnh: lần quay lại không mở lại hội thoại này (lát MSG-T3).
    storeConversationId(null);
  }

  async function open(conv: ConversationView) {
    setOpenedSummary(conv);
    setActiveId(conv.id);
    // Lưu bền hội thoại đang mở để quay lại màn Tin nhắn là gặp
    // đúng ngữ cảnh gần nhất (lát MSG-T3); deep-link thắng giá trị này.
    storeConversationId(conv.id);
    setTypingUsers({});
    setLoadedPages({ conversationId: conv.id, seqs: [] });
    // fetchQuery mồi cache chi tiết (cửa sổ tin + mốc đọc tự suy ra
    // từ cache) và giữ nguyên ngữ nghĩa kiểm tra tư cách thành viên:
    // lỗi thì lời gọi ném ra cho phía khôi phục/deep-link bỏ qua êm.
    const fresh = await queryClient.fetchQuery(conversationDetailQueryOptions(conv.id));
    mergePeople(fresh.memberProfiles);
    const newest = fresh.messages.length
      ? fresh.messages[fresh.messages.length - 1]!.seq
      : (fresh.lastMessageSeq ?? 0);
    if (newest) lastSeqRef.current.set(conv.id, newest);
    realtimeRef.current?.joinConversation(conv.id);
    await markRead(conv.id);
  }

  /**
   * Đảm bảo một cửa sổ tin theo mốc beforeSeq đã có trong cache và
   * ghi mốc vào tiến độ nạp — đường chung của tải-tin-cũ và
   * nhảy-tới-tin: cửa sổ về tay người gọi để xét tin đích có mặt
   * hay không, phần hiển thị tự suy ra từ cache.
   */
  const ensurePageLoaded = useCallback(
    async (beforeSeq: number) => {
      const conversationId = activeRef.current?.id;
      if (!conversationId) return null;
      const page = await queryClient.fetchQuery(conversationMessagesPageQueryOptions(conversationId, beforeSeq));
      setLoadedPages((prev) => {
        const seqs = prev && prev.conversationId === conversationId ? prev.seqs : [];
        return seqs.includes(beforeSeq) ? prev : { conversationId, seqs: [...seqs, beforeSeq] };
      });
      return page;
    },
    [queryClient],
  );

  /** Tải cửa sổ tin cũ hơn (cursor beforeSeq = seq nhỏ nhất đang có trong cửa sổ hiển thị). */
  async function loadOlder() {
    if (!activeId) return;
    const oldest = messages.find((m) => !m.localStatus);
    if (!oldest) return;
    await ensurePageLoaded(oldest.seq);
  }

  /** Gộp tin phía server (tin vừa gửi được xác nhận, tin realtime, phần thiếu khi nối lại) vào cache chi tiết của đúng conversation. */
  const mergeServerMessages = useCallback(
    (conversationId: string, incoming: MessageView[]) => {
      queryClient.setQueryData<ConversationDetailView>(queryKeys.messagingConversationDetail(conversationId), (old) =>
        old ? { ...old, messages: mergeMessages(old.messages, incoming) } : old,
      );
    },
    [queryClient],
  );

  /**
   * Áp một phép biến đổi lên MỌI đoạn của cửa sổ tin của một
   * conversation: cache chi tiết, mọi cache trang đã nạp của
   * conversation đó và tin lạc quan của nó — đường của kiểm duyệt
   * (xoá/thu hồi/gỡ) và sự kiện tin-bị-xoá của realtime, khi tin
   * đích có thể nằm ở bất kỳ đoạn nào.
   */
  const patchMessages = useCallback(
    (conversationId: string, updater: (messages: MessageView[]) => MessageView[]) => {
      queryClient.setQueryData<ConversationDetailView>(queryKeys.messagingConversationDetail(conversationId), (old) =>
        old ? { ...old, messages: updater(old.messages) } : old,
      );
      queryClient.setQueriesData<{ messages: MessageView[]; hasMoreBefore: boolean }>(
        { queryKey: ['messages', 'conversations', conversationId, 'messages'] },
        (old) => (old ? { ...old, messages: updater(old.messages) } : old),
      );
      setLocalMessages((prev) =>
        prev[conversationId] ? { ...prev, [conversationId]: updater(prev[conversationId]!) } : prev,
      );
    },
    [queryClient],
  );

  /** Đẩy/cập nhật một tin lạc quan của một conversation (khớp theo id bản tạm). */
  const addLocalMessage = useCallback((message: MessageView) => {
    setLocalMessages((prev) => {
      const list = prev[message.conversationId] ?? [];
      const next = list.some((m) => m.id === message.id)
        ? list.map((m) => (m.id === message.id ? message : m))
        : [...list, message];
      return { ...prev, [message.conversationId]: next };
    });
  }, []);

  /** Đổi trạng thái của tin lạc quan theo clientMessageId (đang gửi → đã lỗi khi gửi hỏng; đã lỗi → đang gửi khi thử lại). */
  const setLocalMessageStatus = useCallback(
    (conversationId: string, clientMessageId: string, status: 'sending' | 'failed') => {
      setLocalMessages((prev) => {
        const list = prev[conversationId];
        if (!list) return prev;
        return {
          ...prev,
          [conversationId]: list.map((m) =>
            m.clientMessageId === clientMessageId && m.localStatus ? { ...m, localStatus: status } : m,
          ),
        };
      });
    },
    [],
  );

  /**
   * Áp một mốc đọc lên cache chi tiết (giữ mốc lớn nhất — biên nhận
   * đọc đến muộn không được kéo mốc lùi): đường của `markRead` (mốc
   * của chính mình) và của sự kiện biên nhận đọc realtime.
   */
  const applyReadMarker = useCallback(
    (conversationId: string, userId: string, lastReadSeq: number) => {
      queryClient.setQueryData<ConversationDetailView>(queryKeys.messagingConversationDetail(conversationId), (old) => {
        if (!old) return old;
        const markers = old.memberReadMarkers ?? [];
        const existing = markers.find((m) => m.userId === userId);
        if (existing && existing.lastReadSeq >= lastReadSeq) return old;
        return {
          ...old,
          memberReadMarkers: [...markers.filter((m) => m.userId !== userId), { userId, lastReadSeq }],
        };
      });
    },
    [queryClient],
  );

  /**
   * Vô hiệu hoá toàn bộ cửa sổ của một conversation (tiền tố khoá
   * chi tiết phủ cả chi tiết, các trang tin và kết quả tìm): đường
   * của sự kiện conversation.invalidate — chỉ dữ kiện nạp lại mới
   * phân biệt được đã-thu-hồi với đã-xoá và tin xoá cứng mới biến
   * mất khỏi khung.
   */
  const invalidateConversationWindow = useCallback(
    (conversationId: string) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingConversationDetail(conversationId) });
    },
    [queryClient],
  );

  const lastOwnMessage = [...messages].reverse().find((m) => m.userIdFrom === myId && !m.localStatus);
  const seenByAllOthers = Boolean(
    active &&
    lastOwnMessage &&
    active.members
      .filter((memberId) => memberId !== myId)
      .every((memberId) => (readMarkers[memberId] ?? 0) >= lastOwnMessage.seq),
  );
  const typingNames = Object.keys(typingUsers).filter((userId) => typingUsers[userId]);
  // Tầm nhìn xoá mềm ở phía client (server đã chốt theo vai trò):
  // tin đã xoá chỉ còn hiện với người có thẩm quyền kiểm duyệt.
  const visibleMessages = messages.filter((m) => !m.deletedAt || active?.canModerate);

  return {
    active,
    messages,
    hasMoreBefore,
    readMarkers,
    typingUsers,
    setTypingUsers,
    onlineUsers,
    setOnlineUsers,
    activeRef,
    closeConversation,
    open,
    loadOlder,
    ensurePageLoaded,
    mergeServerMessages,
    patchMessages,
    addLocalMessage,
    setLocalMessageStatus,
    applyReadMarker,
    invalidateConversationWindow,
    lastOwnMessage,
    seenByAllOthers,
    typingNames,
    visibleMessages,
  };
}
