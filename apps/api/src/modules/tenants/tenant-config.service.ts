import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, isNull } from 'drizzle-orm';
import type { SiteSetting } from '@lms/contracts';
import type { Database } from '../../db/database';
import { adminSettingAudit, config, pluginConfig } from '../../db/schema';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import {
  SITE_SETTINGS,
  findSiteSetting,
  validateSiteSettingValue,
  type SiteSettingDefinition,
} from '../site-config/settings-registry';
import { TenantsRepository } from './tenants.repository';
import { TenantContextService } from './tenant-context.service';

/**
 * TenantConfigService — phân giải cấu hình theo tenant (TENANT-0, #168;
 * hồ sơ mục 3.5): giá trị hiệu lực của một khoá cho một tenant =
 * ghi đè của tenant (bảng `tenant_config`) → giá trị platform (bảng
 * `config`/`plugin_config` qua cùng quy tắc lưu trữ của SiteConfig) →
 * mặc định trong registry. Chỉ các setting có scope `tenant`/`both` mới
 * được tenant ghi đè; setting scope `platform` tenant admin không chạm
 * được. Mọi thay đổi của tenant đều ghi vết vào `admin_setting_audit`
 * với tenant_id đi kèm — đây là seam mà công tắc cấp duyệt của EB-3 sẽ
 * đọc qua {@link getEffectiveValue} khi chuyển về tenant_config.
 */
@Injectable()
export class TenantConfigService {
  constructor(
    private readonly repo: TenantsRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly tenantContext: TenantContextService,
    @InjectDrizzle() private readonly db: Database,
  ) {}

  private settingKey(def: SiteSettingDefinition): string {
    return `${def.component}/${def.name}`;
  }

  /** Giá trị đã lưu ở tầng platform (cùng quy tắc lưu trữ với SiteConfigRepository); undefined khi chưa có ghi đè. */
  private async platformStoredValue(component: string, name: string): Promise<unknown> {
    if (component === 'core') {
      const [row] = await this.db.select().from(config).where(eq(config.key, name));
      return row ? row.value : undefined;
    }
    const [row] = await this.db
      .select()
      .from(pluginConfig)
      .where(and(eq(pluginConfig.plugin, component), eq(pluginConfig.name, name), isNull(pluginConfig.tenantId)));
    if (!row || row.value === null) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return row.value;
    }
  }

  /**
   * Giá trị hiệu lực của một setting cho một tenant cụ thể — API đọc
   * chuẩn cho mọi module cần cấu hình theo tenant (EB-3 đọc công tắc
   * duyệt qua đây). Setting chưa đăng ký trả về undefined.
   */
  async getEffectiveValue<T = unknown>(tenantId: string, component: string, name: string): Promise<T | undefined> {
    const def = findSiteSetting(component, name);
    if (!def) return undefined;
    if (def.scope !== 'platform') {
      const row = await this.repo.getConfigValue(tenantId, this.settingKey(def));
      if (row) return row.value as T;
    }
    const stored = await this.platformStoredValue(component, name);
    return (stored === undefined ? def.defaultValue : stored) as T;
  }

  /** Giá trị hiệu lực cho tenant của request hiện tại (ngoài request: tầng platform). */
  async getValueForCurrentTenant<T = unknown>(component: string, name: string): Promise<T | undefined> {
    const tenantId = this.tenantContext.currentTenantId();
    if (!tenantId) {
      const def = findSiteSetting(component, name);
      if (!def) return undefined;
      const stored = await this.platformStoredValue(component, name);
      return (stored === undefined ? def.defaultValue : stored) as T;
    }
    return this.getEffectiveValue<T>(tenantId, component, name);
  }

  /** Một setting chiếu theo hiệu lực cho một tenant: ghi đè tenant → ghi đè platform → mặc định code. */
  async viewForTenant(tenantId: string, component: string, name: string): Promise<SiteSetting> {
    const def = findSiteSetting(component, name);
    if (!def) {
      throw new BadRequestException({
        message: `Unknown site setting ${component}/${name}`,
        code: 'site_config.unknown_setting',
      });
    }
    const tenantRow = def.scope === 'platform' ? undefined : await this.repo.getConfigValue(tenantId, this.settingKey(def));
    const platformStored = await this.platformStoredValue(def.component, def.name);
    return {
      component: def.component,
      name: def.name,
      type: def.type,
      defaultValue: def.defaultValue,
      value: tenantRow ? tenantRow.value : platformStored === undefined ? def.defaultValue : platformStored,
      source: tenantRow || platformStored !== undefined ? 'database' : 'default',
      scope: def.scope,
    };
  }

  /** Danh sách setting của tenant hiệu lực (scope tenant|both) kèm giá trị hiệu lực — cổng xem: tenant:viewall/manage tại context tenant. */
  async listForTenant(actorId: string, tenantId: string): Promise<SiteSetting[]> {
    const tenantCtx = await this.contexts.ensureTenantContext(tenantId);
    const canView =
      (await this.evaluator.hasCapability(actorId, 'tenant:viewall', tenantCtx.id)) ||
      (await this.evaluator.hasCapability(actorId, 'tenant:manage', tenantCtx.id));
    if (!canView) {
      throw new BadRequestException({
        message: 'Missing capability tenant:viewall in the active tenant',
        code: 'access.capability_denied',
      });
    }
    const views: SiteSetting[] = [];
    for (const def of SITE_SETTINGS) {
      if (def.scope === 'platform') continue;
      views.push(await this.viewForTenant(tenantId, def.component, def.name));
    }
    return views;
  }

  /** Tenant admin đặt ghi đè cho tenant của mình (gác `tenant:manage` tại context tenant ngay trong service). */
  async setForTenant(
    actorId: string,
    tenantId: string,
    component: string,
    name: string,
    value: unknown,
  ): Promise<SiteSetting> {
    const def = this.requireTenantDefinition(component, name);
    await this.assertTenantSettingsManager(actorId, tenantId);
    const problem = validateSiteSettingValue(def, value);
    if (problem) {
      throw new BadRequestException({
        message: `Invalid value for ${component}/${name}: ${problem}`,
        code: 'site_config.invalid_value',
      });
    }
    const before = await this.getEffectiveValue(tenantId, component, name);
    await this.repo.upsertConfigValue(tenantId, this.settingKey(def), value);
    await this.insertAudit(tenantId, def, before, value, actorId);
    return this.viewForTenant(tenantId, component, name);
  }

  /** Tenant admin xoá ghi đè của tenant (giá trị hiệu lực trở về tầng platform/mặc định). */
  async clearForTenant(actorId: string, tenantId: string, component: string, name: string): Promise<SiteSetting> {
    const def = this.requireTenantDefinition(component, name);
    await this.assertTenantSettingsManager(actorId, tenantId);
    const existing = await this.repo.getConfigValue(tenantId, this.settingKey(def));
    if (!existing) {
      throw new NotFoundException({
        message: `Tenant setting ${component}/${name} has no tenant override`,
        code: 'site_config.override_not_found',
      });
    }
    const before = existing.value;
    await this.repo.deleteConfigValue(tenantId, this.settingKey(def));
    const after = await this.getEffectiveValue(tenantId, component, name);
    await this.insertAudit(tenantId, def, before, after, actorId);
    return this.viewForTenant(tenantId, component, name);
  }

  private requireTenantDefinition(component: string, name: string): SiteSettingDefinition {
    const def = findSiteSetting(component, name);
    if (!def) {
      throw new BadRequestException({
        message: `Unknown site setting ${component}/${name}`,
        code: 'site_config.unknown_setting',
      });
    }
    if (def.scope === 'platform') {
      throw new BadRequestException({
        message: `Setting ${component}/${name} is platform-scoped and cannot be overridden by a tenant`,
        code: 'site_config.platform_only',
      });
    }
    return def;
  }

  private async assertTenantSettingsManager(actorId: string, tenantId: string): Promise<void> {
    const tenantCtx = await this.contexts.ensureTenantContext(tenantId);
    await this.evaluator.requireCapability(actorId, 'tenant:manage', tenantCtx.id);
  }

  private async insertAudit(
    tenantId: string,
    def: SiteSettingDefinition,
    oldValue: unknown,
    newValue: unknown,
    actorId: string,
  ): Promise<void> {
    await this.db.insert(adminSettingAudit).values({
      settingKey: this.settingKey(def),
      oldValue: oldValue ?? null,
      newValue: newValue ?? null,
      changedBy: actorId,
      tenantId,
    });
  }
}
