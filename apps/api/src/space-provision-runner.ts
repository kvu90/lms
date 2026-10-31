/**
 * Pipeline cấp phát trung tâm mới (issue #583, chương trình tenant
 * #579) — MỘT lệnh vận hành duy nhất dựng một trung tâm từ con số
 * không thành một kho riêng hoạt động được trên cụm chung.
 *
 * Thứ tự 7 bước (mỗi bước kiểm tra trạng thái đã làm trước khi làm
 * — chạy lại sau sự cố tiếp tục từ bước dở dang, không tạo trùng):
 * 1. Đăng ký: dòng `space_registry` (trạng thái `provisioning`) +
 *    lịch sử `create`. Từ chối slug đã có (trừ khi chạy lại đúng
 *    trung tâm đó) và từ chối tên database đã có ở BẤT KỲ dòng nào
 *    (kể cả hàng shared — kho dedicated mang tên trùng kho chung
 *    sẽ khiến trung tâm trỏ thẳng vào kho chung).
 * 2. Database + role: role kết nối riêng + database riêng thuộc sở
 *    hữu role đó trên cụm chung, thu hồi CONNECT của PUBLIC, chỉ
 *    cấp cho role của trung tâm. Mật khẩu role: ưu tiên biến môi
 *    trường `SPACE_PROVISION_DB_PASSWORD` (vận hành cấp tường minh,
 *    cũng là cách xoay mật khẩu khi đã mất); chưa cấp mà role chưa
 *    có thì sinh mật khẩu chữ-số và in đúng một lần; role đã có mà
 *    không cấp mật khẩu thì GIỮ NGUYÊN mật khẩu cũ (không xoay lén
 *    dưới chân môi trường triển khai đã lưu mật khẩu trước đó).
 * 3. Migration: toàn bộ migration nghiệp vụ hiện hành vào database
 *    mới bằng đúng bộ máy `migrate()` của Drizzle (như fleet
 *    runner), rồi ghi phiên bản schema vào registry của trung tâm.
 *    Database mới nên không cần sao lưu trước như fleet runner.
 * 4. Dữ kiện nền: context hệ thống + dòng tenant (kind `center`,
 *    trạng thái `active`) + context tenant + bản cài cục bộ gói
 *    chương trình (YCCĐ) — dump chương trình được restore nguyên
 *    văn bằng `restoreProgramDumpSql` (một transaction, neo lại
 *    context hệ thống của kho đích). Ghi nhận bản cài (phiên bản +
 *    checksum) để lần chạy lại biết kho này đã ở bản nào: bản cài
 *    khớp thì bỏ qua; chưa có bản cài mà dữ kiện đã có (chết giữa
 *    lúc restore và lúc ghi bản cài) thì chỉ ghi bản cài.
 * 5. Nhận diện: dòng `centre_identity` (tên hiển thị = tên trung
 *    tâm, logo/chưa có, màu/chưa đặt) — dữ kiện này sống trong kho
 *    của trung tâm, không nằm ở sổ đăng ký control plane.
 * 6. Quản trị đầu tiên: tài khoản KHÔNG mật khẩu (không tồn tại mật
 *    khẩu mặc định dùng chung) + membership active vào tenant +
 *    id vào `config.siteadmins` của kho trung tâm + lời mời kích
 *    hoạt (token chỉ lưu dạng băm, hạn 7 ngày). Lời mời đang chờ
 *    sẵn thì tái dùng (không cấp chồng); token gốc chỉ in ra khi
 *    tạo mới — mất link thì dùng lệnh cấp lại lời mời.
 * 7. Kích hoạt định tuyến: trạng thái sổ → `active` + lịch sử
 *    `status_change`. Từ đây khung định tuyến phục vụ trung tâm
 *    (đệm phân giải hết hạn theo TTL, không cần khởi động lại).
 *
 * Sau bước 7, vận hành còn MỘT việc ngoài pipeline (in rõ ở đầu ra):
 * thêm biến môi trường `SPACE_<SLUG>_DATABASE_URL` (URL kết nối của
 * trung tâm) vào môi trường triển khai — sổ đăng ký chỉ giữ tham
 * chiếu, tầng ứng dụng chỉ phân giải được trung tâm khi biến này
 * đã có trong môi trường của nó.
 *
 * Ranh giới tin cậy: runner chạy ngoài NestJS như các công cụ fleet
 * (không gác capability — quyền chạy script của đội vận hành là
 * ranh giới), dùng đúng repository/writer của control plane và đúng
 * bất biến ghi của tầng service.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SpaceRegistryRow } from '@lms/db/control-plane';
import {
  buildCentreDatabaseUrl,
  CENTRE_INVITE_TTL_MS,
  CENTRE_PROGRAM_PACKAGE_KEY,
  deriveCentreDatabaseName,
  deriveCentreRoleName,
  deriveCentreSecretEnvVar,
  generateCentreDatabasePassword,
  generateCentreInviteToken,
  hashCentreInviteToken,
  normalizeSpaceSlug,
} from './centre-provision';
import {
  buildEnsureDatabaseStatements,
  buildEnsureRoleStatements,
  buildRestrictConnectStatements,
} from './control-plane-provision';
import {
  listMigrationFolders,
  readDatabaseAppliedMigrations,
  readDatabaseSchemaVersion,
  retargetUrl,
} from './fleet-common';
import { FleetRegistryWriter } from './fleet-registry-writer';
import { CONTEXT_LEVELS } from './modules/access/domain/capabilities';
import { isDedicatedDatabaseNameConflict } from './modules/control-plane/control-plane.repository';
import {
  loadProgramDumpSql,
  PROGRAM_DUMP_VERSION,
  restoreProgramDumpSql,
} from './modules/curriculum/program-dump';
import { relations } from './db/relations';
import {
  centreIdentity,
  centreInvites,
  config,
  context,
  programPackageInstalls,
  tenantMemberships,
  tenants,
  users,
} from './db/schema';

/** Đầu vào của một lượt cấp phát. */
export type SpaceProvisionOptions = {
  /** Slug của trung tâm (chuẩn hoá theo nhãn DNS trước khi dùng). */
  slug: string;
  /** Tên hiển thị của trung tâm. */
  name: string;
  /** Gói dịch vụ của trung tâm (lưu vào sổ, null = chưa gắn gói). */
  plan?: string | null;
  /** Tên đăng nhập của quản trị đầu tiên (mặc định `admin`). */
  adminUsername?: string;
  /** Email của quản trị đầu tiên (bắt buộc — lời mời gửi tới địa chỉ này). */
  adminEmail: string;
  /** Tên riêng của quản trị đầu tiên. */
  adminFirstName?: string;
  /** Họ của quản trị đầu tiên. */
  adminLastName?: string;
  /** Ghi đè tên database (mặc định suy từ slug). */
  databaseName?: string;
  /** Mật khẩu role kết nối do vận hành cấp (mặc định đọc `SPACE_PROVISION_DB_PASSWORD`, rồi sinh mới). */
  databasePassword?: string;
  /** UUID của người vận hành — bắt buộc, ghi vào lịch sử sổ đăng ký (fail-closed khi thiếu). */
  actorId: string;
  /** Thư mục migration nghiệp vụ (mặc định `<cwd>/drizzle`). */
  migrationsDir?: string;
  /** Biến môi trường (mặc định `process.env`) — test chèn env riêng qua đây. */
  env?: NodeJS.ProcessEnv;
  /** Ghi nhật ký tiến trình (mặc định `console.log`). */
  log?: (message: string) => void;
};

/** Kết quả một lượt cấp phát. */
export type SpaceProvisionResult = {
  slug: string;
  spaceId: string;
  databaseName: string;
  connectionRole: string;
  secretEnvVar: string;
  /** Id tenant trong kho trung tâm (null khi chạy lại trên trung tâm đã active — không đổi gì). */
  tenantId: string | null;
  /** Id tài khoản quản trị đầu tiên (null khi chạy lại trên trung tâm đã active). */
  adminUserId: string | null;
  /** Token lời mời gốc — chỉ có khi tạo mới trong lượt này; null khi tái dùng lời mời đang chờ hoặc chạy lại. */
  inviteToken: string | null;
  /** Hạn của lời mời (tạo mới hoặc đang chờ) — null khi chạy lại trên trung tâm đã active. */
  inviteExpiresAt: Date | null;
  /** Lượt này có sinh mật khẩu database mới không (in một lần ở đầu ra). */
  passwordWasGenerated: boolean;
  /** Mật khẩu database mới sinh (chỉ khi `passwordWasGenerated`, để CLI in một lần — không ghi log nơi khác). */
  generatedPassword: string | null;
  /** `active` = cấp phát xong trong lượt này; `already-active` = trung tâm đã active sẵn, không đổi gì. */
  status: 'active' | 'already-active';
  /** Tiến trình từng bước: created = làm mới, reused = đã có sẵn nên bỏ qua. */
  steps: { name: string; outcome: 'created' | 'reused' }[];
};

/**
 * Shim `uuidv7()` cho cụm PostgreSQL dưới 18 (cùng công thức với
 * shim của spec fleet — môi trường kiểm thử và cụm cũ chưa có hàm
 * gốc): CHỈ áp khi phiên bản máy chủ < 18; trên 18 tuyệt đối không
 * áp vì sẽ che mất hàm gốc. Cần `pgcrypto` (extension trusted từ
 * PG13 nên chủ sở hữu database tự tạo được).
 */
const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/**
 * Chạy pipeline cấp phát trung tâm mới.
 *
 * @param options - Đầu vào của lượt cấp phát.
 * @returns Kết quả lượt cấp phát (xem `SpaceProvisionResult`).
 * @throws Error khi đầu vào sai (slug, actorId, thiếu cấu hình) hoặc
 *   bất kỳ bước nào hỏng — lỗi mang tên bước để vận hành chạy lại
 *   đúng từ bước dở dang.
 */
export async function runSpaceProvision(options: SpaceProvisionOptions): Promise<SpaceProvisionResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));
  const slug = normalizeSpaceSlug(options.slug);
  const name = options.name.trim();
  if (!name) throw new Error('Space name is required');
  const adminUsername = (options.adminUsername ?? 'admin').trim().toLowerCase();
  if (!adminUsername) throw new Error('Admin username is required');
  const adminEmail = options.adminEmail.trim().toLowerCase();
  if (!adminEmail) throw new Error('Admin email is required');
  const actorId = options.actorId.trim();
  if (!actorId) throw new Error('actorId is required: pass the operator admin user id with --actor-id (history rows require an actor)');
  if (!env.CONTROL_PLANE_DATABASE_URL) throw new Error('CONTROL_PLANE_DATABASE_URL is required for provisioning');
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required to derive the cluster admin connection');

  const databaseName = options.databaseName ?? deriveCentreDatabaseName(slug);
  const connectionRole = deriveCentreRoleName(slug);
  const secretEnvVar = deriveCentreSecretEnvVar(slug);
  const migrationsDir = options.migrationsDir ?? join(process.cwd(), 'drizzle');
  const steps: SpaceProvisionResult['steps'] = [];
  const step = (stepName: string, outcome: 'created' | 'reused') => {
    steps.push({ name: stepName, outcome });
    log(`[provision:${slug}] ${stepName}: ${outcome}`);
  };

  const writer = new FleetRegistryWriter(env);
  // Kết nối quản trị của cụm: ưu tiên DATABASE_ADMIN_URL, dự phòng
  // DATABASE_URL trỏ về database `postgres` (cùng khuôn setup).
  const adminUrl = retargetUrl(env.DATABASE_ADMIN_URL ?? databaseUrl, 'postgres');
  const adminParsed = new URL(adminUrl);
  const clusterHost = adminParsed.hostname;
  const clusterPort = adminParsed.port ? Number(adminParsed.port) : 5432;
  try {
    // ---- Bước 1: dòng đăng ký (chạy lại an toàn) ----
    const existing = await writer.findSpaceBySlug(slug);
    let spaceId: string;
    if (existing) {
      if (existing.storageMode !== 'dedicated') {
        throw new Error(`Slug ${slug} is already registered as a ${existing.storageMode} space (id ${existing.id}) — refusing to take it over`);
      }
      if (existing.databaseName !== databaseName) {
        throw new Error(`Slug ${slug} is already registered with database ${existing.databaseName}, not ${databaseName} — refusing to take it over`);
      }
      if (existing.status === 'active') {
        log(`[provision:${slug}] already active — nothing changed`);
        return {
          slug, spaceId: existing.id, databaseName, connectionRole, secretEnvVar,
          tenantId: null, adminUserId: null, inviteToken: null, inviteExpiresAt: null,
          passwordWasGenerated: false, generatedPassword: null, status: 'already-active', steps,
        };
      }
      spaceId = existing.id;
      step('registration', 'reused');
    } else {
      const clash = await writer.findSpaceByDatabaseName(databaseName);
      if (clash) {
        throw new Error(`Database name ${databaseName} is already used by space ${clash.slug} — refusing to provision a second centre on it`);
      }
      let row: SpaceRegistryRow | undefined;
      try {
        row = await writer.createSpaceRegistration(actorId, {
          slug, name, kind: 'center', databaseName, connectionRoleRef: connectionRole, secretRef: `env:${secretEnvVar}`, plan: options.plan ?? null,
        });
      } catch (error) {
        if (isDedicatedDatabaseNameConflict(error)) {
          throw new Error(`Database name ${databaseName} is already used by another dedicated space — refusing to provision a second centre on it`);
        }
        throw error;
      }
      if (!row) throw new Error(`Slug ${slug} was registered concurrently — re-run provisioning to resume`);
      spaceId = row.id;
      step('registration', 'created');
    }

    // ---- Bước 2: role + database trên cụm (chạy lại an toàn) ----
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    let passwordWasGenerated = false;
    let generatedPassword: string | null = null;
    try {
      const roleRow = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [connectionRole]);
      const roleExists = (roleRow.rowCount ?? 0) > 0;
      const providedPassword = options.databasePassword ?? env.SPACE_PROVISION_DB_PASSWORD;
      let rolePassword: string | null;
      if (providedPassword) {
        rolePassword = providedPassword;
      } else if (!roleExists) {
        rolePassword = generateCentreDatabasePassword();
        passwordWasGenerated = true;
        generatedPassword = rolePassword;
      } else {
        // Role đã có mà vận hành không cấp mật khẩu: giữ nguyên mật
        // khẩu cũ — xoay lén sẽ làm môi trường triển khai đã lưu mật
        // khẩu trước đó mất kết nối tới kho này.
        rolePassword = null;
      }
      if (rolePassword !== null) {
        for (const stmt of buildEnsureRoleStatements({ database: databaseName, role: connectionRole, rolePassword }, roleExists)) {
          await admin.query(stmt);
        }
      }
      const dbRow = await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [databaseName]);
      if (dbRow.rows.length > 0) {
        const owner = dbRow.rows[0].owner as string;
        if (owner !== connectionRole) {
          throw new Error(`Database ${databaseName} already exists owned by ${owner}, not ${connectionRole} — refusing to take it over`);
        }
      } else {
        for (const stmt of buildEnsureDatabaseStatements({ database: databaseName, role: connectionRole, rolePassword: rolePassword ?? '' }, false)) {
          await admin.query(stmt);
        }
      }
      for (const stmt of buildRestrictConnectStatements({ database: databaseName, role: connectionRole, rolePassword: rolePassword ?? '' })) {
        await admin.query(stmt);
      }
      step('database-role', roleExists ? 'reused' : 'created');
    } finally {
      await admin.end().catch(() => undefined);
    }

    // URL kết nối của trung tâm (dùng cho các bước còn lại): mật khẩu
    // lấy từ biến vận hành, hoặc mật khẩu vừa sinh, hoặc — khi role
    // đã có và không cấp mật khẩu — mật khẩu cũ nằm trong biến môi
    // trường của tầng ứng dụng (`secretEnvVar`) nếu tiến trình này có
    // nó (đọc qua URL parser để mật khẩu chứa ký tự đặc biệt vẫn
    // đúng); không có thì các bước sau không mở được kết nối và lỗi
    // rõ thay vì thử mật khẩu rỗng.
    let centrePassword = options.databasePassword ?? env.SPACE_PROVISION_DB_PASSWORD ?? generatedPassword ?? null;
    if (!centrePassword && env[secretEnvVar]) {
      try {
        centrePassword = decodeURIComponent(new URL(env[secretEnvVar]!).password);
      } catch {
        centrePassword = null;
      }
    }
    if (!centrePassword) {
      throw new Error(`Cannot connect to the centre database: role ${connectionRole} already exists but no password was provided (set SPACE_PROVISION_DB_PASSWORD or ${secretEnvVar})`);
    }
    const centreUrl = buildCentreDatabaseUrl({ host: clusterHost, port: clusterPort, role: connectionRole, password: decodeURIComponent(centrePassword), databaseName });

    // ---- Bước 3: migration nghiệp vụ vào kho mới ----
    const migrationPool = new Pool({ connectionString: centreUrl });
    try {
      const versionRow = await migrationPool.query('SHOW server_version');
      const major = Number(String(versionRow.rows[0].server_version).split('.')[0]);
      if (major < 18) {
        await migrationPool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await migrationPool.query(UUIDV7_SHIM);
      }
      const folders = listMigrationFolders(migrationsDir);
      if (folders.length === 0) throw new Error(`No migration folders found under ${migrationsDir}`);
      const targetVersion = folders[folders.length - 1]!;
      const probe = new Client({ connectionString: centreUrl });
      await probe.connect();
      let applied: string[];
      let currentVersion: string | null;
      try {
        applied = await readDatabaseAppliedMigrations(probe);
        currentVersion = await readDatabaseSchemaVersion(probe);
      } finally {
        await probe.end().catch(() => undefined);
      }
      if (!applied.includes(targetVersion)) {
        const db = drizzle({ client: migrationPool });
        await migrate(db, { migrationsFolder: migrationsDir });
        const verify = new Client({ connectionString: centreUrl });
        await verify.connect();
        try {
          const appliedAfter = await readDatabaseAppliedMigrations(verify);
          const reached = await readDatabaseSchemaVersion(verify);
          const missing = folders.filter((folder) => !appliedAfter.includes(folder));
          if (missing.length > 0 || reached !== targetVersion) {
            throw new Error(`Migration verification failed: missing ${missing.join(', ') || 'none'}, version ${reached ?? 'none'} != ${targetVersion}`);
          }
        } finally {
          await verify.end().catch(() => undefined);
        }
        await writer.recordMigrationOutcome(spaceId, {
          runId: `provision-${slug}-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 14)}`,
          fromVersion: currentVersion,
          toVersion: targetVersion,
          status: 'success',
          steps: [{ name: 'apply-migrations', status: 'success' }],
        });
        step('migrations', 'created');
      } else {
        step('migrations', 'reused');
      }
    } finally {
      await migrationPool.end().catch(() => undefined);
    }

    // ---- Bước 4–6: dữ kiện nền, nhận diện, quản trị đầu tiên ----
    // Một kết nối riêng với GUC platform ở mức phiên: mọi ghi seed
    // (kể cả restore dump chạy transaction riêng của nó) đều thấy
    // platform='on' nên qua được RLS FORCE của kho mới.
    const seedClient = new Client({ connectionString: centreUrl });
    await seedClient.connect();
    try {
      // GUC platform ở mức phiên (không phải transaction-local):
      // restore dump chạy transaction riêng của nó nên GUC phải tồn
      // tại ngoài transaction mới tới được bên trong nó.
      await seedClient.query(`SELECT set_config('app.platform', 'on', false)`);
      const db = drizzle({ client: seedClient, relations });
      // Context hệ thống (level 10) — neo của toàn bộ cây chương trình và tenant.
      const [existingSystem] = await db.select().from(context)
        .where(and(eq(context.contextLevel, CONTEXT_LEVELS.SYSTEM), isNull(context.instanceId))).limit(1);
      let systemContextId: string;
      if (existingSystem) {
        systemContextId = existingSystem.id;
      } else {
        const [inserted] = await db.insert(context).values({ contextLevel: CONTEXT_LEVELS.SYSTEM, instanceId: null, path: '', depth: 0 }).returning();
        const path = `/${inserted!.id}`;
        await db.update(context).set({ path, depth: 1 }).where(eq(context.id, inserted!.id));
        systemContextId = inserted!.id;
      }
      // Dòng tenant của trung tâm (kind center, active — cổng guard
      // yêu cầu tenant active và membership active để đi qua).
      const [existingTenant] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
      let tenantId: string;
      if (existingTenant) {
        tenantId = existingTenant.id;
        if (existingTenant.kind !== 'center' || existingTenant.status !== 'active') {
          throw new Error(`Tenant ${slug} already exists in the centre database with kind ${existingTenant.kind} / status ${existingTenant.status} — refusing to take it over`);
        }
      } else {
        const [inserted] = await db.insert(tenants).values({ slug, name, kind: 'center', status: 'active', plan: options.plan ?? null }).returning();
        tenantId = inserted!.id;
      }
      // Context tenant (level 20) dưới context hệ thống.
      const [existingTenantContext] = await db.select().from(context)
        .where(and(eq(context.contextLevel, CONTEXT_LEVELS.TENANT), eq(context.instanceId, tenantId))).limit(1);
      if (!existingTenantContext) {
        const [inserted] = await db.insert(context).values({ contextLevel: CONTEXT_LEVELS.TENANT, instanceId: tenantId, path: '', depth: 0 }).returning();
        await db.update(context).set({ path: `${'/' + systemContextId}/${inserted!.id}`, depth: 2 }).where(eq(context.id, inserted!.id));
      }
      // Bản cài gói chương trình: khớp phiên bản + checksum thì bỏ
      // qua; chưa có bản cài mà dữ kiện đã có thì chỉ ghi bản cài
      // (cửa sổ hỏng giữa restore và ghi bản cài); còn lại restore
      // dump rồi ghi bản cài.
      const dumpSql = loadProgramDumpSql();
      const dumpChecksum = createHash('sha256').update(dumpSql).digest('hex');
      const [existingInstall] = await db.select().from(programPackageInstalls)
        .where(and(eq(programPackageInstalls.tenantId, tenantId), eq(programPackageInstalls.packageKey, CENTRE_PROGRAM_PACKAGE_KEY))).limit(1);
      let programRecordsPresent = false;
      if (!existingInstall || existingInstall.version !== PROGRAM_DUMP_VERSION || existingInstall.checksum !== dumpChecksum) {
        const executed = await db.execute(sql`SELECT COUNT(*) AS c FROM subjects`);
        const subjectRows = (executed as unknown as { rows: { c: string }[] }).rows;
        programRecordsPresent = Number(subjectRows[0]?.c ?? 0) > 0;
        if (!existingInstall && !programRecordsPresent) {
          await restoreProgramDumpSql(db, dumpSql, { anchorContextId: systemContextId });
        }
        if (!existingInstall) {
          await db.insert(programPackageInstalls).values({
            tenantId, packageKey: CENTRE_PROGRAM_PACKAGE_KEY, version: PROGRAM_DUMP_VERSION, checksum: dumpChecksum,
          });
        } else {
          // Bản cài cũ lệch phiên bản/checksum: gói đã đổi bản — cấp
          // phát không tự nâng cấp kho đã có (đó là việc của migration
          // gói), dừng rõ thay vì ghi đè lặng lẽ hay restore chồng.
          throw new Error(`Centre database already has program package ${CENTRE_PROGRAM_PACKAGE_KEY} at version ${existingInstall.version} (expected ${PROGRAM_DUMP_VERSION}) — refusing to overwrite; upgrade the package instead`);
        }
      }
      step('seed', 'created');
      // Nhận diện của trung tâm (một dòng cho mỗi tenant).
      const [existingIdentity] = await db.select().from(centreIdentity).where(eq(centreIdentity.tenantId, tenantId)).limit(1);
      if (!existingIdentity) {
        await db.insert(centreIdentity).values({ tenantId, displayName: name, logoPath: null, brandColor: null });
        step('identity', 'created');
      } else {
        step('identity', 'reused');
      }
      // Quản trị đầu tiên: tài khoản chưa có mật khẩu + membership +
      // siteadmins của kho trung tâm + lời mời kích hoạt.
      const [existingUser] = await db.select().from(users).where(eq(users.username, adminUsername)).limit(1);
      let adminUserId: string;
      if (existingUser) {
        if (existingUser.email !== adminEmail) {
          throw new Error(`Username ${adminUsername} already exists in the centre database with a different email — refusing to take it over`);
        }
        adminUserId = existingUser.id;
      } else {
        const [inserted] = await db.insert(users).values({
          username: adminUsername, email: adminEmail, passwordHash: null,
          firstName: options.adminFirstName ?? '', lastName: options.adminLastName ?? '',
          forcePasswordChange: true,
        }).returning();
        adminUserId = inserted!.id;
      }
      await db.insert(tenantMemberships).values({ tenantId, userId: adminUserId, status: 'active' })
        .onConflictDoNothing({ target: [tenantMemberships.tenantId, tenantMemberships.userId] });
      const [siteAdminsRow] = await db.select().from(config).where(eq(config.key, 'siteadmins')).limit(1);
      const currentAdmins = Array.isArray(siteAdminsRow?.value) ? (siteAdminsRow!.value as unknown[]).map((v) => String(v)) : [];
      if (!currentAdmins.includes(adminUserId)) {
        const next = [...currentAdmins, adminUserId];
        if (siteAdminsRow) {
          await db.update(config).set({ value: next }).where(eq(config.id, siteAdminsRow.id));
        } else {
          await db.insert(config).values({ key: 'siteadmins', value: next });
        }
      }
      // Lời mời: đang chờ thì tái dùng (token gốc đã mất sau lần in
      // đầu — vận hành dùng lệnh cấp lại nếu mất link); chưa có thì
      // tạo mới và trả token gốc để CLI in ra.
      const [pendingInvite] = await db.select().from(centreInvites)
        .where(and(
          eq(centreInvites.userId, adminUserId),
          isNull(centreInvites.usedAt),
          isNull(centreInvites.revokedAt),
          sql`${centreInvites.expiresAt} > now()`,
        )).limit(1);
      let inviteToken: string | null = null;
      let inviteExpiresAt: Date | null = null;
      if (pendingInvite) {
        inviteExpiresAt = pendingInvite.expiresAt;
        step('admin-invite', 'reused');
      } else {
        inviteToken = generateCentreInviteToken();
        inviteExpiresAt = new Date(Date.now() + CENTRE_INVITE_TTL_MS);
        await db.insert(centreInvites).values({
          tenantId, userId: adminUserId, email: adminEmail,
          tokenHash: hashCentreInviteToken(inviteToken), expiresAt: inviteExpiresAt,
        });
        step('admin-invite', 'created');
      }

      // ---- Bước 7: kích hoạt định tuyến ----
      await writer.changeSpaceStatus(spaceId, 'active', actorId);
      step('activation', 'created');
      return {
        slug, spaceId, databaseName, connectionRole, secretEnvVar,
        tenantId, adminUserId, inviteToken, inviteExpiresAt,
        passwordWasGenerated, generatedPassword, status: 'active', steps,
      };
    } finally {
      await seedClient.end().catch(() => undefined);
    }
  } finally {
    await writer.close().catch(() => undefined);
  }
}

/** Đầu vào của lệnh cấp lại / huỷ lời mời kích hoạt. */
export type CentreInviteOptions = {
  slug: string;
  /** Email của tài khoản nhận lời mời (khớp đúng email của tài khoản trong kho trung tâm). */
  email: string;
  /** Chỉ huỷ các lời mời đang chờ, không tạo mới. */
  revokeOnly?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
};

/** Kết quả lệnh lời mời. */
export type CentreInviteResult = {
  slug: string;
  userId: string;
  /** Số lời mời đang chờ đã bị huỷ trong lượt này. */
  revokedCount: number;
  /** Token lời mời mới (null khi chỉ huỷ). */
  inviteToken: string | null;
  /** Hạn của lời mời mới (null khi chỉ huỷ). */
  inviteExpiresAt: Date | null;
};

/**
 * Cấp lại lời mời kích hoạt cho một tài khoản của trung tâm (dùng
 * khi link kích hoạt đầu tiên bị mất sau khi token gốc đã in ra —
 * token gốc không lưu nên không thể "gửi lại" mà chỉ có thể cấp
 * mới): huỷ mọi lời mời đang chờ của tài khoản rồi tạo một lời mời
 * mới (hạn 7 ngày). Với `--revoke` thì chỉ huỷ, không tạo mới.
 *
 * @param options - Slug trung tâm + email tài khoản.
 * @returns Kết quả lệnh (xem `CentreInviteResult`).
 * @throws Error khi trung tâm chưa đăng ký, chưa active, tài khoản
 *   không tồn tại trong kho trung tâm, hoặc biến môi trường URL kết
 *   nối của trung tâm chưa có trong môi trường chạy lệnh.
 */
export async function manageCentreInvite(options: CentreInviteOptions): Promise<CentreInviteResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));
  const slug = normalizeSpaceSlug(options.slug);
  const email = options.email.trim().toLowerCase();
  if (!email) throw new Error('Email is required');
  if (!env.CONTROL_PLANE_DATABASE_URL) throw new Error('CONTROL_PLANE_DATABASE_URL is required');
  const writer = new FleetRegistryWriter(env);
  try {
    const space = await writer.findSpaceBySlug(slug);
    if (!space) throw new Error(`Space ${slug} is not registered`);
    if (space.storageMode !== 'dedicated') throw new Error(`Space ${slug} is not a dedicated centre space`);
    const secretRef = space.secretRef;
    if (!secretRef?.startsWith('env:')) throw new Error(`Space ${slug} has no env secret reference to connect with`);
    const secretEnvVar = secretRef.slice('env:'.length);
    const centreUrl = env[secretEnvVar];
    if (!centreUrl) throw new Error(`Connection URL env var ${secretEnvVar} is not set in this environment`);
    const client = new Client({ connectionString: centreUrl });
    await client.connect();
    try {
      await client.query(`SELECT set_config('app.platform', 'on', false)`);
      const db = drizzle({ client, relations });
      const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
      if (!tenant) throw new Error(`Tenant ${slug} does not exist in the centre database yet`);
      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (!user) throw new Error(`No user with email ${email} in the centre database`);
      const pending = await db.select().from(centreInvites)
        .where(and(
          eq(centreInvites.userId, user.id),
          isNull(centreInvites.usedAt),
          isNull(centreInvites.revokedAt),
          sql`${centreInvites.expiresAt} > now()`,
        ));
      for (const invite of pending) {
        await db.update(centreInvites).set({ revokedAt: new Date() }).where(eq(centreInvites.id, invite.id));
      }
      log(`[invite:${slug}] revoked ${pending.length} pending invite(s) for ${email}`);
      if (options.revokeOnly) {
        return { slug, userId: user.id, revokedCount: pending.length, inviteToken: null, inviteExpiresAt: null };
      }
      const inviteToken = generateCentreInviteToken();
      const inviteExpiresAt = new Date(Date.now() + CENTRE_INVITE_TTL_MS);
      await db.insert(centreInvites).values({
        tenantId: tenant.id, userId: user.id, email,
        tokenHash: hashCentreInviteToken(inviteToken), expiresAt: inviteExpiresAt,
      });
      return { slug, userId: user.id, revokedCount: pending.length, inviteToken, inviteExpiresAt };
    } finally {
      await client.end().catch(() => undefined);
    }
  } finally {
    await writer.close().catch(() => undefined);
  }
}
