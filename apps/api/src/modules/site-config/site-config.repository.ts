import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { adminSettingAudit, config, pluginConfig } from '../../db/schema';

export type AuditRow = typeof adminSettingAudit.$inferSelect;

/**
 * Kho dữ liệu cấu hình site: hai bảng có sẵn của tầng hạ tầng — `config`
 * cho setting của core (giá trị JSON) và `plugin_config` cho setting theo
 * component/plugin (giá trị text chứa JSON), kèm bảng vết
 * `admin_setting_audit` ghi mọi thay đổi do quản trị thực hiện.
 */
@Injectable()
export class SiteConfigRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /**
   * Đọc giá trị đã lưu trong cơ sở dữ liệu của một setting; undefined nếu
   * chưa từng có ghi đè (khi đó giá trị hiệu lực là mặc định trong code).
   */
  async getStoredValue(component: string, name: string): Promise<unknown> {
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
   * Ghi đè giá trị của một setting (chèn mới hoặc cập nhật dòng đã có).
   */
  async storeValue(component: string, name: string, value: unknown): Promise<void> {
    if (component === 'core') {
      await this.db
        .insert(config)
        .values({ key: name, value })
        .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: new Date() } });
      return;
    }
    await this.db
      .insert(pluginConfig)
      .values({ plugin: component, name, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: [pluginConfig.plugin, pluginConfig.name],
        targetWhere: sql`tenant_id is null`,
        set: { value: JSON.stringify(value) },
      });
  }

  /**
   * Xoá ghi đè của một setting để giá trị hiệu lực trở về mặc định code.
   */
  async deleteValue(component: string, name: string): Promise<void> {
    if (component === 'core') {
      await this.db.delete(config).where(eq(config.key, name));
      return;
    }
    await this.db
      .delete(pluginConfig)
      .where(and(eq(pluginConfig.plugin, component), eq(pluginConfig.name, name), isNull(pluginConfig.tenantId)));
  }

  /**
   * Ghi một dòng vết thay đổi: khoá setting, giá trị trước, giá trị sau và
   * người thực hiện.
   */
  async insertAudit(entry: {
    settingKey: string;
    oldValue: unknown;
    newValue: unknown;
    changedBy: string;
    /** NULL = thay đổi ở tầng platform; có giá trị = đổi cấu hình tenant (TENANT-0, #168). */
    tenantId?: string | null;
  }): Promise<void> {
    await this.db.insert(adminSettingAudit).values({
      settingKey: entry.settingKey,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      changedBy: entry.changedBy,
      tenantId: entry.tenantId ?? null,
    });
  }

  /**
   * Liệt kê vết thay đổi mới nhất trước; lọc theo khoá setting nếu có.
   */
  async listAudit(settingKey?: string): Promise<AuditRow[]> {
    const base = this.db.select().from(adminSettingAudit);
    return settingKey
      ? base
          .where(eq(adminSettingAudit.settingKey, settingKey))
          .orderBy(desc(adminSettingAudit.createdAt))
      : base.orderBy(desc(adminSettingAudit.createdAt));
  }
}
