import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Sse, type MessageEvent } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { MessagingService } from './messaging.service';
import { bulkRemoveMessagesSchema, createConversationSchema, createGroupConversationSchema, hardDeleteMessageSchema, listConversationsQueryServerSchema, listCourseRosterQueryServerSchema, listMessagesQueryServerSchema, listNotificationGroupsQueryServerSchema, listNotificationItemsQueryServerSchema, notifyUserSchema, readNotificationGroupSchema, reportConversationSchema, searchMessagesQueryServerSchema, sendMessageSchema, setNotificationCourseOverrideSchema, setNotificationPreferenceSchema, updateConversationSchema, updateConversationStateSchema, updateReportStatusSchema, type BulkRemoveMessagesDto, type CreateConversationDto, type CreateGroupConversationDto, type HardDeleteMessageDto, type ListConversationsQueryDto, type ListCourseRosterQueryDto, type ListMessagesQueryDto, type ListNotificationGroupsQueryDto, type ListNotificationItemsQueryDto, type NotifyDto, type ReadNotificationGroupDto, type ReportConversationDto, type SearchMessagesQueryDto, type SendMessageDto, type SetCourseOverrideDto, type SetPreferenceDto, type UpdateConversationDto, type UpdateConversationStateDto, type UpdateReportStatusDto } from './dto/messaging.dto';

@ApiTags('messaging')
@Controller({ path: 'messages', version: '1' })
/**
 * API nhắn tin: conversation, tin nhắn, chặn liên hệ.
 */
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Post('conversations')
  /**
   * POST /messages/conversations — tạo conversation.
   */
  async createConversation(@Body({ schema: createConversationSchema }) dto: CreateConversationDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.createConversation(actor.id, dto);
  }
  @Post('conversations/group')
  /**
   * POST /messages/conversations/group — tạo (hoặc lấy lại) conversation gắn với một course group.
   */
  async createGroupConversation(@Body({ schema: createGroupConversationSchema }) dto: CreateGroupConversationDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.createGroupConversation(actor.id, dto);
  }
  @Get('conversations')
  /**
   * GET /messages/conversations — conversation của tôi: đã ghim lên
   * đầu, còn lại theo hoạt động gần nhất. Mặc định chỉ mục CHƯA lưu
   * trữ; `?archived=true` xem riêng mục ĐÃ LƯU (lát M5, issue #240).
   */
  async listConversations(@Query({ schema: listConversationsQueryServerSchema }) query: ListConversationsQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listConversations(actor.id, { archivedOnly: query.archived });
  }
  @Patch('conversations/:id/state')
  /**
   * PATCH /messages/conversations/:id/state — đặt trạng thái cá nhân
   * của CHÍNH tôi trên conversation (lát M5, issue #240): ghim
   * (`pinned`), lưu trữ (`archived`), tắt tiếng (`muted`) — ba cờ
   * độc lập, chỉ trường có mặt mới đổi. Người ngoài nhận 404 như
   * conversation không tồn tại.
   */
  async updateConversationState(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateConversationStateSchema }) dto: UpdateConversationStateDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.updateConversationState(actor.id, id, dto);
  }
  @Get('conversations/:id')
  /**
   * GET /messages/conversations/:id — chi tiết + tin nhắn.
   */
  async getConversation(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.getConversation(actor.id, id);
  }
  @Get('conversations/:id/messages')
  /**
   * GET /messages/conversations/:id/messages — một cửa sổ tin theo
   * cursor seq: beforeSeq tải lịch sử cũ, afterSeq lấy phần thiếu khi
   * đồng bộ lại, limit chặn kích thước cửa sổ (mặc định 50).
   */
  async listMessages(@Param('id', { schema: uuidIdSchema }) id: string, @Query({ schema: listMessagesQueryServerSchema }) query: ListMessagesQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listConversationMessages(actor.id, id, query);
  }
  @Get('conversations/:id/search')
  /**
   * GET /messages/conversations/:id/search — tìm nội dung tin TRONG
   * một conversation (lát M4, issue #237): chỉ thành viên của chính
   * conversation đó, kết quả chỉ chứa tin còn hiển thị được với người
   * tìm. Tìm kiếm tin CHỈ tồn tại ở bề mặt này — không có index nội
   * dung tin vào search toàn cục.
   */
  async searchMessages(@Param('id', { schema: uuidIdSchema }) id: string, @Query({ schema: searchMessagesQueryServerSchema }) query: SearchMessagesQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.searchConversationMessages(actor.id, id, query);
  }
  @Post('conversations/:id/messages')
  /**
   * POST /messages/conversations/:id/messages — gửi tin nhắn (handler send của NotificationsController là POST /notifications/send).
   */
  async send(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: sendMessageSchema }) dto: SendMessageDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.sendMessage(actor.id, id, dto);
  }
  @Post('conversations/:id/read')
  /**
   * POST /messages/conversations/:id/read — đánh dấu đã đọc.
   */
  async markRead(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.markConversationRead(actor.id, id);
  }
  @Patch('conversations/:id')
  /**
   * PATCH /messages/conversations/:id — bật/tắt chat của conversation
   * (Lớp B, issue #33): chỉ người có thẩm quyền quản lý theo phạm vi
   * khoá (giáo viên phụ trách/staff, quản trị viên, hoặc người tạo
   * nhóm tự do) mới đổi được.
   */
  async updateConversation(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateConversationSchema }) dto: UpdateConversationDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.updateConversation(actor.id, id, dto);
  }
  @Post('conversations/:id/report')
  /**
   * POST /messages/conversations/:id/report — báo cáo một conversation
   * (Lớp B, issue #33): chỉ thành viên báo cáo được; báo cáo về hàng
   * đợi của giáo viên phụ trách + quản trị viên.
   */
  async reportConversation(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: reportConversationSchema }) dto: ReportConversationDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.reportConversation(actor.id, id, dto.reason);
  }
  @Get('reports')
  /**
   * GET /messages/reports — hàng đợi báo cáo TRONG THẨM QUYỀN của tôi:
   * quản trị viên thấy tất cả, giáo viên chỉ thấy báo cáo thuộc khoá
   * mình phụ trách, người khác thấy danh sách rỗng.
   */
  async listReports(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listReports(actor.id);
  }
  @Get('reports/:reportId/conversation')
  /**
   * GET /messages/reports/:reportId/conversation — xem lại nội dung
   * của ĐÚNG conversation bị báo cáo (gồm tin đã xoá mềm), chỉ dành
   * cho người có thẩm quyền theo phạm vi; mọi lần xem ghi event_log.
   */
  async getReportConversation(@Param('reportId', { schema: uuidIdSchema }) reportId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.getReportConversation(actor.id, reportId);
  }
  @Patch('reports/:reportId')
  /**
   * PATCH /messages/reports/:reportId — đổi trạng thái xử lý của một
   * báo cáo (open/resolved/dismissed), cùng phạm vi thẩm quyền với
   * đường xem lại nội dung.
   */
  async updateReportStatus(@Param('reportId', { schema: uuidIdSchema }) reportId: string, @Body({ schema: updateReportStatusSchema }) dto: UpdateReportStatusDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.updateReportStatus(actor.id, reportId, dto.status);
  }
  /**
   * Sửa tin đã gửi vẫn bị từ chối (chính sách Lớp B của issue #33 chỉ
   * nới XOÁ theo mô hình xoá mềm có truy vết, không nới sửa nội dung).
   */
  @Patch('messages/:id')
  /**
   * PATCH /messages/messages/:id — sửa tin nhắn.
   */
  async updateMessage() { return this.messaging.updateMessage(); }
  @Delete('messages/:id')
  /**
   * DELETE /messages/messages/:id — XOÁ-PHÍA-MÌNH (vòng đời tin nhắn
   * theo vai, issue #33): chỉ tác giả, mọi lúc — tin chỉ ẩn khỏi tầm
   * nhìn của chính người xoá (cờ cá nhân), phía kia không đổi. Gỡ cho
   * mọi người đi hai đường riêng: thu hồi trong cửa sổ (tác giả) và
   * xoá cứng (moderator có `moderation:manage`).
   */
  async deleteMessage(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.deleteMessage(actor.id, id);
  }
  @Post('messages/:id/recall')
  /**
   * POST /messages/messages/:id/recall — THU HỒI tin cho mọi người:
   * chỉ tác giả, chỉ trong cửa sổ site-config
   * `core/messagingrecallwindowminutes` (mặc định 15 phút từ lúc
   * gửi); nội dung bị vô hiệu với mọi thành viên thường và một dòng
   * moderator_action 'recall' được ghi làm dấu vết.
   */
  async recallMessage(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.recallMessage(actor.id, id);
  }
  @Post('messages/:id/hard-delete')
  /**
   * POST /messages/messages/:id/hard-delete — XOÁ CỨNG một tin: chỉ
   * người có capability `moderation:manage` trong phạm vi của
   * conversation, lý do bắt buộc trong body; dòng tin bị xoá vật lý
   * và một moderator_action 'hard_delete' kèm lý do được ghi trước.
   */
  async hardDeleteMessage(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: hardDeleteMessageSchema }) dto: HardDeleteMessageDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.hardDeleteMessage(actor.id, id, dto);
  }
  @Post('messages/bulk-remove')
  /**
   * POST /messages/messages/bulk-remove — GỠ HÀNG LOẠT nhiều tin:
   * cùng cổng thẩm quyền `moderation:manage` và lý do bắt buộc như
   * xoá cứng một tin; toàn bộ danh sách được kiểm tra thẩm quyền
   * trước — một tin ngoài phạm vi là cả yêu cầu bị từ chối.
   */
  async bulkRemoveMessages(@Body({ schema: bulkRemoveMessagesSchema }) dto: BulkRemoveMessagesDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.bulkRemoveMessages(actor.id, dto);
  }

  @Get('unread-count')
  /**
   * GET /messages/unread-count (và /notifications/unread-count) — số chưa đọc.
   */
  async unread(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.unreadCounts(actor.id);
  }
  @Get('preferences')
  /**
   * GET /messages/preferences — tuỳ chọn thông báo v2 của tôi (một dòng mỗi provider, kèm nhãn/mô tả từ registry).
   * Học sinh (NB-7) chỉ nhận phần tối thiểu: danh sách rỗng — bề mặt của họ là ghi đè theo khoá ở dưới.
   */
  async preferences(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.getPreferences(actor.id);
  }
  @Put('preferences')
  /**
   * PUT /messages/preferences — đặt tuỳ chọn v2 cho một provider (popup và/hoặc tần suất email).
   * Chỉ giáo viên/nhân sự: học sinh nhận 403 `messaging.preference_staff_only` ngay ở server (NB-7).
   */
  async setPreference(@Body({ schema: setNotificationPreferenceSchema }) dto: SetPreferenceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.setPreference(actor.id, dto);
  }
  @Get('preferences/courses')
  /**
   * GET /messages/preferences/courses — ghi đè thông báo theo khoá
   * của tôi (NB-4, issue #174): mọi khoá tôi thuộc về kèm chế độ hiệu
   * lực ('all' | 'mute') — dữ liệu của trang "Ngoại lệ" trong cài đặt.
   */
  async courseOverrides(@CurrentUser() actor: AuthenticatedUser) {
    return { courses: await this.messaging.listCourseNotificationOverrides(actor.id) };
  }
  @Put('preferences/courses')
  /**
   * PUT /messages/preferences/courses — đặt ghi đè cho một khoá
   * ('all' | 'mute'); khoá không thuộc về tôi nhận 404 như không tồn tại.
   */
  async setCourseOverride(@Body({ schema: setNotificationCourseOverrideSchema }) dto: SetCourseOverrideDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.setCourseNotificationOverride(actor.id, dto);
  }
  @Get('courses')
  /**
   * GET /messages/courses — các khoá TÔI thuộc về (ghi danh hiệu lực
   * hoặc gán vai tại context khoá): bước chọn khoá của luồng tìm bạn
   * theo danh sách thành viên (mô hình đã chốt lại 24/10/2026 trên
   * issue #33 — tìm người theo tên đã GỠ hẳn, endpoint
   * /messages/people/search không còn tồn tại).
   */
  async myCourses(@CurrentUser() actor: AuthenticatedUser) {
    return { courses: await this.messaging.listMyMessagingCourses(actor.id) };
  }
  @Get('courses/:courseId/members')
  /**
   * GET /messages/courses/:courseId/members — một trang roster thành
   * viên của khoá (phân trang con trỏ theo (displayName, username,
   * id), trần 100 dòng/trang). Chỉ thành viên của chính khoá đó xem
   * được; người ngoài khoá nhận 404 y hệt khoá không tồn tại. Mỗi
   * dòng kèm dấu hiệu vai trò (teacher/student) và trạng thái quan
   * hệ với người xem để hiện hành động kết bạn đúng trạng thái.
   */
  async courseRoster(
    @Param('courseId', { schema: uuidIdSchema }) courseId: string,
    @Query({ schema: listCourseRosterQueryServerSchema }) query: ListCourseRosterQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.messaging.listCourseRoster(actor.id, courseId, query);
  }
  @Get('courses/:courseId/conversation')
  /**
   * GET /messages/courses/:courseId/conversation — mở (ensure) CHAT
   * TOÀN LỚP của khoá: cấp phát lười idempotent conversation cấp khoá
   * (type 2, gắn itemType 'course') và trả conversation kèm members —
   * đầu vào cho trang khoá, cài đặt khoá (đọc cờ `enabled`) và deep-link
   * trang Tin nhắn. Chỉ thành viên khoá (ghi danh hiệu lực/gán vai tại
   * context khoá) hoặc staff khoá mở được; người ngoài nhận 404 như
   * khoá không tồn tại.
   */
  async courseConversation(
    @Param('courseId', { schema: uuidIdSchema }) courseId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.messaging.ensureCourseConversation(actor.id, courseId);
  }
  @Get('contacts')
  /**
   * GET /messages/contacts — danh bạ của tôi (chỉ liên hệ đã được
   * duyệt), kèm `profiles`: tên hiển thị + username theo từng id để
   * client hiện TÊN thay cho UUID thô.
   */
  async contacts(@CurrentUser() actor: AuthenticatedUser) {
    const contacts = await this.messaging.listContacts(actor.id);
    return { contacts, profiles: await this.messaging.profilesFor(contacts) };
  }
  @Get('contacts/requests')
  /**
   * GET /messages/contacts/requests — yêu cầu kết bạn đến (chờ tôi
   * duyệt) và yêu cầu tôi đã gửi (đang chờ phía kia duyệt).
   */
  async contactRequests(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listContactRequests(actor.id);
  }
  @Post('contacts/requests/:userId/accept')
  /**
   * POST /messages/contacts/requests/:userId/accept — chấp nhận yêu
   * cầu kết bạn từ :userId; quan hệ hình thành ở cả hai phía.
   */
  async acceptContactRequest(@Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.acceptContactRequest(actor.id, userId);
  }
  @Post('contacts/requests/:userId/decline')
  /**
   * POST /messages/contacts/requests/:userId/decline — từ chối yêu
   * cầu kết bạn từ :userId.
   */
  async declineContactRequest(@Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.declineContactRequest(actor.id, userId);
  }
  @Post('contacts/:userId')
  /**
   * POST /messages/contacts/:userId — GỬI YÊU CẦU kết bạn tới một user
   * (luồng yêu cầu–chấp nhận thay danh bạ một chiều: quan hệ chỉ hình
   * thành khi phía kia chấp nhận; phía kia đã xin trước thì yêu cầu
   * này chấp nhận luôn yêu cầu của họ).
   */
  async requestContact(@Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.requestContact(actor.id, userId);
  }
  @Delete('contacts/:userId')
  /**
   * DELETE /messages/contacts/:userId — gỡ một user khỏi danh bạ của tôi.
   */
  async removeContact(@Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.removeContact(actor.id, userId);
  }
  @Get('contacts/blocked')
  /**
   * GET /messages/contacts/blocked — liên hệ bị chặn, kèm `profiles`
   * (tên hiển thị + username theo từng id) như danh bạ.
   */
  async blocked(@CurrentUser() actor: AuthenticatedUser) {
    const blocked = await this.messaging.listBlocked(actor.id);
    return { blocked, profiles: await this.messaging.profilesFor(blocked) };
  }
  @Post('contacts/:userId/block')
  /**
   * POST /messages/contacts/:userId/block — chặn liên hệ.
   */
  async block(@Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.blockContact(actor.id, userId);
  }
  @Delete('contacts/:userId/block')
  /**
   * DELETE /messages/contacts/:userId/block — bỏ chặn.
   */
  async unblock(@Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.unblockContact(actor.id, userId);
  }
}

@ApiTags('notifications')
@Controller({ path: 'notifications', version: '1' })
/**
 * API thông báo: danh sách, chưa đọc, tuỳ chọn kênh và gửi (nội bộ).
 */
export class NotificationsController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  /**
   * GET /notifications — trung tâm thông báo v2 (issue #51): danh
   * sách GỘP theo (loại × nguồn × ngày), phân trang con trỏ, lọc
   * theo 3 nhóm (`group`) và trạng thái chưa đọc (`unreadOnly`).
   */
  async list(@Query({ schema: listNotificationGroupsQueryServerSchema }) query: ListNotificationGroupsQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listNotificationGroups(actor.id, query);
  }
  @Get('items')
  /**
   * GET /notifications/items — danh sách PHẲNG phân trang con trỏ:
   * mở chi tiết một dòng gộp bằng bộ lọc (eventType + contextUrl +
   * day), hoặc lọc theo nhóm/chưa đọc.
   */
  async items(@Query({ schema: listNotificationItemsQueryServerSchema }) query: ListNotificationItemsQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listNotificationItems(actor.id, query);
  }
  @Get('unread-count')
  async unread(@CurrentUser() actor: AuthenticatedUser) {
    return { unread: await this.messaging.unreadNotificationCount(actor.id) };
  }
  @Sse('unread-count/stream')
  /**
   * GET /notifications/unread-count/stream — stream SSE số chưa đọc của
   * chính user: sự kiện `unread-count` đầu tiên là số hiện tại, các sự
   * kiện sau đẩy mỗi khi số thay đổi; heartbeat giữ kết nối. EventSource
   * không đặt được header Authorization nên riêng route này JWT strategy
   * nhận thêm access token qua query `access_token` (xem strategies.ts
   * của module auth) — Bearer header vẫn được ưu tiên khi có.
   */
  unreadCountStream(@CurrentUser() actor: AuthenticatedUser): Observable<MessageEvent> {
    return this.messaging.unreadCountStream(actor.id);
  }
  @Get('dispatch-log')
  /**
   * GET /notifications/dispatch-log — nhật ký phân phối.
   */
  async dispatchLog(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listDispatchLog(actor.id);
  }
  @Post('send')
  async send(@Body({ schema: notifyUserSchema }) dto: NotifyDto, @CurrentUser() actor: AuthenticatedUser) {
    // System-trigger endpoint (used by other subsystems/tests): site admins
    // only; delivery law lives in MessagingService.notify.
    return this.messaging.sendSystemNotification(actor.id, dto);
  }
  @Post('read-all')
  /**
   * POST /notifications/read-all — đánh dấu tất cả đã đọc.
   */
  async readAll(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.markAllNotificationsRead(actor.id);
  }
  @Post('read-group')
  /**
   * POST /notifications/read-group — đánh dấu đã đọc HÀNG LOẠT theo
   * khoá gộp (loại × nguồn × ngày) của trung tâm v2.
   */
  async readGroup(@Body({ schema: readNotificationGroupSchema }) dto: ReadNotificationGroupDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.markNotificationGroupRead(actor.id, dto);
  }
  @Post('clear-read')
  /**
   * POST /notifications/clear-read — dọn mọi thông báo ĐÃ ĐỌC của tôi.
   */
  async clearRead(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.clearReadNotifications(actor.id);
  }
  @Post(':id/read')
  /**
   * POST /notifications/:id/read — đánh dấu một thông báo đã đọc.
   */
  async read(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.markNotificationRead(actor.id, id);
  }
  @Delete(':id')
  /**
   * DELETE /notifications/:id — xoá một thông báo của chính mình
   * (trung tâm v2); thông báo của người khác trả 404 như không tồn tại.
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.deleteNotification(actor.id, id);
  }
}
