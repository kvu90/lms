import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { I18nService } from '@nestjs/i18n';
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  assignGrades,
  assignSubmissions,
  assignments,
  context,
  course,
  courseModules,
  enrol,
  examAttempts,
  examPins,
  examVersions,
  gradeGrades,
  gradeItems,
  message,
  messageConversationMembers,
  messageConversations,
  messageUsersBlocked,
  notifications,
  role,
  roleAssignments,
  tenantMemberships,
  tenants,
  userEnrolments,
  users,
} from '@lms/db';
import type { relations } from './db/relations';
import { NotificationDeliveryService } from './notification-delivery.service';

type Database = NodePgDatabase<typeof relations>;

/**
 * Mười loại sự kiện outbox mà consumer thông báo sự kiện xử lý.
 * Bảng định tuyến của relay ánh xạ cả mười loại này vào hàng đợi
 * `notification-events`; processor chỉ nhận diện đúng tập này.
 */
export const NOTIFICATION_EVENT_TYPES = [
  'grade_updated',
  'course_completed',
  'enrol_expiry_warning',
  'message_sent',
  'activity_due_reminder',
  'assignment_created',
  'assignment_submitted',
  'assignment_returned',
  'exam_pinned',
  'quiz_attempt_finished',
] as const;

/** Các loại grade item KHÔNG sinh thông báo điểm: tổng khoá, tổng hạng mục, item công thức. */
const NON_NOTIFIED_ITEM_TYPES = new Set(['course', 'category', 'calculated']);

/** Archetype vai trò được coi là đội ngũ phụ trách khoá khi phát thông báo cho giáo viên. */
const STAFF_ARCHETYPES = ['manager', 'coursecreator', 'editingteacher', 'teacher'] as const;

/**
 * Tên hiển thị của một user: họ tên đã trim, rỗng thì dùng username.
 *
 * @param user Dòng user tối thiểu gồm họ, tên và username.
 * @returns Tên hiển thị không rỗng chừng nào username tồn tại.
 */
function displayNameOf(user: { firstName: string; lastName: string; username: string }): string {
  return `${user.firstName} ${user.lastName}`.trim() || user.username;
}

/**
 * Handler nghiệp vụ của consumer thông báo sự kiện ở worker (issue
 * con #520 của #491), thay consumer polling phía API trước đây.
 *
 * @remarks
 * Flow tổng thể: relay outbox duy nhất phát mỗi dòng sự kiện thành
 * một job BullMQ trong hàng đợi `notification-events` với `jobId`
 * bằng id dòng outbox; `NotificationEventsProcessor` chống trùng
 * theo `outboxId` rồi gọi {@link handle} ở đây. Handler tra dữ kiện
 * tối thiểu từ DB dùng chung tại thời điểm xử lý, dựng nội dung
 * tiếng Việt và phát qua bề mặt dùng chung
 * {@link NotificationDeliveryService.notify} — không dựng đường
 * phát thông báo riêng. Mọi truy vấn chạy trong ngữ cảnh platform
 * do processor thiết lập; tenant của từng thông báo được truyền
 * tường minh vào `notify()` theo đúng nguồn của consumer cũ:
 * tenant trong payload hoặc tenant của khoá/conversation nguồn,
 * thiếu nữa mới tới tenant mặc định của người nhận.
 *
 * Các cổng nghiệp vụ được giữ nguyên theo từng loại:
 * - `grade_updated`: bỏ qua item tổng/công thức, item bị ẩn và
 *   điểm bị ẩn theo từng user; nội dung không chứa điểm số.
 * - `course_completed` và `enrol_expiry_warning`: phát trực tiếp
 *   cho user của sự kiện sau khi đủ định danh và mốc thời gian.
 * - `message_sent`: bỏ qua tin đã xoá, thành viên đã tắt tiếng
 *   conversation, thành viên đã chặn người gửi và thành viên đã có
 *   một `message_new` chưa đọc của cùng conversation.
 * - `activity_due_reminder`: phân biệt bài tập và hoạt động đề
 *   bằng `activityType`/`assignmentId`/`pinId` như sự kiện gốc.
 * - `assignment_created` và `exam_pinned`: chỉ phát khi khoá và
 *   module còn hiển thị với học sinh; người nhận là học viên đang
 *   ghi danh hiệu lực trừ người thực hiện.
 * - `assignment_submitted`: gửi xác nhận cho người nộp và bản gộp
 *   có số bài đang chờ chấm cho đội ngũ phụ trách.
 * - `assignment_returned`: gửi cho chủ bài nộp; điểm và mức trong
 *   payload tuyệt đối không đi vào nội dung.
 * - `quiz_attempt_finished`: chỉ phát bản gộp cho đội ngũ phụ
 *   trách khi lượt làm cần chấm tay và không phải preview.
 *
 * Khác biệt cơ chế duy nhất so với consumer polling: consumer cũ
 * khử dội các sự kiện điểm của cùng (user, item) trong MỘT lô quét
 * 500 ms và chỉ báo sự kiện cuối. Hàng đợi xử lý từng sự kiện thành
 * một job độc lập, không còn cửa sổ lô để gộp; việc dựng lại cửa sổ
 * chờ nhân tạo sẽ trì hoãn thông báo và tạo ngữ nghĩa mới ngoài
 * đặc tả. Điều kiện phát, người nhận và nội dung của từng sự kiện
 * không đổi; chống trùng khi phát lại do processor phụ trách bằng
 * dấu theo `outboxId`.
 *
 * Payload thiếu hoặc sai kiểu ở trường bắt buộc được bỏ qua lặng
 * lẽ như consumer cũ. Lỗi DB hoặc lỗi của đường phát được ném ra
 * cho processor/BullMQ thử lại, vì thông báo không có chốt nghiệp
 * vụ bền nào ngoài dấu đã xử lý của processor để nuốt lỗi an toàn.
 */
@Injectable()
export class NotificationEventsHandlerService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly delivery: NotificationDeliveryService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Xử lý một sự kiện đã được processor nhận diện thuộc hàng đợi
   * thông báo.
   *
   * @param type Loại sự kiện outbox.
   * @param payload Payload của sự kiện; processor đã chuẩn hoá
   * payload null thành object rỗng để các cổng kiểm tra trường bắt
   * buộc bỏ qua lặng lẽ như consumer cũ.
   * @returns true khi loại thuộc mười loại của consumer này (kể cả
   * khi handler bỏ qua vì payload thiếu trường); false với loại lạ.
   */
  async handle(type: string, payload: Record<string, unknown>): Promise<boolean> {
    if (type === 'grade_updated') { await this.handleGradeUpdated(payload); return true; }
    if (type === 'course_completed') { await this.handleCourseCompleted(payload); return true; }
    if (type === 'enrol_expiry_warning') { await this.handleEnrolExpiryWarning(payload); return true; }
    if (type === 'message_sent') { await this.handleMessageSent(payload); return true; }
    if (type === 'activity_due_reminder') { await this.handleActivityDueReminder(payload); return true; }
    if (type === 'assignment_created') { await this.handleAssignmentCreated(payload); return true; }
    if (type === 'assignment_submitted') { await this.handleAssignmentSubmitted(payload); return true; }
    if (type === 'assignment_returned') { await this.handleAssignmentReturned(payload); return true; }
    if (type === 'exam_pinned') { await this.handlePinCreated(payload); return true; }
    if (type === 'quiz_attempt_finished') { await this.handleQuizAttemptFinished(payload); return true; }
    return false;
  }

  /**
   * Phát thông báo điểm mới cho đúng học viên sở hữu điểm, sau các
   * cổng loại item và ẩn điểm.
   *
   * @param payload Payload sự kiện `grade_updated`.
   */
  private async handleGradeUpdated(payload: Record<string, unknown>): Promise<void> {
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const itemId = typeof payload.itemId === 'string' ? payload.itemId : null;
    const finalGrade = typeof payload.finalGrade === 'number' ? payload.finalGrade : null;
    if (!userId || !itemId || finalGrade === null) return;
    const item = await this.getGradeItemNotifyInfo(itemId);
    // Item đã biến mất, là tổng/công thức, hoặc bị ẩn ở cấp item:
    // không có "điểm mới" nào để học sinh xem.
    if (!item || item.hidden || NON_NOTIFIED_ITEM_TYPES.has(item.itemType)) return;
    if (await this.isGradeHiddenForUser(itemId, userId)) return;
    const courseName = (await this.getCourseFullName(item.courseId)) ?? '';
    const itemName = item.itemName || courseName;
    // Nội dung tuyệt đối không chứa điểm số ở bất kỳ kênh nào:
    // thông báo chỉ nói có điểm mới, điểm xem ở trang điểm.
    await this.delivery.notify(userId, 'grade_updated', {
      subject: this.t('platform.gradeUpdatedSubject', { course: courseName }),
      body: this.t('platform.gradeUpdatedBody', { course: courseName, item: itemName }),
      contextUrl: `/courses/${item.courseId}/grades`,
      courseId: item.courseId,
      tenantId: await this.resolveCourseTenantId(payload, item.courseId, userId),
    });
  }

  /**
   * Phát thông báo hoàn thành khoá cho user trong sự kiện.
   *
   * @param payload Payload sự kiện `course_completed`.
   */
  private async handleCourseCompleted(payload: Record<string, unknown>): Promise<void> {
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    if (!userId || !courseId) return;
    const courseName = (await this.getCourseFullName(courseId)) ?? '';
    await this.delivery.notify(userId, 'course_completed', {
      subject: this.t('platform.courseCompletedSubject', { course: courseName }),
      body: this.t('platform.courseCompletedBody', { course: courseName }),
      contextUrl: `/courses/${courseId}`,
      courseId,
      tenantId: await this.resolveCourseTenantId(payload, courseId, userId),
    });
  }

  /**
   * Phát cảnh báo ghi danh sắp hết hạn, định dạng ngày theo vi-VN.
   *
   * @param payload Payload sự kiện `enrol_expiry_warning`.
   */
  private async handleEnrolExpiryWarning(payload: Record<string, unknown>): Promise<void> {
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const timeEnd = typeof payload.timeEnd === 'string' ? payload.timeEnd : null;
    if (!userId || !courseId || !timeEnd) return;
    const courseName = (await this.getCourseFullName(courseId)) ?? '';
    const date = new Date(timeEnd);
    const dateText = Number.isNaN(date.getTime()) ? timeEnd : date.toLocaleDateString('vi-VN');
    await this.delivery.notify(userId, 'enrol_expiry_warning', {
      subject: this.t('platform.enrolExpiryWarningSubject', { course: courseName }),
      body: this.t('platform.enrolExpiryWarningBody', { course: courseName, date: dateText }),
      contextUrl: `/courses/${courseId}`,
      courseId,
      tenantId: await this.resolveCourseTenantId(payload, courseId, userId),
    });
  }

  /**
   * Phát nhắc hạn cho một hoạt động đề hoặc bài tập.
   *
   * @param payload Payload sự kiện `activity_due_reminder`.
   */
  private async handleActivityDueReminder(payload: Record<string, unknown>): Promise<void> {
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const timeClose = typeof payload.timeClose === 'string' ? payload.timeClose : null;
    if (!userId || !courseId || !timeClose) return;
    // Hai loại hoạt động dùng chung sự kiện: hoạt động đề mang
    // pinId; bài tập mang assignmentId + activityType 'assign';
    // sự kiện không có activityType thì hiểu là hoạt động đề.
    const isAssign = payload.activityType === 'assign';
    const pinId = typeof payload.pinId === 'string' ? payload.pinId : null;
    const assignmentId = typeof payload.assignmentId === 'string' ? payload.assignmentId : null;
    if (!isAssign && !pinId) return;
    if (isAssign && !assignmentId) return;
    const courseName = (await this.getCourseFullName(courseId)) ?? '';
    const activityName = typeof payload.activityName === 'string' && payload.activityName ? payload.activityName : courseName;
    const date = new Date(timeClose);
    const dateText = Number.isNaN(date.getTime()) ? timeClose : date.toLocaleString('vi-VN');
    // Nội dung chỉ gồm tên hoạt động, khoá và mốc hạn — dữ kiện
    // người nhận tự thấy trong khoá; không có điểm hay nội dung riêng.
    await this.delivery.notify(userId, 'activity_due_soon', {
      subject: this.t('platform.activityDueSoonSubject', { activity: activityName }),
      body: this.t('platform.activityDueSoonBody', { activity: activityName, course: courseName, datetime: dateText }),
      contextUrl: isAssign
        ? `/courses/${courseId}/assignments/${assignmentId}`
        : `/courses/${courseId}/exams/${pinId}`,
      courseId,
      tenantId: await this.resolveCourseTenantId(payload, courseId, userId),
    });
  }

  /**
   * Hoạt động có đang hiện với học sinh hay không: khoá hiện, module
   * không bị ẩn và không đang xoá; module null được coi là hiện.
   *
   * @param info Trạng thái hiển thị của khoá và module.
   * @returns true khi học sinh thấy hoạt động.
   */
  private isVisibleToStudents(info: {
    courseVisible: boolean;
    cmVisible: boolean | null;
    cmDeletionInProgress: boolean | null;
  }): boolean {
    return info.courseVisible && info.cmVisible !== false && info.cmDeletionInProgress !== true;
  }

  /**
   * Phát thông báo kiểu gộp theo (người nhận, provider, contextUrl):
   * còn một bản chưa đọc của cùng ngữ cảnh thì cập nhật nội dung của
   * bản đó, không sinh bản mới; đã đọc hết thì lần phát sau sinh bản
   * mới như thường. Khi phải sinh bản mới, tenant mặc định của
   * người nhận được phân giải và truyền tường minh cho `notify()`,
   * giữ đúng kết quả phân giải tenant của consumer cũ.
   *
   * @param userId Người nhận.
   * @param provider Provider thông báo.
   * @param contextUrl URL ngữ cảnh làm khoá gộp.
   * @param subject Tiêu đề nội dung mới nhất.
   * @param body Nội dung mới nhất.
   * @param courseId Khoá nguồn để áp ghi đè tắt tiếng theo khoá.
   */
  private async notifyGrouped(
    userId: string,
    provider: string,
    contextUrl: string,
    subject: string,
    body: string,
    courseId: string,
  ): Promise<void> {
    const existing = await this.getUnreadNotification(userId, provider, contextUrl);
    if (existing) {
      if (existing.subject !== subject || existing.fullMessage !== body) {
        await this.updateNotificationContent(existing.id, subject, body);
      }
      return;
    }
    await this.delivery.notify(userId, provider, {
      subject,
      body,
      contextUrl,
      courseId,
      tenantId: await this.getUserDefaultTenantId(userId),
    });
  }

  /**
   * Phát `assignment_assigned` kiểu gộp cho học viên đang ghi danh
   * của khoá, trừ người tạo bài tập.
   *
   * @param payload Payload sự kiện `assignment_created`.
   */
  private async handleAssignmentCreated(payload: Record<string, unknown>): Promise<void> {
    const assignmentId = typeof payload.assignmentId === 'string' ? payload.assignmentId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : null;
    if (!assignmentId || !courseId) return;
    const info = await this.getAssignmentNotifyInfo(assignmentId);
    if (!info || !this.isVisibleToStudents(info)) return;
    const courseName = (await this.getCourseFullName(courseId)) ?? '';
    const contextUrl = `/courses/${courseId}/assignments/${assignmentId}`;
    const studentIds = await this.listActiveEnrolledUserIds(courseId);
    for (const studentId of studentIds) {
      if (studentId === actorId) continue;
      await this.notifyGrouped(
        studentId,
        'assignment_assigned',
        contextUrl,
        this.t('platform.assignmentAssignedSubject', { assignment: info.name }),
        this.t('platform.assignmentAssignedBody', { assignment: info.name, course: courseName }),
        courseId,
      );
    }
  }

  /**
   * Gửi xác nhận đã nộp cho người nộp và bản gộp cho đội ngũ phụ
   * trách với số bài nộp đang chờ chấm hiện tại.
   *
   * @param payload Payload sự kiện `assignment_submitted`.
   */
  private async handleAssignmentSubmitted(payload: Record<string, unknown>): Promise<void> {
    const assignmentId = typeof payload.assignmentId === 'string' ? payload.assignmentId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    if (!assignmentId || !courseId || !userId) return;
    const info = await this.getAssignmentNotifyInfo(assignmentId);
    if (!info) return;
    const courseName = (await this.getCourseFullName(courseId)) ?? '';
    const contextUrl = `/courses/${courseId}/assignments/${assignmentId}`;
    await this.notifyGrouped(
      userId,
      'assignment_submitted',
      contextUrl,
      this.t('platform.assignmentSubmitReceiptSubject', { assignment: info.name }),
      this.t('platform.assignmentSubmitReceiptBody', { assignment: info.name, course: courseName }),
      courseId,
    );
    const awaiting = await this.countAssignmentSubmissionsAwaitingGrading(assignmentId);
    const staffIds = await this.listCourseStaffUserIds(courseId);
    for (const staffId of staffIds) {
      if (staffId === userId) continue;
      await this.notifyGrouped(
        staffId,
        'assignment_submitted',
        contextUrl,
        this.t('platform.assignmentSubmittedSubject', { assignment: info.name }),
        this.t('platform.assignmentSubmittedBody', { assignment: info.name, course: courseName, count: awaiting }),
        courseId,
      );
    }
  }

  /**
   * Phát `assignment_returned` cho chủ bài nộp; không đưa điểm/mức
   * trong payload vào nội dung thông báo.
   *
   * @param payload Payload sự kiện `assignment_returned`.
   */
  private async handleAssignmentReturned(payload: Record<string, unknown>): Promise<void> {
    const assignmentId = typeof payload.assignmentId === 'string' ? payload.assignmentId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    if (!assignmentId || !courseId || !userId) return;
    const info = await this.getAssignmentNotifyInfo(assignmentId);
    if (!info) return;
    const courseName = (await this.getCourseFullName(courseId)) ?? '';
    await this.notifyGrouped(
      userId,
      'assignment_returned',
      `/courses/${courseId}/assignments/${assignmentId}`,
      this.t('platform.assignmentReturnedSubject', { assignment: info.name }),
      this.t('platform.assignmentReturnedBody', { assignment: info.name, course: courseName }),
      courseId,
    );
  }

  /**
   * Phát `quiz_available` kiểu gộp cho học viên đang ghi danh khi
   * một đề được ghim vào khoá đang hiển thị.
   *
   * @param payload Payload sự kiện `exam_pinned`.
   */
  private async handlePinCreated(payload: Record<string, unknown>): Promise<void> {
    const pinId = typeof payload.pinId === 'string' ? payload.pinId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : null;
    if (!pinId || !courseId) return;
    const info = await this.getPinNotifyInfo(pinId);
    if (!info || !this.isVisibleToStudents(info)) return;
    const courseName = (await this.getCourseFullName(courseId)) ?? '';
    const contextUrl = `/courses/${courseId}/exams/${pinId}`;
    const studentIds = await this.listActiveEnrolledUserIds(courseId);
    for (const studentId of studentIds) {
      if (studentId === actorId) continue;
      await this.notifyGrouped(
        studentId,
        'quiz_available',
        contextUrl,
        this.t('platform.quizAvailableSubject', { quiz: info.name }),
        this.t('platform.quizAvailableBody', { quiz: info.name, course: courseName }),
        courseId,
      );
    }
  }

  /**
   * Phát bản gộp `quiz_attempt_finished` cho đội ngũ phụ trách khi
   * lượt làm cần chấm tay; bỏ qua preview và lượt không cần chấm.
   *
   * @param payload Payload sự kiện `quiz_attempt_finished`.
   */
  private async handleQuizAttemptFinished(payload: Record<string, unknown>): Promise<void> {
    const pinId = typeof payload.pinId === 'string' ? payload.pinId : null;
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    if (!pinId || !courseId) return;
    if (payload.needsGrading !== true || payload.preview === true) return;
    const info = await this.getPinNotifyInfo(pinId);
    if (!info) return;
    const courseName = (await this.getCourseFullName(courseId)) ?? '';
    const contextUrl = `/courses/${courseId}/exams/${pinId}/results`;
    const awaiting = await this.countPinAttemptsNeedingGrading(pinId);
    const staffIds = await this.listCourseStaffUserIds(courseId);
    for (const staffId of staffIds) {
      if (staffId === userId) continue;
      await this.notifyGrouped(
        staffId,
        'quiz_attempt_finished',
        contextUrl,
        this.t('platform.quizAttemptFinishedSubject', { quiz: info.name }),
        this.t('platform.quizAttemptFinishedBody', { quiz: info.name, course: courseName, count: awaiting }),
        courseId,
      );
    }
  }

  /**
   * Phát `message_new` cho các thành viên hiện tại của conversation
   * sau các cổng người gửi, tắt tiếng, chặn và gộp chưa đọc. Nội
   * dung tin nhắn không bao giờ đi vào thông báo.
   *
   * @param payload Payload sự kiện `message_sent`.
   */
  private async handleMessageSent(payload: Record<string, unknown>): Promise<void> {
    const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
    if (!messageId) return;
    const messageRow = await this.getMessage(messageId);
    if (!messageRow || messageRow.deletedAt) return;
    const senderName = await this.getUserDisplayName(messageRow.userIdFrom);
    const contextUrl = `/messages?conversation=${messageRow.conversationId}`;
    const payloadTenantId = typeof payload.tenantId === 'string' ? payload.tenantId : null;
    const conversationTenantId = payloadTenantId ?? await this.getConversationTenantId(messageRow.conversationId);
    // Membership được chốt tại thời điểm xử lý: thành viên đã rời
    // conversation không nhận thông báo.
    const memberIds = await this.listMembers(messageRow.conversationId);
    const mutedMemberIds = new Set(await this.listMutedMemberIds(messageRow.conversationId));
    for (const memberId of memberIds) {
      if (memberId === messageRow.userIdFrom) continue;
      if (mutedMemberIds.has(memberId)) continue;
      // Người nhận đã chặn người gửi thì không nhận thông báo từ
      // người đó; đây là lớp bảo vệ cho tin phát trước khi chặn.
      if (await this.isBlocked(memberId, messageRow.userIdFrom)) continue;
      // Còn một bản chưa đọc của cùng conversation thì bản đó đã
      // đại diện cho mọi tin mới, không sinh thêm.
      if (await this.hasUnreadNotification(memberId, 'message_new', contextUrl)) continue;
      await this.delivery.notify(memberId, 'message_new', {
        subject: this.t('platform.messageNewSubject', { name: senderName }),
        body: this.t('platform.messageNewBody'),
        contextUrl,
        fromUserId: messageRow.userIdFrom,
        tenantId: conversationTenantId ?? await this.getUserDefaultTenantId(memberId),
      });
    }
  }

  /**
   * Phân giải tenant cho một sự kiện gắn khoá: ưu tiên tenantId
   * trong payload, sau đó tenant của khoá, cuối cùng là tenant mặc
   * định của người nhận khi cả hai nguồn trên đều không có.
   *
   * @param payload Payload sự kiện.
   * @param courseId Khoá nguồn của sự kiện.
   * @param userId Người nhận thông báo.
   * @returns Tenant sẽ truyền tường minh vào đường phát chung.
   */
  private async resolveCourseTenantId(
    payload: Record<string, unknown>,
    courseId: string,
    userId: string,
  ): Promise<string | null> {
    if (typeof payload.tenantId === 'string') return payload.tenantId;
    return (await this.getCourseTenantId(courseId)) ?? await this.getUserDefaultTenantId(userId);
  }

  /**
   * Thông tin tối thiểu của grade item để quyết định có phát thông
   * báo điểm hay không và dựng nội dung không chứa điểm.
   *
   * @param itemId Id grade item.
   * @returns Loại item, tên item, cờ ẩn và khoá của item.
   */
  private async getGradeItemNotifyInfo(itemId: string): Promise<{
    itemType: string;
    itemName: string;
    hidden: boolean;
    courseId: string;
  } | undefined> {
    const [row] = await this.db.select({
      itemType: gradeItems.itemType,
      itemName: gradeItems.itemName,
      hidden: gradeItems.hidden,
      courseId: gradeItems.courseId,
    }).from(gradeItems).where(eq(gradeItems.id, itemId));
    return row;
  }

  /**
   * Điểm của user trên item có đang bị ẩn với chính user đó không;
   * không có dòng điểm thì coi là không ẩn.
   *
   * @param itemId Id grade item.
   * @param userId Id học viên.
   * @returns true khi dòng điểm tồn tại và đang ẩn.
   */
  private async isGradeHiddenForUser(itemId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.select({ hidden: gradeGrades.hidden }).from(gradeGrades)
      .where(and(eq(gradeGrades.itemId, itemId), eq(gradeGrades.userId, userId)));
    return row?.hidden ?? false;
  }

  /**
   * Tên đầy đủ của khoá học để dựng nội dung thông báo.
   *
   * @param courseId Id khoá.
   * @returns Tên đầy đủ hoặc undefined khi khoá không tồn tại.
   */
  private async getCourseFullName(courseId: string): Promise<string | undefined> {
    const [row] = await this.db.select({ fullName: course.fullName }).from(course).where(eq(course.id, courseId));
    return row?.fullName;
  }

  /**
   * Thông tin tối thiểu của bài tập và trạng thái hiển thị của
   * khoá/module gắn với nó.
   *
   * @param assignmentId Id bài tập.
   * @returns Tên, khoá và ba trạng thái hiển thị cần cho cổng phát.
   */
  private async getAssignmentNotifyInfo(assignmentId: string): Promise<{
    name: string;
    courseId: string;
    courseVisible: boolean;
    cmVisible: boolean | null;
    cmDeletionInProgress: boolean | null;
  } | undefined> {
    const [row] = await this.db.select({
      name: assignments.name,
      courseId: assignments.course,
      courseVisible: course.visible,
      cmVisible: courseModules.visible,
      cmDeletionInProgress: courseModules.deletionInProgress,
    }).from(assignments)
      .innerJoin(course, eq(course.id, assignments.course))
      .leftJoin(courseModules, eq(courseModules.id, assignments.cmId))
      .where(eq(assignments.id, assignmentId));
    return row;
  }

  /**
   * Thông tin tối thiểu của một lần ghim đề và trạng thái hiển thị
   * của khoá/module; tên lấy từ lần ghim, thiếu thì lấy tên phiên
   * bản đề.
   *
   * @param pinId Id lần ghim.
   * @returns Tên, khoá và ba trạng thái hiển thị cần cho cổng phát.
   */
  private async getPinNotifyInfo(pinId: string): Promise<{
    name: string;
    courseId: string;
    courseVisible: boolean;
    cmVisible: boolean | null;
    cmDeletionInProgress: boolean | null;
  } | undefined> {
    const [row] = await this.db.select({
      name: sql<string>`coalesce(${examPins.name}, ${examVersions.name})`,
      courseId: examPins.courseId,
      courseVisible: course.visible,
      cmVisible: courseModules.visible,
      cmDeletionInProgress: courseModules.deletionInProgress,
    }).from(examPins)
      .innerJoin(examVersions, eq(examVersions.id, examPins.examVersionId))
      .innerJoin(course, eq(course.id, examPins.courseId))
      .leftJoin(courseModules, eq(courseModules.id, examPins.cmId))
      .where(eq(examPins.id, pinId));
    return row;
  }

  /**
   * Số bài nộp đang chờ chấm của một bài tập: bài ở trạng thái
   * submitted mà gói chấm đúng lần nộp chưa được released.
   *
   * @param assignmentId Id bài tập.
   * @returns Số bài nộp đang chờ chấm tại thời điểm đọc.
   */
  private async countAssignmentSubmissionsAwaitingGrading(assignmentId: string): Promise<number> {
    const rows = await this.db.select({ id: assignSubmissions.id }).from(assignSubmissions)
      .leftJoin(assignGrades, and(
        eq(assignGrades.assignmentId, assignSubmissions.assignmentId),
        eq(assignGrades.userId, assignSubmissions.userId),
        eq(assignGrades.attemptNumber, assignSubmissions.attemptNumber),
      ))
      .where(and(
        eq(assignSubmissions.assignmentId, assignmentId),
        eq(assignSubmissions.status, 'submitted'),
        or(isNull(assignGrades.id), ne(assignGrades.status, 'released')),
      ));
    return rows.length;
  }

  /**
   * Số lượt làm của một lần ghim đang cần chấm tay, không tính
   * lượt preview.
   *
   * @param pinId Id lần ghim.
   * @returns Số lượt ở trạng thái `needsgrading` và preview=false.
   */
  private async countPinAttemptsNeedingGrading(pinId: string): Promise<number> {
    const rows = await this.db.select({ id: examAttempts.id }).from(examAttempts)
      .where(and(
        eq(examAttempts.pinId, pinId),
        eq(examAttempts.state, 'needsgrading'),
        eq(examAttempts.preview, false),
      ));
    return rows.length;
  }

  /**
   * Bản thông báo chưa đọc mới nhất của một (user, provider,
   * contextUrl), làm căn cứ gộp và cập nhật nội dung.
   *
   * @param userIdTo Người nhận.
   * @param eventType Provider/loại sự kiện của thông báo.
   * @param contextUrl URL ngữ cảnh.
   * @returns Dòng thông báo chưa đọc mới nhất hoặc undefined.
   */
  private async getUnreadNotification(userIdTo: string, eventType: string, contextUrl: string) {
    const [row] = await this.db.select().from(notifications)
      .where(and(
        eq(notifications.userIdTo, userIdTo),
        eq(notifications.eventType, eventType),
        eq(notifications.contextUrl, contextUrl),
        isNull(notifications.timeRead),
      ))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    return row;
  }

  /**
   * Cập nhật nội dung của một thông báo gộp đang chưa đọc;
   * smallMessage luôn là 200 ký tự đầu của nội dung đầy đủ.
   *
   * @param id Id thông báo.
   * @param subject Tiêu đề mới.
   * @param fullMessage Nội dung đầy đủ mới.
   */
  private async updateNotificationContent(id: string, subject: string, fullMessage: string): Promise<void> {
    await this.db.update(notifications)
      .set({ subject, fullMessage, smallMessage: fullMessage.slice(0, 200) })
      .where(eq(notifications.id, id));
  }

  /**
   * Còn thông báo chưa đọc của (user, provider, contextUrl) hay
   * không — căn cứ gộp `message_new` theo conversation.
   *
   * @param userIdTo Người nhận.
   * @param eventType Provider/loại sự kiện.
   * @param contextUrl URL ngữ cảnh.
   * @returns true khi đã có ít nhất một bản chưa đọc.
   */
  private async hasUnreadNotification(userIdTo: string, eventType: string, contextUrl: string): Promise<boolean> {
    const [row] = await this.db.select({ id: notifications.id }).from(notifications)
      .where(and(
        eq(notifications.userIdTo, userIdTo),
        eq(notifications.eventType, eventType),
        eq(notifications.contextUrl, contextUrl),
        isNull(notifications.timeRead),
      ))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Lấy một tin nhắn theo id để kiểm tra xoá mềm, người gửi và
   * conversation trước khi phát `message_new`.
   *
   * @param id Id tin nhắn.
   * @returns Dòng tin nhắn hoặc undefined.
   */
  private async getMessage(id: string) {
    const [row] = await this.db.select().from(message).where(eq(message.id, id));
    return row;
  }

  /**
   * Tên hiển thị của người gửi; user đã biến mất thì trả chuỗi rỗng
   * như consumer cũ khi không tra được người gửi.
   *
   * @param userId Id người gửi.
   * @returns Tên hiển thị hoặc chuỗi rỗng.
   */
  private async getUserDisplayName(userId: string): Promise<string> {
    const [row] = await this.db.select({
      firstName: users.firstName,
      lastName: users.lastName,
      username: users.username,
    }).from(users).where(eq(users.id, userId));
    return row ? displayNameOf(row) : '';
  }

  /**
   * Mọi thành viên hiện tại của conversation tại thời điểm xử lý.
   *
   * @param conversationId Id conversation.
   * @returns Danh sách user id thành viên.
   */
  private async listMembers(conversationId: string): Promise<string[]> {
    const rows = await this.db.select({ userId: messageConversationMembers.userId })
      .from(messageConversationMembers)
      .where(eq(messageConversationMembers.conversationId, conversationId));
    return rows.map((row) => row.userId);
  }

  /**
   * Các thành viên đã tắt tiếng conversation này.
   *
   * @param conversationId Id conversation.
   * @returns Danh sách user id có cờ muted=true.
   */
  private async listMutedMemberIds(conversationId: string): Promise<string[]> {
    const rows = await this.db.select({ userId: messageConversationMembers.userId })
      .from(messageConversationMembers)
      .where(and(
        eq(messageConversationMembers.conversationId, conversationId),
        eq(messageConversationMembers.muted, true),
      ));
    return rows.map((row) => row.userId);
  }

  /**
   * Một user có đang chặn user khác hay không.
   *
   * @param userId Người đã thiết lập chặn.
   * @param blockedUserId Người bị chặn.
   * @returns true khi quan hệ chặn tồn tại đúng chiều.
   */
  private async isBlocked(userId: string, blockedUserId: string): Promise<boolean> {
    const rows = await this.db.select({ userId: messageUsersBlocked.userId })
      .from(messageUsersBlocked)
      .where(and(eq(messageUsersBlocked.userId, userId), eq(messageUsersBlocked.blockedUserId, blockedUserId)));
    return rows.length > 0;
  }

  /**
   * Tenant sở hữu khoá học nguồn của sự kiện.
   *
   * @param courseId Id khoá.
   * @returns Tenant của khoá hoặc null.
   */
  private async getCourseTenantId(courseId: string): Promise<string | null> {
    const [row] = await this.db.select({ tenantId: course.tenantId }).from(course).where(eq(course.id, courseId));
    return row?.tenantId ?? null;
  }

  /**
   * Tenant của conversation nguồn của một tin nhắn.
   *
   * @param conversationId Id conversation.
   * @returns Tenant của conversation hoặc null.
   */
  private async getConversationTenantId(conversationId: string): Promise<string | null> {
    const [row] = await this.db.select({ tenantId: messageConversations.tenantId })
      .from(messageConversations)
      .where(eq(messageConversations.id, conversationId));
    return row?.tenantId ?? null;
  }

  /**
   * Tenant mặc định của user: một membership active duy nhất thì
   * lấy tenant đó; nhiều tenant thì lấy tenant khác platform đầu
   * tiên theo thứ tự đọc; không có membership thì lấy tenant có
   * kind platform.
   *
   * @param userId Id người nhận.
   * @returns Tenant mặc định hoặc null khi không có tenant platform.
   */
  private async getUserDefaultTenantId(userId: string): Promise<string | null> {
    const rows = await this.db.select({ tenantId: tenantMemberships.tenantId, kind: tenants.kind })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(and(
        eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.status, 'active'),
        eq(tenants.status, 'active'),
      ));
    const distinct = [...new Map(rows.map((row) => [row.tenantId, row])).values()];
    if (distinct.length === 1) return distinct[0]!.tenantId;
    if (distinct.length > 1) {
      const nonPlatform = distinct.find((row) => row.kind !== 'platform');
      if (nonPlatform) return nonPlatform.tenantId;
    }
    const [platform] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.kind, 'platform'));
    return platform?.id ?? null;
  }

  /**
   * Học viên đang ghi danh hiệu lực trong khoá: instance bật, ghi
   * danh ở trạng thái 0 và thời điểm hiện tại nằm trong cửa sổ ghi
   * danh; kết quả được khử trùng lặp theo user.
   *
   * @param courseId Id khoá.
   * @returns Danh sách user id phân biệt.
   */
  private async listActiveEnrolledUserIds(courseId: string): Promise<string[]> {
    const now = new Date();
    const rows = await this.db.select({ userId: userEnrolments.userId }).from(userEnrolments)
      .innerJoin(enrol, eq(userEnrolments.enrolId, enrol.id))
      .where(and(
        eq(enrol.courseId, courseId),
        eq(userEnrolments.status, 0),
        eq(enrol.status, 0),
        lte(userEnrolments.timeStart, now),
        or(isNull(userEnrolments.timeEnd), gte(userEnrolments.timeEnd, now)),
      ));
    return [...new Set(rows.map((row) => row.userId))];
  }

  /**
   * Mọi user mang vai trò staff tại context của khoá hoặc một
   * context tổ tiên của nó theo đường path context.
   *
   * @param courseId Id khoá.
   * @returns Danh sách user id phân biệt mang archetype staff.
   */
  private async listCourseStaffUserIds(courseId: string): Promise<string[]> {
    const [courseContext] = await this.db.select().from(context)
      .where(and(eq(context.contextLevel, 50), eq(context.instanceId, courseId)));
    if (!courseContext) return [];
    const pathIds = courseContext.path.split('/').filter((part) => part.length > 0);
    if (!pathIds.length) return [];
    const rows = await this.db.selectDistinct({ userId: roleAssignments.userId })
      .from(roleAssignments)
      .innerJoin(role, eq(role.id, roleAssignments.roleId))
      .where(and(
        inArray(role.archetype, [...STAFF_ARCHETYPES]),
        inArray(roleAssignments.contextId, pathIds),
      ));
    return rows.map((row) => row.userId);
  }

  /**
   * Dịch một khoá nội dung thông báo bằng locale mặc định `vi`,
   * vì job nền không có request context của người nhận.
   *
   * @param key Khoá i18n đầy đủ.
   * @param args Tham số nội suy của mẫu dịch.
   * @returns Chuỗi đã dịch.
   */
  private t(key: string, args?: Record<string, unknown>): string {
    return String(this.i18n.t(key, { locale: 'vi', args }));
  }
}
