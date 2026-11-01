/**
 * Các bảng của CONTROL PLANE (issue #580, chương trình tenant #579) —
 * tầng quản trị nền tảng đứng NGOÀI kho dữ liệu nghiệp vụ: sổ đăng ký
 * trung tâm, lịch sử quản trị sổ và registry phiên bản schema của từng
 * kho đã đăng ký.
 *
 * Vì sao file này KHÔNG nằm trong barrel `src/index.ts`: barrel đó là
 * nguồn sinh migration của kho nghiệp vụ (`apps/api/drizzle.config.ts`
 * trỏ vào index.ts). Control plane có database RIÊNG trên cùng cụm
 * Postgres và bộ migration RIÊNG (`apps/api/drizzle-control-plane.config.ts`
 * trỏ thẳng vào file này, đầu ra `apps/api/drizzle-control-plane/`) —
 * trộn hai bộ schema vào một điểm sinh migration sẽ làm mỗi phía sinh
 * lệnh tạo/xoá bảng của phía kia. Điểm vào dùng chung của file này là
 * subpath `@lms/db/control-plane` (xem `src/control-plane.ts`).
 *
 * Quy ước dữ liệu của tầng này:
 * - Chỉ lưu THAM CHIẾU tới bí mật (tên biến môi trường, tên mục trong
 *   kho bí mật) — giá trị bí mật không bao giờ nằm trong database.
 * - Không khoá ngoại sang kho nghiệp vụ (hai database tách nhau): các
 *   định danh phía nghiệp vụ (ví dụ mã người quản trị ghi lịch sử) lưu
 *   dạng uuid thuần, toàn vẹn do tầng service bảo đảm.
 * - Không RLS: đây là dữ liệu của platform, không thuộc tenant nào;
 *   quyền truy cập cưỡng chế ở tầng service bằng capability platform.
 *   Các bảng này là bảng nền tảng của control plane theo quyết định
 *   trong đặc tả issue #580 — ngoại lệ đích danh với khuôn RLS của
 *   bảng nghiệp vụ (xem AGENTS.md của package).
 */
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Một dòng lịch sử trước/sau của sổ đăng ký (ảnh chụp JSON của dòng đăng ký). */
export type SpaceRegistrySnapshot = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  status: string;
  databaseName: string;
  storageMode: string;
  connectionRoleRef: string;
  secretRef: string | null;
  schemaVersion: string | null;
  plan: string | null;
};

/** Kết quả một bước trong một lượt chạy migration (do công cụ fleet ghi). */
export type SchemaMigrationStep = {
  name: string;
  status: string;
  detail?: string;
};

/**
 * Sổ đăng ký không gian: mỗi dòng là một không gian đã được platform
 * ghi nhận — một trung tâm (`kind = 'center'`) hoặc chính Trang chính
 * (`kind = 'platform'`, cũng là một không gian như mọi trung tâm).
 * `slug` là định danh địa chỉ của không gian (duy nhất toàn sổ) và là
 * khoá tra cứu định tuyến của tầng ứng dụng.
 *
 * `storageMode` ghi chế độ kho dữ liệu của không gian: `shared` = đang
 * dùng kho chung hiện tại (mọi không gian hiện hữu ở thời điểm dựng sổ),
 * `dedicated` = đã có database riêng. Vòng đời `status`:
 * `provisioning` (đang cấp phát) → `active` (đang hoạt động) →
 * `suspended` (tạm ngưng) / `closed` (đã đóng).
 *
 * Sổ này chỉ giữ bản ghi định tuyến tối thiểu — nhận diện riêng của
 * trung tâm (tên hiển thị nghiệp vụ, logo, thương hiệu) KHÔNG nằm ở
 * đây; chúng thuộc về dữ liệu của chính trung tâm (issue #583).
 * `plan` chỉ LƯU mã gói dịch vụ của trung tâm — nghiệp vụ billing
 * (hoá đơn, thu tiền) không thuộc tầng này.
 */
export const spaceRegistry = pgTable(
  'space_registry',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    /** center | platform (platform chỉ cho Trang chính). */
    kind: text('kind').notNull(),
    /** provisioning | active | suspended | closed. */
    status: text('status').notNull().default('provisioning'),
    databaseName: text('database_name').notNull(),
    /** shared | dedicated. */
    storageMode: text('storage_mode').notNull(),
    /** Tham chiếu role kết nối của kho đích (tên role) — không phải bí mật. */
    connectionRoleRef: text('connection_role_ref').notNull(),
    /** Tham chiếu bí mật kết nối (ví dụ `env:CONTROL_PLANE_DATABASE_URL`) — chỉ tham chiếu, không chứa giá trị. */
    secretRef: text('secret_ref'),
    /** Phiên bản schema hiện tại của kho đích (đồng bộ từ registry phiên bản schema). */
    schemaVersion: text('schema_version'),
    plan: text('plan'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Chỉ số theo trạng thái vòng đời: các đường vận hành (định tuyến,
  // công cụ fleet) lọc không gian theo trạng thái là truy vấn chính
  // trên sổ này; slug đã có ràng buộc duy nhất làm chỉ số tra cứu.
  // Chỉ số duy nhất RIÊNG PHẦN cho tên database của kho DEDICATED
  // (issue #583, ghi chú điều phối 6528534235 — điểm P1-2b từ review
  // PR #594): hai trung tâm không bao giờ được trỏ cùng một database
  // riêng, vì đó là hai kho độc lập bị chập thành một. Chỉ số KHÔNG
  // phủ hàng shared: kho chung vốn là MỘT database được nhiều dòng
  // đăng ký cùng trỏ (Trang chính + trường mặc định), nên ràng buộc
  // duy nhất toàn bảng sẽ phá bước migrate của control plane. Đường
  // cấp phát kiểm tra trùng ở tầng ứng dụng trước khi ghi, chỉ số
  // này là chốt chặn cuối cho cuộc đua dedicated-vs-dedicated.
  (table) => [
    index('space_registry_status_idx').on(table.status),
    uniqueIndex('space_registry_database_name_dedicated_unique')
      .on(table.databaseName)
      .where(sql`"space_registry"."storage_mode" = 'dedicated'`),
  ],
);

/**
 * Lịch sử quản trị sổ đăng ký: MỌI thao tác ghi (tạo, cập nhật, đổi
 * trạng thái) đều để lại đúng một dòng ở đây — người thực hiện, thời
 * gian, ảnh chụp giá trị trước và sau — ghi trong CÙNG transaction với
 * thay đổi trên sổ, nên sổ và lịch sử không bao giờ lệch nhau.
 * `actorId` là mã tài khoản quản trị ở kho nghiệp vụ (không khoá ngoại
 * vì hai database tách nhau).
 */
export const spaceRegistryHistory = pgTable(
  'space_registry_history',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    spaceId: uuid('space_id').notNull().references(() => spaceRegistry.id, { onDelete: 'restrict' }),
    actorId: uuid('actor_id').notNull(),
    /** create | update | status_change. */
    action: text('action').notNull(),
    before: jsonb('before').$type<SpaceRegistrySnapshot>(),
    after: jsonb('after').$type<SpaceRegistrySnapshot>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('space_registry_history_space_id_idx').on(table.spaceId)],
);

/**
 * Registry phiên bản schema của MỘT kho đã đăng ký (khoá chính là
 * chính dòng đăng ký): phiên bản schema hiện tại và trạng thái sao
 * lưu/khôi phục gần nhất. Issue này dựng KHUNG bảng và đường ghi/đọc;
 * cơ chế tự động ghi (công cụ migration/sao lưu toàn fleet) thuộc
 * issue #586 — ở đây các trường trạng thái chỉ là dữ kiện được ghi
 * qua API quản trị, chưa có tiến trình nền nào tự điền.
 */
export const spaceSchemaRegistry = pgTable('space_schema_registry', {
  spaceId: uuid('space_id').primaryKey().references(() => spaceRegistry.id, { onDelete: 'restrict' }),
  currentVersion: text('current_version'),
  /** Trạng thái lượt sao lưu gần nhất (khung trường — cơ chế ghi thuộc issue #586). */
  lastBackupStatus: text('last_backup_status'),
  lastBackupAt: timestamp('last_backup_at', { withTimezone: true }),
  /** Trạng thái lượt khôi phục gần nhất (khung trường — cơ chế ghi thuộc issue #586). */
  lastRestoreStatus: text('last_restore_status'),
  lastRestoreAt: timestamp('last_restore_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Lịch sử các lượt chạy migration trên kho của một không gian: mỗi
 * lượt có mã lượt chạy do công cụ cấp, phiên bản điểm đầu/điểm đích,
 * kết quả chung và kết quả theo từng bước (JSON). Bảng này là nhật ký
 * chỉ thêm (append-only) — không sửa dòng cũ.
 */
export const spaceSchemaMigrationRuns = pgTable(
  'space_schema_migration_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    spaceId: uuid('space_id').notNull().references(() => spaceRegistry.id, { onDelete: 'restrict' }),
    runId: text('run_id').notNull(),
    fromVersion: text('from_version'),
    toVersion: text('to_version'),
    /** running | success | failed. */
    status: text('status').notNull(),
    steps: jsonb('steps').$type<SchemaMigrationStep[]>().notNull().default([]),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('space_schema_migration_runs_space_id_idx').on(table.spaceId)],
);

/**
 * Thư mục THÀNH VIÊN của các không gian ở kho riêng (issue #587,
 * tiền điều kiện Phần B — hạng mục 3, thiết kế B1): một dòng cho
 * mỗi cặp (tài khoản toàn cục, không gian kho riêng) mà người đó
 * là thành viên ở kho đích.
 *
 * Vì sao bảng này tồn tại: sau khi một trung tâm chuyển sang kho
 * riêng, các dòng `tenant_memberships` của nó chỉ còn ở kho đích,
 * và tài khoản vật chất hoá ở kho đích có thể mang `id` khác hẳn
 * tài khoản toàn cục (hai kho là hai database độc lập, không có
 * khoá nối xuyên kho theo người dùng). Bộ chọn trung tâm của
 * thành viên (`listMyTenants`) tra ở kho chung sẽ không còn thấy
 * membership của trung tâm đã chuyển. Thư mục này là chỉ mục ĐỊNH
 * TUYẾN để bộ chọn biết người dùng còn là thành viên của những
 * không gian kho riêng nào — dữ kiện hiển thị và trạng thái
 * membership THẬT luôn được đọc lại tại kho đích, thư mục không
 * bao giờ là nguồn sự thật nghiệp vụ.
 *
 * Bất biến:
 * - Chỉ giữ dữ kiện định tuyến tối thiểu: `globalUserId` (định
 *   danh của tài khoản ở kho chung — hoặc chính định danh ở kho
 *   đích với tài khoản chỉ sinh ra trong kho riêng, vì đó là định
 *   danh duy nhất người đó có), `spaceSlug` (khoá định tuyến của
 *   không gian), `spaceUserId` (định danh của chính người đó
 *   trong kho đích), `status` (ảnh trạng thái membership ở kho
 *   đích tại thời điểm đồng bộ gần nhất — chỉ để bộ chọn bỏ qua
 *   nhanh các mục đã kết thúc; quyết định cuối luôn đối chiếu
 *   dòng membership thật ở kho đích).
 * - Duy nhất theo cặp (`globalUserId`, `spaceSlug`): một người
 *   chỉ có tối đa một tài khoản thành viên trong một không gian.
 * - Không khoá ngoại sang `space_registry`: khoá của thư mục là
 *   slug — khoá định tuyến mọi tầng ứng dụng đang dùng — và toàn
 *   vẹn do tầng service bảo đảm, cùng quy ước của tầng này.
 * - Các điểm ghi bị chặn và liệt kê được: thêm/bớt/đổi trạng thái
 *   membership ở tầng service của API, tạo người dùng trong kho
 *   riêng, cấp phát trung tâm kho riêng, và công cụ lấp thư mục
 *   (backfill) của từng đợt di trú. Ngoài các điểm đó không đường
 *   nào khác ghi bảng này.
 */
export const spaceMembershipDirectory = pgTable(
  'space_membership_directory',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    globalUserId: uuid('global_user_id').notNull(),
    spaceSlug: text('space_slug').notNull(),
    spaceUserId: uuid('space_user_id').notNull(),
    /** active | suspended | ended — khớp trạng thái membership ở kho đích. */
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('space_membership_directory_user_space_unique').on(table.globalUserId, table.spaceSlug),
    index('space_membership_directory_space_user_idx').on(table.spaceUserId),
  ],
);

/**
 * Thư mục MÃ THAM GIA LỚP của các không gian ở kho riêng (issue
 * #587, tiền điều kiện Phần B — hạng mục 3, thiết kế C1): một
 * dòng cho mỗi mã tham gia đang hiệu lực của một lớp thuộc không
 * gian kho riêng, ánh xạ mã → slug của không gian giữ lớp đó.
 *
 * Vì sao bảng này tồn tại: mã tham gia là bí mật toàn hệ — học
 * viên nhập mã ở bất kỳ địa chỉ nào cũng phải tới đúng lớp, mà
 * sau khi trung tâm chuyển kho, dòng lớp chỉ còn ở kho đích nên
 * tra mã ở kho chung không còn thấy lớp. Thư mục cho phép phân
 * giải mã → không gian trước, rồi toàn bộ luồng tham gia (đọc
 * lớp, ghi yêu cầu/ghi danh/membership) chạy trong kho đích.
 *
 * Bất biến:
 * - `joinCode` DUY NHẤT toàn bảng: tính duy nhất toàn hệ của mã
 *   tham gia từ nay do ràng buộc này chốt giữ cho mọi mã đã đăng
 *   ký thư mục; hai không gian không bao giờ giữ cùng một mã.
 * - Chỉ giữ dữ kiện định tuyến (`joinCode` → `spaceSlug`); dữ
 *   kiện của lớp luôn đọc tại kho đích.
 * - Điểm ghi: đặt/đổi mã tham gia và xoá lớp ở tầng service của
 *   API (chỉ cho lớp thuộc không gian kho riêng), và công cụ lấp
 *   thư mục của đợt di trú cho lớp có sẵn.
 */
export const spaceJoinCodeDirectory = pgTable(
  'space_join_code_directory',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    joinCode: text('join_code').notNull().unique(),
    spaceSlug: text('space_slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('space_join_code_directory_space_slug_idx').on(table.spaceSlug)],
);

export type SpaceRegistryRow = typeof spaceRegistry.$inferSelect;
export type SpaceRegistryHistoryRow = typeof spaceRegistryHistory.$inferSelect;
export type SpaceSchemaRegistryRow = typeof spaceSchemaRegistry.$inferSelect;
export type SpaceSchemaMigrationRunRow = typeof spaceSchemaMigrationRuns.$inferSelect;
export type SpaceMembershipDirectoryRow = typeof spaceMembershipDirectory.$inferSelect;
export type SpaceJoinCodeDirectoryRow = typeof spaceJoinCodeDirectory.$inferSelect;
