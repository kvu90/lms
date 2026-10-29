/**
 * Kiểm chứng hành vi nạp lười catalog tiếng Anh (issue #503): catalog vi
 * đóng gói sẵn là mặc định; catalog en nằm ở module riêng `i18n-en.ts` và
 * chỉ được nạp khi ngôn ngữ chuyển sang `en` — sau khi nạp, mọi khoá của
 * cả bốn namespace phải tra được đúng chuỗi tiếng Anh (không thiếu khoá
 * nào so với catalog nguồn) và chuyển về lại tiếng Việt vẫn đúng. Riêng
 * ca nạp lỗi: lần nạp đầu thất bại không được khoá cứng các lần sau —
 * lần chuyển ngôn ngữ kế tiếp phải nạp lại từ đầu và thành công.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import i18n, {
  appResources,
  dashboardResources,
  guardianResources,
  platformResources,
} from './i18n';
import { enResources } from './i18n-en';

const NAMESPACES = ['platform', 'app', 'dashboard', 'guardian'] as const;

const vietnameseBundles = {
  platform: platformResources.vi.platform,
  app: appResources.vi.app,
  dashboard: dashboardResources.vi.dashboard,
  guardian: guardianResources.vi.guardian,
} as const;

afterAll(async () => {
  await i18n.changeLanguage('vi');
});

describe('i18n — catalog mặc định tiếng Việt', () => {
  it('khởi tạo ở tiếng Việt và tra được chuỗi tiếng Việt ở cả bốn namespace', () => {
    expect(i18n.language).toBe('vi');
    expect(i18n.t('loading', { ns: 'platform' })).toBe('Đang tải…');
    expect(i18n.t('navProfile', { ns: 'app' })).toBe('Hồ sơ');
    expect(i18n.t('itemDashboard', { ns: 'dashboard' })).toBe('Tổng quan');
    expect(i18n.t('digestOff', { ns: 'guardian' })).toBe('Tắt');
  });
});

describe('i18n — catalog tiếng Anh nạp lười', () => {
  it('catalog en có đúng tập khoá của catalog vi ở cả bốn namespace', () => {
    for (const ns of NAMESPACES) {
      expect(Object.keys(enResources[ns]).sort()).toEqual(
        Object.keys(vietnameseBundles[ns]).sort(),
      );
    }
  });

  it('trước khi chuyển ngôn ngữ, kho tài nguyên chưa hề có chuỗi tiếng Anh', () => {
    expect(i18n.hasResourceBundle('en', 'app')).toBe(false);
    expect(i18n.hasResourceBundle('en', 'platform')).toBe(false);
  });

  it('chuyển sang en thì nạp đủ mọi khoá của cả bốn namespace, không thiếu khoá nào', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.language).toBe('en');
    for (const ns of NAMESPACES) {
      for (const [key, value] of Object.entries(enResources[ns])) {
        expect(i18n.getResource('en', ns, key)).toBe(value);
      }
    }
    expect(i18n.t('loading', { ns: 'platform' })).toBe('Loading…');
    expect(i18n.t('navProfile', { ns: 'app' })).toBe('Profile');
  });

  it('chuyển về vi sau khi đã nạp en vẫn tra đúng chuỗi tiếng Việt', async () => {
    await i18n.changeLanguage('vi');
    expect(i18n.t('loading', { ns: 'platform' })).toBe('Đang tải…');
    expect(i18n.t('itemDashboard', { ns: 'dashboard' })).toBe('Tổng quan');
  });
});

describe('i18n — nạp lười catalog tiếng Anh gặp lỗi rồi thử lại', () => {
  // Trần thời gian nới riêng cho ca này: lần nạp đầu lỗi được i18next
  // tự thử lại theo cấp số nhân (retryTimeout 350ms nhân đôi, tối đa
  // maxRetries 5 lượt) nên riêng chặng lỗi chạy khoảng 11 giây.
  it('lần nạp đầu lỗi thì lần chuyển sang en sau đó nạp lại thành công thay vì kẹt ở promise đã reject', async () => {
    vi.resetModules();
    // Giả lập chunk catalog en tải lỗi (mạng/CDN) ở lần import đầu tiên:
    // module `i18n-en` bị mock để ném lỗi ngay khi được import.
    vi.doMock('./i18n-en', () => {
      throw new Error('Không tải được chunk catalog tiếng Anh');
    });
    const { default: freshI18n } = await import('./i18n');

    await freshI18n.changeLanguage('en');
    expect(freshI18n.hasResourceBundle('en', 'app')).toBe(false);
    expect(freshI18n.hasResourceBundle('en', 'platform')).toBe(false);

    // Lần yêu cầu sau chunk đã tải được: catalog phải được nạp lại từ
    // đầu và đủ khoá, không dùng lại kết quả lỗi của lần đầu.
    vi.doUnmock('./i18n-en');
    await freshI18n.changeLanguage('vi');
    await freshI18n.changeLanguage('en');
    expect(freshI18n.language).toBe('en');
    for (const ns of NAMESPACES) {
      for (const [key, value] of Object.entries(enResources[ns])) {
        expect(freshI18n.getResource('en', ns, key)).toBe(value);
      }
    }
    expect(freshI18n.t('loading', { ns: 'platform' })).toBe('Loading…');
  }, 30_000);
});
