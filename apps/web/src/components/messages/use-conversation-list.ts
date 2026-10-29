/**
 * Hook điều phối danh sách hội thoại của trang Tin nhắn (đợt C của
 * issue #223, lát 1; chuyển sang cache TanStack ở CN-13, issue
 * #493): danh sách chính, mục đã lưu, cây nhóm và khoá của tôi đều
 * là dữ kiện máy chủ — chúng sống trong CACHE của TanStack Query
 * qua các options của `lib/messaging-data` và hook này chỉ ĐĂNG KÝ
 * (useQuery) rồi suy ra giá trị hiển thị; state cục bộ chỉ còn tab
 * khung trái, bản đồ tên hiển thị (dữ kiện suy ra, không có
 * endpoint riêng) và lỗi của thao tác đổi trạng thái. Đột biến
 * thành công tự invalidate/vá cache ở tầng dữ kiện; `reload` là
 * invalidate đồng loạt các khoá danh sách; `markRead` áp mốc đọc
 * của chính mình lên cache chi tiết qua callback của trang. Lỗi ở
 * các đường phụ (khoá, cây nhóm) không làm hỏng danh sách chính;
 * server là nguồn sự thật của từng mục danh sách.
 *
 * @param params - Tham số điều phối chéo: id người xem hiện tại và
 * callback dùng-chung do trang cung cấp (xem ghi chú về callback
 * dùng-chung trong file trang): `applyReadMarker` để `markRead`
 * phản ánh mốc đọc của chính mình lên cache chi tiết hội thoại.
 * @returns Trạng thái danh sách và handler cho trang lắp ghép.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  messagingArchivedConversationsQueryOptions,
  messagingConversationsQueryOptions,
  messagingCoursesQueryOptions,
  messagingGroupTreeQueryOptions,
  useMarkConversationRead,
  useSetConversationState,
} from '#lib/messaging-data';
import { queryKeys } from '#lib/query-keys';
import { readStoredMessagesTab, storeMessagesTab } from './page-helpers';
import type {
  ConversationGroupTreeView,
  ConversationStatePatch,
  ConversationView,
  PersonSummary,
} from './types';

export interface UseConversationListParams {
  /** Id người xem hiện tại (để `markRead` ghi mốc đọc của chính mình). */
  myId: string | undefined;
  /** Áp mốc đọc của một thành viên lên cache chi tiết hội thoại — do hook hội thoại đang mở sở hữu, trang nối qua callback dùng-chung. */
  applyReadMarker: (conversationId: string, userId: string, lastReadSeq: number) => void;
  /** Mốc seq cao nhất đã thấy của từng conversation — trang sở hữu chung, bốn hook cùng dùng. */
  lastSeqRef: { current: Map<string, number> };
}

export function useConversationList({ myId, applyReadMarker, lastSeqRef }: UseConversationListParams) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();

  // Dữ kiện máy chủ của khung trái — đăng ký trực tiếp trên cache.
  const conversationsQuery = useQuery(messagingConversationsQueryOptions());
  const conversations = useMemo(() => conversationsQuery.data ?? [], [conversationsQuery.data]);
  /**
   * Mục ĐÃ LƯU (lát M5, issue #240): danh sách riêng của server,
   * nạp LƯỜI — query chỉ bật sau lần đầu người dùng mở mục (cờ
   * `archivedRequested`); hai danh sách không trộn nhau, server là
   * nguồn sự thật của từng mục.
   */
  const [archivedRequested, setArchivedRequested] = useState(false);
  const archivedQuery = useQuery({
    ...messagingArchivedConversationsQueryOptions(),
    enabled: archivedRequested,
  });
  const archivedConversations = useMemo(() => archivedQuery.data ?? [], [archivedQuery.data]);
  /**
   * CÂY NHÓM của tôi (lát MSG-T1 dựng ở server, MSG-T3 trình bày ở
   * tab Nhóm): đăng ký cùng nhịp với danh sách hội thoại; lỗi thì
   * giữ cây gần nhất trong cache như các đường phụ khác của trang.
   */
  const groupTreeQuery = useQuery(messagingGroupTreeQueryOptions());
  const groupTree = groupTreeQuery.data ?? null;
  // Tìm bạn theo KHOÁ (mô hình chốt lại 24/10/2026): khoá của tôi →
  // chọn khoá → roster thành viên (phân trang con trỏ phía server).
  const coursesQuery = useQuery(messagingCoursesQueryOptions());
  const myCourses = useMemo(() => coursesQuery.data?.courses ?? [], [coursesQuery.data]);

  /** Lỗi của lần đổi trạng thái hội thoại gần nhất (lát M5). */
  const [stateError, setStateError] = useState<string | null>(null);
  /** Lỗi nạp danh sách chính lần đầu (chưa từng có dữ kiện trong cache). */
  const error =
    conversationsQuery.isError && !conversationsQuery.data ? t('messagesLoadFailed') : null;
  /** Đã nạp xong danh sách conversation ít nhất một lần — mốc cho deep-link mở đúng cuộc trò chuyện. */
  const listLoaded = conversationsQuery.isSuccess;
  // Tên hiển thị gom từ mọi response của API (profiles/memberProfiles):
  // bản đồ SUY RA phục vụ tra cứu tên đồng bộ, không có endpoint riêng.
  const [people, setPeople] = useState<Record<string, PersonSummary>>({});
  /**
   * Tab khung trái đang chọn (lát MSG-T3): giữ ở trang và LƯU BỀN
   * cùng hội thoại đang mở — quay lại màn Tin nhắn (kể cả sau khi
   * tải lại trang) là gặp đúng ngữ cảnh gần nhất.
   */
  const [sidebarTab, setSidebarTabState] = useState<string>(() => readStoredMessagesTab());

  /**
   * Số conversation chưa đọc — SUY RA từ danh sách trong cache (mỗi
   * mục mang unread của chính user). Đi kèm là `recountUnread` cho
   * kênh realtime gọi mỗi khi có sự kiện đổi số chưa đọc: số của
   * trang tự khớp vì cùng suy từ cache, còn huy hiệu Tin nhắn của
   * sidebar đọc truy vấn riêng nên phải làm mới bằng invalidate để
   * server vẫn là nguồn số đếm cuối cùng (lát M1, issue #204).
   */
  const unread = useMemo(() => conversations.filter((c) => (c.unread ?? 0) > 0).length, [conversations]);
  const recountUnread = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.messageUnreadCount });
  }, [queryClient]);

  /** Gom tên hiển thị từ một response (profiles/memberProfiles) vào bản đồ tên dùng chung của trang. */
  const mergePeople = useCallback((profiles: Record<string, PersonSummary> | undefined) => {
    if (!profiles) return;
    setPeople((prev) => ({ ...prev, ...profiles }));
  }, []);

  /** Tên hiển thị của một user; chưa tra được thông tin thì lùi về chính id như trước. */
  const nameOf = useCallback((userId: string) => people[userId]?.displayName ?? userId, [people]);

  // Mỗi khi danh sách trong cache đổi bản (nạp lần đầu,
  // invalidate, vá realtime): gom hồ sơ thành viên của hai danh
  // sách vào bản đồ tên. Điều chỉnh state ngay trong render theo
  // khuôn React dành cho state suy từ dữ kiện ngoài (chỉ chạy khi
  // tham chiếu dữ kiện thật sự đổi), không qua hiệu ứng phụ.
  const [mergedProfilesSource, setMergedProfilesSource] = useState<{
    list?: ConversationView[];
    archived?: ConversationView[];
  }>({});
  if (
    conversationsQuery.data !== mergedProfilesSource.list ||
    archivedQuery.data !== mergedProfilesSource.archived
  ) {
    setMergedProfilesSource({ list: conversationsQuery.data, archived: archivedQuery.data });
    for (const c of conversationsQuery.data ?? []) mergePeople(c.memberProfiles);
    for (const c of archivedQuery.data ?? []) mergePeople(c.memberProfiles);
  }
  // Nâng mốc seq cao nhất đã thấy của từng conversation mỗi khi
  // danh sách đổi — mốc xin đồng bộ khi nối lại của kênh realtime
  // (chỉ ghi ref trong hiệu ứng, không đụng state).
  useEffect(() => {
    for (const c of conversations) {
      if (c.lastMessageSeq !== undefined) {
        const seen = lastSeqRef.current.get(c.id) ?? 0;
        if (c.lastMessageSeq > seen) lastSeqRef.current.set(c.id, c.lastMessageSeq);
      }
    }
  }, [conversations, lastSeqRef]);

  /**
   * Ghi danh sách chính vào CACHE thay cho state (bộ chuyển đổi giữ
   * nguyên chữ ký cập nhật-hàm như setter cũ cho các hook tiêu thụ:
   * khôi phục ngữ cảnh chèn hội thoại lấy theo id, realtime áp sự
   * kiện conversation.updated, hành động nhóm chèn hội thoại vừa
   * ensure).
   */
  const setConversations = useCallback(
    (updater: ConversationView[] | ((prev: ConversationView[]) => ConversationView[])) => {
      queryClient.setQueryData<ConversationView[]>(queryKeys.messagingConversations, (old) =>
        typeof updater === 'function' ? updater(old ?? []) : updater,
      );
    },
    [queryClient],
  );

  /** Ghi mục đã lưu vào CACHE — cùng khuôn bộ chuyển đổi với `setConversations`. */
  const setArchivedConversations = useCallback(
    (updater: ConversationView[] | ((prev: ConversationView[]) => ConversationView[])) => {
      queryClient.setQueryData<ConversationView[]>(queryKeys.messagingArchivedConversations, (old) =>
        typeof updater === 'function' ? updater(old ?? []) : updater,
      );
    },
    [queryClient],
  );

  /** Ghi cây nhóm vào CACHE — bộ chuyển đổi cho kênh realtime áp số chưa đọc mới lên cây. */
  const setGroupTree = useCallback(
    (
      updater:
        | ConversationGroupTreeView
        | null
        | ((prev: ConversationGroupTreeView | null) => ConversationGroupTreeView | null),
    ) => {
      queryClient.setQueryData<ConversationGroupTreeView | null>(queryKeys.messagingGroupTree, (old) =>
        typeof updater === 'function'
          ? (updater as (prev: ConversationGroupTreeView | null) => ConversationGroupTreeView | null)(old ?? null)
          : updater,
      );
    },
    [queryClient],
  );

  // Thao tác ghi của trang qua các đột biến của lib/messaging-data:
  // đột biến tự invalidate/vá đúng khoá trong cache khi thành công
  // (xem tầng dữ kiện), hook này chỉ còn bắt lỗi để hiện thông báo.
  const conversationStateMutation = useSetConversationState();
  const markReadMutation = useMarkConversationRead();

  /** Nạp cây nhóm cho tab Nhóm (lát MSG-T3): invalidate để query đang đăng ký nạp lại; lỗi thì giữ cây gần nhất trong cache. */
  const loadGroupTree = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.messagingGroupTree });
  }, [queryClient]);

  /** Đổi tab khung trái (lát MSG-T3): cập nhật state + lưu bền để lần quay lại vẫn gặp tab này. */
  const setSidebarTab = useCallback((value: string) => {
    setSidebarTabState(value);
    storeMessagesTab(value);
  }, []);

  /**
   * Nạp lại toàn bộ dữ kiện khung trái + danh bạ: invalidate đồng
   * loạt các khoá danh sách/cây/khoá/danh bạ — các query đang đăng
   * ký nạp lại ngay, query chưa bật (mục đã lưu trước lần mở đầu)
   * chỉ bị đánh dấu cũ và nạp tươi ở lần bật sau. Lời gọi chờ các
   * lần nạp lại đang hoạt động settle như nhịp nạp đầy đủ trước đây.
   */
  const reload = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.messagingConversations }),
      queryClient.invalidateQueries({ queryKey: queryKeys.messagingArchivedConversations }),
      queryClient.invalidateQueries({ queryKey: queryKeys.messagingGroupTree }),
      queryClient.invalidateQueries({ queryKey: queryKeys.messagingCourses }),
      queryClient.invalidateQueries({ queryKey: queryKeys.messagingContacts }),
      queryClient.invalidateQueries({ queryKey: queryKeys.messagingContactRequests }),
      queryClient.invalidateQueries({ queryKey: queryKeys.messagingBlockedContacts }),
    ]);
  }, [queryClient]);

  /** Nạp mục ĐÃ LƯU (lát M5): lần đầu thì bật query lười, các lần sau invalidate để nạp tươi. */
  const loadArchived = useCallback(async () => {
    setArchivedRequested(true);
    await queryClient.invalidateQueries({ queryKey: queryKeys.messagingArchivedConversations });
  }, [queryClient]);

  /**
   * Đặt một cờ trạng thái cá nhân trên một cuộc trò chuyện (lát M5):
   * server trả trạng thái đầy đủ sau khi đặt; đột biến đã khai
   * invalidate cả hai danh sách + chi tiết nên cache tự hội tụ về
   * trạng thái server (lưu thì rời danh sách chính sang mục đã lưu,
   * ghim thì thứ tự nạp lại khớp thứ tự server) — hook chỉ bắt lỗi.
   */
  const updateConversationState = useCallback(
    async (conversation: ConversationView, patch: ConversationStatePatch) => {
      setStateError(null);
      try {
        await conversationStateMutation.mutateAsync({ conversationId: conversation.id, patch });
      } catch {
        setStateError(t('conversationStateFailed'));
      }
    },
    [conversationStateMutation, t],
  );

  /**
   * Đánh dấu đã đọc ở server: đột biến vá tại chỗ mục hội thoại
   * trong cache danh sách (unread về 0) + invalidate huy hiệu chưa
   * đọc; mốc đọc của chính mình áp lên cache chi tiết qua callback
   * của trang để dòng "đã xem" của khung chat khớp ngay.
   */
  const markRead = useCallback(
    async (conversationId: string) => {
      try {
        const res = await markReadMutation.mutateAsync(conversationId);
        if (myId) applyReadMarker(conversationId, myId, res.lastReadSeq);
      } catch {
        // Đánh dấu đã đọc lỗi thì để lần mở/đọc sau thử lại — không chặn đọc tin.
      }
    },
    [applyReadMarker, markReadMutation, myId],
  );

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
