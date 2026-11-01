import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  bulkRemoveMessages, createDirectConversation, createFreeGroup, createGroupConversation, deleteMessageForMe,
  fetchClassConversation, fetchConversationDetail, fetchConversationMessagesPage, fetchCourseConversation,
  fetchMessagingArchivedConversations, fetchMessagingBlockedContacts, fetchMessagingContactRequests,
  fetchMessagingContacts, fetchMessagingConversations, fetchMessagingCourses, fetchMessagingGroupTree,
  fetchMessagingPersonProfile,
  fetchRosterPage, hardDeleteMessage, markConversationRead, recallMessage, removeConversationMember,
  reportConversation, respondContactRequest, searchConversationMessages, sendContactRequest, sendMessage,
  setContactBlocked, setConversationEnabled, setConversationState,
} from '../api/messaging';
import type {
  ConversationDetailView,
  ConversationStatePatch,
  ConversationView,
  PersonSummary,
} from '../types/types';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu nhắn tin (F-01 của rà soát #133; chuyển sang cache
 * TanStack ở CN-13, issue #493).
 *
 * Luồng nghiệp vụ: trang Tin nhắn là một MÁY TRẠNG THÁI THỜI GIAN
 * THỰC — danh sách hội thoại, khung tin, cây nhóm và danh bạ đều bị
 * sự kiện WebSocket (outbox của server) và thao tác của người dùng
 * cập nhật liên tục. Nguồn sự thật duy nhất của dữ kiện máy chủ là
 * CACHE của TanStack Query: các options dưới đây khai khoá nhà máy
 * và thừa hưởng `staleTime` mặc định của app (30 giây — xem
 * lib/query-client) thay cho việc ghim mốc tươi bằng không đồng
 * loạt trước đây;
 * trang đọc qua useQuery/useQueries, đột biến thành công thì
 * invalidate đúng khoá liên quan hoặc vá cache bằng `setQueryData`
 * khi đáp ứng mang theo đúng dữ kiện mới (khuôn "updates from
 * mutation responses" của TanStack Query), và sự kiện realtime vá
 * cache bằng `setQueryData` tại tầng hook của trang. Kênh realtime
 * (api/messaging-socket) không đổi.
 *
 * Bốn đột biến theo tin (xoá-phía-mình, thu hồi, xoá cứng, gỡ hàng
 * loạt) chỉ mang id của tin trong biến — không mang id hội thoại —
 * nên không khoá được invalidate đích danh ở tầng này; đáp ứng của
 * chúng được tầng hook kiểm duyệt của trang vá vào cache chi tiết
 * hội thoại bằng `setQueryData`.
 *
 * Tầng này bọc các hàm gọi API thuần ở `../api/messaging` (tách
 * khỏi module dữ liệu phẳng `src/lib/messaging-data.ts` khi tổ
 * chức lại apps/web theo mô hình features/, issue #500).
 */

/** Cây nhóm của tab Nhóm (GET /messages/group-tree). */
export function messagingGroupTreeQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingGroupTree,
    queryFn: () => fetchMessagingGroupTree(),
  });
}

/** Danh sách hội thoại chính (GET /messages/conversations). */
export function messagingConversationsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingConversations,
    queryFn: () => fetchMessagingConversations(),
  });
}

/**
 * Hồ sơ người phục vụ panel thông tin của chat 1–1 (issue #592,
 * GET /messages/users/:id/profile): tên + tên đăng nhập + email từ
 * dữ kiện thật của hệ. Nơi gọi tự bật/tắt query theo trạng thái mở
 * panel (panel chỉ render khi mở nên query lười theo panel).
 */
export function messagingPersonProfileQueryOptions(userId: string) {
  return queryOptions({
    queryKey: queryKeys.messagingPersonProfile(userId),
    queryFn: () => fetchMessagingPersonProfile(userId),
  });
}

/**
 * Danh sách hội thoại đã lưu của server (GET /messages/conversations?archived=true).
 * Từ issue #623 tập này là dữ kiện của tab Lưu trữ ở cột danh
 * sách (tab thay cho tab Yêu thích): hook danh sách nạp nó
 * cùng nhịp với danh sách chính để số đếm trên tab luôn đúng;
 * hai tập không trộn nhau.
 */
export function messagingArchivedConversationsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingArchivedConversations,
    queryFn: () => fetchMessagingArchivedConversations(),
  });
}

/** Danh sách người đã chặn kèm hồ sơ hiển thị (GET /messages/contacts/blocked). */
export function messagingBlockedContactsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingBlockedContacts,
    queryFn: () => fetchMessagingBlockedContacts(),
  });
}

/** Danh bạ đã duyệt kèm hồ sơ (GET /messages/contacts). */
export function messagingContactsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingContacts,
    queryFn: () => fetchMessagingContacts(),
  });
}

/** Hàng chờ kết bạn đến/đi (GET /messages/contacts/requests). */
export function messagingContactRequestsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingContactRequests,
    queryFn: () => fetchMessagingContactRequests(),
  });
}

/** Các khoá của người xem cho luồng tìm bạn theo khoá (GET /messages/courses). */
export function messagingCoursesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingCourses,
    queryFn: () => fetchMessagingCourses(),
  });
}

/** Chi tiết một hội thoại kèm cửa sổ tin gần nhất (GET /messages/conversations/:id). */
export function conversationDetailQueryOptions(conversationId: string) {
  return queryOptions({
    queryKey: queryKeys.messagingConversationDetail(conversationId),
    queryFn: () => fetchConversationDetail(conversationId),
  });
}

/** Một cửa sổ tin cũ hơn theo mốc seq (GET /messages/conversations/:id/messages?beforeSeq=). */
export function conversationMessagesPageQueryOptions(conversationId: string, beforeSeq: number) {
  return queryOptions({
    queryKey: queryKeys.messagingMessagesPage(conversationId, beforeSeq),
    queryFn: () => fetchConversationMessagesPage(conversationId, beforeSeq),
  });
}

/** Tìm nội dung trong một hội thoại (GET /messages/conversations/:id/search). */
export function messageSearchQueryOptions(conversationId: string, q: string) {
  return queryOptions({
    queryKey: queryKeys.messagingSearch(conversationId, q),
    queryFn: () => searchConversationMessages(conversationId, q),
  });
}

/** Một trang roster lớp/khoá theo URL đầy đủ (con trỏ do trang điều phối). */
export function rosterPageQueryOptions(url: string) {
  return queryOptions({
    queryKey: queryKeys.messagingRosterPage(url),
    queryFn: () => fetchRosterPage(url),
  });
}

/** Ensure chat cấp lớp (GET /messages/classes/:id/conversation). */
export function classConversationQueryOptions(classId: string) {
  return queryOptions({
    queryKey: queryKeys.messagingClassConversation(classId),
    queryFn: () => fetchClassConversation(classId),
  });
}

/** Ensure chat cấp khoá (GET /messages/courses/:id/conversation) — dùng chung khoá factory `courseConversation` với trang quản trị khoá. */
export function courseConversationQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.courseConversation(courseId),
    queryFn: () => fetchCourseConversation(courseId),
  });
}

/**
 * Đột biến đặt cờ trạng thái cá nhân (ghim/lưu/tắt tiếng) — server trả trạng thái đầy đủ (PATCH .../state).
 * Ghim đổi thứ tự và lưu đổi tư cách thành viên giữa hai danh sách nên làm mới cả hai danh sách và chi tiết.
 */
export function useSetConversationState() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, patch }: { conversationId: string; patch: ConversationStatePatch }) =>
      setConversationState(conversationId, patch),
    onSuccess: (_data, { conversationId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingConversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingArchivedConversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingConversationDetail(conversationId) });
    },
  });
}

/**
 * Đột biến đánh dấu đã đọc một hội thoại (POST .../read).
 * Đột biến này được gọi theo từng tin đến khi hội thoại đang mở nên
 * KHÔNG invalidate danh sách (mỗi lần invalidate là một lần nạp lại
 * danh sách tổng hợp, và ảnh chụp nạp lại có thể ghi đè vá realtime
 * mới hơn); thay vào đó vá tại chỗ mục hội thoại trong cache danh
 * sách bằng chính đáp ứng (chưa đọc về 0, mốc đọc mới) và invalidate
 * khoá số chưa đọc của huy hiệu sidebar.
 */
export function useMarkConversationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => markConversationRead(conversationId),
    onSuccess: (res, conversationId) => {
      const applyRead = (old: ConversationView[] | undefined) =>
        old?.map((c) => (c.id === conversationId ? { ...c, unread: 0, lastReadSeq: res.lastReadSeq } : c));
      queryClient.setQueryData<ConversationView[]>(queryKeys.messagingConversations, applyRead);
      queryClient.setQueryData<ConversationView[]>(queryKeys.messagingArchivedConversations, applyRead);
      void queryClient.invalidateQueries({ queryKey: sharedQueryKeys.messageUnreadCount });
    },
  });
}

/** Đột biến chặn/bỏ chặn một liên hệ theo biến `block` (POST/DELETE /messages/contacts/:id/block) — đáp ứng là danh sách đã chặn mới nên vá thẳng vào cache, giữ nguyên phần hồ sơ kèm theo. */
export function useSetContactBlocked() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, block }: { userId: string; block: boolean }) => setContactBlocked(userId, block),
    onSuccess: (res) => {
      queryClient.setQueryData<{ blocked: string[]; profiles?: Record<string, PersonSummary> }>(
        queryKeys.messagingBlockedContacts,
        (old) => (old ? { ...old, blocked: res.blocked } : old),
      );
    },
  });
}

/**
 * Đột biến gửi một tin (POST .../messages) — thân mang clientMessageId chống trùng phía server.
 * Tin vừa gửi là hoạt động mới nhất của hội thoại: vá cache danh
 * sách (xem trước = tin vừa gửi, hội thoại lên đầu) bằng chính đáp
 * ứng; cửa sổ tin do tầng soạn tin vá vào cache chi tiết.
 */
export function useSendMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, body }: { conversationId: string; body: Record<string, unknown> }) =>
      sendMessage(conversationId, body),
    onSuccess: (saved, { conversationId }) => {
      queryClient.setQueryData<ConversationView[]>(queryKeys.messagingConversations, (old) => {
        if (!old) return old;
        const target = old.find((c) => c.id === conversationId);
        if (!target) return old;
        return [
          { ...target, lastMessage: saved, lastMessageSeq: saved.seq },
          ...old.filter((c) => c.id !== conversationId),
        ];
      });
    },
  });
}

/** Đột biến gửi yêu cầu kết bạn (POST /messages/contacts/:id) — trả pending hoặc accepted ngay; làm mới hàng chờ kết bạn và danh bạ (accepted thì danh bạ có thêm người). */
export function useSendContactRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => sendContactRequest(userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingContactRequests });
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingContacts });
    },
  });
}

/** Đột biến trả lời một yêu cầu kết bạn (POST /messages/contacts/requests/:id/accept|decline) — làm mới hàng chờ kết bạn và danh bạ. */
export function useRespondContactRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, action }: { userId: string; action: 'accept' | 'decline' }) =>
      respondContactRequest(userId, action),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingContactRequests });
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingContacts });
    },
  });
}

/** Đột biến mở hội thoại 1–1 với một liên hệ (POST /messages/conversations với memberIds) — làm mới danh sách hội thoại. */
export function useCreateDirectConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => createDirectConversation(userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingConversations });
    },
  });
}

/** Đột biến tạo/lấy hội thoại của một nhóm con trong khoá (POST /messages/conversations/group) — làm mới danh sách hội thoại và cây nhóm. */
export function useCreateGroupConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => createGroupConversation(groupId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingConversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingGroupTree });
    },
  });
}

/** Đột biến tạo nhóm tự do (POST /messages/conversations với type 2 + tên + thành viên) — làm mới danh sách hội thoại và cây nhóm. */
export function useCreateFreeGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, memberIds }: { name: string; memberIds: string[] }) => createFreeGroup(name, memberIds),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingConversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingGroupTree });
    },
  });
}

/** Đột biến báo cáo hội thoại đang mở (POST .../report) — làm mới chi tiết hội thoại để bề mặt hội thoại phản ánh trạng thái phía server mới nhất. */
export function useReportConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => reportConversation(conversationId),
    onSuccess: (_data, conversationId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagingConversationDetail(conversationId) });
    },
  });
}

/** Đột biến gỡ một thành viên khỏi nhóm tự do (DELETE .../members/:userId) — đáp ứng là hội thoại đã cập nhật nên vá thẳng vào cache danh sách và cache chi tiết. */
export function useRemoveConversationMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, userId }: { conversationId: string; userId: string }) =>
      removeConversationMember(conversationId, userId),
    onSuccess: (updated, { conversationId }) => {
      queryClient.setQueryData<ConversationView[]>(queryKeys.messagingConversations, (old) =>
        old?.map((c) => (c.id === conversationId ? { ...c, members: updated.members } : c)),
      );
      queryClient.setQueryData<ConversationDetailView>(queryKeys.messagingConversationDetail(conversationId), (old) =>
        old ? { ...old, ...updated } : old,
      );
    },
  });
}

/** Đột biến bật/tắt chat của hội thoại (PATCH /messages/conversations/:id với enabled) — đáp ứng là hội thoại đã cập nhật nên vá thẳng vào cache danh sách và cache chi tiết. */
export function useSetConversationEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, enabled }: { conversationId: string; enabled: boolean }) =>
      setConversationEnabled(conversationId, enabled),
    onSuccess: (updated, { conversationId }) => {
      queryClient.setQueryData<ConversationView[]>(queryKeys.messagingConversations, (old) =>
        old?.map((c) => (c.id === conversationId ? { ...c, enabled: updated.enabled } : c)),
      );
      queryClient.setQueryData<ConversationDetailView>(queryKeys.messagingConversationDetail(conversationId), (old) =>
        old ? { ...old, ...updated } : old,
      );
    },
  });
}

/** Đột biến xoá-phía-mình một tin (DELETE /messages/:id) — trả dòng tin kèm dấu vết xoá; đáp ứng được tầng kiểm duyệt của trang vá vào cache chi tiết hội thoại (đột biến chỉ mang id tin, xem ghi chú đầu file). */
export function useDeleteMessageForMe() {
  return useMutation({
    mutationFn: (messageId: string) => deleteMessageForMe(messageId),
  });
}

/** Đột biến thu hồi tin của mình cho mọi người (POST /messages/:id/recall) — đáp ứng được tầng kiểm duyệt của trang vá vào cache chi tiết hội thoại. */
export function useRecallMessage() {
  return useMutation({
    mutationFn: (messageId: string) => recallMessage(messageId),
  });
}

/** Đột biến xoá cứng một tin kèm lý do bắt buộc (POST /messages/:id/hard-delete) — việc gỡ khỏi cửa sổ do tầng kiểm duyệt của trang vá vào cache chi tiết hội thoại. */
export function useHardDeleteMessage() {
  return useMutation({
    mutationFn: ({ messageId, reason }: { messageId: string; reason: string }) => hardDeleteMessage(messageId, reason),
  });
}

/** Đột biến gỡ hàng loạt các tin đã chọn kèm lý do (POST /messages/bulk-remove) — việc gỡ khỏi cửa sổ do tầng kiểm duyệt của trang vá vào cache chi tiết hội thoại. */
export function useBulkRemoveMessages() {
  return useMutation({
    mutationFn: ({ messageIds, reason }: { messageIds: string[]; reason: string }) =>
      bulkRemoveMessages(messageIds, reason),
  });
}
