import { formatDateTime, formatWithOptions } from '#utils/date-format';

import type { MessageQuoteView, MessageView, PresenceStatus } from '../types/types';

/** Rút gọn excerpt ở client cho bản lạc quan — CÙNG luật với server (120 ký tự theo code point, thêm … khi cắt). */
export function quoteExcerptOfText(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= 120) return text;
  return `${chars.slice(0, 120).join('')}…`;
}

/**
 * Dựng khối trích dẫn LẠC QUAN từ chính tin gốc đang hiển thị khi
 * người dùng bấm Trả lời: nội dung lấy từ bản đang thấy (tin đã thu
 * hồi thì nội dung vốn đã rỗng ở đường đọc thường → unavailable).
 * Server dựng lại bản chính thức khi gửi — bản này chỉ để khung hiện
 * ngay, không chờ mạng.
 */
export function localQuoteOf(m: MessageView): MessageQuoteView {
  return {
    id: m.id,
    seq: m.seq,
    userIdFrom: m.userIdFrom,
    excerpt: m.recalledAt ? '' : quoteExcerptOfText(m.fullMessage),
    unavailable: Boolean(m.recalledAt),
  };
}

/**
 * Mốc thời gian tương đối của tin cuối trong danh sách conversation
 * (lát M1, issue #204 — cùng khuôn và cùng khoá i18n với trang thông
 * báo): "vừa xong", "{{count}} phút/giờ/ngày trước"; quá một tuần thì
 * in ngày giờ cụ thể.
 */
export function relativeTime(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return t('justNow');
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return t('minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('daysAgo', { count: days });
  return formatDateTime(iso);
}

/**
 * Mốc thời gian trên HÀNG hội thoại (issue #608 — căn theo đúng
 * hàm định dạng phía bản demo, trích từ chunk JS của demo): dưới
 * một phút là "vừa xong"; dưới 60 phút là dạng rút gọn "{{số}}m";
 * trong ngày là khuôn 12 giờ (`h:mm a` bản địa hoá theo ngôn ngữ
 * hiển thị); hôm qua là nhãn "Hôm qua"; cũ hơn là ngày lịch dạng
 * tháng viết tắt + ngày (ví dụ "Jun 5" / "5 thg 6"), không kèm
 * năm. Khác `relativeTime` ở trên (khuôn tương đối đầy đủ của
 * các bề mặt cũ): hàng hội thoại của demo không dùng khuôn giờ/
 * ngày tương đối.
 */
export function conversationTime(
  iso: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  lang: string | undefined,
): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return t('justNow');
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return t('minutesShort', { count: minutes });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (diffDays <= 0) {
    return formatWithOptions(date, lang, { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (diffDays === 1) return t('messagesYesterday');
  return formatWithOptions(date, lang, { month: 'short', day: 'numeric' });
}

/**
 * Bản đồ màu chấm hiện diện theo trạng thái (issue #608 — đúng
 * bản đồ phía bản demo): trực tuyến xanh lá, vắng mặt vàng, đang
 * bận đỏ, ngoại tuyến xám muted. Các màu đi qua token màu của hệ
 * (green/yellow/red-500 đã căn về giá trị demo ở `globals.css`).
 */
export const PRESENCE_DOT_CLASS: Record<PresenceStatus, string> = {
  online: 'bg-green-500',
  away: 'bg-yellow-500',
  busy: 'bg-red-500',
  offline: 'bg-muted-foreground',
};

/**
 * Ánh xạ dữ kiện hiện diện hiện hành (ba trạng thái theo sự kiện:
 * `true` đã xác nhận trực tuyến, `false` đã xác nhận ngoại
 * tuyến, `undefined` chưa biết) sang trạng thái hiển thị. Dữ
 * kiện hiện hành không mang vắng mặt/bận nên hai trạng thái đó
 * chưa bao giờ được hàm này trả ra — chúng chỉ có mặt ở bản đồ
 * hiển thị, chờ dữ kiện (xem {@link PresenceStatus}).
 */
export function presenceStatusOf(isOnline: boolean | undefined): PresenceStatus | undefined {
  if (isOnline === undefined) return undefined;
  return isOnline ? 'online' : 'offline';
}

/** Khoá i18n của nhãn một trạng thái hiện diện (dòng trạng thái ở đầu khung và panel). */
export function presenceLabelKey(status: PresenceStatus): string {
  switch (status) {
    case 'online': return 'onlineNow';
    case 'away': return 'presenceAway';
    case 'busy': return 'presenceBusy';
    default: return 'messagesOfflineNow';
  }
}

/**
 * Bề rộng tử tế cho các menu nổi ở bề mặt chat (menu ⋯ trên tin ở
 * khung chat và menu quan hệ trên avatar/tên thành viên — lát dọn
 * gọn UI nhắn tin, nối tiếp issue #33).
 *
 * @remarks
 * `DropdownMenuContent` mặc định của \@lms/ui ghim bề rộng theo bề
 * rộng của phần tử gọt (`w-(--anchor-width)`) — nút ⋯ và avatar đều
 * rất hẹp nên các nhãn dài bị bẻ xuống nhiều dòng, menu trông nát.
 * Hằng này sửa TẠI ĐIỂM DÙNG (cố ý không đổi class mặc định toàn cục
 * của \@lms/ui để không đổi hành vi mọi menu khác trong hệ): menu
 * lấy bề rộng theo mục dài nhất (`w-max`), không hẹp hơn `min-w-52`,
 * và bị chặn ở `max-w-[calc(100vw-2rem)]` để positioner của Base UI
 * vẫn giữ trọn menu trong viewport (cùng khuôn chặn của menu chuông
 * thông báo). Không dùng bề rộng cố định `w-56` như menu của bảng dữ
 * liệu vì mục dài nhất — checkbox "Chọn tin để gỡ hàng loạt" /
 * "Select message for bulk removal" kèm khoảng đệm cho dấu tick —
 * vượt 224px: cố định 224px sẽ cắt chữ khi mục đã cấm xuống dòng.
 */
export const CHAT_MENU_CONTENT_CLASS = 'w-max min-w-52 max-w-[calc(100vw-2rem)]';

/**
 * Mục của menu chat luôn nằm trên MỘT dòng (đi cùng
 * {@link CHAT_MENU_CONTENT_CLASS}): icon và nhãn thẳng hàng, không
 * bẻ chữ xuống dòng như trước lát dọn gọn.
 */
export const CHAT_MENU_ITEM_CLASS = 'whitespace-nowrap';

/**
 * Chữ viết tắt của tên hiển thị — nội dung AvatarFallback.
 *
 * Luật (issue #591): chỉ lấy KÝ TỰ CHỮ — ký tự đặc biệt ở đầu
 * tên (ví dụ tên nhóm bắt đầu bằng dấu ngoặc như "[KT] Nhóm…")
 * bị bỏ qua, không lọt vào chữ viết tắt như trước. Cách lấy giữ
 * cùng khuôn với tên người: tách tên thành các TỪ CHỮ (mỗi từ chỉ
 * giữ các ký tự chữ Unicode của nó, từ không còn ký tự chữ nào
 * thì bỏ hẳn); từ hai từ chữ trở lên thì lấy chữ đầu của từ đầu
 * + chữ đầu của từ cuối; đúng một từ chữ thì lấy hai chữ đầu của
 * từ đó; không có ký tự chữ nào thì rơi về '?'.
 */
export function initialsOf(name: string): string {
  const letterWords = name
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word).filter((ch) => /\p{L}/u.test(ch)).join(''))
    .filter(Boolean);
  if (letterWords.length === 0) return '?';
  if (letterWords.length === 1) return Array.from(letterWords[0]!).slice(0, 2).join('').toUpperCase();
  const first = Array.from(letterWords[0]!)[0]!;
  const last = Array.from(letterWords[letterWords.length - 1]!)[0]!;
  return (first + last).toUpperCase();
}

/** Gộp tin vào danh sách hiện có: chống trùng theo id và clientMessageId, sắp theo seq (tin lạc quan chưa có seq thật nằm cuối). */
export function mergeMessages(existing: MessageView[], incoming: MessageView[]): MessageView[] {
  const byId = new Map<string, MessageView>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) {
    // Tin lạc quan của chính lần gửi này đã được server xác nhận: bỏ
    // bản tạm, dùng bản thật (khớp theo clientMessageId).
    if (m.clientMessageId) {
      for (const [id, local] of byId) {
        if (local.localStatus && local.clientMessageId === m.clientMessageId) byId.delete(id);
      }
    }
    byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => (a.seq || Number.MAX_SAFE_INTEGER) - (b.seq || Number.MAX_SAFE_INTEGER));
}

/**
 * Đếm ký tự người dùng thấy (grapheme) của nháp — CÙNG cách đếm với
 * trần phía server (lát M2, issue #212) để bộ đếm ở composer không
 * lệch với cổng 400 `messaging.message_too_long`: emoji ghép và chữ
 * kèm dấu tổ hợp tính là một ký tự, không đếm đơn vị UTF-16.
 */
export function countMessageCharacters(text: string): number {
  const SegmenterCtor = (Intl as unknown as {
    Segmenter?: new (locales?: string, options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<unknown>;
    };
  }).Segmenter;
  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor(undefined, { granularity: 'grapheme' });
    let count = 0;
    for (const _segment of segmenter.segment(text)) count += 1;
    return count;
  }
  return [...text].length;
}
