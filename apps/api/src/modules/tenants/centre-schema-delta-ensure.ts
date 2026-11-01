/**
 * Bước ensure cho phần delta schema của issue #583 (chương trình
 * tenant #579) — ba bảng riêng của trung tâm trong kho nghiệp vụ
 * (`centre_identity`, `centre_invites`, `program_package_installs`)
 * kèm index, khoá ngoại và policy RLS, cộng chỉ mục unique từng
 * phần của sổ đăng ký trong kho control plane.
 *
 * Vì sao cần bước này thay vì chỉ trông vào migration: phần delta
 * được gộp thêm vào CUỐI các file migration ĐÃ PHÁT HÀNH (baseline
 * nghiệp vụ và migration control plane đã có), mà `drizzle-kit
 * migrate` chỉ áp các thư mục chưa có tên trong bảng theo dõi nên
 * sẽ bỏ qua lặng lẽ phần gộp thêm trên database đã có. Không có
 * bước ensure, sau merge api phục vụ endpoint mới trong khi các
 * bảng còn thiếu (lỗi 500) và health check vẫn xanh vì nó không
 * chạm các bảng này.
 *
 * Luồng: với mỗi đối tượng trong delta, kiểm tra sự tồn tại trong
 * `pg_catalog` rồi chỉ tạo đúng đối tượng còn thiếu, trong MỘT
 * transaction cho mỗi kho. Database đã áp baseline MỚI (đủ delta)
 * thì bước này là no-op thật (chỉ đọc kiểm tra, báo cáo `created`
 * rỗng). Database đã áp baseline CŨ thì sau bước này có đủ delta
 * đúng định nghĩa của baseline (cùng tên bảng/cột/ràng buộc/index/
 * policy) — baseline vẫn là nguồn sự thật duy nhất cho database
 * mới, bước này chỉ lấp khoảng trống triển khai cho database đã có.
 *
 * Tiền điều kiện: kho nghiệp vụ và kho control plane đều đã áp
 * baseline/migration của chúng (cũ hoặc mới). Bước này KHÔNG thay
 * bộ migration: database trống vẫn phải chạy runner migration của
 * package (`@lms/db/dist/migrate/run.js`) trước (nó tạo mọi bảng
 * kể cả delta).
 *
 * Nối dây: chuỗi migrate của stack (`compose.yaml`, service
 * `migrate`) chạy script này SAU hai lượt migrate của runner
 * (kho nghiệp vụ rồi kho control plane) và TRƯỚC khi api/worker
 * khởi động. Script đọc `DATABASE_URL`
 * (kho nghiệp vụ, bắt buộc) và `CONTROL_PLANE_DATABASE_URL` (kho
 * control plane — vắng thì bỏ qua phần control plane kèm dòng log,
 * theo cùng cách script cấp phát control plane bỏ qua khi chưa cấu
 * hình).
 *
 * Phạm vi: chỉ kho nghiệp vụ CHUNG (`DATABASE_URL`) và kho control
 * plane. Kho riêng của trung tâm tạo SAU bản này nhận đủ delta ngay
 * từ bước migration của pipeline cấp phát; kho riêng tạo trước (nếu
 * có) thuộc phạm vi di trú của issue #587, không thuộc bước này.
 */

import { Client } from 'pg';

import { UUIDV7_SHIM } from './centre-provision';

/** Báo cáo của một kho: đối tượng nào vừa tạo, đối tượng nào đã có sẵn. */
export type CentreDeltaStoreReport = {
  /** Tên các đối tượng bước này vừa tạo (rỗng khi chạy lại = no-op). */
  created: string[];
  /** Tên các đối tượng đã tồn tại trước lượt chạy nên được bỏ qua. */
  alreadyPresent: string[];
};

/** Báo cáo đầy đủ của một lượt ensure: kho nghiệp vụ + kho control plane (`null` khi bỏ qua). */
export type CentreDeltaReport = {
  business: CentreDeltaStoreReport;
  controlPlane: CentreDeltaStoreReport | null;
};

/** Một đối tượng delta: cách kiểm tra sự tồn tại và câu lệnh tạo nó (đã tự phòng trùng). */
type DeltaObject = {
  /** Tên hiển thị trong báo cáo (tên bảng/index/ràng buộc/policy). */
  name: string;
  /** Câu SQL trả về một dòng khi đối tượng đã tồn tại. */
  existsSql: string;
  /** Câu lệnh tạo đối tượng — chỉ chạy khi kiểm tra báo chưa có. */
  createSql: string;
};

/** Điều kiện RLS `tenant_isolation` — đúng nguyên văn policy của baseline. */
const TENANT_ISOLATION_CONDITION =
  `(current_setting('app.platform', true) = 'on' OR "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`;

/** Câu lệnh tạo một policy RLS `tenant_isolation` cho một bảng (phòng trùng bằng khối DO). */
function createPolicySql(table: string): string {
  return `DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = '${table}' AND p.polname = 'tenant_isolation'
  ) THEN CREATE POLICY "tenant_isolation" ON "${table}" USING ${TENANT_ISOLATION_CONDITION} WITH CHECK ${TENANT_ISOLATION_CONDITION}; END IF; END $$;`;
}

/** Câu lệnh tạo một khoá ngoại (phòng trùng bằng khối DO kiểm tra `pg_constraint`). */
function createForeignKeySql(table: string, constraint: string, definition: string): string {
  return `DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = '${table}' AND con.conname = '${constraint}'
  ) THEN ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" ${definition}; END IF; END $$;`;
}

/** Kiểm tra một bảng đã tồn tại trong schema `public` hay chưa. */
function tableExistsSql(table: string): string {
  return `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = '${table}' AND c.relkind = 'r'`;
}

/** Kiểm tra một index đã tồn tại trong schema `public` hay chưa. */
function indexExistsSql(index: string): string {
  return `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = '${index}' AND c.relkind = 'i'`;
}

/** Kiểm tra một policy RLS đã tồn tại trên một bảng hay chưa. */
function policyExistsSql(table: string): string {
  return `SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = '${table}' AND p.polname = 'tenant_isolation'`;
}

/**
 * Danh sách đối tượng delta của kho nghiệp vụ, đúng thứ tự phụ
 * thuộc (bảng → index → khoá ngoại → RLS) và đúng nguyên văn định
 * nghĩa của baseline: tên bảng/cột/ràng buộc/index/policy, giá trị
 * mặc định `uuidv7()`, `ON DELETE` của từng khoá ngoại.
 */
const BUSINESS_DELTA_OBJECTS: DeltaObject[] = [
  {
    name: 'centre_identity',
    existsSql: tableExistsSql('centre_identity'),
    createSql: `CREATE TABLE IF NOT EXISTS "centre_identity" (
      "id" uuid PRIMARY KEY DEFAULT uuidv7(),
      "tenant_id" uuid NOT NULL CONSTRAINT "centre_identity_tenant_unique" UNIQUE,
      "display_name" text NOT NULL,
      "logo_path" text,
      "brand_color" text,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  },
  {
    name: 'centre_invites',
    existsSql: tableExistsSql('centre_invites'),
    createSql: `CREATE TABLE IF NOT EXISTS "centre_invites" (
      "id" uuid PRIMARY KEY DEFAULT uuidv7(),
      "tenant_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "email" text NOT NULL,
      "token_hash" text NOT NULL UNIQUE,
      "expires_at" timestamp with time zone NOT NULL,
      "used_at" timestamp with time zone,
      "revoked_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  },
  {
    name: 'program_package_installs',
    existsSql: tableExistsSql('program_package_installs'),
    createSql: `CREATE TABLE IF NOT EXISTS "program_package_installs" (
      "id" uuid PRIMARY KEY DEFAULT uuidv7(),
      "tenant_id" uuid NOT NULL,
      "package_key" text NOT NULL,
      "version" text NOT NULL,
      "checksum" text NOT NULL,
      "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "program_package_installs_tenant_key_unique" UNIQUE("tenant_id","package_key")
    )`,
  },
  {
    name: 'centre_invites_tenant_id_idx',
    existsSql: indexExistsSql('centre_invites_tenant_id_idx'),
    createSql: `CREATE INDEX IF NOT EXISTS "centre_invites_tenant_id_idx" ON "centre_invites" ("tenant_id")`,
  },
  {
    name: 'centre_invites_user_id_idx',
    existsSql: indexExistsSql('centre_invites_user_id_idx'),
    createSql: `CREATE INDEX IF NOT EXISTS "centre_invites_user_id_idx" ON "centre_invites" ("user_id")`,
  },
  {
    name: 'centre_identity_tenant_id_tenants_id_fkey',
    existsSql: `SELECT 1 FROM pg_constraint WHERE conname = 'centre_identity_tenant_id_tenants_id_fkey'`,
    createSql: createForeignKeySql('centre_identity', 'centre_identity_tenant_id_tenants_id_fkey', `FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT`),
  },
  {
    name: 'centre_invites_tenant_id_tenants_id_fkey',
    existsSql: `SELECT 1 FROM pg_constraint WHERE conname = 'centre_invites_tenant_id_tenants_id_fkey'`,
    createSql: createForeignKeySql('centre_invites', 'centre_invites_tenant_id_tenants_id_fkey', `FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT`),
  },
  {
    name: 'centre_invites_user_id_users_id_fkey',
    existsSql: `SELECT 1 FROM pg_constraint WHERE conname = 'centre_invites_user_id_users_id_fkey'`,
    createSql: createForeignKeySql('centre_invites', 'centre_invites_user_id_users_id_fkey', `FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE`),
  },
  {
    name: 'program_package_installs_tenant_id_tenants_id_fkey',
    existsSql: `SELECT 1 FROM pg_constraint WHERE conname = 'program_package_installs_tenant_id_tenants_id_fkey'`,
    createSql: createForeignKeySql('program_package_installs', 'program_package_installs_tenant_id_tenants_id_fkey', `FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT`),
  },
];

/** Ba bảng của delta — mỗi bảng kèm câu lệnh bật RLS khi policy của nó còn thiếu. */
const BUSINESS_RLS_TABLES = ['centre_identity', 'centre_invites', 'program_package_installs'];

/** Đối tượng delta duy nhất của kho control plane: chỉ mục unique từng phần. */
const CONTROL_PLANE_DELTA_OBJECT: DeltaObject = {
  name: 'space_registry_database_name_dedicated_unique',
  existsSql: indexExistsSql('space_registry_database_name_dedicated_unique'),
  createSql: `CREATE UNIQUE INDEX IF NOT EXISTS "space_registry_database_name_dedicated_unique" ON "space_registry" ("database_name") WHERE "space_registry"."storage_mode" = 'dedicated'`,
};

/**
 * Áp một danh sách đối tượng delta lên một kết nối đang mở, trong
 * một transaction duy nhất: kiểm tra từng đối tượng rồi chỉ tạo
 * đối tượng còn thiếu. Lỗi ở bất kỳ câu nào cũng rollback toàn bộ
 * lượt ensure của kho đó — chạy lại sau đó sẽ tạo nốt phần thiếu.
 *
 * @param client - Kết nối `pg` đang mở tới kho cần ensure.
 * @param objects - Danh sách đối tượng delta theo thứ tự phụ thuộc.
 * @param log - Ghi nhật ký tiến trình (mặc định `console.log`).
 * @returns Báo cáo `created`/`alreadyPresent` của kho.
 */
async function ensureObjects(
  client: Client,
  objects: DeltaObject[],
  log: (message: string) => void,
): Promise<CentreDeltaStoreReport> {
  const report: CentreDeltaStoreReport = { created: [], alreadyPresent: [] };
  await client.query('BEGIN');
  try {
    for (const object of objects) {
      const exists = await client.query(object.existsSql);
      if ((exists.rowCount ?? 0) > 0) {
        report.alreadyPresent.push(object.name);
      } else {
        await client.query(object.createSql);
        report.created.push(object.name);
        log(`[centre-delta] created ${object.name}`);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return report;
}

/**
 * Đảm bảo phần delta schema của issue #583 có mặt trên kho nghiệp
 * vụ và (khi có URL) kho control plane.
 *
 * @param options - URL kết nối kho nghiệp vụ (bắt buộc), URL kho
 *   control plane (tuỳ chọn — vắng thì bỏ qua phần đó), hàm log.
 * @returns Báo cáo đầy đủ; `controlPlane` là `null` khi bỏ qua.
 * @throws Error khi thiếu URL kho nghiệp vụ hoặc khi bất kỳ câu
 *   lệnh ensure nào hỏng (transaction của kho đó đã rollback).
 */
export async function ensureCentreSchemaDelta(options: {
  businessDatabaseUrl: string;
  controlPlaneDatabaseUrl?: string | null;
  log?: (message: string) => void;
}): Promise<CentreDeltaReport> {
  const log = options.log ?? ((message: string) => console.log(message));
  if (!options.businessDatabaseUrl) throw new Error('businessDatabaseUrl is required for centre schema delta ensure');
  const business = new Client({ connectionString: options.businessDatabaseUrl });
  await business.connect();
  try {
    // Baseline dùng `uuidv7()` làm giá trị mặc định nên cụm dưới 18
    // cần shim trước khi tạo bảng — cùng điều kiện và công thức với
    // bước migration của pipeline cấp phát; trên 18 tuyệt đối
    // không áp để khỏi che hàm gốc.
    const versionRow = await business.query('SHOW server_version');
    const major = Number(String(versionRow.rows[0]!.server_version).split('.')[0]);
    if (major < 18) {
      await business.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await business.query(UUIDV7_SHIM);
    }
    const businessReport = await ensureObjects(business, BUSINESS_DELTA_OBJECTS, log);
    // RLS: policy còn thiếu thì bật + ép RLS rồi tạo policy; policy
    // đã có thì bỏ qua toàn bộ (bảng đã ở đúng trạng thái RLS của
    // baseline — bước này chỉ lấp đối tượng thiếu, không sửa đối
    // tượng đã bị sửa tay).
    await business.query('BEGIN');
    try {
      for (const table of BUSINESS_RLS_TABLES) {
        const policy = await business.query(policyExistsSql(table));
        if ((policy.rowCount ?? 0) > 0) {
          businessReport.alreadyPresent.push(`tenant_isolation on ${table}`);
        } else {
          await business.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
          await business.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
          await business.query(createPolicySql(table));
          businessReport.created.push(`tenant_isolation on ${table}`);
          log(`[centre-delta] created tenant_isolation on ${table}`);
        }
      }
      await business.query('COMMIT');
    } catch (error) {
      await business.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    let controlPlane: CentreDeltaStoreReport | null = null;
    if (options.controlPlaneDatabaseUrl) {
      const cp = new Client({ connectionString: options.controlPlaneDatabaseUrl });
      await cp.connect();
      try {
        controlPlane = await ensureObjects(cp, [CONTROL_PLANE_DELTA_OBJECT], log);
      } finally {
        await cp.end().catch(() => undefined);
      }
    } else {
      log('[centre-delta] CONTROL_PLANE_DATABASE_URL is not set — skipping control plane delta.');
    }
    return { business: businessReport, controlPlane };
  } finally {
    await business.end().catch(() => undefined);
  }
}

if (require.main === module) {
  (async (): Promise<void> => {
    const businessDatabaseUrl = process.env.DATABASE_URL;
    if (!businessDatabaseUrl) throw new Error('DATABASE_URL is required for centre schema delta ensure');
    const report = await ensureCentreSchemaDelta({
      businessDatabaseUrl,
      controlPlaneDatabaseUrl: process.env.CONTROL_PLANE_DATABASE_URL ?? null,
    });
    console.log(`CENTRE_SCHEMA_DELTA_ENSURE ${JSON.stringify(report)}`);
  })().catch((error: unknown) => {
    console.error(`centre-schema-delta-ensure failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
