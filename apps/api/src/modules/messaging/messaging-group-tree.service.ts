import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MessagingRepository } from './messaging.repository';
import type { ContactRelationship, PersonSummaryView } from './messaging-contacts.service';
import { MessagingMembershipSyncService } from './messaging-membership-sync.service';

/** Một dòng roster thành viên khoá: tóm tắt hiển thị + dấu hiệu vai trò + trạng thái quan hệ với người xem. */
export interface CourseRosterMemberView extends PersonSummaryView {
  role: 'teacher' | 'student';
  relationship: ContactRelationship;
  /**
   * Người xem là giáo viên của khoá này và thành viên đang ghi danh
   * hiệu lực trong khoá → hai người nhắn riêng trực tiếp được không
   * cần kết bạn (ngoại lệ chốt bổ sung 25/10/2026 trên issue #33).
   * Web hiện nút "Nhắn tin" tại dòng theo cờ này; cổng API vẫn tự
   * kiểm lại quan hệ tại mỗi lần mở/gửi, cờ này chỉ là gợi ý hiển thị.
   */
  canDirectMessage: boolean;
}

/**
 * Một dòng roster thành viên LỚP: cùng hình dạng dòng roster khoá —
 * `canDirectMessage` là người xem là giáo viên của lớp này và thành
 * viên đang thuộc roster hiệu lực của lớp → nhắn riêng trực tiếp
 * được theo cùng ngoại lệ GV–HS (sổ quyết định mục D: HS thuộc
 * khoá/LỚP của mình).
 */
export type ClassRosterMemberView = CourseRosterMemberView;

/** Một khoá mà người dùng thuộc về — đầu vào của luồng tìm bạn theo khoá. */
export interface MessagingCourseView {
  courseId: string;
  fullName: string;
  shortName: string;
}

/** Vai của người gọi tại một nút cây nhóm (hợp đồng ở @lms/contracts, lát MSG-T1). */
export type ConversationTreeRole = 'teaching' | 'learning' | 'staff';

/**
 * Nút NHÓM CON của cây nhóm: chat chưa ensure thì conversationId
 * null + unread 0. `pinnedAt` là mốc ghim CÁ NHÂN của người gọi
 * trên conversation của nút (null = chưa ghim / chưa có
 * conversation / chưa là thành viên) — xem ghi chú ở nút lớp.
 */
export interface ConversationTreeGroupView {
  groupId: string;
  name: string;
  myRole: ConversationTreeRole;
  conversationId: string | null;
  unread: number;
  pinnedAt: Date | null;
}

/** Nút NHÓM TỰ DO của cây nhóm (conversation luôn đã tồn tại); `pinnedAt` là mốc ghim cá nhân của người gọi. */
export interface ConversationTreeFreeGroupView {
  conversationId: string;
  name: string;
  myRole: ConversationTreeRole;
  unread: number;
  pinnedAt: Date | null;
}

/** Nút KHOÁ của cây nhóm: unread gồm chat khoá + các nhóm con của nó; `pinnedAt` là mốc ghim cá nhân của người gọi trên chat khoá. */
export interface ConversationTreeCourseView {
  courseId: string;
  name: string;
  myRole: ConversationTreeRole;
  conversationId: string | null;
  unread: number;
  pinnedAt: Date | null;
  groups: ConversationTreeGroupView[];
}

/**
 * Nút LỚP của cây nhóm: unread là tổng của nút lớp + mọi nút con.
 * Mọi nút của cây mang `pinnedAt`: mốc ghim CÁ NHÂN của người gọi
 * trên conversation của chính nút đó, lấy từ dòng thành viên của
 * người gọi trên cả hai tập hội thoại chưa lưu trữ và đã lưu trữ
 * (ghim và lưu trữ là hai trạng thái độc lập — hội thoại vừa ghim
 * vừa lưu trữ vẫn phải báo đúng mốc ghim để client xếp hàng vào
 * mục Ghim của tab Nhóm); null khi nút chưa có conversation hoặc
 * người gọi chưa là thành viên của conversation đó.
 */
export interface ConversationTreeClassView {
  classId: string;
  name: string;
  myRole: ConversationTreeRole;
  conversationId: string | null;
  unread: number;
  pinnedAt: Date | null;
  courses: ConversationTreeCourseView[];
}

/** CÂY NHÓM của chính người gọi (GET /messages/group-tree, lát MSG-T1). */
export interface ConversationGroupTreeView {
  classes: ConversationTreeClassView[];
  coursesOutsideClasses: ConversationTreeCourseView[];
  freeGroups: ConversationTreeFreeGroupView[];
  /**
   * Người gọi có được tạo nhóm tự do hay không, do facade tính bằng
   * ĐÚNG cổng của API (MessagingConversationsService.canCreateFreeGroup)
   * cho tenant hiện hành và truyền xuống — web hiện nút tạo nhóm theo
   * cờ này, không tự suy từ vai trên cây.
   */
  canCreateFreeGroup: boolean;
}

/** Roster thành viên khoá: kích thước trang mặc định và trần cứng mỗi trang (phân trang con trỏ là bắt buộc — xem contracts). */
export const ROSTER_DEFAULT_PAGE_SIZE = 50;

export const ROSTER_MAX_PAGE_SIZE = 100;

/**
 * CÂY NHÓM + ROSTER của MessagingModule (cụm ca sử dụng "cây nhóm/roster").
 *
 * Luồng nghiệp vụ: cây nhóm (GET /messages/group-tree, lát MSG-T1) là
 * bản đồ điều hướng nhắn tin của chính người gọi — lớp của tôi → khoá
 * trong lớp → nhóm con của khoá, cộng khoá ngoài lớp và nhóm tự do —
 * mỗi nút mang conversation tương ứng (chưa ensure thì conversationId
 * null) và số chưa đọc đã gồm các nút con, sau khi đồng bộ lười thành
 * viên các conversation gắn cấu trúc. Mỗi nút của cây còn mang
 * mốc ghim cá nhân của người gọi trên conversation của nút —
 * dựng từ cả hai tập tóm tắt hội thoại (chưa lưu trữ và đã lưu
 * trữ) vì hai trạng thái ghim/lưu trữ độc lập nhau. Roster thành viên khoá/lớp là
 * bề mặt KHÁM PHÁ bạn bè duy nhất (cổng liên lạc đã chốt trên issue
 * #33: không tìm người theo tên): phân trang con trỏ keyset bắt buộc,
 * mỗi dòng kèm vai trò, trạng thái quan hệ với người xem và cờ
 * `canDirectMessage` theo ngoại lệ giáo viên–học viên cùng khoá/lớp.
 * `listMyMessagingCourses` liệt kê các khoá người gọi thuộc về — đầu
 * vào của luồng tìm bạn theo khoá và của ghi đè tắt tiếng theo khoá ở
 * cụm thông báo.
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
export class MessagingGroupTreeService {
  constructor(
    private readonly repo: MessagingRepository,
    private readonly membershipSync: MessagingMembershipSyncService,
  ) {}

  // --- roster thành viên khoá (khám phá bạn bè) --------------------------------

  /**
   * Các khoá mà người dùng thuộc về (ghi danh hiệu lực ∪ gán vai tại
   * context khoá) — bước chọn khoá của luồng tìm bạn mới. Sắp theo
   * tên khoá cho ổn định.
   */
  async listMyMessagingCourses(actorId: string): Promise<MessagingCourseView[]> {
    const courseIds = await this.repo.listMembershipCourseIds(actorId);
    const out: MessagingCourseView[] = [];
    for (const courseId of courseIds) {
      const summary = await this.repo.getCourseSummary(courseId);
      if (summary) out.push(summary);
    }
    return out.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.shortName.localeCompare(b.shortName));
  }

  /**
   * CÂY NHÓM của chính người gọi (lát MSG-T1, issue #33 — thiết kế
   * cấu trúc nhắn tin chốt 11:36 ngày 26/10/2026): Lớp → Khoá → Nhóm
   * con theo VAI của người xem, cộng mục Nhóm tự do. Cây dựng hoàn
   * toàn ở server (classes + enrol + conversations): lớp tôi chỉ
   * thuộc QUA một khoá (không có quan hệ trực tiếp với lớp) vẫn xuất
   * hiện đúng vị trí cha của khoá đó — phần "chỉ qua khoá" được tổng
   * hợp thành khoá nằm NGOÀI các lớp trực tiếp của tôi
   * (`coursesOutsideClasses`) để client không mất khoá nào.
   *
   * Mỗi nút: `conversationId` null khi chat của nút CHƯA được ensure
   * (bấm vào mới ensure ở MSG-T3/T2), unread khi đó là 0; đã ensure
   * thì unread là số chưa đọc của chính người gọi trên conversation
   * đó. Unread của nút khoá gồm chat khoá + các nhóm con của nó;
   * unread của nút lớp là tổng của nút lớp + mọi nút con — để nhìn
   * lướt là biết lớp/khoá nào đang có tin. Chat cấp lớp (MSG-T2) là
   * conversation riêng của nút lớp: conversationId của nút tra theo
   * item 'class' như các nút khác — null cho tới khi có người thuộc
   * lớp mở chat lớp lần đầu (bấm vào nút ở MSG-T3 sẽ ensure qua
   * endpoint cấp lớp). Đồng bộ lười membership được kích hoạt như ở
   * danh sách conversation để số chưa đọc bám đúng tư cách thành
   * viên hiện tại.
   *
   * @param actorId - Người gọi cây nhóm của chính mình.
   * @param canCreateFreeGroup - Cờ quyền tạo nhóm tự do do facade tính
   * bằng cổng tạo nhóm của cụm hội thoại cho tenant hiện hành; cụm này
   * chỉ gắn nguyên vẹn vào kết quả, không tự suy quyền.
   */
  async getGroupTree(actorId: string, canCreateFreeGroup: boolean): Promise<ConversationGroupTreeView> {
    // Đồng bộ lười membership như listConversations: group/khoá tôi
    // mới gia nhập (hoặc đã rời) phải phản ánh đúng trước khi đếm.
    for (const c of await this.repo.listGroupConversationsForGroupMember(actorId)) {
      await this.membershipSync.syncGroupConversationMembers(c);
    }
    for (const c of await this.repo.listCourseConversationsForMember(actorId)) {
      await this.membershipSync.syncCourseConversationMembers(c);
    }
    for (const c of await this.repo.listClassConversationsForMember(actorId)) {
      await this.membershipSync.syncClassConversationMembers(c);
    }

    const classRelations = await this.repo.listTreeClassesForUser(actorId);
    const myClassIds = new Set(classRelations.map((r) => r.classId));
    // Khoá dạng MẪU (is_template) không phải khoá đang dạy/học — loại
    // ở cả hai đường (qua lớp và qua thành viên khoá).
    const membershipCourseIds = await this.repo.listMembershipCourseIds(actorId);
    const myCourseNameRows = await this.repo.listCourseNames(membershipCourseIds);
    const myCourseIds = new Set(myCourseNameRows.map((r) => r.courseId));
    const coursesInMyClasses = (await this.repo.listCoursesByClassIds([...myClassIds]))
      .filter((c) => myCourseIds.has(c.courseId));
    // Lớp chứa các khoá tôi thuộc về nhưng tôi không có quan hệ trực
    // tiếp: các khoá đó nằm ở coursesOutsideClasses (giữ nguyên
    // classId của chúng trong dữ liệu nguồn — client MSG-T3 trình
    // bày phẳng phần này, không ngắt quan hệ lớp–khoá ở dữ liệu).
    const parentRows = await this.repo.listClassesOfCourses(
      [...myCourseIds].filter((id) => !coursesInMyClasses.some((c) => c.courseId === id)),
    );
    const outsideCourseIds = parentRows
      .filter((r) => !myClassIds.has(r.classId) && r.classStatus === 'active')
      .map((r) => r.courseId);
    const detachedCourseIds = [...myCourseIds].filter((id) => !coursesInMyClasses.some((c) => c.courseId === id) && !parentRows.some((r) => r.courseId === id));
    const outsideAll = [...outsideCourseIds, ...detachedCourseIds];

    const allCourseIds = [...new Set([...coursesInMyClasses.map((c) => c.courseId), ...outsideAll])];
    const teachingIds = new Set(await this.repo.listTeachingCourseIds(actorId, allCourseIds));
    const nameOfCourse = new Map(myCourseNameRows.map((r) => [r.courseId, r.fullName]));

    // Số chưa đọc theo conversation của chính tôi (một truy vấn tổng
    // hợp như danh sách conversation; conversation đã lưu trữ vẫn
    // tính ở cây — cây là cấu trúc điều hướng, không phải hộp thư).
    const summaries = await this.repo.listConversationSummaries(actorId, {});
    const summariesArchived = await this.repo.listConversationSummaries(actorId, { archivedOnly: true });
    const unreadByConversation = new Map<string, number>();
    for (const s of [...summaries, ...summariesArchived]) {
      unreadByConversation.set(s.conversation.id, s.unreadCount);
    }
    // Mốc ghim CÁ NHÂN của chính tôi theo conversation, dựng từ
    // CẢ HAI tập tóm tắt như số chưa đọc ở trên: ghim và lưu trữ
    // là hai trạng thái độc lập trên dòng thành viên, nên hội
    // thoại vừa ghim vừa lưu trữ chỉ xuất hiện ở tập đã lưu —
    // chỉ nhìn tập chưa lưu là mất trạng thái ghim của nó và
    // client xếp sai mục ở tab Nhóm. Conversation không có dòng
    // tóm tắt (tôi chưa là thành viên) thì không có trạng thái
    // ghim cá nhân — tra bản đồ ra undefined, nút nhận null.
    const pinnedAtByConversation = new Map<string, Date | null>();
    for (const s of [...summaries, ...summariesArchived]) {
      pinnedAtByConversation.set(s.conversation.id, s.pinnedAt);
    }
    // conversationId của nút cấu trúc tra TRỰC TIẾP theo item (đã
    // ensure hay chưa là sự thật ở bảng conversation, không phụ
    // thuộc việc tôi đã là thành viên conversation hay chưa); số chưa
    // đọc mới là phần theo người xem (không có dòng thành viên thì 0).
    const courseConvByCourse = new Map(
      (await this.repo.listCourseConversationsByCourseIds(allCourseIds)).map((c) => [c.itemId!, c.id]),
    );
    const classConvByClass = new Map(
      (await this.repo.listClassConversations([...myClassIds])).map((c) => [c.itemId!, c.id]),
    );

    // Nhóm con: các group tôi là thành viên, chỉ giữ group thuộc các
    // khoá có mặt trong cây.
    const myGroupIds = await this.repo.listGroupIdsForUser(actorId);
    const groupRows = (await this.repo.listGroupNames(myGroupIds))
      .filter((g) => allCourseIds.includes(g.courseId));
    const groupConvByGroup = new Map(
      (await this.repo.listGroupConversationsByGroupIds(groupRows.map((g) => g.groupId))).map((c) => [c.itemId!, c.id]),
    );

    const buildCourseNode = (courseId: string, name: string, myRole: ConversationTreeRole): ConversationTreeCourseView => {
      const convId = courseConvByCourse.get(courseId) ?? null;
      let unread = convId ? (unreadByConversation.get(convId) ?? 0) : 0;
      const groups: ConversationTreeGroupView[] = groupRows
        .filter((g) => g.courseId === courseId)
        .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
        .map((g) => {
          const gConvId = groupConvByGroup.get(g.groupId) ?? null;
          const gUnread = gConvId ? (unreadByConversation.get(gConvId) ?? 0) : 0;
          unread += gUnread;
          return {
            groupId: g.groupId, name: g.name, myRole, conversationId: gConvId, unread: gUnread,
            pinnedAt: gConvId ? (pinnedAtByConversation.get(gConvId) ?? null) : null,
          };
        });
      return {
        courseId, name, myRole, conversationId: convId, unread,
        pinnedAt: convId ? (pinnedAtByConversation.get(convId) ?? null) : null,
        groups,
      };
    };

    const classNodes: ConversationTreeClassView[] = [];
    for (const rel of classRelations) {
      const myRole: ConversationTreeRole = rel.isOwner ? 'teaching' : rel.isClassStaff ? 'staff' : 'learning';
      // Vai tại khoá suy từ vai tại lớp khi tôi có vai công tác ở
      // lớp: chủ lớp/staff lớp dạy các khoá trong lớp của mình; thành
      // viên roster thuần tuý thì học các khoá đó trừ khoá mình có
      // gán vai staff riêng (đã tính ở teachingIds).
      const courseNodes = coursesInMyClasses
        .filter((c) => c.classId === rel.classId)
        .sort((a, b) => a.fullName.localeCompare(b.fullName, 'vi'))
        .map((c) => buildCourseNode(
          c.courseId,
          c.fullName,
          teachingIds.has(c.courseId) || rel.isOwner || rel.isClassStaff ? 'teaching' : 'learning',
        ));
      const classConvId = classConvByClass.get(rel.classId) ?? null;
      const ownUnread = classConvId ? (unreadByConversation.get(classConvId) ?? 0) : 0;
      const totalUnread = ownUnread + courseNodes.reduce((sum, n) => sum + n.unread, 0);
      classNodes.push({
        classId: rel.classId, name: rel.name, myRole, conversationId: classConvId, unread: totalUnread,
        pinnedAt: classConvId ? (pinnedAtByConversation.get(classConvId) ?? null) : null,
        courses: courseNodes,
      });
    }
    classNodes.sort((a, b) => a.name.localeCompare(b.name, 'vi'));

    const outsideNodes = outsideAll
      .sort((a, b) => (nameOfCourse.get(a) ?? '').localeCompare(nameOfCourse.get(b) ?? '', 'vi'))
      .map((courseId) => buildCourseNode(
        courseId,
        nameOfCourse.get(courseId) ?? courseId,
        teachingIds.has(courseId) ? 'teaching' : 'learning',
      ));

    // Nhóm tự do: conversation type 2 KHÔNG gắn cấu trúc mà tôi là
    // thành viên (đúng tập listConversationSummaries trả về — đã qua
    // cổng hiển thị của danh sách). Mốc ghim lấy thẳng từ dòng tóm
    // tắt của chính conversation (dòng thành viên của tôi trên một
    // trong hai tập) nên nhóm vừa ghim vừa lưu trữ vẫn mang đúng
    // mốc ghim như nhóm chỉ ghim.
    const freeGroups: ConversationTreeFreeGroupView[] = [...summaries, ...summariesArchived]
      .filter((s) => s.conversation.type === 2 && !s.conversation.itemType)
      .sort((a, b) => b.conversation.updatedAt.getTime() - a.conversation.updatedAt.getTime())
      .map((s) => ({
        conversationId: s.conversation.id,
        name: s.conversation.name ?? '',
        myRole: (s.conversation.createdBy === actorId ? 'staff' : 'learning') as ConversationTreeRole,
        unread: s.unreadCount,
        pinnedAt: s.pinnedAt,
      }));

    return { classes: classNodes, coursesOutsideClasses: outsideNodes, freeGroups, canCreateFreeGroup };
  }

  /** Giải mã con trỏ phân trang roster; con trỏ hỏng → 400 rõ ràng thay vì lặng lẽ về trang đầu. */
  private decodeRosterCursor(raw: string): { displayName: string; username: string; userId: string } {
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
        d?: unknown; u?: unknown; i?: unknown;
      };
      if (typeof parsed.d !== 'string' || typeof parsed.u !== 'string' || typeof parsed.i !== 'string') {
        throw new Error('bad cursor shape');
      }
      return { displayName: parsed.d, username: parsed.u, userId: parsed.i };
    } catch {
      throw new BadRequestException({ message: 'Invalid roster cursor', code: 'messaging.roster_cursor_invalid' });
    }
  }

  /**
   * Một trang roster thành viên của một khoá — đường khám phá bạn bè
   * duy nhất sau khi gỡ tìm người theo tên (quyết định 24/10/2026
   * trên issue #33). Cổng xem: chỉ THÀNH VIÊN của chính khoá đó (ghi
   * danh hiệu lực ∪ gán vai tại context khoá) mới xem được; người
   * ngoài khoá nhận đúng 404 như khoá không tồn tại — không oracle
   * xác nhận tồn tại khoá hay số thành viên. Mỗi dòng đúng whitelist
   * đã kiểm chứng (userId, displayName, username) + dấu hiệu vai trò
   * + trạng thái quan hệ với người xem; quan hệ chặn (cả hai chiều)
   * đã bị giấu ngay tại SQL nên `blocked` không xuất hiện ở đây.
   * Mỗi dòng còn mang `canDirectMessage`: người xem là giáo viên của
   * khoá và thành viên đang ghi danh hiệu lực thì nhắn riêng trực
   * tiếp được theo ngoại lệ GV–HS (chốt bổ sung 25/10/2026 trên
   * issue #33) — web hiện nút "Nhắn tin" theo cờ này.
   * Phân trang con trỏ theo (displayName, username, id), trần trang
   * {@link ROSTER_MAX_PAGE_SIZE} — không có đường lấy toàn bộ roster.
   */
  async listCourseRoster(actorId: string, courseId: string, query: { limit?: number; cursor?: string }): Promise<{
    members: CourseRosterMemberView[];
    nextCursor: string | null;
  }> {
    const course = await this.repo.getCourseSummary(courseId);
    if (!course || !(await this.repo.isCourseMember(courseId, actorId))) {
      throw new NotFoundException({ message: 'Course not found', code: 'messaging.course_not_found' });
    }
    const limit = Math.min(Math.max(query.limit ?? ROSTER_DEFAULT_PAGE_SIZE, 1), ROSTER_MAX_PAGE_SIZE);
    const cursor = query.cursor ? this.decodeRosterCursor(query.cursor) : null;
    const rows = await this.repo.listCourseRosterPage(courseId, actorId, cursor, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const [contactIds, incoming, outgoing, viewerIsTeacher] = await Promise.all([
      this.repo.listContacts(actorId),
      this.repo.listIncomingContactRequests(actorId),
      this.repo.listOutgoingContactRequests(actorId),
      this.repo.isCourseTeachingStaff(courseId, actorId),
    ]);
    const contactSet = new Set(contactIds);
    const incomingSet = new Set(incoming.map((r) => r.userIdFrom));
    const outgoingSet = new Set(outgoing.map((r) => r.userIdTo));
    const relationshipOf = (id: string): ContactRelationship => {
      if (contactSet.has(id)) return 'contact';
      if (incomingSet.has(id)) return 'pending_incoming';
      if (outgoingSet.has(id)) return 'pending_outgoing';
      return 'none';
    };
    const members = page.map((row) => ({
      userId: row.userId,
      displayName: row.displayName,
      username: row.username,
      role: (row.staff ? 'teacher' : 'student') as 'teacher' | 'student',
      relationship: relationshipOf(row.userId),
      // Cờ nhắn thẳng khớp đúng cổng API: người xem dạy khoá này +
      // thành viên đang ghi danh (dòng có quan hệ chặn đã bị SQL giấu
      // nên không cần trừ ở đây).
      canDirectMessage: viewerIsTeacher && row.enrolled,
    }));
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ d: last.displayName, u: last.username, i: last.userId }), 'utf8').toString('base64url')
      : null;
    return { members, nextCursor };
  }

  /**
   * Một trang roster thành viên của một LỚP — bản cấp lớp của roster
   * khoá (lát MSG-T2, issue #184; hồ sơ cấu trúc nhắn tin mục 4.6):
   * tập thành viên là roster lớp hiệu lực (backing cohort) ∪ gán vai
   * tại context lớp ∪ chủ lớp. Cổng xem cùng kỷ luật roster khoá:
   * chỉ người thuộc lớp mới xem được; người ngoài lớp (và lớp đã lưu
   * trữ) nhận đúng 404 như lớp không tồn tại. `canDirectMessage`
   * khớp đúng cổng nhắn riêng: người xem là giáo viên của lớp
   * (staff tại context lớp — chủ lớp mang editingteacher tại đó) và
   * thành viên đang thuộc roster hiệu lực thì nhắn trực tiếp được
   * theo ngoại lệ GV–HS ở cấp lớp (sổ mục D).
   *
   * Flow: kiểm lớp tồn tại + đang hoạt động + người xem thuộc lớp →
   * đọc một trang (limit + 1 dòng để biết còn trang sau) → gắn quan
   * hệ liên hệ và cờ nhắn thẳng cho từng dòng → mã hoá con trỏ
   * trang kế từ dòng cuối trang.
   *
   * @param actorId - Người xem (phải thuộc lớp).
   * @param classId - Lớp cần lấy roster.
   * @param query - `limit` (kẹp trong [1, trần trang]) và `cursor`
   *   mờ của trang trước, nếu có.
   * @returns Một trang thành viên kèm `nextCursor` (null khi hết).
   * @throws {NotFoundException} `messaging.class_not_found` khi lớp
   *   không tồn tại, đã lưu trữ, hoặc người xem không thuộc lớp —
   *   ba trường hợp không phân biệt được với nhau.
   */
  async listClassRoster(actorId: string, classId: string, query: { limit?: number; cursor?: string }): Promise<{
    members: ClassRosterMemberView[];
    nextCursor: string | null;
  }> {
    const cls = await this.repo.getClassSummary(classId);
    if (!cls || cls.status !== 'active' || !(await this.repo.isClassMember(classId, actorId))) {
      throw new NotFoundException({ message: 'Class not found', code: 'messaging.class_not_found' });
    }
    const limit = Math.min(Math.max(query.limit ?? ROSTER_DEFAULT_PAGE_SIZE, 1), ROSTER_MAX_PAGE_SIZE);
    const cursor = query.cursor ? this.decodeRosterCursor(query.cursor) : null;
    const rows = await this.repo.listClassRosterPage(classId, actorId, cursor, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const [contactIds, incoming, outgoing, viewerIsTeacher] = await Promise.all([
      this.repo.listContacts(actorId),
      this.repo.listIncomingContactRequests(actorId),
      this.repo.listOutgoingContactRequests(actorId),
      this.repo.isClassTeachingStaff(classId, actorId),
    ]);
    const contactSet = new Set(contactIds);
    const incomingSet = new Set(incoming.map((r) => r.userIdFrom));
    const outgoingSet = new Set(outgoing.map((r) => r.userIdTo));
    const relationshipOf = (id: string): ContactRelationship => {
      if (contactSet.has(id)) return 'contact';
      if (incomingSet.has(id)) return 'pending_incoming';
      if (outgoingSet.has(id)) return 'pending_outgoing';
      return 'none';
    };
    const members = page.map((row) => ({
      userId: row.userId,
      displayName: row.displayName,
      username: row.username,
      role: (row.staff ? 'teacher' : 'student') as 'teacher' | 'student',
      relationship: relationshipOf(row.userId),
      // Cờ nhắn thẳng khớp đúng cổng API (assertCanContact có vế
      // cấp lớp): người xem dạy lớp này + thành viên thuộc roster.
      canDirectMessage: viewerIsTeacher && row.enrolled,
    }));
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ d: last.displayName, u: last.username, i: last.userId }), 'utf8').toString('base64url')
      : null;
    return { members, nextCursor };
  }
}
