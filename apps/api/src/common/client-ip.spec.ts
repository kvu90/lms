import { describe, expect, it } from 'vitest';
import { clientIpOf, normalizeIpAddress, TRUSTED_PROXY_HOPS } from './client-ip';

/**
 * Kiểm thử đơn vị cho chuẩn hoá địa chỉ IP khách: tiền tố `::ffff:`
 * chỉ được cắt khi phần còn lại là IPv4 thật; ngoài ra mọi giá trị
 * giữ nguyên để không làm sai lệch IP đã ghi.
 */
describe('Hàm normalizeIpAddress', () => {
  it('cắt tiền tố ::ffff: khi phần còn lại là địa chỉ IPv4 hợp lệ', () => {
    expect(normalizeIpAddress('::ffff:10.1.32.229')).toBe('10.1.32.229');
    expect(normalizeIpAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
  });

  it('giữ nguyên địa chỉ IPv6 thuần', () => {
    expect(normalizeIpAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIpAddress('::1')).toBe('::1');
  });

  it('giữ tiền tố ::ffff: khi phần còn lại không phải IPv4', () => {
    expect(normalizeIpAddress('::ffff:2001:db8::1')).toBe('::ffff:2001:db8::1');
    expect(normalizeIpAddress('::ffff:not-an-ip')).toBe('::ffff:not-an-ip');
  });

  it('giữ nguyên địa chỉ IPv4 thuần', () => {
    expect(normalizeIpAddress('203.0.113.55')).toBe('203.0.113.55');
  });

  it('trả undefined và giữ nguyên đầu vào rỗng', () => {
    expect(normalizeIpAddress(undefined)).toBeUndefined();
    expect(normalizeIpAddress('')).toBe('');
  });
});

describe('Hàm clientIpOf', () => {
  it('trả req.ip đã chuẩn hoá', () => {
    expect(clientIpOf({ ip: '::ffff:10.1.32.229' })).toBe('10.1.32.229');
    expect(clientIpOf({ ip: '198.51.100.23' })).toBe('198.51.100.23');
    expect(clientIpOf({ ip: undefined })).toBeUndefined();
  });
});

describe('Khối TRUSTED_PROXY_HOPS', () => {
  it('chỉ tin đúng một hop proxy (edge proxy)', () => {
    expect(TRUSTED_PROXY_HOPS).toBe(1);
  });
});
