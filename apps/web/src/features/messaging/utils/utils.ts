import { formatDateTime } from '#utils/date-format';

import type { MessageQuoteView, MessageView } from '../types/types';

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

/** Hai chữ cái đầu của tên hiển thị — nội dung AvatarFallback. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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
