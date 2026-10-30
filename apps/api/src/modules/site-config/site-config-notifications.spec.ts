import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  MANDATORY_NOTIFICATION_PROVIDERS,
  MESSAGE_PROVIDERS,
  NOTIFICATION_POLICY_COMPONENT,
  notificationPolicySettingName,
} from '../messaging/notification-providers';
import { SITE_SETTINGS, findSiteSetting } from './settings-registry';
import { SiteConfigService } from './site-config.service';

/**
 * NB-7 (issue #174): họ khoá chính sách thông báo trong site-config.
 *
 * - Đúng MỘT khoá boolean cho mỗi provider của registry thông báo,
 *   sinh từ chính MESSAGE_PROVIDERS (không lệch sổ), mặc định bật,
 *   scope platform (tenant không ghi đè được).
 * - Hai loại bắt buộc P2: SiteConfigService từ chối đặt false
 *   (site_config.notification_mandatory) — admin cũng không tắt được;
 *   đặt true/bật lại thì được.
 */
describe('Cài đặt chính sách site cho thông báo (NB-7)', () => {
  it('đăng ký đúng một cài đặt platform boolean cho mỗi provider thông báo, mặc định bật', () => {
    const policySettings = SITE_SETTINGS.filter((s) => s.component === NOTIFICATION_POLICY_COMPONENT);
    expect(policySettings).toHaveLength(MESSAGE_PROVIDERS.length);
    expect(MESSAGE_PROVIDERS).toHaveLength(20);
    for (const provider of MESSAGE_PROVIDERS) {
      const def = findSiteSetting(NOTIFICATION_POLICY_COMPONENT, notificationPolicySettingName(provider.name));
      expect(def, provider.name).toBeDefined();
      expect(def).toMatchObject({ type: 'boolean', defaultValue: true, scope: 'platform' });
    }
  });

  it('tập bắt buộc đúng là hai loại P2', () => {
    expect([...MANDATORY_NOTIFICATION_PROVIDERS].sort()).toEqual(['admin_announcement', 'enrol_expiry_warning']);
  });

  function buildService() {
    const stored = new Map<string, unknown>();
    const repo = {
      getStoredValue: vi.fn(async (component: string, name: string) => stored.get(`${component}/${name}`)),
      storeValue: vi.fn(async (component: string, name: string, value: unknown) => { stored.set(`${component}/${name}`, value); }),
      insertAudit: vi.fn(async () => undefined),
      deleteValue: vi.fn(async (component: string, name: string) => { stored.delete(`${component}/${name}`); }),
    };
    return { service: new SiteConfigService(repo as never), repo };
  }

  it('từ chối tắt loại thông báo bắt buộc ở cấp site', async () => {
    const { service, repo } = buildService();
    for (const provider of MANDATORY_NOTIFICATION_PROVIDERS) {
      const error = await service
        .setSetting('admin-1', NOTIFICATION_POLICY_COMPONENT, notificationPolicySettingName(provider), false)
        .catch((e: unknown) => e);
      expect(error, provider).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'site_config.notification_mandatory' });
    }
    expect(repo.storeValue).not.toHaveBeenCalled();
  });

  it('cho tắt loại thường và (bật lại) loại bắt buộc', async () => {
    const { service, repo } = buildService();
    const off = await service.setSetting('admin-1', NOTIFICATION_POLICY_COMPONENT, notificationPolicySettingName('grade_updated'), false);
    expect(off.value).toBe(false);
    const on = await service.setSetting('admin-1', NOTIFICATION_POLICY_COMPONENT, notificationPolicySettingName('enrol_expiry_warning'), true);
    expect(on.value).toBe(true);
    expect(repo.storeValue).toHaveBeenCalledTimes(2);
  });
});
