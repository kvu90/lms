import { apiJson } from '#lib/api';
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
} from '../types/types';

/**
 * Tầng gọi API thuần của trang Tin nhắn thuộc feature messaging:
 * chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay React
 * Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions và đột biến. Tách từ module dữ liệu phẳng
 * `src/lib/messaging-data.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 */

/**
 * Đọc cây nhóm của tab Nhóm (GET /messages/group-tree).
 *
 * @returns Cây nhóm.
 */
export function fetchMessagingGroupTree() {
  return apiJson<ConversationGroupTreeView>('/api/v1/messages/group-tree');
}

/**
 * Đọc danh sách hội thoại chính (GET /messages/conversations).
 *
 * @returns Danh sách hội thoại.
 */
export function fetchMessagingConversations() {
  return apiJson<ConversationView[]>('/api/v1/messages/conversations');
}

/**
 * Hồ sơ người phục vụ panel thông tin của chat 1–1 (issue #592,
 * GET /messages/users/:id/profile): chỉ các trường hệ có dữ kiện
 * nguồn — định danh, tên hiển thị, tên đăng nhập và email. Các
 * trường panel còn lại không có nguồn nên không nằm trong
 * response này (xem `person-profile-adapter.ts`).
 */
export interface PersonProfileServer {
  userId: string;
  displayName: string;
  username: string;
  email: string;
}

/**
 * Đọc hồ sơ người phục vụ panel thông tin của chat 1–1.
 *
 * @param userId - Người cần xem hồ sơ.
 * @returns Hồ sơ người từ dữ kiện thật của hệ.
 */
export function fetchMessagingPersonProfile(userId: string) {
  return apiJson<PersonProfileServer>(`/api/v1/messages/users/${userId}/profile`);
}

/**
 * Đọc danh sách hội thoại đã lưu (GET /messages/conversations?archived=true).
 *
 * @returns Danh sách hội thoại đã lưu.
 */
export function fetchMessagingArchivedConversations() {
  return apiJson<ConversationView[]>('/api/v1/messages/conversations?archived=true');
}

/**
 * Đọc danh sách người đã chặn kèm hồ sơ hiển thị (GET /messages/contacts/blocked).
 *
 * @returns Id đã chặn và hồ sơ kèm theo (khi có).
 */
export function fetchMessagingBlockedContacts() {
  return apiJson<{ blocked: string[]; profiles?: Record<string, PersonSummary> }>('/api/v1/messages/contacts/blocked');
}

/**
 * Đọc danh bạ đã duyệt kèm hồ sơ (GET /messages/contacts).
 *
 * @returns Id liên hệ và hồ sơ kèm theo (khi có).
 */
export function fetchMessagingContacts() {
  return apiJson<{ contacts: string[]; profiles?: Record<string, PersonSummary> }>('/api/v1/messages/contacts');
}

/**
 * Đọc hàng chờ kết bạn đến/đi (GET /messages/contacts/requests).
 *
 * @returns Hai hàng chờ kết bạn.
 */
export function fetchMessagingContactRequests() {
  return apiJson<{ incoming: ContactRequestView[]; outgoing: ContactRequestView[] }>(
    '/api/v1/messages/contacts/requests',
  );
}

/**
 * Đọc các khoá của người xem cho luồng tìm bạn theo khoá (GET /messages/courses).
 *
 * @returns Danh sách khoá của người xem.
 */
export function fetchMessagingCourses() {
  return apiJson<{ courses: MessagingCourse[] }>('/api/v1/messages/courses');
}

/**
 * Đọc chi tiết một hội thoại kèm cửa sổ tin gần nhất (GET /messages/conversations/:id).
 *
 * @param conversationId - Định danh hội thoại.
 * @returns Chi tiết hội thoại.
 */
export function fetchConversationDetail(conversationId: string) {
  return apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${conversationId}`);
}

/**
 * Đọc một cửa sổ tin cũ hơn theo mốc seq (GET /messages/conversations/:id/messages?beforeSeq=).
 *
 * @param conversationId - Định danh hội thoại.
 * @param beforeSeq - Mốc seq trên.
 * @returns Trang tin và cờ còn tin cũ hơn.
 */
export function fetchConversationMessagesPage(conversationId: string, beforeSeq: number) {
  return apiJson<{ messages: MessageView[]; hasMoreBefore: boolean }>(
    `/api/v1/messages/conversations/${conversationId}/messages?beforeSeq=${beforeSeq}&limit=50`,
  );
}

/**
 * Tìm nội dung trong một hội thoại (GET /messages/conversations/:id/search).
 *
 * @param conversationId - Định danh hội thoại.
 * @param q - Từ khoá tìm.
 * @returns Kết quả tìm.
 */
export function searchConversationMessages(conversationId: string, q: string) {
  return apiJson<{ results: MessageSearchResultView[] }>(
    `/api/v1/messages/conversations/${conversationId}/search?q=${encodeURIComponent(q)}&limit=50`,
  );
}

/**
 * Đọc một trang roster lớp/khoá theo URL đầy đủ (con trỏ do trang điều phối).
 *
 * @param url - URL đầy đủ của trang roster.
 * @returns Thành viên và con trỏ trang kế (khi có).
 */
export function fetchRosterPage(url: string) {
  return apiJson<{ members: RosterMember[]; nextCursor: string | null }>(url);
}

/**
 * Ensure chat cấp lớp (GET /messages/classes/:id/conversation).
 *
 * @param classId - Định danh lớp.
 * @returns Hội thoại của lớp.
 */
export function fetchClassConversation(classId: string) {
  return apiJson<ConversationView>(`/api/v1/messages/classes/${classId}/conversation`);
}

/**
 * Ensure chat cấp khoá (GET /messages/courses/:id/conversation).
 *
 * @param courseId - Định danh khoá.
 * @returns Hội thoại của khoá.
 */
export function fetchCourseConversation(courseId: string) {
  return apiJson<ConversationView>(`/api/v1/messages/courses/${courseId}/conversation`);
}

/**
 * Đặt cờ trạng thái cá nhân (ghim/lưu/tắt tiếng) — server trả trạng thái đầy đủ (PATCH .../state).
 *
 * @param conversationId - Định danh hội thoại.
 * @param patch - Bản vá trạng thái.
 * @returns Trạng thái đầy đủ sau khi đặt.
 */
export function setConversationState(conversationId: string, patch: ConversationStatePatch) {
  return apiJson<ConversationStateView>(`/api/v1/messages/conversations/${conversationId}/state`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/**
 * Đánh dấu đã đọc một hội thoại (POST .../read).
 *
 * @param conversationId - Định danh hội thoại.
 * @returns Số tin đã đánh dấu và mốc đọc mới.
 */
export function markConversationRead(conversationId: string) {
  return apiJson<{ marked: number; lastReadSeq: number }>(`/api/v1/messages/conversations/${conversationId}/read`, {
    method: 'POST',
    body: '{}',
  });
}

/**
 * Chặn/bỏ chặn một liên hệ theo biến `block` (POST/DELETE /messages/contacts/:id/block).
 *
 * @param userId - Định danh liên hệ.
 * @param block - true = chặn, false = bỏ chặn.
 * @returns Danh sách đã chặn mới.
 */
export function setContactBlocked(userId: string, block: boolean) {
  return apiJson<{ blocked: string[] }>(`/api/v1/messages/contacts/${userId}/block`, {
    method: block ? 'POST' : 'DELETE',
    ...(block ? { body: '{}' } : {}),
  });
}

/**
 * Gửi một tin (POST .../messages) — thân mang clientMessageId chống trùng phía server.
 *
 * @param conversationId - Định danh hội thoại.
 * @param body - Thân tin.
 * @returns Tin vừa gửi.
 */
export function sendMessage(conversationId: string, body: Record<string, unknown>) {
  return apiJson<MessageView>(`/api/v1/messages/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Gửi yêu cầu kết bạn (POST /messages/contacts/:id).
 *
 * @param userId - Định danh người nhận.
 * @returns Trạng thái pending hoặc accepted ngay.
 */
export function sendContactRequest(userId: string) {
  return apiJson<{ status: 'pending' | 'accepted' }>(`/api/v1/messages/contacts/${userId}`, {
    method: 'POST',
    body: '{}',
  });
}

/**
 * Trả lời một yêu cầu kết bạn (POST /messages/contacts/requests/:id/accept|decline).
 *
 * @param userId - Định danh người gửi yêu cầu.
 * @param action - accept hoặc decline.
 * @returns Đáp ứng của API.
 */
export function respondContactRequest(userId: string, action: 'accept' | 'decline') {
  return apiJson(`/api/v1/messages/contacts/requests/${userId}/${action}`, { method: 'POST', body: '{}' });
}

/**
 * Mở hội thoại 1–1 với một liên hệ (POST /messages/conversations với memberIds).
 *
 * @param userId - Định danh liên hệ.
 * @returns Hội thoại.
 */
export function createDirectConversation(userId: string) {
  return apiJson<ConversationView>('/api/v1/messages/conversations', {
    method: 'POST',
    body: JSON.stringify({ memberIds: [userId] }),
  });
}

/**
 * Tạo/lấy hội thoại của một nhóm con trong khoá (POST /messages/conversations/group).
 *
 * @param groupId - Định danh nhóm con.
 * @returns Hội thoại.
 */
export function createGroupConversation(groupId: string) {
  return apiJson<ConversationView>('/api/v1/messages/conversations/group', {
    method: 'POST',
    body: JSON.stringify({ groupId }),
  });
}

/**
 * Tạo nhóm tự do (POST /messages/conversations với type 2 + tên + thành viên).
 *
 * @param name - Tên nhóm.
 * @param memberIds - Danh sách thành viên.
 * @returns Hội thoại nhóm vừa tạo.
 */
export function createFreeGroup(name: string, memberIds: string[]) {
  return apiJson<ConversationView>('/api/v1/messages/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 2, name, memberIds }),
  });
}

/**
 * Báo cáo hội thoại đang mở (POST .../report).
 *
 * @param conversationId - Định danh hội thoại.
 * @returns Đáp ứng của API.
 */
export function reportConversation(conversationId: string) {
  return apiJson(`/api/v1/messages/conversations/${conversationId}/report`, { method: 'POST', body: '{}' });
}

/**
 * Gỡ một thành viên khỏi nhóm tự do (DELETE .../members/:userId).
 *
 * @param conversationId - Định danh hội thoại.
 * @param userId - Định danh thành viên.
 * @returns Hội thoại đã cập nhật.
 */
export function removeConversationMember(conversationId: string, userId: string) {
  return apiJson<ConversationView>(`/api/v1/messages/conversations/${conversationId}/members/${userId}`, {
    method: 'DELETE',
  });
}

/**
 * Bật/tắt chat của hội thoại (PATCH /messages/conversations/:id với enabled).
 *
 * @param conversationId - Định danh hội thoại.
 * @param enabled - Cờ bật/tắt.
 * @returns Hội thoại đã cập nhật.
 */
export function setConversationEnabled(conversationId: string, enabled: boolean) {
  return apiJson<ConversationView>(`/api/v1/messages/conversations/${conversationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
}

/**
 * Xoá-phía-mình một tin (DELETE /messages/:id).
 *
 * @param messageId - Định danh tin.
 * @returns Dòng tin kèm dấu vết xoá.
 */
export function deleteMessageForMe(messageId: string) {
  return apiJson<MessageView>(`/api/v1/messages/${messageId}`, { method: 'DELETE' });
}

/**
 * Thu hồi tin của mình cho mọi người (POST /messages/:id/recall).
 *
 * @param messageId - Định danh tin.
 * @returns Dòng tin sau khi thu hồi.
 */
export function recallMessage(messageId: string) {
  return apiJson<MessageView>(`/api/v1/messages/${messageId}/recall`, { method: 'POST', body: '{}' });
}

/**
 * Xoá cứng một tin kèm lý do bắt buộc (POST /messages/:id/hard-delete).
 *
 * @param messageId - Định danh tin.
 * @param reason - Lý do xoá.
 * @returns Đáp ứng của API.
 */
export function hardDeleteMessage(messageId: string, reason: string) {
  return apiJson(`/api/v1/messages/${messageId}/hard-delete`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/**
 * Gỡ hàng loạt các tin đã chọn kèm lý do (POST /messages/bulk-remove).
 *
 * @param messageIds - Danh sách tin.
 * @param reason - Lý do gỡ.
 * @returns Đáp ứng của API.
 */
export function bulkRemoveMessages(messageIds: string[], reason: string) {
  return apiJson('/api/v1/messages/bulk-remove', {
    method: 'POST',
    body: JSON.stringify({ messageIds, reason }),
  });
}
