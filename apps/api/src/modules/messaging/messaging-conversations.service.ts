import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { UsersService } from '../users/users.service';
import { blankRecalledContent, MessagingRepository, type ConversationRow, type MessageRow, type MessageWithQuoteRow } from './messaging.repository';
import { tenantAls } from '../tenants/tenant-als';
import { MessagingContactsService, type PersonSummaryView } from './messaging-contacts.service';
import { MessagingMembershipSyncService } from './messaging-membership-sync.service';

/**
 * HỘI THOẠI của MessagingModule (cụm ca sử dụng "hội thoại").
 *
 * Luồng nghiệp vụ: CONVERSATION là user-tới-user — hội thoại 1-1 chỉ
 * mở qua cổng liên lạc đã duyệt (MessagingContactsService.assertCanContact),
 * hội thoại nhóm tự do do người dùng tạo, và các hội thoại gắn cấu
 * trúc (nhóm con của khoá / chat toàn khoá / chat toàn lớp) được cấp
 * phát lười khi thành viên hoặc staff mở, thành viên đồng bộ lười
 * theo cấu trúc nguồn mỗi lần liệt kê/mở (MessagingMembershipSyncService).
 * Cụm này sở hữu các câu hỏi THẨM QUYỀN theo phạm vi trên một
 * conversation — thành viên hay không, phụ trách khoá (kiểm duyệt)
 * hay quản lý conversation, hội thoại thuộc khoá/lớp nào — và cụm
 * tin nhắn (MessagingMessagesService) dùng lại đúng các cổng này cho
 * vòng đời tin, nên chúng để public trong nội bộ module; đây không
 * phải bề mặt API của MessagingModule. Hội thoại 1-1 bị một phía
 * chặn thì ẩn khỏi phía bị chặn (assertDirectConversationVisible) trừ
 * các đường kiểm duyệt có thẩm quyền riêng.
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
export class MessagingConversationsService {
  constructor(
    private readonly repo: MessagingRepository,
    private readonly users: UsersService,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly contacts: MessagingContactsService,
    private readonly membershipSync: MessagingMembershipSyncService,
  ) {}

  // --- conversation & message ---------------------------------------------------

  /**
   * Tạo conversation (nhóm hoặc 1-1; 1-1 đã tồn tại thì dùng lại). Tạo MỚI
   * conversation 1-1 phải qua cổng liên lạc (xem {@link assertCanContact});
   * việc trả lại conversation đã tồn tại là truy hồi idempotent, còn việc
   * gửi tiếp trong đó vẫn bị cổng kiểm ở {@link sendMessage} — đúng luật
   * Moodle (can_send_message_to_conversation kiểm mỗi lần gửi, kể cả
   * conversation có từ trước khi bật cổng).
   */
  async createConversation(actorId: string, input: { type?: number; memberIds: string[]; name?: string }): Promise<ConversationRow & { members: string[] }> {
    const type = input.type ?? 1;
    const memberIds = [...new Set([actorId, ...input.memberIds])];
    if (type === 1) {
      if (memberIds.length !== 2) throw new BadRequestException({ message: 'An individual conversation has exactly 2 members', code: 'messaging.individual_members' });
      const other = memberIds.find((id) => id !== actorId)!;
      const existing = await this.repo.findIndividualConversation(actorId, other);
      if (existing) return { ...existing, members: await this.repo.listMembers(existing.id) };
    }
    if (type === 2 && memberIds.length < 2) {
      throw new BadRequestException({ message: 'A group conversation needs at least 2 members', code: 'messaging.group_members' });
    }
    for (const id of memberIds) await this.users.getUser(id);
    if (type === 1) {
      const other = memberIds.find((id) => id !== actorId)!;
      await this.contacts.assertCanContact(actorId, other);
    }
    if (type === 2) {
      // Cổng lập nhóm tự do (Lớp B, chính sách đã chốt): học sinh KHÔNG
      // tự lập nhóm trong hệ thống — nhóm tự do chỉ do giáo viên/staff
      // (có ít nhất một gán vai trò staff ở bất kỳ context nào) hoặc
      // quản trị viên tạo; nhóm của lớp/khoá đi đường cấu trúc riêng
      // (createGroupConversation). Chặn TẠI TẦNG SERVICE này để mọi
      // client đều bị chặn như nhau, không chỉ ẩn ở giao diện.
      const isAdmin = await this.evaluator.isSiteAdmin(actorId);
      if (!isAdmin && !(await this.repo.hasStaffRoleAssignment(actorId))) {
        throw new ForbiddenException({
          message: 'Only teachers or staff can create group conversations; students cannot create their own groups',
          code: 'messaging.group_creation_forbidden',
        });
      }
    }
    const conversation = await this.repo.dbHandle.transaction(async (tx) => {
      const created = await this.repo.insertConversation({ type, name: input.name ?? null, createdBy: actorId, tenantId: tenantAls.getStore()?.tenantId ?? null }, tx);
      for (const id of memberIds) await this.repo.addMember(created.id, id, tx);
      return created;
    });
    return { ...conversation, members: memberIds };
  }

  /**
   * Cổng thành viên cho các đường theo id (đọc/gửi/báo cáo): người
   * không phải thành viên bị từ chối — riêng conversation CẤP KHOÁ
   * và CẤP LỚP hành xử như KHÔNG TỒN TẠI (404, cùng mã
   * `conversation_not_found`) để bề mặt chat cấu trúc không rò sự
   * tồn tại của khoá/lớp/conversation cho người ngoài, đồng nhất với
   * cổng ensure; các loại conversation khác giữ 403 `not_member`
   * như hiện hành.
   */
  async assertConversationMember(userId: string, conversation: ConversationRow): Promise<void> {
    if (await this.repo.isMember(conversation.id, userId)) return;
    if (this.membershipSync.isCourseLinked(conversation) || this.membershipSync.isClassLinked(conversation)) {
      throw new NotFoundException({ message: `Conversation ${conversation.id} not found`, code: 'messaging.conversation_not_found' });
    }
    throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
  }

  /**
   * Staff của khoá theo đúng nghĩa GroupsModule dùng: site admin, hoặc có
   * capability `course:managegroups` tại context của khoá.
   */
  private async isCourseStaff(userId: string, courseId: string): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
    if (!courseCtx) return false;
    return this.evaluator.hasCapability(userId, 'course:managegroups', courseCtx.id);
  }

  /**
   * Staff của lớp: site admin, hoặc thuộc tập staff của lớp (gán vai
   * archetype staff tại context lớp hoặc tổ tiên — chủ lớp mang
   * editingteacher tại context lớp nên thuộc tập này).
   *
   * @param userId - Người cần kiểm.
   * @param classId - Lớp làm phạm vi.
   * @returns `true` khi người dùng có thẩm quyền staff trên lớp.
   */
  private async isClassStaff(userId: string, classId: string): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    const staff = await this.repo.listClassStaffUserIds(classId);
    return staff.includes(userId);
  }

  /**
   * Tạo (hoặc lấy lại) conversation của một course group: component
   * 'core_group', itemType 'groups', itemId = group id. Chỉ thành viên
   * group hoặc staff của khoá mới tạo được; thành viên conversation khởi
   * tạo đúng bằng thành viên group hiện tại và về sau được đồng bộ lười.
   */
  async createGroupConversation(actorId: string, input: { groupId: string; name?: string }): Promise<ConversationRow & { members: string[] }> {
    const group = await this.repo.getCourseGroup(input.groupId);
    if (!group) throw new NotFoundException({ message: `Course group ${input.groupId} not found`, code: 'messaging.group_not_found' });
    const groupMemberIds = await this.repo.listGroupMemberIds(group.id);
    if (!groupMemberIds.includes(actorId) && !(await this.isCourseStaff(actorId, group.courseId))) {
      throw new ForbiddenException({ message: 'Only group members or course staff can create the group conversation', code: 'messaging.group_conversation_forbidden' });
    }
    const existing = await this.repo.findGroupConversation(group.id);
    if (existing) return { ...existing, members: await this.membershipSync.syncGroupConversationMembers(existing) };
    const courseCtx = await this.contexts.getByLevelInstance(50, group.courseId);
    // TENANT-1 (#196): conversation của group thuộc tenant của khoá chứa group.
    const tenantId = (await this.repo.getCourseTenantId(group.courseId)) ?? tenantAls.getStore()?.tenantId ?? null;
    const conversation = await this.repo.dbHandle.transaction(async (tx) => {
      const created = await this.repo.insertConversation({
        type: 2, name: input.name ?? group.name,
        component: 'core_group', itemType: 'groups', itemId: group.id,
        contextId: courseCtx?.id ?? null, createdBy: actorId, tenantId,
      }, tx);
      for (const id of groupMemberIds) await this.repo.addMember(created.id, id, tx);
      return created;
    });
    return { ...conversation, members: groupMemberIds };
  }

  // --- conversation khoá học (chat toàn lớp, gắn chính khoá) -------------------

  /**
   * Mở (ensure) conversation của CHÍNH khoá — chat toàn lớp: component
   * 'core_course', itemType 'course', itemId = course id, contextId =
   * context của khoá. Cấp phát LƯỜI idempotent: chưa có thì tạo với
   * thành viên khởi tạo = ghi danh hiệu lực ∪ staff khoá, đã có thì
   * đồng bộ lười rồi trả lại — khoá cũ tự có chat khi mở lần đầu, không
   * migration dữ liệu. Chỉ thành viên của khoá (ghi danh hiệu lực, gán
   * vai tại context khoá) hoặc staff khoá mới mở được; người ngoài nhận
   * 404 cùng mã như khoá không tồn tại (không rò tồn tại). Thẩm quyền
   * quản lý (bật/tắt) theo staff khoá — người tạo bản ghi (có thể là
   * một học viên mở lần đầu) KHÔNG thành quản lý, đúng luật conversation
   * gắn cấu trúc. Đua ensure song song: transaction tạo giữ
   * `pg_advisory_xact_lock` theo courseId rồi re-check trong cùng
   * transaction — schema không có unique nên khoá này là điểm đồng bộ
   * giữ bất biến một khoá/một conversation (phán quyết 6395599464).
   */
  async ensureCourseConversation(actorId: string, courseId: string): Promise<ConversationRow & { members: string[] }> {
    const course = await this.repo.getCourseSummary(courseId);
    if (!course) throw new NotFoundException({ message: `Course ${courseId} not found`, code: 'messaging.course_not_found' });
    if (!(await this.repo.isCourseMember(courseId, actorId)) && !(await this.isCourseStaff(actorId, courseId))) {
      throw new NotFoundException({ message: `Course ${courseId} not found`, code: 'messaging.course_not_found' });
    }
    const existing = await this.repo.findCourseConversation(courseId);
    if (existing) return { ...existing, members: await this.membershipSync.syncCourseConversationMembers(existing) };
    const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
    const memberIds = await this.repo.listCourseConversationMemberIds(courseId);
    const ensured = await this.repo.dbHandle.transaction(async (tx) => {
      // Khoá advisory TRƯỚC, re-check SAU — trong cùng transaction:
      // lượt ensure song song đến sau phải chờ lượt trước commit xong
      // mới qua được khoá, và re-check lúc đó thấy conversation đã
      // tồn tại nên không insert trùng.
      await this.repo.acquireCourseConversationLock(tx, courseId);
      const rechecked = await this.repo.findCourseConversation(courseId, tx);
      if (rechecked) return { conversation: rechecked, created: false as const };
      const created = await this.repo.insertConversation({
        type: 2, name: course.fullName,
        component: 'core_course', itemType: 'course', itemId: courseId,
        contextId: courseCtx?.id ?? null, createdBy: actorId,
      }, tx);
      for (const id of memberIds) await this.repo.addMember(created.id, id, tx);
      return { conversation: created, created: true as const };
    });
    if (!ensured.created) return { ...ensured.conversation, members: await this.membershipSync.syncCourseConversationMembers(ensured.conversation) };
    return { ...ensured.conversation, members: memberIds };
  }

  // --- conversation lớp (chat của chính lớp, lát MSG-T2) -------------------

  /**
   * Mở (ensure) conversation của CHÍNH lớp — chat cấp lớp: component
   * 'core_class', itemType 'class', itemId = class id, contextId =
   * context của lớp (mức 45), tenantId = tenant của lớp. Đây là
   * conversation RIÊNG của lớp — không dùng lại nhóm con "Cả lớp"
   * của bất kỳ khoá nào trong lớp. Cấp phát LƯỜI idempotent đúng
   * khuôn {@link ensureCourseConversation}: chưa có thì tạo với thành
   * viên khởi tạo = roster lớp hiệu lực ∪ chủ lớp ∪ đồng GV, đã có
   * thì đồng bộ lười rồi trả lại. Chỉ người thuộc lớp (thành viên
   * roster, chủ lớp, có gán vai tại context lớp) hoặc staff lớp mới
   * mở được; người ngoài và lớp đã lưu trữ nhận 404 cùng mã như lớp
   * không tồn tại (không rò tồn tại). Đua ensure song song: giữ
   * `pg_advisory_xact_lock` theo classId rồi re-check trong cùng
   * transaction như đường khoá.
   *
   * Flow: tra lớp + cổng thuộc lớp → đã có conversation thì đồng bộ
   * lười thành viên rồi trả; chưa có thì trong MỘT transaction: giữ
   * khoá advisory theo classId → re-check → insert conversation +
   * toàn bộ thành viên khởi tạo.
   *
   * Bất biến: mỗi lớp có ĐÚNG MỘT conversation cấp lớp; gọi lại bao
   * nhiêu lần (kể cả đồng thời) vẫn trả cùng một conversation.
   *
   * Side-effect: ghi DB (insert conversation + dòng thành viên) ở
   * lần mở đầu tiên; các lần sau ghi thêm/gỡ dòng thành viên khi
   * đồng bộ lười thấy roster đã đổi.
   *
   * @param actorId - Người mở chat lớp (phải thuộc lớp hoặc staff).
   * @param classId - Lớp cần mở chat.
   * @returns Conversation cấp lớp kèm danh sách thành viên hiện tại.
   * @throws {NotFoundException} `messaging.class_not_found` khi lớp
   *   không tồn tại, đã lưu trữ, hoặc người mở không thuộc lớp —
   *   ba trường hợp không phân biệt được với nhau.
   */
  async ensureClassConversation(actorId: string, classId: string): Promise<ConversationRow & { members: string[] }> {
    const cls = await this.repo.getClassSummary(classId);
    if (!cls || cls.status !== 'active') {
      throw new NotFoundException({ message: `Class ${classId} not found`, code: 'messaging.class_not_found' });
    }
    if (!(await this.repo.isClassMember(classId, actorId)) && !(await this.isClassStaff(actorId, classId))) {
      throw new NotFoundException({ message: `Class ${classId} not found`, code: 'messaging.class_not_found' });
    }
    const existing = await this.repo.findClassConversation(classId);
    if (existing) return { ...existing, members: await this.membershipSync.syncClassConversationMembers(existing) };
    const classCtx = await this.contexts.getByLevelInstance(45, classId);
    const memberIds = await this.repo.listClassConversationMemberIds(classId);
    const ensured = await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.acquireClassConversationLock(tx, classId);
      const rechecked = await this.repo.findClassConversation(classId, tx);
      if (rechecked) return { conversation: rechecked, created: false as const };
      const created = await this.repo.insertConversation({
        type: 2, name: cls.name,
        component: 'core_class', itemType: 'class', itemId: classId,
        contextId: classCtx?.id ?? null, createdBy: actorId, tenantId: cls.tenantId,
      }, tx);
      for (const id of memberIds) await this.repo.addMember(created.id, id, tx);
      return { conversation: created, created: true as const };
    });
    if (!ensured.created) return { ...ensured.conversation, members: await this.membershipSync.syncClassConversationMembers(ensured.conversation) };
    return { ...ensured.conversation, members: memberIds };
  }

  // --- thẩm quyền theo phạm vi trên một conversation (Lớp B) -----------------
  // Ba câu hỏi khác nhau, không gộp làm một:
  //  - "phụ trách khoá của conversation này" (staff tại context khoá
  //    hoặc tổ tiên của nó, hoặc quản trị viên) → quyền KIỂM DUYỆT:
  //    xoá tin của người khác, xem lại báo cáo, xem tin đã xoá mềm.
  //  - "quản lý conversation" = phụ trách khoá, cộng thêm NGƯỜI TẠO
  //    đối với conversation KHÔNG gắn cấu trúc lớp/khoá → quyền bật/tắt
  //    chat và gửi tin khi chat đang tắt. Conversation gắn group của
  //    khoá thì người tạo bản ghi (có thể là một học sinh bấm mở nhóm
  //    lớp) KHÔNG thành người quản lý — quản lý chỉ theo staff khoá.

  /**
   * Khoá học mà một conversation "thuộc về" — căn cứ phân phạm vi
   * thẩm quyền của Lớp B. Thứ tự: conversation gắn course group thì là
   * khoá của group; conversation có context là context khoá thì là
   * khoá đó; còn lại (chat tự do/1-1) suy ra từ GIAO của các khoá mà
   * mọi thành viên đang cùng ghi danh active (không có khoá chung thì
   * conversation không thuộc khoá nào — chỉ quản trị viên có thẩm
   * quyền kiểm duyệt trên nó).
   */
  async resolveConversationCourseId(conversation: ConversationRow): Promise<string | null> {
    // Conversation CẤP LỚP không thuộc khoá nào: thành viên của nó
    // thường cùng thuộc các khoá trong lớp nên phép giao tập khoá ở
    // dưới sẽ gán nhầm một khoá cho chat lớp — chặn ngay tại đây;
    // thẩm quyền của chat lớp resolve qua lớp (xem canModerate).
    if (this.membershipSync.isClassLinked(conversation)) return null;
    if (this.membershipSync.isCourseLinked(conversation)) return conversation.itemId;
    if (this.membershipSync.isGroupLinked(conversation)) {
      const group = await this.repo.getCourseGroup(conversation.itemId!);
      if (group) return group.courseId;
    }
    if (conversation.contextId) {
      const ctx = await this.contexts.getContext(conversation.contextId).catch(() => undefined);
      if (ctx && ctx.contextLevel === 50) return ctx.instanceId;
    }
    const members = await this.repo.listMembers(conversation.id);
    if (!members.length) return null;
    let common: string[] | null = null;
    for (const memberId of members) {
      const courses = await this.repo.activeCourseIds(memberId);
      common = common === null ? [...courses] : common.filter((id) => courses.includes(id));
      if (!common.length) return null;
    }
    return common?.sort()[0] ?? null;
  }

  /**
   * Lớp mà một conversation "thuộc về" (lát MSG-T2): conversation
   * gắn lớp thì là chính lớp đó; conversation có context là context
   * lớp (mức 45) thì là lớp đó; còn lại không thuộc lớp nào. Dùng để
   * resolve thẩm quyền kiểm duyệt/quản lý qua context lớp — song
   * song với {@link resolveConversationCourseId} ở cấp khoá.
   *
   * @param conversation - Conversation cần resolve phạm vi lớp.
   * @returns Id lớp mà conversation thuộc về, hoặc null.
   */
  async resolveConversationClassId(conversation: ConversationRow): Promise<string | null> {
    if (this.membershipSync.isClassLinked(conversation)) return conversation.itemId;
    if (conversation.contextId) {
      const ctx = await this.contexts.getContext(conversation.contextId).catch(() => undefined);
      if (ctx && ctx.contextLevel === 45) return ctx.instanceId;
    }
    return null;
  }

  /**
   * Người có thẩm quyền KIỂM DUYỆT trên conversation: quản trị viên,
   * hoặc staff của khoá mà conversation thuộc về (gán vai trò staff
   * tại context khoá hoặc tổ tiên — đúng tập
   * {@link MessagingRepository.listCourseStaffUserIds}), hoặc staff
   * của LỚP mà conversation thuộc về (cùng khuôn ở cấp lớp — lát
   * MSG-T2: staff lớp và quản trị tenant tổ tiên có thẩm quyền trên
   * chat lớp như thiết kế).
   *
   * @param userId - Người cần kiểm thẩm quyền.
   * @param conversation - Conversation đang xét.
   * @returns `true` khi có thẩm quyền kiểm duyệt trên conversation.
   */
  async canModerateConversation(userId: string, conversation: ConversationRow): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    const courseId = await this.resolveConversationCourseId(conversation);
    if (courseId) {
      const staff = await this.repo.listCourseStaffUserIds(courseId);
      if (staff.includes(userId)) return true;
    }
    const classId = await this.resolveConversationClassId(conversation);
    if (classId) {
      const staff = await this.repo.listClassStaffUserIds(classId);
      if (staff.includes(userId)) return true;
    }
    return false;
  }

  /**
   * Người có thẩm quyền QUẢN LÝ conversation (bật/tắt chat, gửi khi
   * chat tắt): mọi người có thẩm quyền kiểm duyệt, cộng người tạo —
   * nhưng chỉ với conversation không gắn cấu trúc lớp/khoá. Hệ quả
   * ở chat cấp lớp (MSG-T2): học sinh bấm mở chat lớp đầu tiên chỉ
   * là người tạo BẢN GHI, không thành người quản lý — quản lý thuộc
   * về staff lớp qua đường kiểm duyệt.
   *
   * @param userId - Người cần kiểm thẩm quyền.
   * @param conversation - Conversation đang xét.
   * @returns `true` khi có thẩm quyền quản lý conversation.
   */
  async canManageConversation(userId: string, conversation: ConversationRow): Promise<boolean> {
    if (await this.canModerateConversation(userId, conversation)) return true;
    if (!this.membershipSync.isGroupLinked(conversation) && !this.membershipSync.isCourseLinked(conversation) && !this.membershipSync.isClassLinked(conversation) && conversation.createdBy !== null && conversation.createdBy === userId) return true;
    return false;
  }

  /**
   * Bật/tắt chat của một conversation (Lớp B — chốt "nhóm lớp mặc
   * định chat hai chiều, giáo viên tắt được"): chỉ người có thẩm
   * quyền quản lý theo phạm vi khoá. Khi tắt, đường gửi chặn thành
   * viên thường nhưng người quản lý vẫn gửi được (đường thông báo
   * một chiều của giáo viên).
   */
  async updateConversation(actorId: string, conversationId: string, input: { enabled: boolean }): Promise<ConversationRow & { members: string[] }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.membershipSync.syncGroupConversationIfLinked(conversation);
    if (!(await this.canManageConversation(actorId, conversation))) {
      throw new ForbiddenException({
        message: 'Only the teacher in charge, course staff, an administrator, or the group creator can change this conversation',
        code: 'messaging.conversation_manage_forbidden',
      });
    }
    const updated = await this.repo.setConversationEnabled(conversationId, input.enabled);
    return { ...updated!, members: await this.repo.listMembers(conversationId) };
  }

  /**
   * Gỡ một thành viên khỏi NHÓM TỰ DO (lát MSG-T4, issue #33 — hành
   * động quản trị trong panel thành viên của khung chat).
   *
   * Flow:
   * 1. Nạp conversation; không có thì 404 như mọi đường theo id.
   * 2. Cổng LOẠI conversation: chỉ nhóm tự do (type 2, không gắn
   *    cấu trúc lớp/khoá/nhóm con) mới gỡ tay được ở đây. Thành viên
   *    nhóm cấu trúc suy ra từ roster/ghi danh — gỡ tại chat sẽ bị
   *    đồng bộ lười lắp lại ngay, nên server từ chối thẳng bằng
   *    400 `messaging.member_remove_structural` để client dẫn người
   *    dùng về màn roster thay vì báo thành công giả.
   * 3. Cổng THẨM QUYỀN: chỉ người có thẩm quyền quản lý conversation
   *    (canManageConversation — người tạo nhóm tự do hoặc người có
   *    thẩm quyền kiểm duyệt) mới gỡ được; người ngoài nhận 403
   *    `messaging.conversation_manage_forbidden` như đường bật/tắt
   *    chat.
   * 4. Hai biên bất biến: không tự gỡ chính mình (rời nhóm là luồng
   *    khác, không thuộc lát này) và không gỡ NGƯỜI TẠO nhóm (nhóm
   *    không thể mất chủ sở hữu qua đường này).
   * 5. Xoá dòng thành viên (kèm luôn trạng thái cá nhân ghim/lưu/
   *    tắt tiếng + mốc đã đọc của người đó trên conversation, vì
   *    chúng sống trên cùng dòng) rồi trả conversation kèm danh
   *    sách thành viên mới — cùng hình dạng đường bật/tắt chat.
   *
   * @param actorId - Người gọi (phải có thẩm quyền quản lý).
   * @param conversationId - Nhóm tự do cần gỡ thành viên.
   * @param targetUserId - Thành viên bị gỡ.
   * @returns Conversation sau khi gỡ, kèm danh sách thành viên mới.
   * @throws 404 `messaging.conversation_not_found` khi conversation
   *   không tồn tại; 404 `messaging.member_not_found` khi người bị
   *   gỡ không còn là thành viên; 400
   *   `messaging.member_remove_structural` cho nhóm cấu trúc; 400
   *   `messaging.member_remove_self` khi tự gỡ mình; 403
   *   `messaging.conversation_manage_forbidden` khi thiếu thẩm
   *   quyền; 403 `messaging.member_remove_creator` khi gỡ người tạo.
   */
  async removeConversationMember(actorId: string, conversationId: string, targetUserId: string): Promise<ConversationRow & { members: string[] }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    if (!(await this.canManageConversation(actorId, conversation))) {
      throw new ForbiddenException({
        message: 'Only the teacher in charge, course staff, an administrator, or the group creator can change this conversation',
        code: 'messaging.conversation_manage_forbidden',
      });
    }
    if (conversation.type !== 2 || this.membershipSync.isGroupLinked(conversation) || this.membershipSync.isCourseLinked(conversation) || this.membershipSync.isClassLinked(conversation)) {
      throw new BadRequestException({
        message: 'Members of a class, course or course-group conversation come from its roster — manage them on the roster screen, not in chat',
        code: 'messaging.member_remove_structural',
      });
    }
    if (targetUserId === actorId) {
      throw new BadRequestException({ message: 'You cannot remove yourself from the group', code: 'messaging.member_remove_self' });
    }
    if (conversation.createdBy !== null && conversation.createdBy === targetUserId) {
      throw new ForbiddenException({ message: 'The group creator cannot be removed', code: 'messaging.member_remove_creator' });
    }
    if (!(await this.repo.isMember(conversationId, targetUserId))) {
      throw new NotFoundException({ message: `User ${targetUserId} is not a member of conversation ${conversationId}`, code: 'messaging.member_not_found' });
    }
    await this.repo.removeMember(conversationId, targetUserId);
    const updated = await this.repo.getConversation(conversationId);
    return { ...updated!, members: await this.repo.listMembers(conversationId) };
  }

  /**
   * Đặt trạng thái cá nhân của CHÍNH thành viên trên một conversation
   * (lát M5, issue #240): ghim / lưu trữ / tắt tiếng — ba cờ độc lập,
   * chỉ trường có mặt mới đổi. Cổng như các đường theo id của thành
   * viên: conversation không tồn tại, người ngoài, và hội thoại 1–1
   * đang bị chặn đều 404 `messaging.conversation_not_found` — trạng
   * thái cá nhân không bao giờ lộ tồn tại của conversation với người
   * không thuộc về nó. Trạng thái chỉ chạm dòng thành viên của chính
   * người gọi; phía còn lại không đổi.
   */
  async updateConversationState(
    userId: string,
    conversationId: string,
    input: { pinned?: boolean; archived?: boolean; muted?: boolean },
  ): Promise<{ conversationId: string; pinned: boolean; pinnedAt: Date | null; archived: boolean; archivedAt: Date | null; muted: boolean }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.membershipSync.syncGroupConversationIfLinked(conversation);
    if (!(await this.repo.isMember(conversationId, userId))) {
      throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    }
    await this.assertDirectConversationVisible(userId, conversation);
    const state = await this.repo.updateMemberConversationState(conversationId, userId, input);
    if (!state) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    return {
      conversationId,
      pinned: state.pinnedAt !== null,
      pinnedAt: state.pinnedAt,
      archived: state.archivedAt !== null,
      archivedAt: state.archivedAt,
      muted: state.muted,
    };
  }

  /**
   * Conversation của user kèm số chưa đọc, tin cuối và mốc đã đọc của
   * chính user — lấy bằng MỘT truy vấn tổng hợp ở repository (không còn
   * tải toàn bộ lịch sử về đếm như trước). Conversation gắn group được
   * đồng bộ lười trước khi liệt kê — kể cả các group mà user mới gia
   * nhập (chưa từng là thành viên conversation) để chúng xuất hiện
   * ngay; membership đã cũ (user đã rời group nhưng chưa lần đồng bộ
   * nào chạy) được đồng bộ và loại khỏi danh sách tại đây.
   */
  async listConversations(userId: string, opts: { archivedOnly?: boolean } = {}): Promise<(ConversationRow & {
    members: string[]; unread: number; lastReadSeq: number; lastMessage: MessageRow | null;
    pinnedAt: Date | null; archivedAt: Date | null; muted: boolean;
    memberProfiles: Record<string, PersonSummaryView>;
  })[]> {
    for (const c of await this.repo.listGroupConversationsForGroupMember(userId)) {
      await this.membershipSync.syncGroupConversationMembers(c);
    }
    for (const c of await this.repo.listCourseConversationsForMember(userId)) {
      await this.membershipSync.syncCourseConversationMembers(c);
    }
    for (const c of await this.repo.listClassConversationsForMember(userId)) {
      await this.membershipSync.syncClassConversationMembers(c);
    }
    const summaries = await this.repo.listConversationSummaries(userId, opts);
    const myGroupIds = new Set(await this.repo.listGroupIdsForUser(userId));
    const out: (ConversationRow & {
      members: string[]; unread: number; lastReadSeq: number; lastMessage: MessageRow | null;
      pinnedAt: Date | null; archivedAt: Date | null; muted: boolean;
    })[] = [];
    for (const s of summaries) {
      if (this.membershipSync.isGroupLinked(s.conversation) && !myGroupIds.has(s.conversation.itemId!)) {
        // Đã rời group nhưng membership conversation chưa được đồng bộ:
        // đồng bộ ngay (gỡ user khỏi conversation) và ẩn khỏi danh sách.
        await this.membershipSync.syncGroupConversationMembers(s.conversation);
        continue;
      }
      if (this.membershipSync.isCourseLinked(s.conversation)) {
        // Đã rời khoá (huỷ ghi danh/hết vai staff) nhưng membership
        // conversation chưa được đồng bộ: đối chiếu tập thành viên đúng
        // nghĩa của khoá — không còn thuộc thì đồng bộ ngay (gỡ user
        // khỏi conversation) và ẩn khỏi danh sách như đường group.
        const memberIds = await this.repo.listCourseConversationMemberIds(s.conversation.itemId!);
        if (!memberIds.includes(userId)) {
          await this.membershipSync.syncCourseConversationMembers(s.conversation);
          continue;
        }
      }
      if (this.membershipSync.isClassLinked(s.conversation)) {
        // Đã rời lớp (rời roster/hết vai tại lớp) nhưng membership
        // conversation chưa được đồng bộ: đối chiếu tập thành viên
        // đúng nghĩa của lớp như đường khoá ở trên.
        const memberIds = await this.repo.listClassConversationMemberIds(s.conversation.itemId!);
        if (!memberIds.includes(userId)) {
          await this.membershipSync.syncClassConversationMembers(s.conversation);
          continue;
        }
      }
      out.push({
        ...s.conversation,
        members: s.members,
        unread: s.unreadCount,
        lastReadSeq: s.lastReadSeq,
        // Trạng thái cá nhân của chính người xem (lát M5): client
        // hiện dấu ghim, số chưa đọc dạng mờ khi tắt tiếng, và biết
        // mình đang ở mục đã lưu hay mục chính.
        pinnedAt: s.pinnedAt,
        archivedAt: s.archivedAt,
        muted: s.muted,
        // Danh sách là đường đọc thường: tin cuối đã thu hồi thì xem
        // trước chỉ còn dấu vết thu hồi, không lộ nội dung gốc.
        lastMessage: s.lastMessage ? blankRecalledContent(s.lastMessage) : null,
      });
    }
    // Tên hiển thị của mọi thành viên (gồm người gửi tin cuối) để
    // client hiện TÊN thay cho UUID thô trong danh sách.
    const profiles = await this.contacts.profilesFor(out.flatMap((entry) => entry.members));
    return out.map((entry) => ({
      ...entry,
      memberProfiles: Object.fromEntries(
        entry.members.filter((id) => profiles[id]).map((id) => [id, profiles[id]!]),
      ),
    }));
  }

  /**
   * Cổng tầm nhìn hội thoại 1–1 khi đang chặn (việc nối tiếp của
   * issue #33, siết sau PR #89): danh sách hội thoại đã ẩn hội thoại
   * 1–1 có quan hệ chặn ở bất kỳ chiều nào, nhưng đường MỞ THẲNG
   * theo id (deep-link từ thông báo) trước đây chỉ kiểm tra tư cách
   * thành viên nên vẫn đọc được. Từ nay mọi đường đọc theo id của
   * hội thoại 1–1 đang bị chặn — chi tiết, cửa sổ lịch sử, đánh dấu
   * đã đọc — hành xử như hội thoại KHÔNG TỒN TẠI đối với cả hai
   * phía (404, cùng mã `messaging.conversation_not_found`); dữ liệu
   * giữ nguyên, bỏ chặn là mở lại. Hội thoại nhóm không bị chạm:
   * cổng chỉ chạy khi `type === 1`.
   */
  async assertDirectConversationVisible(userId: string, conversation: ConversationRow): Promise<void> {
    if (conversation.type !== 1) return;
    const members = await this.repo.listMembers(conversation.id);
    const other = members.find((id) => id !== userId);
    if (!other) return;
    if ((await this.repo.listBlockedCounterpartIds(userId)).includes(other)) {
      throw new NotFoundException({ message: `Conversation ${conversation.id} not found`, code: 'messaging.conversation_not_found' });
    }
  }

  /**
   * Chi tiết conversation + một cửa sổ tin nhắn mới nhất theo cursor
   * seq (chỉ thành viên mới xem được; conversation gắn group được đồng
   * bộ thành viên trước khi kiểm tra). `memberReadMarkers` cho client
   * hiển thị biên "đã xem" theo mốc đã đọc của từng thành viên.
   * Hội thoại 1–1 đang có quan hệ chặn thì 404 như không tồn tại
   * (xem {@link assertDirectConversationVisible}).
   */
  async getConversation(userId: string, conversationId: string, opts: { limit?: number } = {}): Promise<ConversationRow & {
    members: string[]; messages: MessageWithQuoteRow[]; hasMoreBefore: boolean;
    lastReadSeq: number; memberReadMarkers: { userId: string; lastReadSeq: number }[];
    memberProfiles: Record<string, PersonSummaryView>;
    canModerate: boolean; canManage: boolean;
  }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.membershipSync.syncGroupConversationIfLinked(conversation);
    await this.assertConversationMember(userId, conversation);
    await this.assertDirectConversationVisible(userId, conversation);
    // Tầm nhìn theo vai trò (Lớp B): thành viên thường KHÔNG BAO GIỜ
    // thấy tin đã xoá mềm; người có thẩm quyền kiểm duyệt trên
    // conversation (giáo viên phụ trách/quản trị) thấy cả tin đã xoá
    // kèm dấu vết — đó là đường truy vết của chính sách xoá mềm.
    const canModerate = await this.canModerateConversation(userId, conversation);
    const canManage = canModerate || await this.canManageConversation(userId, conversation);
    // Đường đọc thường (không phải truy vết): lọc tin chính người xem
    // đã xoá-phía-mình và vô hiệu nội dung tin đã thu hồi. Đường truy
    // vết (canModerate) giữ nguyên mọi thứ kèm dấu vết đầy đủ.
    const rawMessages = await this.repo.listMessages(conversationId, {
      limit: opts.limit ?? 50,
      includeDeleted: canModerate,
      viewerId: canModerate ? undefined : userId,
    });
    // Khối trích dẫn (lát M3) dựng từ dòng tin gốc THÔ theo quyền
    // của người xem, TRƯỚC khi vô hiệu nội dung tin đã thu hồi của
    // chính cửa sổ — hai việc độc lập: quote lộ hay không do trạng
    // thái của tin GỐC quyết, theo messageQuoteOf.
    const withQuotes = await this.repo.attachQuotes(rawMessages, {
      privileged: canModerate,
      viewerId: canModerate ? undefined : userId,
    });
    const messages = canModerate ? withQuotes : withQuotes.map((m) => ({ ...blankRecalledContent(m), replyTo: m.replyTo }));
    const markers = await this.repo.listMemberReadMarkers(conversationId);
    const members = await this.repo.listMembers(conversationId);
    return {
      ...conversation,
      members,
      messages,
      hasMoreBefore: messages.length > 0 ? await this.repo.hasMessagesBefore(conversationId, messages[0]!.seq, canModerate, canModerate ? undefined : userId) : false,
      lastReadSeq: markers.find((m) => m.userId === userId)?.lastReadSeq ?? 0,
      memberReadMarkers: markers,
      // Tên hiển thị của thành viên: client dùng cho nhãn người gửi,
      // chỉ báo đang gõ và danh sách thành viên (thay UUID thô).
      memberProfiles: await this.contacts.profilesFor(members),
      canModerate,
      canManage,
    };
  }
}
