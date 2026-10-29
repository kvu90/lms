import type { LmsMessage } from '@lms/contracts';
import type { message, messageConversations } from '@lms/db';

/** Một dòng tin nhắn (bảng `message` của `@lms/db`). */
export type MessageRow = typeof message.$inferSelect;
/** Một dòng conversation (bảng `message_conversations` của `@lms/db`). */
export type ConversationRow = typeof messageConversations.$inferSelect;

/**
 * Vô hiệu hoá NỘI DUNG của một tin đã thu hồi cho các đường đọc/phân
 * phối thường (vòng đời tin nhắn theo vai): giữ nguyên mọi trường
 * định danh và dấu vết (id, seq, recalledAt, recalledBy...) để phía
 * nhận hiện dòng "tin nhắn đã được thu hồi", chỉ làm rỗng hai trường
 * nội dung. Đường truy vết có thẩm quyền KHÔNG đi qua hàm này. Đặt ở
 * package dùng chung để repository phía API, tầng realtime phía API
 * và consumer phân phối phía worker dùng chung một luật.
 */
export function blankRecalledContent(row: MessageRow): MessageRow {
  if (!row.recalledAt) return row;
  return { ...row, fullMessage: '', smallMessage: '' };
}

/**
 * Khối tóm tắt TRÍCH DẪN của một tin gốc (lát M3, issue #229) — hình
 * dạng khớp `messageQuoteSchema` của @lms/contracts (khai báo cục bộ
 * ở đây để tầng dữ liệu không phụ thuộc contracts; tương thích cấu
 * trúc khi gán vào wire ở tầng realtime/service).
 */
export interface MessageQuoteView {
  id: string;
  seq: number;
  userIdFrom: string;
  excerpt: string;
  unavailable: boolean;
}

/** Một dòng tin kèm khối trích dẫn đã dựng sẵn cho người nhận (`replyTo = null` khi không trích dẫn). */
export type MessageWithQuoteRow = MessageRow & { replyTo: MessageQuoteView | null };

/** Trần độ dài của excerpt trích dẫn: đủ nhận ra tin gốc, không biến khối trích dẫn thành bản sao của tin. */
export const QUOTE_EXCERPT_MAX_CHARS = 120;

/**
 * Rút gọn nội dung làm excerpt trích dẫn: cắt theo CODE POINT (không
 * cắt giữa cặp surrogate của emoji) và thêm dấu … khi bị cắt.
 */
export function quoteExcerptOf(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= QUOTE_EXCERPT_MAX_CHARS) return text;
  return `${chars.slice(0, QUOTE_EXCERPT_MAX_CHARS).join('')}…`;
}

/**
 * Dựng khối trích dẫn của một tin gốc cho một người nhận.
 *
 * Luật lộ nội dung (cùng họ với blankRecalledContent): người xem
 * THƯỜNG không bao giờ nhận nội dung của tin gốc đã xoá mềm/đã thu
 * hồi, cũng không nhận nội dung của tin chính họ đã xoá-phía-mình —
 * cả ba trường hợp đều thành `unavailable = true` + excerpt rỗng để
 * client hiện "tin gốc đã bị xoá". Người có thẩm quyền kiểm duyệt
 * (privileged — cửa sổ truy vết) thấy excerpt thật, vì họ vốn đọc
 * được chính tin gốc ở đường truy vết.
 */
export function messageQuoteOf(original: MessageRow, opts: { privileged: boolean; deletedForViewer?: boolean }): MessageQuoteView {
  const unavailable = !opts.privileged
    && (original.deletedAt !== null || original.recalledAt !== null || opts.deletedForViewer === true);
  return {
    id: original.id,
    seq: original.seq,
    userIdFrom: original.userIdFrom,
    excerpt: unavailable ? '' : quoteExcerptOf(original.fullMessage),
    unavailable,
  };
}

/**
 * Dạng wire của một tin nhắn (khớp `messageSchema` của contracts; createdAt là chuỗi ISO).
 * Khối trích dẫn (lát M3) do tầng gọi dựng sẵn qua `attachQuotes` của
 * bề mặt đọc rồi truyền vào — hàm này thuần ánh xạ, không tự tra DB.
 */
export function toWireMessage(row: MessageRow, quote: MessageQuoteView | null = null): LmsMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    userIdFrom: row.userIdFrom,
    subject: row.subject,
    fullMessage: row.fullMessage,
    createdAt: row.createdAt.toISOString(),
    seq: row.seq,
    clientMessageId: row.clientMessageId,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    deletedBy: row.deletedBy,
    recalledAt: row.recalledAt ? row.recalledAt.toISOString() : null,
    recalledBy: row.recalledBy,
    replyToMessageId: row.replyToMessageId,
    replyTo: quote,
  };
}
