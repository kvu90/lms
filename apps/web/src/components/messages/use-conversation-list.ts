/**
 * Hook điều phối danh sách hội thoại của trang Tin nhắn (đợt C của
 * issue #223, lát 1): sở hữu toàn bộ trạng thái danh sách — danh
 * sách chính, mục đã lưu, số chưa đọc, cây nhóm, khoá của tôi, bản
 * đồ tên hiển thị, tab khung trái — cùng các callback nạp danh
 * sách và hiệu ứng nạp lần đầu. Di chuyển từ `pages/messages.tsx`
 * (dòng 241–258, 398–574 và hiệu ứng nạp lần đầu), giữ nguyên hành
 * vi: lỗi ở các đường phụ (danh bạ, khoá, cây nhóm) không làm hỏng
 * danh sách chính; server là nguồn sự thật của từng mục danh sách.
 *
 * @param params - Tham số điều phối chéo: id người xem hiện tại và
 * hai callback dùng-chung do trang cung cấp (xem ghi chú về callback
 * dùng-chung trong file trang): `setBlocked` để `reload` phản ánh
 * danh sách đã chặn, `setReadMarkers` để `markRead` phản ánh mốc
 * đọc của chính mình.
 * @returns Trạng thái danh sách và handler cho trang lắp ghép.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  messagingArchivedConversationsQueryOptions,
  messagingBlockedContactsQueryOptions,
  messagingContactRequestsQueryOptions,
  messagingContactsQueryOptions,
  messagingConversationsQueryOptions,
  messagingCoursesQueryOptions,
  messagingGroupTreeQueryOptions,
  useMarkConversationRead,
  useSetConversationState,
} from '#lib/messaging-data';
import { queryKeys } from '#lib/query-keys';
import { readStoredMessagesTab, storeMessagesTab } from './page-helpers';
import type {
  ContactRequestView,
  ConversationGroupTreeView,
  ConversationStatePatch,
  ConversationView,
  MessagingCourse,
  PersonSummary,
} from './types';

export interface UseConversationListParams {
  /** Id người xem hiện tại (để `markRead` ghi mốc đọc của chính mình). */
  myId: string | undefined;
  /** Ghi danh sách đã chặn — do hook danh bạ sở hữu, trang nối qua callback dùng-chung. */
  setBlocked: (blocked: string[]) => void;
  /** Ghi mốc đọc — do hook hội thoại đang mở sở hữu, trang nối qua callback dùng-chung. */
  setReadMarkers: (
    markers: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>),
  ) => void;
  /** Ghi danh bạ đã duyệt — do hook danh bạ sở hữu, trang nối qua callback dùng-chung. */
  setContacts: (contacts: string[]) => void;
  /** Ghi hàng chờ kết bạn đến — do hook danh bạ sở hữu, trang nối qua callback dùng-chung. */
  setIncomingRequests: (requests: ContactRequestView[]) => void;
  /** Ghi hàng chờ kết bạn đi — do hook danh bạ sở hữu, trang nối qua callback dùng-chung. */
  setOutgoingRequests: (requests: ContactRequestView[]) => void;
  /** Mốc seq cao nhất đã thấy của từng conversation — trang sở hữu chung, bốn hook cùng dùng. */
  lastSeqRef: { current: Map<string, number> };
}

export function useConversationList({
  myId,
  setBlocked,
  setReadMarkers,
  setContacts,
  setIncomingRequests,
  setOutgoingRequests,
  lastSeqRef,
}: UseConversationListParams) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  /**
   * Mục ĐÃ LƯU (lát M5, issue #240): danh sách riêng nạp bằng
   * `?archived=true` khi người dùng mở mục; hai danh sách không trộn
   * nhau — server là nguồn sự thật của từng mục.
   */
  const [archivedConversations, setArchivedConversations] = useState<ConversationView[]>([]);
  /** Lỗi của lần đổi trạng thái hội thoại gần nhất (lát M5). */
  const [stateError, setStateError] = useState<string | null>(null);
  /** Đã nạp xong danh sách conversation ít nhất một lần — mốc cho deep-link mở đúng cuộc trò chuyện. */
  const [listLoaded, setListLoaded] = useState(false);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Tên hiển thị gom từ mọi response của API (profiles/memberProfiles).
  const [people, setPeople] = useState<Record<string, PersonSummary>>({});
  // Tìm bạn theo KHOÁ (mô hình chốt lại 24/10/2026): khoá của tôi →
  // chọn khoá → roster thành viên (phân trang con trỏ phía server).
  const [myCourses, setMyCourses] = useState<MessagingCourse[]>([]);
  /**
   * CÂY NHÓM của tôi (lát MSG-T1 dựng ở server, MSG-T3 trình bày ở
   * tab Nhóm): nạp cùng nhịp với danh sách hội thoại; lỗi thì giữ
   * cây gần nhất như các đường phụ khác của trang.
   */
  const [groupTree, setGroupTree] = useState<ConversationGroupTreeView | null>(null);
  /**
   * Tab khung trái đang chọn (lát MSG-T3): giữ ở trang và LƯU BỀN
   * cùng hội thoại đang mở — quay lại màn Tin nhắn (kể cả sau khi
   * tải lại trang) là gặp đúng ngữ cảnh gần nhất.
   */
  const [sidebarTab, setSidebarTabState] = useState<string>(() => readStoredMessagesTab());

  /**
   * Số conversation chưa đọc suy từ danh sách (mỗi mục mang unread
   * của chính user). Mỗi lần đếm lại cũng làm mới truy vấn huy hiệu
   * Tin nhắn của sidebar (lát M1, issue #204): sidebar tự làm tươi
   * mỗi 30 giây, nhưng khi người dùng đang ở chính trang này thì số
   * trên huy hiệu phải khớp ngay với số trang vừa đếm qua realtime
   * thay vì chờ chu kỳ — làm mới bằng invalidate để server vẫn là
   * nguồn số đếm cuối cùng.
   */
  const recountUnread = useCallback(
    (list: ConversationView[]) => {
      setUnread(list.filter((c) => (c.unread ?? 0) > 0).length);
      void queryClient.invalidateQueries({ queryKey: queryKeys.messageUnreadCount });
    },
    [queryClient],
  );

  /** Gom tên hiển thị từ một response (profiles/memberProfiles) vào bản đồ tên dùng chung của trang. */
  const mergePeople = useCallback((profiles: Record<string, PersonSummary> | undefined) => {
    if (!profiles) return;
    setPeople((prev) => ({ ...prev, ...profiles }));
  }, []);

  /** Tên hiển thị của một user; chưa tra được thông tin thì lùi về chính id như trước. */
  const nameOf = useCallback((userId: string) => people[userId]?.displayName ?? userId, [people]);

  // Thao tác ghi của trang qua các đột biến của lib/messaging-data
  // (F-01 của rà soát #133): đột biến mỏng, trang tự áp kết quả vào
  // state của nó như bản thủ công (kênh realtime không đổi).
  const conversationStateMutation = useSetConversationState();
  const markReadMutation = useMarkConversationRead();

  /** Nạp cây nhóm cho tab Nhóm (lát MSG-T3): đường riêng, lỗi thì giữ cây gần nhất. */
  const loadGroupTree = useCallback(async () => {
    try {
      const tree = await queryClient.fetchQuery(messagingGroupTreeQueryOptions());
      setGroupTree(tree);
    } catch {
      // Giữ cây gần nhất.
    }
  }, [queryClient]);

  /** Đổi tab khung trái (lát MSG-T3): cập nhật state + lưu bền để lần quay lại vẫn gặp tab này. */
  const setSidebarTab = useCallback((value: string) => {
    setSidebarTabState(value);
    storeMessagesTab(value);
  }, []);

  const reload = useCallback(async () => {
    const [list, blockedRes] = await Promise.all([
      queryClient.fetchQuery(messagingConversationsQueryOptions()),
      queryClient.fetchQuery(messagingBlockedContactsQueryOptions()),
    ]);
    setConversations(list);
    recountUnread(list);
    setBlocked(blockedRes.blocked);
    setListLoaded(true);
    mergePeople(blockedRes.profiles);
    for (const c of list) mergePeople(c.memberProfiles);
    // Danh bạ + hàng chờ kết bạn (Lớp B): lỗi ở hai đường này không
    // được phép làm hỏng danh sách cuộc trò chuyện ở trên.
    try {
      const [contactsRes, requestsRes] = await Promise.all([
        queryClient.fetchQuery(messagingContactsQueryOptions()),
        queryClient.fetchQuery(messagingContactRequestsQueryOptions()),
      ]);
      setContacts(contactsRes.contacts);
      mergePeople(contactsRes.profiles);
      setIncomingRequests(requestsRes.incoming);
      setOutgoingRequests(requestsRes.outgoing);
    } catch {
      // Giữ trạng thái danh bạ gần nhất.
    }
    // Khoá của tôi (luồng tìm bạn theo khoá): đường riêng, lỗi thì
    // giữ danh sách khoá gần nhất như danh bạ.
    try {
      const coursesRes = await queryClient.fetchQuery(messagingCoursesQueryOptions());
      setMyCourses(coursesRes.courses);
    } catch {
      // Giữ danh sách khoá gần nhất.
    }
    for (const c of list) {
      if (c.lastMessageSeq !== undefined) {
        const seen = lastSeqRef.current.get(c.id) ?? 0;
        if (c.lastMessageSeq > seen) lastSeqRef.current.set(c.id, c.lastMessageSeq);
      }
    }
    // Cây nhóm đi cùng nhịp nạp (tab Nhóm luôn tươi như danh sách).
    await loadGroupTree();
  }, [
    lastSeqRef,
    loadGroupTree,
    mergePeople,
    queryClient,
    recountUnread,
    setBlocked,
    setContacts,
    setIncomingRequests,
    setOutgoingRequests,
  ]);

  /** Nạp mục ĐÃ LƯU (lát M5): danh sách riêng của server, lỗi thì giữ bản gần nhất. */
  const loadArchived = useCallback(async () => {
    try {
      const list = await queryClient.fetchQuery(messagingArchivedConversationsQueryOptions());
      setArchivedConversations(list);
      for (const c of list) mergePeople(c.memberProfiles);
    } catch {
      // Giữ mục đã lưu gần nhất.
    }
  }, [mergePeople, queryClient]);

  /**
   * Đặt một cờ trạng thái cá nhân trên một cuộc trò chuyện (lát M5):
   * server trả trạng thái đầy đủ sau khi đặt; client phản ánh ngay —
   * lưu thì cuộc trò chuyện rời danh sách chính sang mục đã lưu, bỏ
   * lưu thì đi chiều ngược lại, ghim/tắt tiếng cập nhật tại chỗ.
   */
  const updateConversationState = useCallback(
    async (conversation: ConversationView, patch: ConversationStatePatch) => {
      setStateError(null);
      try {
        const res = await conversationStateMutation.mutateAsync({ conversationId: conversation.id, patch });
        const applyState = (c: ConversationView): ConversationView =>
          c.id === conversation.id ? { ...c, pinnedAt: res.pinnedAt, archivedAt: res.archivedAt, muted: res.muted } : c;
        if (res.archived) {
          setConversations((prev) => prev.filter((c) => c.id !== conversation.id));
          setArchivedConversations((prev) => [
            applyState(conversation),
            ...prev.filter((c) => c.id !== conversation.id),
          ]);
        } else if (conversation.archivedAt) {
          setArchivedConversations((prev) => prev.filter((c) => c.id !== conversation.id));
          void reload();
        } else {
          setConversations((prev) => prev.map(applyState));
          setArchivedConversations((prev) => prev.map(applyState));
          // Ghim đổi THỨ TỰ danh sách (server xếp đã ghim lên đầu):
          // nạp lại cả hai danh sách để thứ tự khớp server ngay.
          if (patch.pinned !== undefined) {
            void reload();
            void loadArchived();
          }
        }
      } catch {
        setStateError(t('conversationStateFailed'));
      }
    },
    [loadArchived, reload, t],
  );

  /** Đánh dấu đã đọc ở server và phản ánh ngay vào state (mốc của mình + unread của conversation). */
  const markRead = useCallback(
    async (conversationId: string) => {
      try {
        const res = await markReadMutation.mutateAsync(conversationId);
        if (myId) setReadMarkers((prev) => ({ ...prev, [myId]: res.lastReadSeq }));
        setConversations((prev) => {
          const next = prev.map((c) =>
            c.id === conversationId ? { ...c, unread: 0, lastReadSeq: res.lastReadSeq } : c,
          );
          recountUnread(next);
          return next;
        });
      } catch {
        // Đánh dấu đã đọc lỗi thì để lần mở/đọc sau thử lại — không chặn đọc tin.
      }
    },
    [myId, recountUnread, setReadMarkers],
  );

  useEffect(() => {
    void reload().catch(() => setError(t('messagesLoadFailed')));
  }, [reload]);

  return {
    conversations,
    setConversations,
    archivedConversations,
    setArchivedConversations,
    stateError,
    listLoaded,
    unread,
    error,
    people,
    myCourses,
    groupTree,
    setGroupTree,
    sidebarTab,
    setSidebarTab,
    recountUnread,
    mergePeople,
    nameOf,
    loadGroupTree,
    reload,
    loadArchived,
    updateConversationState,
    markRead,
  };
}
