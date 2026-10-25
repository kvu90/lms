import i18n from '../i18n';

/**
 * Helper meta() theo route (F-08 của rà soát #133, việc #146): trước
 * đây không route nào xuất meta() và Layout gắn cứng một title LMS
 * cho mọi trang. Nay mỗi route module xuất meta() qua các helper này:
 * tiêu đề dạng "<Tên trang> · LMS", lấy từ ĐÚNG resources i18n hiện
 * hữu (locale cố định vi như toàn app — xem i18n.ts) để không có thêm
 * một nguồn chuỗi thứ hai. Trang chủ dùng meta riêng ở root ('LMS').
 */
export function titleMeta(title: string): { title: string }[] {
  return [{ title: `${title} · LMS` }];
}

/** Tiêu đề từ một khoá của namespace `app` (nav*, signIn…). */
export function appKeyMeta(key: string): { title: string }[] {
  return titleMeta(i18n.t(key, { ns: 'app' }));
}

/** Tiêu đề từ một khoá của namespace `platform` (library*, …Title). */
export function platformKeyMeta(key: string): { title: string }[] {
  return titleMeta(i18n.t(key, { ns: 'platform' }));
}
