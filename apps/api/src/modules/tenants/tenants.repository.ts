import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { tenantConfig, tenantMemberships, tenants } from '../../db/schema';

export type TenantRow = typeof tenants.$inferSelect;
export type TenantMembershipRow = typeof tenantMemberships.$inferSelect;
export type TenantConfigRow = typeof tenantConfig.$inferSelect;

/** Slug của tenant-zero — không gian Trang chính (giáo viên/học sinh tự do). */
export const PLATFORM_TENANT_SLUG = 'trang-chinh';
/** Slug của tenant trường mặc định do review-seed dựng cho câu chuyện demo. */
export const DEFAULT_SCHOOL_TENANT_SLUG = 'truong-mac-dinh';

@Injectable()
/**
 * Kho dữ liệu tenant: vòng đời tenant, membership và cấu hình theo tenant.
 * Thuần dữ liệu — mọi quyết định quyền nằm ở TenantsService /
 * PermissionEvaluator.
 */
export class TenantsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  get dbHandle(): Database { return this.db; }

  async insertTenant(v: typeof tenants.$inferInsert): Promise<TenantRow> {
    const [row] = await this.db.insert(tenants).values(v).returning();
    return row!;
  }

  async getTenant(id: string): Promise<TenantRow | undefined> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, id));
    return row;
  }

  async getTenantBySlug(slug: string): Promise<TenantRow | undefined> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.slug, slug));
    return row;
  }

  /** Bản tenant-zero đã tra được, giữ trong singleton của repository. */
  private platformTenantCache: TenantRow | undefined;

  /**
   * Tenant-zero (tenant nền tảng) cho TenantGuard: được gieo một lần
   * lúc bootstrap và không đổi danh tính (id/slug/kind) trong vòng
   * đời tiến trình, nên tra một lần rồi giữ lại trong singleton này
   * — bỏ một truy vấn khỏi MỌI request. Chỉ cache khi ĐÃ tra thấy:
   * trước bootstrap seed (tenant-zero chưa tồn tại) mọi lần gọi vẫn
   * xuống cơ sở dữ liệu để request đầu tiên sau khi gieo thấy ngay.
   * Các thay đổi trạng thái/cấu hình của tenant-zero không đi qua
   * bản cache này (guard chỉ dùng `id` của nó làm tenant hiệu lực
   * mặc định); đường đọc cần trạng thái tươi dùng `getTenantBySlug` /
   * `getTenant` như cũ.
   */
  async getPlatformTenant(): Promise<TenantRow | undefined> {
    if (!this.platformTenantCache) {
      this.platformTenantCache = await this.getTenantBySlug(PLATFORM_TENANT_SLUG);
    }
    return this.platformTenantCache;
  }

  async listTenants(): Promise<TenantRow[]> {
    return this.db.select().from(tenants).orderBy(asc(tenants.createdAt));
  }

  async updateTenant(id: string, patch: Partial<TenantRow>): Promise<void> {
    await this.db.update(tenants).set({ ...patch, updatedAt: new Date() }).where(eq(tenants.id, id));
  }

  async insertMembership(v: typeof tenantMemberships.$inferInsert): Promise<TenantMembershipRow> {
    const [row] = await this.db.insert(tenantMemberships).values(v).returning();
    return row!;
  }

  async getMembership(tenantId: string, userId: string): Promise<TenantMembershipRow | undefined> {
    const [row] = await this.db
      .select()
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)));
    return row;
  }

  async listMembershipsForUser(userId: string): Promise<TenantMembershipRow[]> {
    return this.db
      .select()
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, userId))
      .orderBy(asc(tenantMemberships.joinedAt));
  }

  async listMembershipsForTenant(tenantId: string): Promise<TenantMembershipRow[]> {
    return this.db
      .select()
      .from(tenantMemberships)
      .where(eq(tenantMemberships.tenantId, tenantId))
      .orderBy(asc(tenantMemberships.joinedAt));
  }

  async updateMembership(id: string, patch: Partial<TenantMembershipRow>): Promise<void> {
    await this.db.update(tenantMemberships).set(patch).where(eq(tenantMemberships.id, id));
  }

  async getConfigValue(tenantId: string, key: string): Promise<TenantConfigRow | undefined> {
    const [row] = await this.db
      .select()
      .from(tenantConfig)
      .where(and(eq(tenantConfig.tenantId, tenantId), eq(tenantConfig.key, key)));
    return row;
  }

  async listConfigForTenant(tenantId: string): Promise<TenantConfigRow[]> {
    return this.db.select().from(tenantConfig).where(eq(tenantConfig.tenantId, tenantId));
  }

  async upsertConfigValue(tenantId: string, key: string, value: unknown): Promise<void> {
    await this.db
      .insert(tenantConfig)
      .values({ tenantId, key, value: value as never })
      .onConflictDoUpdate({
        target: [tenantConfig.tenantId, tenantConfig.key],
        set: { value: value as never, updatedAt: new Date() },
      });
  }

  async deleteConfigValue(tenantId: string, key: string): Promise<void> {
    await this.db
      .delete(tenantConfig)
      .where(and(eq(tenantConfig.tenantId, tenantId), eq(tenantConfig.key, key)));
  }
}
