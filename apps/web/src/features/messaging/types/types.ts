// Hình dạng dữ liệu của cụm Tin nhắn (trang + các panel con).

/** Handle cuộn tối thiểu của MessageScroller mà trang cần để nhảy tới tin gốc từ khối trích dẫn (lát M3). */
export type ScrollerHandle = { scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => boolean };
/** Khối tóm tắt TRÍCH DẪN do server dựng sẵn (lát M3, issue #229) — khớp `messageQuoteSchema` của contracts. */
export interface MessageQuoteView {
  id: string;
  seq: number;
  userIdFrom: string;
  excerpt: string;
  /** Tin gốc không còn hiển thị được (đã xoá/thu hồi): hiện dòng "tin gốc đã bị xoá", excerpt rỗng. */
  unavailable: boolean;
}

export interface MessageView {
  id: string;
  conversationId: string;
  userIdFrom: string;
  fullMessage: string;
  createdAt: string;
  seq: number;
  clientMessageId: string | null;
  /** Trích dẫn (lát M3): id tin gốc + khối tóm tắt server dựng theo quyền của người nhận. */
  replyToMessageId?: string | null;
  replyTo?: MessageQuoteView | null;
  /**
   * Dấu vết xoá mềm (Lớp B, issue #33): tin đã xoá chỉ còn xuất hiện
   * trong cửa sổ của người có thẩm quyền kiểm duyệt; phía học sinh
   * không bao giờ nhận được tin có hai trường này khác null.
   */
  deletedAt?: string | null;
  deletedBy?: string | null;
  /**
   * Dấu vết THU HỒI (vòng đời tin nhắn theo vai, issue #33): đường đọc
   * thường trả nội dung rỗng kèm hai trường này để hiện dòng "tin nhắn
   * đã được thu hồi"; chỉ đường truy vết có thẩm quyền mới thấy nội
   * dung gốc.
   */
  recalledAt?: string | null;
  recalledBy?: string | null;
  /** Trạng thái cục bộ của tin gửi lạc quan; tin từ server không có trường này. */
  localStatus?: 'sending' | 'failed';
}
/**
 * Một kết quả TÌM TIN trong conversation (lát M4, issue #237) — khớp
 * `messageSearchResultSchema` của contracts: excerpt quanh chỗ khớp
 * do server rút gọn, `seq` + `id` là neo nhảy tới đúng tin.
 */
export interface MessageSearchResultView {
  id: string;
  conversationId: string;
  userIdFrom: string;
  seq: number;
  excerpt: string;
  createdAt: string;
}
/** Ba cờ trạng thái cá nhân đặt được qua PATCH /conversations/:id/state (lát M5) — chỉ cờ có mặt mới đổi. */
export interface ConversationStatePatch {
  pinned?: boolean;
  archived?: boolean;
  muted?: boolean;
}

/** Kết quả PATCH state do API trả (lát M5): trạng thái đầy đủ sau khi đặt. */
export interface ConversationStateView {
  conversationId: string;
  pinned: boolean;
  pinnedAt: string | null;
  archived: boolean;
  archivedAt: string | null;
  muted: boolean;
}

/** Tóm tắt hiển thị của một user do API trả kèm (tên thật thay cho UUID thô). */
export interface PersonSummary {
  userId: string;
  displayName: string;
  username: string;
}
/** Trạng thái quan hệ của một người so với chính mình. */
export type ContactRelationship = 'contact' | 'pending_incoming' | 'pending_outgoing' | 'blocked' | 'none';
/** Một khoá tôi thuộc về — đầu vào của luồng tìm bạn theo khoá (GET /messages/courses). */
export interface MessagingCourse {
  courseId: string;
  fullName: string;
  shortName: string;
}
/** Một dòng roster thành viên khoá (GET /messages/courses/:id/members). */
export interface RosterMember extends PersonSummary {
  role: 'teacher' | 'student';
  relationship: ContactRelationship;
  /**
   * GV của khoá nhắn riêng trực tiếp được với thành viên này (đang
   * ghi danh) không cần kết bạn — ngoại lệ chốt 25/10/2026 trên
   * issue #33; API kèm cờ này thì hiện nút "Nhắn tin" tại dòng.
   */
  canDirectMessage?: boolean;
}
/** Một yêu cầu kết bạn trong hàng chờ: API đã kèm tên hiển thị của phía kia. */
export interface ContactRequestView {
  userId: string;
  createdAt: string;
  displayName?: string;
  username?: string;
}
export interface ConversationView {
  id: string;
  type: number;
  name: string | null;
  /**
   * Phân loại cấu trúc (lát MSG-T1, issue #33): `core_course`/`course`
   * = chat cấp khoá, `core_group`/`groups` = chat nhóm con,
   * `core_class`/`class` = chat cấp lớp (MSG-T2); null ở hội thoại
   * cá nhân và nhóm tự do. Phân loại CHỈ theo ba trường này, không
   * đoán theo tên.
   */
  component?: string | null;
  itemType?: string | null;
  itemId?: string | null;
  members: string[];
  /** Tên hiển thị của từng thành viên (API trả kèm) — client tra tên từ đây. */
  memberProfiles?: Record<string, PersonSummary>;
  unread?: number;
  lastReadSeq?: number;
  lastMessageSeq?: number;
  lastMessage?: MessageView | null;
  /** Chat đang bật hay không — giáo viên tắt được (Lớp B); vắng mặt coi như đang bật. */
  enabled?: boolean;
  /**
   * Trạng thái cá nhân của CHÍNH user trên conversation này (lát M5,
   * issue #240): `pinnedAt` khác null = đã ghim (danh sách xếp lên
   * đầu), `archivedAt` khác null = đã lưu trữ (chỉ hiện ở mục đã
   * lưu), `muted` = đã tắt tiếng (số chưa đọc hiện mờ, huy hiệu
   * điều hướng không tính).
   */
  pinnedAt?: string | null;
  archivedAt?: string | null;
  muted?: boolean;
  createdBy?: string | null;
  /** Thẩm quyền của CHÍNH user trên conversation (chỉ chi tiết conversation mới mang): kiểm duyệt / quản lý. */
  canModerate?: boolean;
  canManage?: boolean;
}
/** Chi tiết conversation theo API: conversation kèm một cửa sổ tin + mốc đã đọc của từng thành viên. */
export interface ConversationDetailView extends ConversationView {
  messages: MessageView[];
  hasMoreBefore?: boolean;
  memberReadMarkers?: { userId: string; lastReadSeq: number }[];
}

/**
 * CÂY NHÓM của chính tôi (lát MSG-T1, GET /messages/group-tree) —
 * khớp `conversationGroupTreeSchema` của contracts. Server dựng sẵn
 * cây Lớp → Khoá → Nhóm con theo VAI của người xem; `conversationId`
 * null = chat của nút chưa được ensure (bấm vào mới ensure ở MSG-T3),
 * `unread` của nút lớp là tổng chưa đọc của nút lớp + các nút con.
 * Mọi nút mang `pinnedAt`: mốc ghim CÁ NHÂN của người xem trên
 * conversation của nút, server dựng từ dòng thành viên của người
 * xem trên cả hai tập hội thoại chưa lưu trữ và đã lưu trữ (null =
 * chưa ghim / chưa có conversation / chưa là thành viên) — tab Nhóm
 * phân mục Ghim/Nhóm theo chính trường này, KHÔNG tra danh sách
 * hội thoại chưa lưu trữ (hội thoại vừa ghim vừa lưu trữ không
 * nằm trong danh sách đó).
 */
export type ConversationTreeRoleView = 'teaching' | 'learning' | 'staff';

export interface ConversationTreeGroupView {
  groupId: string;
  name: string;
  myRole: ConversationTreeRoleView;
  conversationId: string | null;
  unread: number;
  pinnedAt: string | null;
}

export interface ConversationTreeFreeGroupView {
  conversationId: string;
  name: string;
  myRole: ConversationTreeRoleView;
  unread: number;
  pinnedAt: string | null;
}

export interface ConversationTreeCourseView {
  courseId: string;
  name: string;
  myRole: ConversationTreeRoleView;
  conversationId: string | null;
  unread: number;
  pinnedAt: string | null;
  groups: ConversationTreeGroupView[];
}

export interface ConversationTreeClassView {
  classId: string;
  name: string;
  myRole: ConversationTreeRoleView;
  conversationId: string | null;
  unread: number;
  pinnedAt: string | null;
  courses: ConversationTreeCourseView[];
}

export interface ConversationGroupTreeView {
  classes: ConversationTreeClassView[];
  /** Khoá tôi thuộc về mà lớp chứa chúng tôi không có quan hệ trực tiếp. */
  coursesOutsideClasses: ConversationTreeCourseView[];
  freeGroups: ConversationTreeFreeGroupView[];
  /**
   * Server tính theo ĐÚNG cổng tạo nhóm tự do của API cho tenant hiện
   * hành (chỉ quản trị viên hệ thống hoặc chủ trung tâm mới true) —
   * nút tạo nhóm hiện theo cờ này, không tự suy từ vai trên cây.
   */
  canCreateFreeGroup: boolean;
}

/**
 * Ngữ cảnh ROSTER của PANEL THÀNH VIÊN (lát MSG-T4, issue #33):
 * panel của một hội thoại nhóm đọc thành viên từ đúng MỘT nguồn
 * theo loại hội thoại — roster LỚP (chat cấp lớp), roster KHOÁ (chat
 * cấp khoá và, qua lọc theo thành viên conversation, chat nhóm con),
 * hoặc danh sách thành viên của chính conversation (nhóm tự do —
 * loại này không có roster đứng sau). `parentName` là tên của thực
 * thể chứa (lớp chứa khoá, khoá chứa nhóm con) để panel ghi rõ
 * "thuộc về" — hội thoại đứng độc lập thì để trống.
 */
export type MemberPanelContext =
  | { kind: 'class'; id: string; name: string; parentName?: string }
  | { kind: 'course'; id: string; name: string; parentName?: string; subgroup?: boolean }
  | { kind: 'free'; name: string };

/**
 * Một dòng của PANEL THÀNH VIÊN (lát MSG-T4): hình dạng hợp nhất
 * của dòng roster lớp/khoá (server đã tính `relationship` +
 * `canDirectMessage`) và dòng thành viên nhóm tự do (trang suy quan
 * hệ từ danh bạ/hàng chờ/chặn của chính người xem vì nhóm tự do
 * không có roster). `role` phân nhóm trình bày: lớp/khoá dùng
 * teacher/student như roster; nhóm tự do dùng admin (người tạo
 * nhóm — thẩm quyền quản lý của nhóm tự do neo vào người tạo) /
 * member. Luật hiển thị hành động trong menu bám đúng các trường
 * này, client không tự suy luật quan hệ nào khác.
 */
export interface MemberPanelEntry extends PersonSummary {
  role: 'teacher' | 'student' | 'admin' | 'member';
  relationship: ContactRelationship;
  canDirectMessage: boolean;
  /** Người tạo nhóm tự do — panel đánh dấu và menu không cho gỡ. */
  isCreator?: boolean;
}

/**
 * Ngữ cảnh CHỌN NGƯỜI trong sheet "Tin nhắn mới" và sheet "Tạo nhóm"
 * (lát MSG-T3, issue #33): người chỉ được khám phá từ đúng ba nguồn
 * đã chốt — liên hệ đã kết bạn, roster của MỘT lớp của tôi, roster của
 * MỘT khoá của tôi. Không tồn tại ngữ cảnh "tìm người toàn hệ" (quyết
 * bỏ hẳn tìm người theo tên). Roster lớp và roster khoá dùng chung
 * một hình dạng dòng ({@link RosterMember}) nên một ngữ cảnh chỉ cần
 * mang loại + id + tên hiển thị của lớp/khoá.
 */
export type PeoplePickerContext =
  | { kind: 'contacts' }
  | { kind: 'class'; id: string; name: string }
  | { kind: 'course'; id: string; name: string };
