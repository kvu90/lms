import type { MessageView } from './types';

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
  return new Date(iso).toLocaleString();
}

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
