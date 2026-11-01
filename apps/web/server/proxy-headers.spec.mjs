import { describe, expect, it } from 'vitest';
import { buildProxyHeaders } from './proxy-headers.mjs';

/**
 * Hồi quy header của đường proxy HTTP trong prod-server.mjs
 * (topology C, tiền điều kiện TĐ5 của issue #587).
 *
 * Bối cảnh production: tầng ứng dụng phân giải trung tâm theo nhãn
 * đầu tiên của header Host (issue #582) — tại địa chỉ của một trung
 * tâm ở kho riêng, handler đăng nhập Better Auth chỉ kiểm chứng
 * credential ở kho của trung tâm đó khi Host tới API còn nguyên là
 * tên miền của trung tâm. prod-server bản cũ ghi đè Host bằng
 * origin nội bộ của API (`api:3100`) nên API không bao giờ thấy
 * địa chỉ trung tâm: tài khoản chỉ sống ở kho riêng đăng nhập tại
 * chính địa chỉ của trung tâm bị từ chối, còn tài khoản của kho
 * chung lại đăng nhập thành công tại địa chỉ đó (kiểm chứng tại
 * thí điểm nhantin ngày 01/11/2026). Spec này ghim: header dựng
 * cho request phía API phải giữ nguyên Host gốc, đồng thời giữ
 * đúng hành vi nối chuỗi X-Forwarded-For và mặc định
 * X-Forwarded-Proto như trước.
 */
describe('buildProxyHeaders', () => {
  it('giữ nguyên Host của request gốc để địa chỉ trung tâm kho riêng tới được tầng phân giải của API', () => {
    const headers = buildProxyHeaders(
      { host: 'nhantin.fuckr.net', origin: 'https://nhantin.fuckr.net' },
      '203.0.113.7',
      'api:3100',
    );
    expect(headers.host).toBe('nhantin.fuckr.net');
  });

  it('không ghi đè Host bằng origin nội bộ của API kể cả khi request mang cổng công khai', () => {
    const headers = buildProxyHeaders({ host: 'trung-tam-a.example.com:8443' }, '203.0.113.7', 'api:3100');
    expect(headers.host).toBe('trung-tam-a.example.com:8443');
    expect(headers.host).not.toBe('api:3100');
  });

  it('dùng origin nội bộ làm Host dự phòng khi request gốc không mang Host', () => {
    const headers = buildProxyHeaders({}, '203.0.113.7', 'api:3100');
    expect(headers.host).toBe('api:3100');
  });

  it('nối IP của chặng proxy này vào cuối chuỗi X-Forwarded-For đã có', () => {
    const headers = buildProxyHeaders(
      { host: 'dev.fuckr.net', 'x-forwarded-for': '198.51.100.1, 198.51.100.2' },
      '203.0.113.7',
      'api:3100',
    );
    expect(headers['x-forwarded-for']).toBe('198.51.100.1, 198.51.100.2, 203.0.113.7');
  });

  it('tạo X-Forwarded-For từ IP của chặng này khi request chưa có chuỗi', () => {
    const headers = buildProxyHeaders({ host: 'dev.fuckr.net' }, '203.0.113.7', 'api:3100');
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
  });

  it('đặt X-Forwarded-Proto mặc định là http khi request chưa mang header này', () => {
    const headers = buildProxyHeaders({ host: 'dev.fuckr.net' }, '203.0.113.7', 'api:3100');
    expect(headers['x-forwarded-proto']).toBe('http');
  });

  it('giữ nguyên X-Forwarded-Proto mà chặng trước đã đặt', () => {
    const headers = buildProxyHeaders(
      { host: 'nhantin.fuckr.net', 'x-forwarded-proto': 'https' },
      '203.0.113.7',
      'api:3100',
    );
    expect(headers['x-forwarded-proto']).toBe('https');
  });

  it('chuyển nguyên các header còn lại của request gốc (cookie, origin, content-type)', () => {
    const headers = buildProxyHeaders(
      {
        host: 'nhantin.fuckr.net',
        cookie: 'better-auth.session_token=abc',
        origin: 'https://nhantin.fuckr.net',
        'content-type': 'application/json',
      },
      '203.0.113.7',
      'api:3100',
    );
    expect(headers.cookie).toBe('better-auth.session_token=abc');
    expect(headers.origin).toBe('https://nhantin.fuckr.net');
    expect(headers['content-type']).toBe('application/json');
  });
});
