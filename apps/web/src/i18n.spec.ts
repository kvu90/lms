/**
 * Kiểm chứng hành vi nạp lười catalog tiếng Anh (issue #503): catalog vi
 * đóng gói sẵn là mặc định; catalog en nằm ở module riêng `i18n-en.ts` và
 * chỉ được nạp khi ngôn ngữ chuyển sang `en` — sau khi nạp, mọi khoá của
 * cả bốn namespace phải tra được đúng chuỗi tiếng Anh (không thiếu khoá
 * nào so với catalog nguồn) và chuyển về lại tiếng Việt vẫn đúng.
 */
import { afterAll, describe, expect, it } from 'vitest';
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
