import { MessagingRepository, type ConversationRow } from './messaging.repository';
import { MessagingRealtimeService } from './messaging-realtime.service';

/**
 * ĐỒNG BỘ THÀNH VIÊN của các conversation gắn cấu trúc (cụm hỗ trợ của
 * cụm hội thoại, tách riêng có chủ đích — xem dưới đây).
 *
 * Luồng nghiệp vụ: conversation gắn course group (component
 * core_group), gắn chính khoá (component core_course/itemType course)
 * hay gắn chính lớp học (lát MSG-T2) KHÔNG giữ danh sách thành viên cố
 * định — thành viên suy ra từ cấu trúc nguồn (thành viên group / ghi
 * danh hiệu lực ∪ staff khoá / roster lớp) và được ĐỒNG BỘ LƯỜI mỗi
 * lần chủ thể được liệt kê, mở, gửi tin hoặc đọc: ai rời cấu trúc thì
 * bị gỡ khỏi conversation, ai mới vào thì được thêm. Các vị từ liên
 * kết (isGroupLinked/isCourseLinked/isClassLinked) quyết định một
 * conversation có thuộc diện đồng bộ này hay không (conversation tự
 * do/1-1 không bao giờ bị đụng vào).
 *
 * Vì sao tách thành service riêng thay vì nằm trong service hội thoại:
 * cây nhóm/roster (MessagingGroupTreeService) cần đồng bộ trước khi
 * dựng cây, và cụm tin nhắn (MessagingMessagesService) cần đồng bộ
 * trước khi đọc/gửi — đặt đồng bộ ở tầng thấp dùng chung giữ đồ thị
 * phụ thuộc giữa các service cụm không có vòng (cây nhóm → đồng bộ;
 * hội thoại → đồng bộ; tin nhắn → hội thoại + đồng bộ). Các method ở
 * đây để public trong nội bộ module cho các service cụm gọi — không
 * phải bề mặt API của MessagingModule.
 *
 * Cách lắp ráp (issue #295): service này là một CỤM của MessagingModule,
 * tách từ MessagingService cũ theo cụm ca sử dụng — tách cấu trúc thuần,
 * không đổi hành vi. MessagingService nay là facade giữ nguyên bề mặt
 * công khai và chữ ký constructor, tự lắp ráp các service cụm trong
 * constructor của nó (các test đơn vị hiện hữu khởi tạo trực tiếp
 * `new MessagingService(...)` với đúng các phụ thuộc hạ tầng cũ nên
 * facade là điểm lắp ráp để giữ nguyên hợp đồng khởi tạo đó); các
 * service cụm không đăng ký provider riêng trong module và module
 * wiring giữ nguyên như trước khi tách.
 */
export class MessagingMembershipSyncService {
  constructor(
    private readonly repo: MessagingRepository,
    private readonly realtime: MessagingRealtimeService,
  ) {}

  // --- conversation nhóm (gắn course group) ---------------------------------

  /** Conversation có gắn với một course group qua (component, itemType, itemId) hay không. */
  isGroupLinked(conversation: ConversationRow): boolean {
    return conversation.type === 2
      && conversation.component === 'core_group'
      && conversation.itemType === 'groups'
      && conversation.itemId !== null;
  }

  /** Conversation có gắn với chính một KHOÁ (chat toàn lớp) qua (component, itemType, itemId) hay không. */
  isCourseLinked(conversation: ConversationRow): boolean {
    return conversation.type === 2
      && conversation.component === 'core_course'
      && conversation.itemType === 'course'
      && conversation.itemId !== null;
  }

  /** Conversation có gắn với chính một LỚP (chat cấp lớp, lát MSG-T2) qua (component, itemType, itemId) hay không. */
  isClassLinked(conversation: ConversationRow): boolean {
    return conversation.type === 2
      && conversation.component === 'core_class'
      && conversation.itemType === 'class'
      && conversation.itemId !== null;
  }

  /**
   * Đồng bộ lười thành viên của một conversation gắn cấu trúc (group
   * hoặc khoá) về đúng tập đích HIỆN TẠI: người mới thuộc cấu trúc được
   * thêm, người đã rời bị gỡ khỏi conversation (tin nhắn cũ giữ nguyên).
   * Trả về danh sách thành viên sau đồng bộ. Chỉ chạy phía messaging khi
   * conversation được liệt kê/mở/gửi — không cần hook trong module chủ
   * của cấu trúc.
   */
  async syncLinkedConversationMembers(conversation: ConversationRow, targetIds: string[]): Promise<string[]> {
    const memberIds = [...new Set(targetIds)];
    const current = await this.repo.listMembers(conversation.id);
    for (const id of memberIds) {
      if (!current.includes(id)) await this.repo.addMember(conversation.id, id);
    }
    for (const id of current) {
      if (!memberIds.includes(id)) {
        await this.repo.removeMember(conversation.id, id);
        // Đẩy socket của người vừa bị gỡ ra khỏi room của conversation
        // NGAY: membership ở DB đã mất mà socket còn nằm trong room thì
        // vẫn nhận mọi sự kiện của conversation (F1). Tầng phân phối
        // còn rà soát lại membership một lần nữa trước mỗi lần phát.
        await this.realtime.evictUserFromConversation(id, conversation.id);
      }
    }
    return memberIds;
  }

  /** Đồng bộ thành viên theo thành viên course group hiện tại. */
  async syncGroupConversationMembers(conversation: ConversationRow): Promise<string[]> {
    return this.syncLinkedConversationMembers(conversation, await this.repo.listGroupMemberIds(conversation.itemId!));
  }

  /** Đồng bộ thành viên theo ghi danh hiệu lực ∪ staff của khoá hiện tại. */
  async syncCourseConversationMembers(conversation: ConversationRow): Promise<string[]> {
    return this.syncLinkedConversationMembers(conversation, await this.repo.listCourseConversationMemberIds(conversation.itemId!));
  }

  /**
   * Đồng bộ thành viên chat cấp lớp về tập đích hiện tại (nguồn sự
   * thật duy nhất là roster lớp — xem
   * {@link MessagingRepository.listClassConversationMemberIds}).
   *
   * Bất biến: lớp đã mất hoặc đã lưu trữ thì GIỮ NGUYÊN membership
   * hiện tại thay vì gỡ sạch — danh sách lớp đóng băng khi lưu trữ
   * nên tư cách chat cũng đóng băng theo, đồng bộ chỉ chạy trên lớp
   * đang hoạt động.
   *
   * Side-effect: qua {@link syncLinkedConversationMembers} — thêm/gỡ
   * dòng thành viên trong DB và đẩy socket của người bị gỡ ra khỏi
   * room ngay.
   *
   * @param conversation - Conversation cấp lớp cần đồng bộ.
   * @returns Danh sách id thành viên sau đồng bộ.
   */
  async syncClassConversationMembers(conversation: ConversationRow): Promise<string[]> {
    // Lớp đã mất (xoá/lưu trữ dứt điểm): giữ nguyên membership hiện
    // tại thay vì gỡ sạch — đồng bộ chỉ chạy trên lớp đang hoạt động.
    const cls = await this.repo.getClassSummary(conversation.itemId!);
    if (!cls || cls.status !== 'active') return this.repo.listMembers(conversation.id);
    return this.syncLinkedConversationMembers(conversation, await this.repo.listClassConversationMemberIds(conversation.itemId!));
  }

  /** Đồng bộ nếu conversation gắn cấu trúc (group/khoá/lớp); conversation thường thì bỏ qua. */
  async syncGroupConversationIfLinked(conversation: ConversationRow): Promise<void> {
    if (this.isGroupLinked(conversation)) await this.syncGroupConversationMembers(conversation);
    else if (this.isCourseLinked(conversation)) await this.syncCourseConversationMembers(conversation);
    else if (this.isClassLinked(conversation)) await this.syncClassConversationMembers(conversation);
  }
}
