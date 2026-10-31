/**
 * Các bảng của bounded context TRUNG TÂM (issue #583, chương trình
 * tenant #579) — dữ kiện riêng của một trung tâm sống trong CHÍNH
 * database riêng của trung tâm đó (mỗi trung tâm một database trên
 * cụm chung, tầng ứng dụng dùng chung).
 *
 * Ba bảng này chỉ có ý nghĩa trong kho của một trung tâm (và trong
 * kho chung ở dạng "chưa có trung tâm nào dùng tới" — chúng trống
 * cho tới khi một trung tâm được cấp phát):
 * - `centre_identity`: nhận diện riêng của trung tâm (tên hiển thị,
 *   logo, màu thương hiệu) — đúng một dòng cho mỗi tenant, đọc từ
 *   kho của trung tâm khi phục vụ địa chỉ của trung tâm đó, KHÔNG
 *   đọc từ sổ đăng ký ở control plane (sổ chỉ giữ bản ghi định
 *   tuyến tối thiểu).
 * - `centre_invites`: lời mời kích hoạt tài khoản quản trị đầu tiên
 *   của trung tâm (và các lời mời quản trị về sau): token chỉ lưu
 *   dạng băm SHA-256, dùng một lần, có hạn, huỷ được. Không tồn
 *   tại mật khẩu mặc định dùng chung — tài khoản chỉ có mật khẩu
 *   sau khi người được mời đặt qua liên kết kích hoạt.
 * - `program_package_installs`: bản cài cục bộ của gói yêu cầu đạt
 *   chuẩn (YCCĐ) trong kho trung tâm — mỗi trung tâm giữ một bản
 *   cài của gói, gắn chuẩn theo bản cài đó; phiên bản gói và
 *   checksum của artifact là căn cứ để pipeline cấp phát (và các
 *   đợt cập nhật gói sau này) biết kho này đang ở bản nào và có
 *   cần cài lại hay không.
 *
 * Cả ba bảng đều mang `tenant_id` và chịu policy RLS fail-closed
 * `tenant_isolation` như mọi bảng nghiệp vụ khác (xem khối RLS
 * cuối file migration của đợt này): phiên platform tường minh thấy
 * mọi dòng, phiên tenant chỉ thấy dòng của tenant mình, phiên
 * chưa đặt GUC không thấy dòng nào.
 */
import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.schema';
import { users } from './users.schema';

/**
 * Nhận diện riêng của một trung tâm — đúng một dòng cho mỗi tenant
 * (`tenant_id` duy nhất). `displayName` là tên hiển thị trên bề mặt
 * của trung tâm; `logoPath` là tham chiếu tới tệp logo trong kho
 * lưu trữ tệp của trung tâm (bản ghi tệp nằm trong chính database
 * này nên chỉ trung tâm đó đọc được — đó là "tiền tố riêng theo
 * trung tâm" ở tầng bản ghi, vì kho lưu trữ vật lý của hệ định địa
 * chỉ theo nội dung chứ không theo đường dẫn); `brandColor` là màu
 * thương hiệu cơ bản (mã hex, ví dụ `#1d76db`), null nghĩa là dùng
 * màu mặc định của hệ. Quản trị của trung tâm tự sửa ba trường này
 * qua API nhận diện; tầng ứng dụng đọc dòng này từ kho của trung
 * tâm khi dựng bề mặt cho địa chỉ của trung tâm đó.
 */
export const centreIdentity = pgTable(
  'centre_identity',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    displayName: text('display_name').notNull(),
    logoPath: text('logo_path'),
    brandColor: text('brand_color'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('centre_identity_tenant_unique').on(table.tenantId)],
);

/**
 * Lời mời kích hoạt tài khoản của một trung tâm. Một lời mời gắn với
 * đúng một tài khoản (`userId`) và một địa chỉ email; token gốc chỉ
 * xuất hiện đúng một lần ở đầu ra của lệnh cấp phát (hoặc lệnh cấp
 * lại lời mời) và không bao giờ được lưu — trong database chỉ có
 * băm SHA-256 của token (`tokenHash`, duy nhất toàn bảng để tra cứu
 * nhanh và để hai token không bao giờ trùng băm một cách vô tình).
 * Lời mời hợp lệ khi đồng thời: chưa dùng (`usedAt` null), chưa bị
 * huỷ (`revokedAt` null) và chưa hết hạn (`expiresAt` còn trong
 * tương lai). Kích hoạt là thao tác đốt token trước rồi mới đặt mật
 * khẩu (fail-closed): nếu bước đặt mật khẩu hỏng sau khi đốt, lời
 * mời đã mất và phải cấp lại — không tồn tại đường dùng lại token
 * sau khi mật khẩu đã được đặt.
 */
export const centreInvites = pgTable(
  'centre_invites',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('centre_invites_tenant_id_idx').on(table.tenantId)],
);

/**
 * Bản cài cục bộ của một gói dữ liệu chương trình trong kho của một
 * trung tâm. `packageKey` là mã gói (hiện tại chỉ có `gdpt-2018` —
 * chương trình GDPT 2018); `version` là phiên bản artifact dump tại
 * thời điểm cài (ví dụ `2026-10-29.3`); `checksum` là băm SHA-256
 * của toàn văn artifact đã cài. Cặp (`tenantId`, `packageKey`) duy
 * nhất: một trung tâm tại một thời điểm chỉ giữ một bản cài của mỗi
 * gói. Pipeline cấp phát tra bảng này trước khi nạp dump: bản cài đã
 * khớp phiên bản + checksum thì bỏ qua (chạy lại an toàn); chưa có
 * bản cài mà dữ kiện chương trình đã có sẵn (cửa sổ hỏng giữa lúc
 * nạp dump và lúc ghi bản cài) thì chỉ ghi bản cài, không nạp lại
 * dump để khỏi vi phạm khoá chính.
 */
export const programPackageInstalls = pgTable(
  'program_package_installs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    packageKey: text('package_key').notNull(),
    version: text('version').notNull(),
    checksum: text('checksum').notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('program_package_installs_tenant_key_unique').on(table.tenantId, table.packageKey)],
);

export type CentreIdentityRow = typeof centreIdentity.$inferSelect;
export type CentreInviteRow = typeof centreInvites.$inferSelect;
export type ProgramPackageInstallRow = typeof programPackageInstalls.$inferSelect;
