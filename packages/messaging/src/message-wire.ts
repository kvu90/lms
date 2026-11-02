import type { LmsMessage } from '@lms/contracts';
import type {
  ConversationRow,
  MessageQuoteView,
  MessageRow,
  MessageWithQuoteRow,
} from '@lms/db/repositories/messaging';

/**
 * Hình dạng dòng của tầng dữ liệu messaging được khai một nguồn duy
 * nhất tại `@lms/db/repositories/messaging` (nơi repository Kysely
 * sống) và re-export tại đây cho mọi phía tiêu thụ hiện hữu của
 * package — chỉ là import type-only, không tạo phụ thuộc runtime
 * ngược về `@lms/db` (issue #658: gỡ vòng phụ thuộc hai package).
 */
export type { ConversationRow, MessageQuoteView, MessageRow, MessageWithQuoteRow };

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

/** Trần độ dài của excerpt kết quả tìm tin (lát M4): cùng trần với excerpt trích dẫn. */
export const SEARCH_EXCERPT_MAX_CHARS = QUOTE_EXCERPT_MAX_CHARS;

/**
 * Rút gọn nội dung quanh CHỖ KHỚP cho một kết quả tìm tin (lát M4,
 * issue #237): cửa sổ tối đa {@link SEARCH_EXCERPT_MAX_CHARS} ký tự
 * (theo code point) đặt chỗ khớp gần giữa, thêm … ở phía bị cắt.
 * Khớp theo chuỗi con không phân biệt hoa thường — cùng ngữ nghĩa
 * với truy vấn ILIKE ở repository. Không tìm thấy chỗ khớp (không
 * xảy ra với hàng lấy từ truy vấn khớp) thì lùi về rút gọn từ đầu
 * như excerpt trích dẫn.
 *
 * Hàm này trước đây sống trong file repository phía API; nó là
 * logic hình dạng wire thuần chuỗi (cùng họ với {@link quoteExcerptOf})
 * nên chuyển về đây khi repository dời sang `@lms/db` — `@lms/db`
 * giữ thuần truy cập dữ liệu (issue #658).
 */
export function searchExcerptOf(text: string, query: string): string {
  const chars = Array.from(text);
  if (chars.length <= SEARCH_EXCERPT_MAX_CHARS) return text;
  const at = text.toLocaleLowerCase('vi').indexOf(query.toLocaleLowerCase('vi'));
  if (at < 0) return quoteExcerptOf(text);
  const matchStart = Array.from(text.slice(0, at)).length;
  const matchLength = Array.from(query).length;
  const before = Math.max(0, Math.floor((SEARCH_EXCERPT_MAX_CHARS - matchLength) / 2));
  const start = Math.max(0, matchStart - before);
  const end = Math.min(chars.length, start + SEARCH_EXCERPT_MAX_CHARS);
  const slice = chars.slice(start, end).join('');
  return `${start > 0 ? '…' : ''}${slice}${end < chars.length ? '…' : ''}`;
}
