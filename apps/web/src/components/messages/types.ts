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
  members: string[];
  /** Tên hiển thị của từng thành viên (API trả kèm) — client tra tên từ đây. */
  memberProfiles?: Record<string, PersonSummary>;
  unread?: number;
  lastReadSeq?: number;
  lastMessageSeq?: number;
  lastMessage?: MessageView | null;
  /** Chat đang bật hay không — giáo viên tắt được (Lớp B); vắng mặt coi như đang bật. */
  enabled?: boolean;
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
