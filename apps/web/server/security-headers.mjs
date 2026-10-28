/**
 * Header bảo mật cho tài liệu HTML do tiến trình SSR phục vụ — lớp
 * phòng thủ chiều sâu phía sau cổng làm sạch HTML của api.
 *
 * Bề mặt được bảo vệ: mọi tài liệu HTML của ứng dụng (bản prerender
 * tĩnh `/` + `/login` ở đường tĩnh và mọi tài liệu SSR động ở đường
 * React Router). Nội dung học liệu do người dùng soạn đã được api
 * làm sạch theo allowlist trước khi lưu/đọc; CSP ở đây không thay
 * thế lớp đó mà giới hạn thiệt hại nếu một sink render HTML khác
 * xuất hiện trong tương lai: mặc định chỉ tin chính origin của ứng
 * dụng, cấm nhúng trang vào frame ngoài, cấm object/base/form lạ.
 *
 * Các điểm nới đã cân nhắc theo nhu cầu thật của ứng dụng (nới thêm
 * là phải có bằng chứng tính năng cần):
 * - `script-src 'unsafe-inline'`: React Router chèn script nội
 *   tuyến chứa dữ kiện hydration vào mọi tài liệu; bản prerender
 *   tĩnh sinh lúc build không gắn được nonce theo từng request.
 *   Đây là điểm nới lớn nhất còn lại và là lý do CSP chỉ đóng vai
 *   phòng thủ chiều sâu, cổng chính vẫn là làm sạch phía server.
 * - `style-src 'unsafe-inline'`: giao diện dùng thuộc tính style
 *   nội tuyến phổ biến (component nền, biểu đồ) — chặn sẽ vỡ hiển
 *   thị diện rộng; style nội tuyến không thực thi mã trong trình
 *   duyệt hiện đại.
 * - `img-src`/`media-src` gồm `https:` và `blob:`: ảnh/video học
 *   liệu phát qua URL đã ký (có thể trỏ thẳng tới kho lưu trữ
 *   https ngoài origin) và qua blob URL khi xem trực tuyến trong
 *   trang học; `data:` chỉ cho ảnh (ảnh dán trong nội dung).
 * - `frame-src` gồm `blob:` (iframe xem PDF học liệu bằng blob
 *   URL), chính origin và đúng hai nguồn nhúng video mà api sinh
 *   (YouTube/Vimeo — xem `embedUrlFor` phía api).
 * - `connect-src` gồm `ws:`/`wss:`: kênh realtime Socket.IO nâng
 *   cấp kết nối ngay trên cùng origin qua mặt tiền của tiến trình
 *   này.
 */

/** Chính sách Content-Security-Policy áp cho mọi tài liệu HTML của ứng dụng. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self' blob: https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Gắn header CSP (và `X-Content-Type-Options: nosniff` đi kèm cho
 * tài liệu) lên một response tài liệu HTML sắp được gửi.
 *
 * @param {import('node:http').ServerResponse} res Response đang xử lý.
 */
export function applyDocumentSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
