import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { SiteSetting, SiteSettingAuditEntry } from '@lms/contracts';
import {
  MESSAGE_PROVIDERS,
  NOTIFICATION_POLICY_COMPONENT,
  notificationPolicySettingName,
} from '../messaging/notification-providers';
import { SiteConfigRepository } from '@lms/db/repositories/site-config';
import {
  SITE_SETTINGS,
  findSiteSetting,
  validateSiteSettingValue,
  type SiteSettingDefinition,
} from './settings-registry';

/**
 * Facade của Site Config (Moodle `config` + `config_plugins` + thiết lập admin).
 *
 * Phân tầng giá trị: mặc định khai trong registry (code) < giá trị quản trị
 * lưu cơ sở dữ liệu. Mọi thay đổi qua API đều bị kiểm chứng theo kiểu đã
 * đăng ký và đều để lại vết trong `admin_setting_audit`. Các module khác
 * đọc giá trị hiệu lực qua {@link SiteConfigService.getValue} thay vì tự
 * chạm vào bảng config.
 */
@Injectable()
export class SiteConfigService {
  constructor(private readonly repo: SiteConfigRepository) {}

  /**
   * Khoá chuẩn của một setting trong bảng vết: `component/name`.
   */
  private settingKey(def: SiteSettingDefinition): string {
    return `${def.component}/${def.name}`;
  }

  /**
   * Chiếu một setting thành dạng API trả về: giá trị hiệu lực + nguồn của
   * nó (mặc định code hay ghi đè trong cơ sở dữ liệu).
   */
  private async toView(def: SiteSettingDefinition): Promise<SiteSetting> {
    const stored = await this.repo.getStoredValue(def.component, def.name);
    return {
      component: def.component,
      name: def.name,
      type: def.type,
      defaultValue: def.defaultValue,
      value: stored === undefined ? def.defaultValue : stored,
      source: stored === undefined ? 'default' : 'database',
      scope: def.scope,
    };
  }

  /**
   * Tìm định nghĩa setting hoặc ném lỗi 400 `site_config.unknown_setting` —
   * API không chấp nhận ghi vào khoá chưa đăng ký.
   */
  private requireDefinition(component: string, name: string): SiteSettingDefinition {
    const def = findSiteSetting(component, name);
    if (!def) {
      throw new BadRequestException({
        message: `Unknown site setting ${component}/${name}`,
        code: 'site_config.unknown_setting',
      });
    }
    return def;
  }

  /**
   * Liệt kê mọi setting đã đăng ký kèm giá trị hiệu lực.
   */
  async listSettings(): Promise<SiteSetting[]> {
    const views: SiteSetting[] = [];
    for (const def of SITE_SETTINGS) views.push(await this.toView(def));
    return views;
  }

  /**
   * Đọc một setting theo component + name.
   */
  async getSetting(component: string, name: string): Promise<SiteSetting> {
    return this.toView(this.requireDefinition(component, name));
  }

  /**
   * Giá trị hiệu lực đã ép kiểu cho các module khác tiêu thụ (ví dụ cổng
   * nhắn tin đọc `core/messagingallusers`). Setting chưa đăng ký trả về
   * undefined để bên gọi tự quyết định mặc định của mình.
   */
  async getValue<T extends string | number | boolean>(component: string, name: string): Promise<T | undefined> {
    const def = findSiteSetting(component, name);
    if (!def) return undefined;
    const stored = await this.repo.getStoredValue(component, name);
    return (stored === undefined ? def.defaultValue : stored) as T;
  }

  /**
   * Đặt giá trị mới cho một setting: kiểm chứng kiểu theo registry, lưu
   * ghi đè và ghi vết (giá trị hiệu lực trước → sau, người thực hiện).
   */
  async setSetting(
    actorId: string,
    component: string,
    name: string,
    value: unknown,
  ): Promise<SiteSetting> {
    const def = this.requireDefinition(component, name);
    const problem = validateSiteSettingValue(def, value);
    if (problem) {
      throw new BadRequestException({
        message: `Invalid value for ${component}/${name}: ${problem}`,
        code: 'site_config.invalid_value',
      });
    }
    // Chính sách P2 (issue #174) ở tầng site (NB-7): hai loại thông báo
    // bắt buộc (mandatoryInApp trong registry provider) thì ADMIN cũng
    // không tắt được — đặt false cho khoá chính sách của chúng bị từ
    // chối ngay tại đây để mọi đường ghi (API site-config) đều bị chặn,
    // không chỉ giao diện admin khoá công tắc.
    if (def.component === NOTIFICATION_POLICY_COMPONENT && value === false) {
      const provider = MESSAGE_PROVIDERS.find((p) => notificationPolicySettingName(p.name) === def.name);
      if (provider?.mandatoryInApp) {
        throw new BadRequestException({
          message: `Notification type ${provider.name} is mandatory and cannot be disabled at site level`,
          code: 'site_config.notification_mandatory',
        });
      }
    }
    const before = await this.toView(def);
    await this.repo.storeValue(component, name, value);
    await this.repo.insertAudit({
      settingKey: this.settingKey(def),
      oldValue: before.value,
      newValue: value,
      changedBy: actorId,
    });
    return this.toView(def);
  }

  /**
   * Xoá ghi đè của một setting (giá trị hiệu lực trở về mặc định code) và
   * ghi vết; setting chưa có ghi đè thì báo 404.
   */
  async clearSetting(actorId: string, component: string, name: string): Promise<SiteSetting> {
    const def = this.requireDefinition(component, name);
    const before = await this.toView(def);
    if (before.source === 'default') {
      throw new NotFoundException({
        message: `Site setting ${component}/${name} has no stored override`,
        code: 'site_config.override_not_found',
      });
    }
    await this.repo.deleteValue(component, name);
    await this.repo.insertAudit({
      settingKey: this.settingKey(def),
      oldValue: before.value,
      newValue: def.defaultValue,
      changedBy: actorId,
    });
    return this.toView(def);
  }

  /**
   * Liệt kê vết thay đổi cấu hình (mới nhất trước), lọc theo khoá nếu có.
   */
  async listAudit(settingKey?: string): Promise<SiteSettingAuditEntry[]> {
    const rows = await this.repo.listAudit(settingKey);
    return rows.slice(0, 100).map((row) => ({
      id: row.id,
      settingKey: row.settingKey,
      oldValue: row.oldValue,
      newValue: row.newValue,
      changedBy: row.changedBy,
      tenantId: row.tenantId ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
