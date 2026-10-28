import sanitizeHtml from 'sanitize-html';

/**
 * Làm sạch nội dung HTML của trang đọc (mod_page) và kiểm scheme của
 * URL tài nguyên ngoài (mod_resource) — lớp gác XSS lưu trữ của module
 * content.
 *
 * Ngữ cảnh nghiệp vụ: nội dung trang đọc là HTML do giáo viên soạn
 * (người có `course:manageactivities` tại khoá) và được trang học phía
 * web render bằng `dangerouslySetInnerHTML` — điểm render HTML trực
 * tiếp duy nhất của toàn hệ thống. Trước khi có module này, HTML đi
 * trọn chuỗi hợp đồng → lưu DB → đọc → render mà không qua bất kỳ lớp
 * lọc nào, nên thẻ `<script>`/thuộc tính sự kiện (`onerror`…) trong
 * nội dung một khoá thực thi trong phiên của mọi người mở trang học
 * (học viên, giáo viên khác, quản trị viên). HTML là định dạng có chủ
 * đích của trang đọc nên hướng gác là LÀM SẠCH THEO ALLOWLIST chứ
 * không bỏ HTML: chỉ giữ thẻ/thuộc tính phục vụ định dạng học liệu,
 * loại mọi cấu trúc thực thi.
 *
 * Flow sử dụng:
 * - `ContentService.createPage`/`updatePage` làm sạch trước khi ghi
 *   DB — dữ kiện mới lưu vào đã sạch ngay từ nguồn.
 * - `ContentService.getPage` làm sạch lại ở đường đọc — dữ kiện đã
 *   lưu từ trước khi có cổng ghi (hoặc ghi qua đường vòng như import
 *   backup) vẫn an toàn khi tới tay người xem; hai hàm đọc phục vụ
 *   trang học (`getPageForUser`, `getPlayer`) đều đi qua `getPage`.
 * - {@link isSafeExternalResourceUrl} gác URL tài nguyên ngoài ở cả
 *   tầng hợp đồng (refine trong `packages/contracts`) và tầng nghiệp
 *   vụ (service ném `content.url_scheme_not_allowed`), vì URL đó được
 *   phía web đưa thẳng vào `href` của trang học: scheme `javascript:`
 *   sẽ thực thi khi người xem bấm liên kết.
 *
 * Thư viện: `sanitize-html` — bộ làm sạch allowlist thuần JavaScript
 * (parser `htmlparser2`, không cần DOM/jsdom) chạy trực tiếp trong
 * tiến trình Node của api, đang được bảo trì tích cực và là lựa chọn
 * chuẩn cho phía server; tại thời điểm thêm vào, repo chưa có bất kỳ
 * thư viện làm sạch HTML nào ở bất kỳ tầng nào.
 */

/**
 * Các thẻ được giữ trong nội dung trang đọc: đủ cho định dạng học
 * liệu thực tế (đoạn văn, tiêu đề, danh sách, bảng, trích dẫn, code,
 * ảnh, liên kết) — KHÔNG gồm thẻ nhúng/kịch bản/biểu mẫu
 * (`script`, `iframe`, `form`, `video`…): video/liên kết nhúng có
 * kênh riêng là mod_resource, không đi qua nội dung trang.
 */
const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol',
  'p', 'pre', 'q', 's', 'section', 'small', 'span', 'strong', 'sub',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
];

/** Mẫu giá trị màu CSS an toàn cho phép trong thuộc tính `style` (màu hex, rgb/rgba, tên màu). */
const CSS_COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)|[a-z]{3,30})$/i;

/**
 * Làm sạch một chuỗi HTML của trang đọc theo allowlist của module.
 *
 * Hành vi cụ thể:
 * - Thẻ ngoài allowlist bị gỡ (nội dung chữ của thẻ thường vẫn giữ;
 *   riêng nội dung của `script`/`style`/`textarea`/`noscript` bị loại
 *   hẳn theo mặc định của sanitize-html — mã nguồn không được phép rò
 *   ra thành văn bản hiển thị).
 * - Mọi thuộc tính sự kiện (`on*`) và thuộc tính không khai báo đều
 *   bị loại; `href`/`src` chỉ giữ khi scheme nằm trong allowlist
 *   tương ứng (`a`: http/https/mailto/tel; `img`: http/https + ảnh
 *   `data:` cho ảnh dán trực tiếp vào bài).
 * - Thuộc tính `style` chỉ giữ các thuộc tính CSS trình bày vô hại
 *   trong danh sách `allowedStyles` (căn lề, màu chữ/nền, đậm/nghiêng,
 *   gạch chân/gạch ngang) — đủ cho nội dung dán từ trình soạn thảo
 *   bên ngoài mà không mở đường biểu thức CSS thực thi.
 * - Hàm thuần, không side-effect, idempotent: làm sạch một nội dung
 *   đã sạch cho ra đúng nội dung đó — đây là bất biến để tầng đọc có
 *   thể làm sạch lại dữ kiện đã qua tầng ghi mà không làm biến dạng
 *   nội dung hợp lệ.
 *
 * @param html HTML thô từ người soạn hoặc từ DB.
 * @returns HTML đã làm sạch, an toàn để render qua `dangerouslySetInnerHTML`.
 */
export function sanitizePageContent(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': ['class', 'style'],
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      ol: ['start', 'type'],
      li: ['value'],
    },
    allowedStyles: {
      '*': {
        'text-align': [/^(left|right|center|justify)$/],
        color: [CSS_COLOR_PATTERN],
        'background-color': [CSS_COLOR_PATTERN],
        'font-weight': [/^(bold|normal|bolder|lighter|[1-9]00)$/],
        'font-style': [/^(italic|normal|oblique)$/],
        'text-decoration': [/^(underline|line-through|overline|none)( (underline|line-through|overline))*$/],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data'],
    },
  });
}

/**
 * Kiểm scheme của URL tài nguyên ngoài (mod_resource `kind: 'url'`).
 *
 * Chỉ `http:`/`https:` được phép: mọi scheme khác (`javascript:`,
 * `data:`, `vbscript:`, `file:`…) hoặc chuỗi không phân tích được
 * thành URL tuyệt đối đều bị coi là không an toàn. URL tương đối bị
 * từ chối vì tài nguyên ngoài theo định nghĩa phải là đích tuyệt đối
 * (đường nhúng YouTube/Vimeo cũng chỉ khớp URL tuyệt đối). Kiểm bằng
 * `URL` parser của nền tảng — parser tự loại tab/xuống dòng trong
 * chuỗi nên các biến thể lách kiểu `java\tscript:` vẫn bị bắt.
 *
 * @param url URL thô do người dùng nhập hoặc đã lưu trong DB.
 * @returns `true` khi URL dùng scheme http/https.
 */
export function isSafeExternalResourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
