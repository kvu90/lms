/** Các bảng của bounded context Tenants — nền multi-tenant (issue #168, TENANT-0; hồ sơ multi-tenant-architecture-research-2026-10-25 mục 2–3, 6.2). */
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../users/schema';

/**
 * Tenant = một trường (`school`) hoặc trung tâm (`center`) tự quản lý
 * riêng, tách biệt với các tenant khác; dòng `kind = 'platform'` duy nhất
 * là **tenant-zero** (slug `trang-chinh`) — không gian của Trang chính,
 * nơi giáo viên/học sinh tự do sinh hoạt. Tenant là thực thể thuộc
 * platform, không thuộc tenant nào. `plan` chỉ LƯU mã gói ở lát này —
 * cưỡng chế hạn mức thuộc TENANT-4.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** school | center | platform (platform chỉ cho tenant-zero). */
  kind: text('kind').notNull(),
  /** active | suspended | archived. */
  status: text('status').notNull().default('active'),
  plan: text('plan'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Tư cách thành viên của một tài khoản TOÀN CỤC trong một tenant: một
 * người được thuộc nhiều tenant (giáo viên dạy 2 trường). Membership là
 * CỔNG VÀO — không có membership `active` ở tenant T thì mọi gán vai
 * trong cây context của T đều vô hiệu (cổng ở PermissionEvaluator).
 * Học sinh chuyển trường: membership cũ → `ended`, dữ liệu ở lại trường
 * cũ, KHÔNG chuyển dữ liệu giữa hai tenant.
 */
export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** active | suspended | ended. */
    status: text('status').notNull().default('active'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    index('tenant_memberships_tenant_id_idx').on(table.tenantId),
    index('tenant_memberships_user_id_idx').on(table.userId),
    unique('tenant_memberships_tenant_user_unique').on(table.tenantId, table.userId),
  ],
);

/**
 * Cấu hình RIÊNG theo tenant (ghi đè lên cấu hình platform ở bảng
 * `config`): phân giải tenant → platform → mặc định code qua
 * `TenantConfigService`. Công tắc cấp duyệt BGH của EB-3 là một khoá ở
 * đây. Xoá một dòng = trở về mặc định tầng dưới.
 */
export const tenantConfig = pgTable(
  'tenant_config',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    value: jsonb('value'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tenant_config_tenant_id_idx').on(table.tenantId),
    unique('tenant_config_tenant_key_unique').on(table.tenantId, table.key),
  ],
);
