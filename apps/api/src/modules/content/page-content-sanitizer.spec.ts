import { describe, expect, it } from 'vitest';
import { isSafeExternalResourceUrl, sanitizePageContent } from './page-content-sanitizer';

/**
 * Gác XSS lưu trữ của nội dung trang đọc (mod_page) và URL tài nguyên
 * ngoài ở mức đơn vị: hàm làm sạch phải loại mọi cấu trúc thực thi
 * (thẻ script, thuộc tính sự kiện, URL nguy hiểm) trong khi giữ
 * nguyên định dạng học liệu hợp lệ — đổi allowlist theo hướng nới
 * (cho lại thẻ/thuộc tính thực thi) hoặc hướng siết quá tay (làm mất
 * định dạng hợp lệ) đều phải làm spec này đỏ. Luồng nghiệp vụ đầy đủ
 * (ghi qua API → học viên đọc/player) nằm ở
 * `test/content-page-xss.e2e-spec.ts`.
 */
describe('sanitizePageContent', () => {
  it('loại thẻ script cùng toàn bộ nội dung của nó', () => {
    const out = sanitizePageContent('<p>Bài đọc</p><script>alert(1)</script>');
    expect(out).toBe('<p>Bài đọc</p>');
    expect(out).not.toContain('alert');
  });

  it('loại thuộc tính sự kiện onerror/onclick nhưng giữ thẻ và thuộc tính an toàn', () => {
    const out = sanitizePageContent('<img src="https://example.com/a.png" alt="Ảnh" onerror="alert(document.domain)">');
    expect(out).not.toContain('onerror');
    expect(out).toContain('<img src="https://example.com/a.png" alt="Ảnh" />');
    const clicked = sanitizePageContent('<p onclick="alert(1)">Đoạn văn</p>');
    expect(clicked).toBe('<p>Đoạn văn</p>');
  });

  it('loại href mang scheme javascript:/data: nhưng giữ nguyên thẻ liên kết và chữ', () => {
    expect(sanitizePageContent('<a href="javascript:alert(1)">Bấm</a>')).toBe('<a>Bấm</a>');
    expect(sanitizePageContent('<a href="data:text/html;base64,PHNjcmlwdD4=">Bấm</a>')).toBe('<a>Bấm</a>');
  });

  it('loại thẻ nhúng và biểu mẫu (iframe/object/form) cùng thuộc tính thực thi', () => {
    const out = sanitizePageContent('<iframe src="https://evil.example/x"></iframe><form action="https://evil.example"><input type="text"></form><p>Giữ</p>');
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('form');
    expect(out).not.toContain('input');
    expect(out).toContain('<p>Giữ</p>');
  });

  it('giữ nguyên định dạng học liệu hợp lệ: đoạn văn, đậm/nghiêng, danh sách, bảng, liên kết https, ảnh', () => {
    const valid = '<h2>Bài 1</h2><p>Nội dung <strong>quan trọng</strong> và <em>nghiêng</em>.</p>'
      + '<ul><li>Mục một</li><li>Mục hai</li></ul>'
      + '<table><thead><tr><th>Cột</th></tr></thead><tbody><tr><td>Ô</td></tr></tbody></table>'
      + '<p><a href="https://example.com/tai-lieu" title="Tài liệu">Tài liệu tham khảo</a></p>'
      + '<img src="https://example.com/hinh.png" alt="Hình minh hoạ" />';
    expect(sanitizePageContent(valid)).toBe(valid);
  });

  it('giữ liên kết mailto/tel và ảnh data: dán trực tiếp; loại src ảnh mang scheme lạ', () => {
    expect(sanitizePageContent('<a href="mailto:gv@example.com">Gửi thư</a>')).toContain('href="mailto:gv@example.com"');
    const dataImg = sanitizePageContent('<img src="data:image/png;base64,iVBORw0KGgo=" alt="Ảnh dán" />');
    expect(dataImg).toContain('data:image/png;base64');
    expect(sanitizePageContent('<img src="javascript:alert(1)" />')).not.toContain('javascript:');
  });

  it('style trình bày vô hại được giữ, biểu thức CSS nguy hiểm bị loại', () => {
    const out = sanitizePageContent('<p style="text-align: center; color: #ff0000; width: expression(alert(1))">Giữa</p>');
    // Thư viện chuẩn hoá style thành dạng không khoảng trắng sau dấu hai chấm.
    expect(out).toContain('text-align:center');
    expect(out).toContain('color:#ff0000');
    expect(out).not.toContain('expression');
    expect(out).not.toContain('width');
  });

  it('idempotent: làm sạch nội dung đã sạch cho kết quả không đổi', () => {
    const dirty = '<p onclick="x()">A</p><script>alert(1)</script><a href="javascript:x()">B</a>';
    const once = sanitizePageContent(dirty);
    expect(sanitizePageContent(once)).toBe(once);
  });

  it('chuỗi rỗng và văn bản thuần đi qua không đổi', () => {
    expect(sanitizePageContent('')).toBe('');
    expect(sanitizePageContent('Chỉ là chữ thường')).toBe('Chỉ là chữ thường');
  });
});

/**
 * Scheme của URL tài nguyên ngoài: chỉ http/https là đích an toàn để
 * phát vào href của trang học; parser URL của nền tảng phải bắt được
 * cả biến thể lách bằng ký tự điều khiển.
 */
describe('isSafeExternalResourceUrl', () => {
  it('chấp nhận URL http/https tuyệt đối, gồm đường nhúng YouTube/Vimeo', () => {
    expect(isSafeExternalResourceUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isSafeExternalResourceUrl('https://player.vimeo.com/video/12345')).toBe(true);
    expect(isSafeExternalResourceUrl('http://example.com/tai-lieu.pdf')).toBe(true);
  });

  it('từ chối scheme thực thi và scheme ngoài web', () => {
    expect(isSafeExternalResourceUrl('javascript:alert(document.domain)')).toBe(false);
    expect(isSafeExternalResourceUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isSafeExternalResourceUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeExternalResourceUrl('file:///etc/passwd')).toBe(false);
  });

  it('từ chối biến thể lách bằng ký tự điều khiển và URL tương đối/rỗng', () => {
    expect(isSafeExternalResourceUrl('java\tscript:alert(1)')).toBe(false);
    expect(isSafeExternalResourceUrl('  javascript:alert(1)')).toBe(false);
    expect(isSafeExternalResourceUrl('/duong-dan-tuong-doi')).toBe(false);
    expect(isSafeExternalResourceUrl('')).toBe(false);
    expect(isSafeExternalResourceUrl('khong phai url')).toBe(false);
  });
});
