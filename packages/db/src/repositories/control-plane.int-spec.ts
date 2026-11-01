import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlPlaneKysely, type ControlPlaneDb } from '../client';
import {
  spaceRegistry,
  spaceRegistryHistory,
  spaceSchemaMigrationRuns,
  type SpaceRegistrySnapshot,
} from '../control-plane.schema';
import { adoptJournal } from '../migrate/adopt-journal';
import { FrozenSqlProvider, listCarrierNames } from '../migrate/frozen-sql-provider';
import { verifyStore } from '../migrate/verify';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import {
  ControlPlaneRepository,
  DEDICATED_DATABASE_NAME_UNIQUE_INDEX,
  isDedicatedDatabaseNameConflict,
  type NewSpaceRegistration,
} from './control-plane';

/**
 * Spec tích hợp của PILOT Kysely kho control plane (issue #640).
 *
 * Database control plane được dựng từ rỗng bằng chính cầu nối
 * migration của package (carrier đóng băng) trên cụm PostgreSQL
 * thật của môi trường test (biến `LMS_DB_TEST_ADMIN_URL` ghi đè
 * cụm khi cần, mặc định suy từ `DATABASE_URL` của package). Mọi ca
 * chạy qua repository production ở `control-plane.ts` — không mô
 * phỏng handle.
 *
 * Ngoài đối chiếu hành vi của repository, spec này là nơi CHỐT bốn
 * thử nghiệm được phân bổ cho pilot (kết quả văn bản ghi trong
 * playbook ở `AGENTS.md` của package):
 * - T-4: ngữ nghĩa `undefined` trong values/set/where của Kysely
 *   (đo cả SQL biên dịch lẫn kết quả chạy thật).
 * - T-7 (phần control plane): contract hai ORM trên cùng database —
 *   cùng một dòng đọc qua Drizzle và qua Kysely cho kiểu runtime
 *   từng cột đại diện (jsonb snapshot, timestamptz, uuid, text).
 * - T-10: hình dạng lỗi `pg` hai ORM đặt cạnh nhau cho ca trùng
 *   `database_name` dedicated và ca trùng slug.
 * - U5: insert không truyền id nhận id khớp regex UUIDv7 qua
 *   `returning`; insert có id tường minh giữ nguyên id.
 * Và đo T-1 (registry ~20 instance) + kiểm chứng cầu nối trên kho
 * control plane ở cả hai đường (từ rỗng / đã nhận nuôi no-op).
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : 'postgres://postgres:postgres@localhost:5432/postgres');

const CP_DB = 'lms_db_pilot640_cp';
const T1_DB = 'lms_db_pilot640_t1';

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR_ID = '01a19887-6b35-7760-8e64-a5960bfd0875';

let cpUrl = '';
let pool: Pool;
let db: ControlPlaneDb;
let repo: ControlPlaneRepository;
let drizzleDb: NodePgDatabase;

/** Dữ kiện đăng ký mẫu; slug truyền vào để các ca không giẫm nhau. */
function registration(slug: string, patch: Partial<NewSpaceRegistration> = {}): NewSpaceRegistration {
  return {
    slug,
    name: `Trung tâm ${slug}`,
    kind: 'center',
    status: 'active',
    databaseName: `db_${slug.replaceAll('-', '_')}`,
    storageMode: 'dedicated',
    connectionRoleRef: `role_${slug.replaceAll('-', '_')}`,
    secretRef: `env:SPACE_${slug.toUpperCase().replaceAll('-', '_')}_URL`,
    schemaVersion: 'v1',
    plan: null,
    ...patch,
  };
}

/** Ảnh chụp sổ đăng ký theo đúng hình dạng service ghi vào lịch sử. */
function snapshotOf(row: { id: string; slug: string; name: string; kind: string; status: string; databaseName: string; storageMode: string; connectionRoleRef: string; secretRef: string | null; schemaVersion: string | null; plan: string | null }): SpaceRegistrySnapshot {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    status: row.status,
    databaseName: row.databaseName,
    storageMode: row.storageMode,
    connectionRoleRef: row.connectionRoleRef,
    secretRef: row.secretRef,
    schemaVersion: row.schemaVersion,
    plan: row.plan,
  };
}

beforeAll(async () => {
  cpUrl = await buildTestDatabase({ adminUrl, database: CP_DB, store: 'control-plane' });
  pool = new Pool({ connectionString: cpUrl });
  db = createControlPlaneKysely(pool);
  repo = new ControlPlaneRepository(db);
  drizzleDb = drizzle({ client: pool });
}, 300_000);

afterAll(async () => {
  await db.destroy().catch(() => undefined);
  await dropTestDatabase(adminUrl, CP_DB).catch(() => undefined);
  await dropTestDatabase(adminUrl, T1_DB).catch(() => undefined);
});

describe('repository control plane trên Kysely — đối chiếu hành vi', () => {
  it('U5: insert không truyền id nhận id khớp regex UUIDv7 qua returning; insert có id tường minh giữ nguyên id', async () => {
    const created = await repo.insertSpaceIfAbsent(registration('pilot-u5'));
    expect(created).toBeDefined();
    expect(created!.id).toMatch(UUIDV7_PATTERN);
    expect(created!.slug).toBe('pilot-u5');
    expect(created!.databaseName).toBe('db_pilot_u5');
    expect(created!.createdAt).toBeInstanceOf(Date);

    const explicitId = '01a19887-0000-7000-8000-0000000000aa';
    const withId = await repo.insertSpaceIfAbsent(registration('pilot-u5-explicit', { id: explicitId }));
    expect(withId!.id).toBe(explicitId);
  });

  it('insertSpaceIfAbsent trả undefined khi slug đã có, kể cả bên trong transaction, và transaction vẫn commit được việc còn lại', async () => {
    await repo.insertSpaceIfAbsent(registration('pilot-dup'));
    expect(await repo.insertSpaceIfAbsent(registration('pilot-dup'))).toBeUndefined();

    const anchor = await repo.insertSpaceIfAbsent(registration('pilot-dup-anchor'));
    const outcome = await repo.transaction(async (tx) => {
      const again = await repo.insertSpaceIfAbsent(registration('pilot-dup'), tx);
      await repo.insertHistory(
        { spaceId: anchor!.id, actorId: ACTOR_ID, action: 'create', before: null, after: snapshotOf(anchor!) },
        tx,
      );
      return again;
    });
    expect(outcome).toBeUndefined();
    const history = await repo.listHistory(anchor!.id);
    expect(history).toHaveLength(1);
  });

  it('tra cứu theo slug, id, tên database và tra cứu loại trừ dòng đang sửa cho kết quả đúng', async () => {
    const a = await repo.insertSpaceIfAbsent(registration('pilot-find-a'));
    const b = await repo.insertSpaceIfAbsent(registration('pilot-find-b'));
    expect((await repo.findSpaceById(a!.id))!.slug).toBe('pilot-find-a');
    expect((await repo.findSpaceBySlug('pilot-find-b'))!.id).toBe(b!.id);
    expect((await repo.findSpaceByDatabaseName('db_pilot_find_a'))!.id).toBe(a!.id);
    // Loại trừ trong truy vấn: hỏi tên của A mà loại trừ B thì thấy A;
    // loại trừ chính A thì không thấy dòng nào khác mang tên đó.
    expect((await repo.findOtherSpaceByDatabaseName('db_pilot_find_a', b!.id))!.id).toBe(a!.id);
    expect(await repo.findOtherSpaceByDatabaseName('db_pilot_find_a', a!.id)).toBeUndefined();
    expect(await repo.findSpaceBySlug('khong-ton-tai')).toBeUndefined();

    const slugs = (await repo.listSpaces()).map((row) => row.slug);
    expect(slugs).toEqual([...slugs].sort());
    expect(slugs).toContain('pilot-find-a');
  });

  it('updateSpace chỉ đổi trường có mặt trong patch; trường vắng mặt giữ nguyên giá trị, updatedAt được làm mới', async () => {
    const created = await repo.insertSpaceIfAbsent(registration('pilot-update', { plan: 'basic' }));
    const updated = await repo.updateSpace(created!.id, { name: 'Tên mới' });
    expect(updated.name).toBe('Tên mới');
    expect(updated.plan).toBe('basic');
    expect(updated.status).toBe('active');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created!.updatedAt.getTime());
    // Patch mang undefined tường minh (kiểu Partial cho phép) cũng bị
    // loại như trường vắng mặt — không được ghi thành NULL (T-4).
    const after = await repo.updateSpace(created!.id, { plan: undefined, status: undefined });
    expect(after.plan).toBe('basic');
    expect(after.status).toBe('active');
  });

  it('transaction nguyên tử: đăng ký + lịch sử cùng commit; lỗi giữa transaction thì cả hai cùng rollback', async () => {
    const committed = await repo.transaction(async (tx) => {
      const row = await repo.insertSpaceIfAbsent(registration('pilot-tx-ok'), tx);
      await repo.insertHistory(
        { spaceId: row!.id, actorId: ACTOR_ID, action: 'create', before: null, after: snapshotOf(row!) },
        tx,
      );
      return row!;
    });
    expect(await repo.findSpaceBySlug('pilot-tx-ok')).toBeDefined();
    expect(await repo.listHistory(committed.id)).toHaveLength(1);

    await expect(
      repo.transaction(async (tx) => {
        const row = await repo.insertSpaceIfAbsent(registration('pilot-tx-fail'), tx);
        await repo.insertHistory(
          { spaceId: row!.id, actorId: ACTOR_ID, action: 'create', before: null, after: snapshotOf(row!) },
          tx,
        );
        throw new Error('cố ý hỏng giữa transaction');
      }),
    ).rejects.toThrow('cố ý hỏng giữa transaction');
    expect(await repo.findSpaceBySlug('pilot-tx-fail')).toBeUndefined();
    const orphan = await db
      .selectFrom('space_registry_history')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirst();
    // Chỉ đúng một dòng lịch sử của ca commit ở trên trong toàn DB
    // tính tới thời điểm này của ca nguyên tử (các ca trước ghi vào
    // pilot-dup-anchor 1 dòng → tổng kỳ vọng là 2).
    expect(Number(orphan!.n)).toBe(2);
  });

  it('findSpaceByIdForUpdate giữ ngữ nghĩa khoá hàng: transaction thứ hai đọc kèm khoá cùng dòng bị chặn cho tới khi transaction đầu đóng', async () => {
    const created = await repo.insertSpaceIfAbsent(registration('pilot-lock'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockedSignal = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const first = repo.transaction(async (tx) => {
      const row = await repo.findSpaceByIdForUpdate(created!.id, tx);
      expect(row!.id).toBe(created!.id);
      locked();
      await gate;
    });
    await lockedSignal;

    const secondDb = createControlPlaneKysely(new Pool({ connectionString: cpUrl, max: 2 }));
    const secondRepo = new ControlPlaneRepository(secondDb);
    await expect(
      secondRepo.transaction(async (tx) => {
        await sql`SET LOCAL lock_timeout = '400ms'`.execute(tx);
        return secondRepo.findSpaceByIdForUpdate(created!.id, tx);
      }),
    ).rejects.toMatchObject({ code: '55P03' });
    await secondDb.destroy();
    release();
    await first;
    // Sau khi transaction đầu đóng, đọc kèm khoá chạy bình thường.
    const reread = await repo.transaction((tx) => repo.findSpaceByIdForUpdate(created!.id, tx));
    expect(reread!.slug).toBe('pilot-lock');
  });

  it('snapshot JSON ghi qua repository khớp từng byte ở tầng lưu trữ và đọc lại nguyên vẹn', async () => {
    const created = await repo.insertSpaceIfAbsent(registration('pilot-json'));
    const snapshot = snapshotOf(created!);
    const history = await repo.insertHistory({
      spaceId: created!.id,
      actorId: ACTOR_ID,
      action: 'create',
      before: null,
      after: snapshot,
    });
    expect(history.id).toMatch(UUIDV7_PATTERN);
    expect(history.after).toEqual(snapshot);
    expect(history.before).toBeNull();

    const [listed] = await repo.listHistory(created!.id);
    expect(listed!.after).toEqual(snapshot);
    // Khớp từng byte ở tầng lưu trữ: văn bản jsonb đã lưu của dòng
    // ghi qua Kysely phải bằng văn bản của dòng ghi qua Drizzle với
    // cùng một snapshot (xem thêm ca hai ORM ở mục T-7).
    const raw = await db
      .selectFrom('space_registry_history')
      .select(sql<string>`after::text`.as('stored'))
      .where('id', '=', history.id)
      .executeTakeFirst();
    expect(JSON.parse(raw!.stored)).toEqual(snapshot);
  });

  it('registry phiên bản schema: upsert tạo mới rồi ghi đè đúng một dòng; ensure không ghi đè dòng đã có', async () => {
    const space = await repo.insertSpaceIfAbsent(registration('pilot-schema'));
    const first = await repo.upsertSchemaRegistry({
      spaceId: space!.id,
      currentVersion: 'v1',
      lastBackupStatus: null,
      lastBackupAt: null,
      lastRestoreStatus: null,
      lastRestoreAt: null,
    });
    expect(first.currentVersion).toBe('v1');

    const backupAt = new Date('2026-11-01T10:00:00.000Z');
    const second = await repo.upsertSchemaRegistry({
      spaceId: space!.id,
      currentVersion: 'v2',
      lastBackupStatus: 'ok',
      lastBackupAt: backupAt,
      lastRestoreStatus: null,
      lastRestoreAt: null,
    });
    expect(second.currentVersion).toBe('v2');
    expect(second.lastBackupStatus).toBe('ok');
    expect(second.lastBackupAt).toBeInstanceOf(Date);
    expect(second.lastBackupAt!.toISOString()).toBe(backupAt.toISOString());

    await repo.ensureSchemaRegistry(space!.id, 'v-khong-duoc-ghi-de');
    expect((await repo.findSchemaRegistry(space!.id))!.currentVersion).toBe('v2');

    const fresh = await repo.insertSpaceIfAbsent(registration('pilot-schema-ensure'));
    await repo.ensureSchemaRegistry(fresh!.id, 'v1');
    expect((await repo.findSchemaRegistry(fresh!.id))!.currentVersion).toBe('v1');
  });

  it('nhật ký migration: ghi lượt chạy có steps jsonb và đọc lại theo thứ tự thời gian, steps nguyên vẹn', async () => {
    const space = await repo.insertSpaceIfAbsent(registration('pilot-runs'));
    const steps = [
      { name: 'baseline', status: 'success' },
      { name: 'verify', status: 'success', detail: 'đủ 6 bảng' },
    ];
    const run = await repo.insertMigrationRun({
      spaceId: space!.id,
      runId: 'run-640-1',
      fromVersion: null,
      toVersion: 'v1',
      status: 'success',
      steps,
      finishedAt: new Date('2026-11-01T10:05:00.000Z'),
    });
    expect(run.id).toMatch(UUIDV7_PATTERN);
    expect(run.steps).toEqual(steps);
    const runs = await repo.listMigrationRuns(space!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe('run-640-1');
    expect(runs[0]!.finishedAt).toBeInstanceOf(Date);
  });

  it('thư mục thành viên: upsert theo cặp (tài khoản, không gian) hội tụ một dòng; đổi trạng thái trả đúng số dòng', async () => {
    const userId = '01a19887-1111-7000-8000-000000000001';
    const created = await repo.upsertMembershipDirectory({
      globalUserId: userId,
      spaceSlug: 'pilot-dir',
      spaceUserId: '01a19887-2222-7000-8000-000000000002',
      status: 'active',
    });
    expect(created.id).toMatch(UUIDV7_PATTERN);
    const overwritten = await repo.upsertMembershipDirectory({
      globalUserId: userId,
      spaceSlug: 'pilot-dir',
      spaceUserId: '01a19887-3333-7000-8000-000000000003',
      status: 'suspended',
    });
    expect(overwritten.id).toBe(created.id);
    expect(overwritten.spaceUserId).toBe('01a19887-3333-7000-8000-000000000003');
    expect(overwritten.status).toBe('suspended');

    expect(await repo.updateMembershipDirectoryStatus(userId, 'pilot-dir', 'ended')).toBe(1);
    expect(await repo.updateMembershipDirectoryStatus(userId, 'khong-co', 'ended')).toBe(0);

    // Khớp cả hai chiều định danh; khớp cả hai cùng lúc vẫn một dòng.
    const byGlobal = await repo.listMembershipDirectoryForUser(userId);
    expect(byGlobal).toHaveLength(1);
    const bySpace = await repo.listMembershipDirectoryForUser('01a19887-3333-7000-8000-000000000003');
    expect(bySpace).toHaveLength(1);
    expect(bySpace[0]!.id).toBe(created.id);
  });

  it('thư mục mã tham gia: claim phân biệt claimed/already/conflict đúng ba nhánh', async () => {
    expect(await repo.claimJoinCodeDirectory('CODE640A', 'pilot-dir')).toBe('claimed');
    expect(await repo.claimJoinCodeDirectory('CODE640A', 'pilot-dir')).toBe('already');
    expect(await repo.claimJoinCodeDirectory('CODE640A', 'space-khac')).toBe('conflict');
    expect((await repo.findJoinCodeDirectory('CODE640A'))!.spaceSlug).toBe('pilot-dir');
    expect((await repo.listJoinCodeDirectoryForSpace('pilot-dir')).map((row) => row.joinCode)).toEqual(['CODE640A']);
    await repo.deleteJoinCodeDirectory('CODE640A');
    expect(await repo.findJoinCodeDirectory('CODE640A')).toBeUndefined();
  });
});

describe('T-4 — ngữ nghĩa undefined trong values/set/where của Kysely (đo trên kho control plane)', () => {
  it('values mang undefined: cột bị loại khỏi câu insert biên dịch và dòng ghi nhận giá trị mặc định của database', async () => {
    const query = db
      .insertInto('space_registry')
      .values({
        slug: 't4-values',
        name: 'T4',
        kind: 'center',
        database_name: 'db_t4_values',
        storage_mode: 'dedicated',
        connection_role_ref: 'role_t4',
        status: undefined,
        secret_ref: undefined,
      })
      .returningAll();
    const compiled = query.compile();
    expect(compiled.sql).not.toContain('"status"');
    expect(compiled.sql).not.toContain('"secret_ref"');
    expect(compiled.parameters).not.toContain(undefined);
    const [row] = await query.execute();
    // status nhận default 'provisioning' của database — bằng chứng
    // cột bị bỏ qua chứ không bị ghi NULL hay chuỗi 'undefined'.
    expect(row!.status).toBe('provisioning');
    expect(row!.secret_ref).toBeNull();
  });

  it('set mang undefined: cột bị loại khỏi mệnh đề SET biên dịch, giá trị cũ giữ nguyên', async () => {
    const compiled = db
      .updateTable('space_registry')
      .set({ name: undefined, plan: 't4-plan' })
      .where('slug', '=', 't4-values')
      .returningAll()
      .compile();
    expect(compiled.sql).not.toContain('"name"');
    expect(compiled.parameters).not.toContain(undefined);
    const [row] = await db
      .updateTable('space_registry')
      .set({ name: undefined, plan: 't4-plan' })
      .where('slug', '=', 't4-values')
      .returningAll()
      .execute();
    expect(row!.name).toBe('T4');
    expect(row!.plan).toBe('t4-plan');
  });

  it('where mang undefined: biên dịch thành placeholder giữ tham số undefined (driver gắn NULL khi chạy) và cho 0 dòng — đường nguy hiểm phải cấm ở tầng repository', async () => {
    const query = db.selectFrom('space_registry').selectAll().where('slug', '=', undefined as unknown as string);
    const compiled = query.compile();
    expect(compiled.sql).toContain('"slug" = $1');
    expect(compiled.parameters).toEqual([undefined]);
    const rows = await query.execute();
    expect(rows).toHaveLength(0);
  });
});

describe('T-7 (phần control plane) + T-10 — contract hai ORM trên cùng database', () => {
  it('T-7: cùng một dòng đọc qua Drizzle và qua Kysely cho kiểu runtime và giá trị khớp nhau từng cột đại diện', async () => {
    const [drizzleRow] = await drizzleDb
      .insert(spaceRegistry)
      .values({
        slug: 't7-space',
        name: 'T7',
        kind: 'center',
        status: 'active',
        databaseName: 'db_t7',
        storageMode: 'dedicated',
        connectionRoleRef: 'role_t7',
        secretRef: 'env:T7_URL',
        schemaVersion: 'v1',
        plan: null,
      })
      .returning();
    const kyselyRow = await repo.findSpaceBySlug('t7-space');
    expect(kyselyRow).toBeDefined();
    expect(kyselyRow!.id).toBe(drizzleRow!.id);
    expect(typeof kyselyRow!.id).toBe('string');
    expect(kyselyRow!.createdAt).toBeInstanceOf(Date);
    expect(drizzleRow!.createdAt).toBeInstanceOf(Date);
    expect(kyselyRow!.createdAt.toISOString()).toBe(drizzleRow!.createdAt.toISOString());
    expect(kyselyRow!.plan).toBeNull();
    expect(kyselyRow!.secretRef).toBe('env:T7_URL');

    // jsonb snapshot: ghi qua Drizzle, đọc qua repository và ngược lại.
    const snapshot = snapshotOf(drizzleRow!);
    const [drizzleHistory] = await drizzleDb
      .insert(spaceRegistryHistory)
      .values({ spaceId: drizzleRow!.id, actorId: ACTOR_ID, action: 'create', before: null, after: snapshot })
      .returning();
    const viaRepo = await repo.listHistory(drizzleRow!.id);
    expect(viaRepo).toHaveLength(1);
    expect(viaRepo[0]!.after).toEqual(snapshot);
    expect(viaRepo[0]!.before).toBeNull();
    expect(viaRepo[0]!.createdAt).toBeInstanceOf(Date);
    expect(drizzleHistory!.after).toEqual(snapshot);

    const viaRepoWrite = await repo.insertHistory({
      spaceId: drizzleRow!.id,
      actorId: ACTOR_ID,
      action: 'update',
      before: snapshot,
      after: snapshot,
    });
    const [drizzleReadBack] = await drizzleDb
      .select()
      .from(spaceRegistryHistory)
      .where(eq(spaceRegistryHistory.id, viaRepoWrite.id));
    expect(drizzleReadBack!.before).toEqual(snapshot);
    expect(drizzleReadBack!.after).toEqual(snapshot);

    // Khớp từng byte ở tầng lưu trữ: cùng một snapshot ghi qua hai
    // ORM cho văn bản jsonb đã lưu giống hệt nhau.
    const storedTexts = await db
      .selectFrom('space_registry_history')
      .select(sql<string>`after::text`.as('stored'))
      .where('space_id', '=', drizzleRow!.id)
      .execute();
    expect(storedTexts).toHaveLength(2);
    expect(storedTexts[0]!.stored).toBe(storedTexts[1]!.stored);

    // steps jsonb (mảng) qua đường repository, đọc lại bằng Drizzle.
    const run = await repo.insertMigrationRun({
      spaceId: drizzleRow!.id,
      runId: 't7-run',
      fromVersion: null,
      toVersion: 'v1',
      status: 'success',
      steps: [{ name: 'baseline', status: 'success' }],
    });
    const [drizzleRun] = await drizzleDb
      .select()
      .from(spaceSchemaMigrationRuns)
      .where(eq(spaceSchemaMigrationRuns.id, run.id));
    expect(drizzleRun!.steps).toEqual([{ name: 'baseline', status: 'success' }]);
    expect(drizzleRun!.startedAt).toBeInstanceOf(Date);
    expect(run.startedAt).toBeInstanceOf(Date);
  });

  it('T-7: kho control plane không có cột int8 nào — quyết định setTypeParser toàn cục không có bề mặt trên kho này', async () => {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name IN ('space_registry','space_registry_history','space_schema_registry','space_schema_migration_runs','space_membership_directory','space_join_code_directory')
         AND data_type = 'bigint'`,
    );
    expect(result.rows[0]!.n).toBe(0);
  });

  it('T-10: ca trùng database_name dedicated — Kysely ném lỗi pg trực tiếp, Drizzle bọc qua cause, cả hai đều được nhận diện', async () => {
    await repo.insertSpaceIfAbsent(registration('t10-first'));
    // Qua Kysely (insert thẳng, không onConflict): lỗi pg nguyên bản.
    let kyselyError: unknown;
    try {
      await db
        .insertInto('space_registry')
        .values({
          slug: 't10-second',
          name: 'T10',
          kind: 'center',
          status: 'active',
          database_name: 'db_t10_first',
          storage_mode: 'dedicated',
          connection_role_ref: 'role_t10',
        })
        .execute();
    } catch (err) {
      kyselyError = err;
    }
    expect(kyselyError).toBeDefined();
    const ke = kyselyError as { code?: unknown; constraint?: unknown; cause?: unknown };
    expect(ke.code).toBe('23505');
    expect(ke.constraint).toBe(DEDICATED_DATABASE_NAME_UNIQUE_INDEX);
    expect(ke.cause).toBeUndefined();
    expect(isDedicatedDatabaseNameConflict(kyselyError)).toBe(true);

    // Qua Drizzle: lớp lỗi truy vấn không mang code/constraint ở
    // ngoài; lỗi pg gốc nằm ở cause.
    let drizzleError: unknown;
    try {
      await drizzleDb.insert(spaceRegistry).values({
        slug: 't10-third',
        name: 'T10',
        kind: 'center',
        status: 'active',
        databaseName: 'db_t10_first',
        storageMode: 'dedicated',
        connectionRoleRef: 'role_t10',
      });
    } catch (err) {
      drizzleError = err;
    }
    expect(drizzleError).toBeDefined();
    const de = drizzleError as { code?: unknown; cause?: { code?: unknown; constraint?: unknown } };
    expect(de.code).toBeUndefined();
    expect(de.cause?.code).toBe('23505');
    expect(de.cause?.constraint).toBe(DEDICATED_DATABASE_NAME_UNIQUE_INDEX);
    expect(isDedicatedDatabaseNameConflict(drizzleError)).toBe(true);

    // Đường repository (insert có onConflict theo slug): va chạm
    // database_name vẫn ném và được nhận diện — đây là ca service
    // ánh xạ thành 409.
    let repoError: unknown;
    try {
      await repo.insertSpaceIfAbsent(registration('t10-fourth', { databaseName: 'db_t10_first' }));
    } catch (err) {
      repoError = err;
    }
    expect(isDedicatedDatabaseNameConflict(repoError)).toBe(true);
  });

  it('T-10: ca trùng slug — lỗi 23505 với constraint của slug, helper trả false để không bị nuốt thành trùng database_name', async () => {
    let slugError: unknown;
    try {
      await db
        .insertInto('space_registry')
        .values({
          slug: 't10-first',
          name: 'T10 slug',
          kind: 'center',
          status: 'active',
          database_name: 'db_t10_slug_khac',
          storage_mode: 'dedicated',
          connection_role_ref: 'role_t10',
        })
        .execute();
    } catch (err) {
      slugError = err;
    }
    const se = slugError as { code?: unknown; constraint?: unknown };
    expect(se.code).toBe('23505');
    expect(se.constraint).toBe('space_registry_slug_key');
    expect(isDedicatedDatabaseNameConflict(slugError)).toBe(false);
  });
});

describe('cầu nối migration trên kho control plane — hai đường', () => {
  it('đường từ rỗng: database dựng bằng cầu nối có đủ 6 bảng, 2 dòng nhật ký và hậu kiểm của package đạt', async () => {
    const counts = await verifyStore(db, 'control-plane');
    expect(counts.tables).toBe(6);
    expect(counts.journalRows).toBe(2);
  });

  it('đường đã nhận nuôi: cấy nhật ký trả already-adopted và migrateToLatest là no-op, dữ kiện còn nguyên', async () => {
    const carrierNames = listCarrierNames(join(process.cwd(), 'migrations', 'control-plane'));
    expect(carrierNames).toHaveLength(2);
    const outcome = await adoptJournal(db, carrierNames);
    expect(outcome).toBe('already-adopted');
    const migrator = new Migrator({ db, provider: new FrozenSqlProvider(join(process.cwd(), 'migrations', 'control-plane')) });
    const { error, results } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
    expect(results ?? []).toHaveLength(0);
    expect(await repo.findSpaceBySlug('pilot-u5')).toBeDefined();
  });
});

describe('T-1 — registry nhiều instance trên cụm thật (20 slug mô phỏng)', () => {
  it('tổng connection theo pool size, độ trễ tạo instance đầu, và destroy chờ truy vấn đang chạy', async () => {
    const t1Url = await buildTestDatabase({ adminUrl, database: T1_DB, store: 'control-plane' });
    const counter = new Client({ connectionString: adminUrl });
    await counter.connect();
    const countConnections = async (): Promise<number> => {
      const result = await counter.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
        [T1_DB],
      );
      return result.rows[0]!.n;
    };
    const baseline = await countConnections();

    const instances: ControlPlaneDb[] = [];
    const pools: Pool[] = [];
    const startedAt = performance.now();
    for (let i = 0; i < 20; i += 1) {
      const p = new Pool({ connectionString: t1Url, max: 2 });
      pools.push(p);
      instances.push(createControlPlaneKysely(p));
    }
    // Truy vấn đầu của instance đầu tiên: độ trễ tạo instance + mở
    // connection + chạy truy vấn được đo trọn ở đây.
    await sql`SELECT 1`.execute(instances[0]!);
    const firstLatencyMs = performance.now() - startedAt;
    for (const instance of instances.slice(1)) {
      await sql`SELECT 1`.execute(instance);
    }
    const during = await countConnections();
    // Mỗi pool đã chạy truy vấn giữ ít nhất 1 connection; tổng không
    // vượt tổng trần 20 pool × max 2 (+ connection của chính ca đo
    // không thuộc database này).
    expect(during - baseline).toBeGreaterThanOrEqual(20);
    expect(during - baseline).toBeLessThanOrEqual(40);
    expect(firstLatencyMs).toBeLessThan(5_000);
    console.log(`T-1: pool max=2 ×20 instance → connections đang giữ = ${during - baseline}, độ trễ instance đầu + truy vấn đầu = ${firstLatencyMs.toFixed(1)}ms`);

    // destroy() chờ truy vấn đang chạy xong thay vì cắt ngang.
    const slow = sql`SELECT pg_sleep(2)`.execute(instances[0]!);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const destroyStartedAt = performance.now();
    await instances[0]!.destroy();
    const destroyElapsedMs = performance.now() - destroyStartedAt;
    await slow;
    expect(destroyElapsedMs).toBeGreaterThanOrEqual(1_500);
    console.log(`T-1: destroy() với pg_sleep(2) đang chạy hoàn tất sau ${destroyElapsedMs.toFixed(0)}ms`);

    for (const instance of instances.slice(1)) {
      await instance.destroy();
    }
    await counter.end();
  }, 120_000);
});
