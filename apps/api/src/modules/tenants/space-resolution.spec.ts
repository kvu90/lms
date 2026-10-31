import { describe, expect, it } from 'vitest';
import { extractSpaceSlugFromHost } from './space-resolution';

/**
 * Ca đơn vị của hàm trích slug trung tâm từ địa chỉ request (issue
 * #582): khoá quy ước địa chỉ — nhãn đầu tiên của tên miền con là
 * slug ứng viên; địa chỉ gốc, localhost, IP và nhãn sai hình dạng
 * đều không mang trung tâm.
 */
describe('Trích slug trung tâm từ địa chỉ request', () => {
  it('tên miền con ba nhãn trả nhãn đầu tiên làm slug ứng viên', () => {
    expect(extractSpaceSlugFromHost('trung-tam-a.he-thong.example')).toBe('trung-tam-a');
  });

  it('host kèm cổng vẫn trích đúng slug, cổng bị bỏ qua', () => {
    expect(extractSpaceSlugFromHost('trung-tam-a.he-thong.example:8443')).toBe('trung-tam-a');
  });

  it('chữ hoa trong host được hạ về chữ thường trước khi đối chiếu hình dạng slug', () => {
    expect(extractSpaceSlugFromHost('Trung-Tam-A.He-Thong.Example')).toBe('trung-tam-a');
  });

  it('tên miền con sâu hơn ba nhãn vẫn lấy đúng nhãn đầu tiên', () => {
    expect(extractSpaceSlugFromHost('trung-tam-a.chi-nhanh.he-thong.example')).toBe('trung-tam-a');
  });

  it('địa chỉ gốc hai nhãn không mang trung tâm', () => {
    expect(extractSpaceSlugFromHost('he-thong.example')).toBeNull();
  });

  it('localhost không mang trung tâm, kể cả khi kèm cổng', () => {
    expect(extractSpaceSlugFromHost('localhost')).toBeNull();
    expect(extractSpaceSlugFromHost('localhost:3000')).toBeNull();
  });

  it('địa chỉ IP không mang trung tâm', () => {
    expect(extractSpaceSlugFromHost('127.0.0.1')).toBeNull();
    expect(extractSpaceSlugFromHost('127.0.0.1:8080')).toBeNull();
    expect(extractSpaceSlugFromHost('192.168.1.10')).toBeNull();
  });

  it('nhãn đầu tiên sai hình dạng slug thì không coi là ứng viên', () => {
    expect(extractSpaceSlugFromHost('-trung-tam-.he-thong.example')).toBeNull();
    expect(extractSpaceSlugFromHost('trung_tam_a.he-thong.example')).toBeNull();
    expect(extractSpaceSlugFromHost('.he-thong.example')).toBeNull();
  });

  it('host trống hoặc thiếu thì không mang trung tâm', () => {
    expect(extractSpaceSlugFromHost(undefined)).toBeNull();
    expect(extractSpaceSlugFromHost(null)).toBeNull();
    expect(extractSpaceSlugFromHost('')).toBeNull();
    expect(extractSpaceSlugFromHost('   ')).toBeNull();
  });
});
