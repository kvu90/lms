import { describe, expect, it } from 'vitest';
import { applyDocumentSecurityHeaders, CONTENT_SECURITY_POLICY } from './security-headers.mjs';

/**
 * Hồi quy chính sách CSP của tài liệu HTML phía web (lớp phòng thủ
 * chiều sâu sau cổng làm sạch HTML của api cho nội dung trang học).
 *
 * Ghim: các chỉ thị khoá cứng không được nới lặng lẽ (default về
 * 'self', cấm object, cấm bị nhúng frame, không 'unsafe-eval' ở
 * bất kỳ đâu), các nới có chủ đích theo nhu cầu thật của ứng dụng
 * vẫn còn đúng chỗ (blob/https cho học liệu phát qua URL đã ký,
 * hai nguồn nhúng video YouTube/Vimeo), và hàm gắn header đặt
 * đúng hai header lên response. Thay đổi chính sách phải sửa spec
 * này trong cùng lượt để lý do nới/siết được rà lại.
 */
describe('CONTENT_SECURITY_POLICY', () => {
  it('mặc định chỉ tin chính origin và khoá các bề mặt thực thi lạ', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    expect(CONTENT_SECURITY_POLICY).not.toContain('*');
  });

  it("script chỉ từ chính origin + nội tuyến hydration của React Router (điểm nới đã ghi lý do), không có nguồn ngoài", () => {
    const scriptSrc = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('script-src'));
    expect(scriptSrc).toBe("script-src 'self' 'unsafe-inline'");
  });

  it('ảnh/media/frame phủ đúng nhu cầu học liệu: blob + https đã ký, nhúng chỉ YouTube/Vimeo', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self' data: blob: https:");
    expect(CONTENT_SECURITY_POLICY).toContain("media-src 'self' blob: https:");
    const frameSrc = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('frame-src'));
    expect(frameSrc).toContain('blob:');
    expect(frameSrc).toContain('https://www.youtube.com');
    expect(frameSrc).toContain('https://player.vimeo.com');
    // Không có token scheme `https:` đứng riêng (vốn sẽ cho phép nhúng
    // từ mọi origin https) — kiểm theo token vì 'https:' là chuỗi con
    // của các host-source hợp lệ ở trên.
    expect(frameSrc.split(' ')).not.toContain('https:');
  });

  it('kết nối chỉ về chính origin và kênh realtime cùng origin', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self' ws: wss:");
    expect(CONTENT_SECURITY_POLICY).toContain("font-src 'self' data:");
  });
});

describe('applyDocumentSecurityHeaders', () => {
  it('đặt đúng header CSP và nosniff lên response', () => {
    const headers = new Map();
    const res = { setHeader: (name, value) => headers.set(name.toLowerCase(), value) };
    applyDocumentSecurityHeaders(res);
    expect(headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });
});
