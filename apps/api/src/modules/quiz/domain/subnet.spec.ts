import { describe, expect, it } from 'vitest';
import { ipMatchesSubnetList, isValidSubnetList } from './subnet';

/** Kiểm thử thuần cho đối chiếu subnet kiểu Moodle `quiz.subnet` (IPv4/IPv6/CIDR, dạng mapped). */
describe('quiz subnet matching', () => {
  it('matches plain IPs and CIDR ranges (v4)', () => {
    expect(ipMatchesSubnetList('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(ipMatchesSubnetList('127.0.0.2', '127.0.0.1')).toBe(false);
    expect(ipMatchesSubnetList('10.20.30.40', '10.0.0.0/8')).toBe(true);
    expect(ipMatchesSubnetList('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(ipMatchesSubnetList('192.168.1.200', '10.0.0.0/8, 192.168.1.0/24')).toBe(true);
    expect(ipMatchesSubnetList('203.0.113.9', '0.0.0.0/0')).toBe(true);
  });

  it('matches IPv6 and normalizes IPv4-mapped addresses', () => {
    expect(ipMatchesSubnetList('2001:db8::5', '2001:db8::/32')).toBe(true);
    expect(ipMatchesSubnetList('2001:db9::5', '2001:db8::/32')).toBe(false);
    expect(ipMatchesSubnetList('::ffff:10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipMatchesSubnetList('::1', '::1/128')).toBe(true);
  });

  it('validates lists strictly', () => {
    expect(isValidSubnetList('10.0.0.0/8, 192.168.1.20')).toBe(true);
    expect(isValidSubnetList('not-an-ip')).toBe(false);
    expect(isValidSubnetList('10.0.0.0/33')).toBe(false);
    expect(isValidSubnetList('')).toBe(false);
    expect(isValidSubnetList('10.0.0.0/8, bogus')).toBe(false);
  });
});
