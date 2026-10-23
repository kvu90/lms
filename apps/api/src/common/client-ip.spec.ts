import { describe, expect, it } from 'vitest';
import { clientIpOf, normalizeIpAddress, TRUSTED_PROXY_HOPS } from './client-ip';

/**
 * Kiểm thử đơn vị cho chuẩn hoá địa chỉ IP khách: tiền tố `::ffff:`
 * chỉ được cắt khi phần còn lại là IPv4 thật; ngoài ra mọi giá trị
 * giữ nguyên để không làm sai lệch IP đã ghi.
 */
describe('normalizeIpAddress', () => {
  it('cuts the ::ffff: prefix when the remainder is a valid IPv4 address', () => {
    expect(normalizeIpAddress('::ffff:10.1.32.229')).toBe('10.1.32.229');
    expect(normalizeIpAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
  });

  it('keeps a plain IPv6 address unchanged', () => {
    expect(normalizeIpAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIpAddress('::1')).toBe('::1');
  });

  it('keeps the ::ffff: prefix when the remainder is not IPv4', () => {
    expect(normalizeIpAddress('::ffff:2001:db8::1')).toBe('::ffff:2001:db8::1');
    expect(normalizeIpAddress('::ffff:not-an-ip')).toBe('::ffff:not-an-ip');
  });

  it('keeps a plain IPv4 address unchanged', () => {
    expect(normalizeIpAddress('203.0.113.55')).toBe('203.0.113.55');
  });

  it('returns undefined and empty input unchanged', () => {
    expect(normalizeIpAddress(undefined)).toBeUndefined();
    expect(normalizeIpAddress('')).toBe('');
  });
});

describe('clientIpOf', () => {
  it('returns the normalized req.ip', () => {
    expect(clientIpOf({ ip: '::ffff:10.1.32.229' })).toBe('10.1.32.229');
    expect(clientIpOf({ ip: '198.51.100.23' })).toBe('198.51.100.23');
    expect(clientIpOf({ ip: undefined })).toBeUndefined();
  });
});

describe('TRUSTED_PROXY_HOPS', () => {
  it('trusts exactly one proxy hop (the Heroku router)', () => {
    expect(TRUSTED_PROXY_HOPS).toBe(1);
  });
});
