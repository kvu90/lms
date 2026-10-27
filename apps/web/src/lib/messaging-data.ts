import { queryOptions, useMutation } from '@tanstack/react-query';
import { apiJson } from '#lib/api';
import { queryKeys } from '#lib/query-keys';
import type {
  ContactRequestView,
  ConversationDetailView,
  ConversationGroupTreeView,
  ConversationStatePatch,
  ConversationStateView,
  ConversationView,
  MessageSearchResultView,
  MessageView,
  MessagingCourse,
  PersonSummary,
  RosterMember,
} from '../components/messages/types';

/**
 * Tầng dữ liệu nhắn tin (F-01 của rà soát #133).
 *
 * Luồng nghiệp vụ: trang Tin nhắn là một MÁY TRẠNG THÁI THỜI GIAN
 * THỰC — danh sách hội thoại, khung tin, cây nhóm và danh bạ đều bị
 * sự kiện WebSocket (outbox của server) và thao tác lạc quan (gửi
 * tin kèm clientMessageId chống trùng) cập nhật liên tục tại chỗ,
 * nên trang GIỮ state của chính nó làm bề mặt hiển thị. Module này
 * gom toàn bộ lời gọi REST của trang về một chỗ theo khuôn TanStack
 * Query: các lượt ĐỌC đi qua queryOptions + khoá nhà máy (dedupe,
 * dùng lại cache khi nhiều điểm trong trang cùng xin một chi tiết
 * hội thoại/cửa sổ tin/roster), các lượt GHI là đột biến MỎNG không
 * tự làm mới cache — trang áp kết quả trả về vào state của nó đúng
 * như bản thủ công, kể cả các nhịp hợp nhất với sự kiện socket.
 * Kênh realtime (lib/messaging-socket) không đổi.
 *
 * Mọi options đều đặt `staleTime: 0`: các nhịp nạp của trang
 * (reload sau thao tác, đồng bộ khi có sự kiện invalidate, mở hội
 * thoại) phải luôn lấy số liệu tươi từ server như bản thủ công —
 * cache của TanStack ở đây chỉ khử trùng lặp lời gọi đồng thời,
 * không giữ dữ liệu cũ qua các nhịp nạp.
 */

/** Cây nhóm của tab Nhóm (GET /messages/group-tree). */
export function messagingGroupTreeQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingGroupTree,
    staleTime: 0,
    queryFn: () => apiJson<ConversationGroupTreeView>('/api/v1/messages/group-tree'),
  });
}

/** Danh sách hội thoại chính (GET /messages/conversations). */
export function messagingConversationsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingConversations,
    staleTime: 0,
    queryFn: () => apiJson<ConversationView[]>('/api/v1/messages/conversations'),
  });
}

/** Danh sách hội thoại đã lưu (GET /messages/conversations?archived=true). */
export function messagingArchivedConversationsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingArchivedConversations,
    staleTime: 0,
    queryFn: () => apiJson<ConversationView[]>('/api/v1/messages/conversations?archived=true'),
  });
}

/** Danh sách người đã chặn kèm hồ sơ hiển thị (GET /messages/contacts/blocked). */
export function messagingBlockedContactsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingBlockedContacts,
    staleTime: 0,
    queryFn: () =>
      apiJson<{ blocked: string[]; profiles?: Record<string, PersonSummary> }>('/api/v1/messages/contacts/blocked'),
  });
}

/** Danh bạ đã duyệt kèm hồ sơ (GET /messages/contacts). */
export function messagingContactsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingContacts,
    staleTime: 0,
    queryFn: () =>
      apiJson<{ contacts: string[]; profiles?: Record<string, PersonSummary> }>('/api/v1/messages/contacts'),
  });
}

/** Hàng chờ kết bạn đến/đi (GET /messages/contacts/requests). */
export function messagingContactRequestsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingContactRequests,
    staleTime: 0,
    queryFn: () =>
      apiJson<{ incoming: ContactRequestView[]; outgoing: ContactRequestView[] }>(
        '/api/v1/messages/contacts/requests',
      ),
  });
}

/** Các khoá của người xem cho luồng tìm bạn theo khoá (GET /messages/courses). */
export function messagingCoursesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.messagingCourses,
    staleTime: 0,
    queryFn: () => apiJson<{ courses: MessagingCourse[] }>('/api/v1/messages/courses'),
  });
}

/** Chi tiết một hội thoại kèm cửa sổ tin gần nhất (GET /messages/conversations/:id). */
export function conversationDetailQueryOptions(conversationId: string) {
  return queryOptions({
    queryKey: queryKeys.messagingConversationDetail(conversationId),
    staleTime: 0,
    queryFn: () => apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${conversationId}`),
  });
}

/** Một cửa sổ tin cũ hơn theo mốc seq (GET /messages/conversations/:id/messages?beforeSeq=). */
export function conversationMessagesPageQueryOptions(conversationId: string, beforeSeq: number) {
  return queryOptions({
    queryKey: queryKeys.messagingMessagesPage(conversationId, beforeSeq),
    staleTime: 0,
    queryFn: () =>
      apiJson<{ messages: MessageView[]; hasMoreBefore: boolean }>(
        `/api/v1/messages/conversations/${conversationId}/messages?beforeSeq=${beforeSeq}&limit=50`,
      ),
  });
}

/** Tìm nội dung trong một hội thoại (GET /messages/conversations/:id/search). */
export function messageSearchQueryOptions(conversationId: string, q: string) {
  return queryOptions({
    queryKey: queryKeys.messagingSearch(conversationId, q),
    staleTime: 0,
    queryFn: () =>
      apiJson<{ results: MessageSearchResultView[] }>(
        `/api/v1/messages/conversations/${conversationId}/search?q=${encodeURIComponent(q)}&limit=50`,
      ),
  });
}

/** Một trang roster lớp/khoá theo URL đầy đủ (con trỏ do trang điều phối). */
export function rosterPageQueryOptions(url: string) {
  return queryOptions({
    queryKey: queryKeys.messagingRosterPage(url),
    staleTime: 0,
    queryFn: () => apiJson<{ members: RosterMember[]; nextCursor: string | null }>(url),
  });
}

/** Ensure chat cấp lớp (GET /messages/classes/:id/conversation). */
export function classConversationQueryOptions(classId: string) {
  return queryOptions({
    queryKey: queryKeys.messagingClassConversation(classId),
    staleTime: 0,
    queryFn: () => apiJson<ConversationView>(`/api/v1/messages/classes/${classId}/conversation`),
  });
}

/** Ensure chat cấp khoá (GET /messages/courses/:id/conversation) — dùng chung khoá factory `courseConversation` với trang quản trị khoá. */
export function courseConversationQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseConversation(courseId),
    staleTime: 0,
    queryFn: () => apiJson<ConversationView>(`/api/v1/messages/courses/${courseId}/conversation`),
  });
}

/** Đột biến đặt cờ trạng thái cá nhân (ghim/lưu/tắt tiếng) — server trả trạng thái đầy đủ (PATCH .../state). */
export function useSetConversationState() {
  return useMutation({
    mutationFn: ({ conversationId, patch }: { conversationId: string; patch: ConversationStatePatch }) =>
      apiJson<ConversationStateView>(`/api/v1/messages/conversations/${conversationId}/state`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
  });
}

/** Đột biến đánh dấu đã đọc một hội thoại (POST .../read). */
export function useMarkConversationRead() {
  return useMutation({
    mutationFn: (conversationId: string) =>
      apiJson<{ marked: number; lastReadSeq: number }>(`/api/v1/messages/conversations/${conversationId}/read`, {
        method: 'POST',
        body: '{}',
      }),
  });
}

/** Đột biến chặn/bỏ chặn một liên hệ theo biến `block` (POST/DELETE /messages/contacts/:id/block). */
export function useSetContactBlocked() {
  return useMutation({
    mutationFn: ({ userId, block }: { userId: string; block: boolean }) =>
      apiJson<{ blocked: string[] }>(`/api/v1/messages/contacts/${userId}/block`, {
        method: block ? 'POST' : 'DELETE',
        ...(block ? { body: '{}' } : {}),
      }),
  });
}

/** Đột biến gửi một tin (POST .../messages) — thân mang clientMessageId chống trùng phía server. */
export function useSendMessage() {
  return useMutation({
    mutationFn: ({ conversationId, body }: { conversationId: string; body: Record<string, unknown> }) =>
      apiJson<MessageView>(`/api/v1/messages/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

/** Đột biến gửi yêu cầu kết bạn (POST /messages/contacts/:id) — trả pending hoặc accepted ngay. */
export function useSendContactRequest() {
  return useMutation({
    mutationFn: (userId: string) =>
      apiJson<{ status: 'pending' | 'accepted' }>(`/api/v1/messages/contacts/${userId}`, {
        method: 'POST',
        body: '{}',
      }),
  });
}

/** Đột biến trả lời một yêu cầu kết bạn (POST /messages/contacts/requests/:id/accept|decline). */
export function useRespondContactRequest() {
  return useMutation({
    mutationFn: ({ userId, action }: { userId: string; action: 'accept' | 'decline' }) =>
      apiJson(`/api/v1/messages/contacts/requests/${userId}/${action}`, { method: 'POST', body: '{}' }),
  });
}

/** Đột biến mở hội thoại 1–1 với một liên hệ (POST /messages/conversations với memberIds). */
export function useCreateDirectConversation() {
  return useMutation({
    mutationFn: (userId: string) =>
      apiJson<ConversationView>('/api/v1/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ memberIds: [userId] }),
      }),
  });
}

/** Đột biến tạo/lấy hội thoại của một nhóm con trong khoá (POST /messages/conversations/group). */
export function useCreateGroupConversation() {
  return useMutation({
    mutationFn: (groupId: string) =>
      apiJson<ConversationView>('/api/v1/messages/conversations/group', {
        method: 'POST',
        body: JSON.stringify({ groupId }),
      }),
  });
}

/** Đột biến tạo nhóm tự do (POST /messages/conversations với type 2 + tên + thành viên). */
export function useCreateFreeGroup() {
  return useMutation({
    mutationFn: ({ name, memberIds }: { name: string; memberIds: string[] }) =>
      apiJson<ConversationView>('/api/v1/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ type: 2, name, memberIds }),
      }),
  });
}

/** Đột biến báo cáo hội thoại đang mở (POST .../report). */
export function useReportConversation() {
  return useMutation({
    mutationFn: (conversationId: string) =>
      apiJson(`/api/v1/messages/conversations/${conversationId}/report`, { method: 'POST', body: '{}' }),
  });
}

/** Đột biến gỡ một thành viên khỏi nhóm tự do (DELETE .../members/:userId) — trả hội thoại đã cập nhật. */
export function useRemoveConversationMember() {
  return useMutation({
    mutationFn: ({ conversationId, userId }: { conversationId: string; userId: string }) =>
      apiJson<ConversationView>(`/api/v1/messages/conversations/${conversationId}/members/${userId}`, {
        method: 'DELETE',
      }),
  });
}

/** Đột biến bật/tắt chat của hội thoại (PATCH /messages/conversations/:id với enabled). */
export function useSetConversationEnabled() {
  return useMutation({
    mutationFn: ({ conversationId, enabled }: { conversationId: string; enabled: boolean }) =>
      apiJson<ConversationView>(`/api/v1/messages/conversations/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
  });
}

/** Đột biến xoá-phía-mình một tin (DELETE /messages/:id) — trả dòng tin kèm dấu vết xoá. */
export function useDeleteMessageForMe() {
  return useMutation({
    mutationFn: (messageId: string) =>
      apiJson<MessageView>(`/api/v1/messages/${messageId}`, { method: 'DELETE' }),
  });
}

/** Đột biến thu hồi tin của mình cho mọi người (POST /messages/:id/recall). */
export function useRecallMessage() {
  return useMutation({
    mutationFn: (messageId: string) =>
      apiJson<MessageView>(`/api/v1/messages/${messageId}/recall`, { method: 'POST', body: '{}' }),
  });
}

/** Đột biến xoá cứng một tin kèm lý do bắt buộc (POST /messages/:id/hard-delete). */
export function useHardDeleteMessage() {
  return useMutation({
    mutationFn: ({ messageId, reason }: { messageId: string; reason: string }) =>
      apiJson(`/api/v1/messages/${messageId}/hard-delete`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
  });
}

/** Đột biến gỡ hàng loạt các tin đã chọn kèm lý do (POST /messages/bulk-remove). */
export function useBulkRemoveMessages() {
  return useMutation({
    mutationFn: ({ messageIds, reason }: { messageIds: string[]; reason: string }) =>
      apiJson('/api/v1/messages/bulk-remove', {
        method: 'POST',
        body: JSON.stringify({ messageIds, reason }),
      }),
  });
}
