import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@lms/db';
import { SpaceDatabaseService } from '../../../src/db/routing/space-database.service';
import { ORDINARY_ROLE } from '../../support/ordinary-role';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Kiểm chứng harness boot module bằng role thường (lát 2 của issue
 * #294, `test/ordinary-worker-module.ts`).
 *
 * Harness chỉ có giá trị nếu handle kho chung mà `WorkerModule`
 * dùng qua `SpaceDatabaseService` thật sự là phiên đăng nhập của role thường
 * NOSUPERUSER/NOBYPASSRLS và thật sự chịu RLS như production. Ba ca
 * ở đây khoá đúng ba tính chất đó:
 *
 *   - module nhận đúng kết nối role thường qua handle kho chung
 *     mà harness gắn lại (không phải kết nối superuser do module tự dựng);
 *   - phiên làm việc của kết nối đó đăng nhập bằng role thường và
 *     role không có SUPERUSER/BYPASSRLS — nếu ai cấp thêm hai thuộc
 *     tính này cho role, ca này đỏ;
 *   - chiều âm: ngoài ngữ cảnh tenant, kết nối của module KHÔNG
 *     thấy lớp thuộc một tenant mà kết nối quản trị thấy rõ — nếu
 *     harness bị vô hiệu hoá (module quay lại chạy superuser, hoặc
 *     role có BYPASSRLS), ca này đỏ vì RLS không còn che dữ liệu.
 *     Đây là ca "lỗi RLS cố ý" của tiêu chí nghiệm thu lát 2: nó đỏ
 *     đúng khi môi trường role thường bị phá, chứng minh các spec
 *     đã chuyển sang harness không còn bị superuser che khuất.
 *
 * Fixture nạp bằng kết nối quản trị của harness như đường seed
 * production; spec không khẳng định hành vi nghiệp vụ nào của
 * processor — phần đó thuộc các spec đã chuyển sang harness.
 */
describe('Harness của worker: WorkerModule chạy với vai trò DB thường (issue #294)', () => {
  let harness: OrdinaryWorkerModuleHarness;
  const suffix = `${Date.now() % 100000000}`;
  let classId = '';

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    const db = harness.adminDb;

    await sql`insert into tenants (slug, name, kind, status) values (${`harness-294-${suffix}`}, 'Ordinary harness fixture tenant', 'school', 'active') on conflict (slug) do nothing`.execute(db);
    const tenantRows = await sql<{ id: string }>`select id from tenants where slug = ${`harness-294-${suffix}`} `.execute(db);
    const tenantId = tenantRows.rows[0]!.id;

    const ownerId = '01900000-0000-7000-8000-000000029401';
    await db.insertInto('users').values({
      id: ownerId, username: `harness-294-owner-${suffix}`, email: `harness-294-owner-${suffix}@example.com`,
    }).onConflict((oc) => oc.doNothing()).execute();

    const cohortRow = await db.insertInto('cohort').values({
      tenant_id: tenantId, name: `harness-294-cohort-${suffix}`, context_id: ownerId, component: 'class', visible: false,
    }).returningAll().executeTakeFirstOrThrow();

    const classRow = await db.insertInto('classes').values({
      tenant_id: tenantId, name: `Lớp harness 294 ${suffix}`, owner_id: ownerId, cohort_id: cohortRow.id, status: 'active',
    }).returningAll().executeTakeFirstOrThrow();
    classId = classRow.id;
  });

  afterAll(async () => { await harness.close(); });

  it('module nhận kết nối vai trò thường qua handle kho chung của khung định tuyến', async () => {
    const spaceDb = harness.context.get(SpaceDatabaseService);
    expect(spaceDb).toBe(harness.spaceDb);
    const sessionRows = await sql<{ current_role: string }>`select current_user as current_role`.execute(spaceDb.routedKysely);
    expect(sessionRows.rows[0]!.current_role).toBe(ORDINARY_ROLE);
  });

  it('phiên module đăng nhập với vai trò thường, không có SUPERUSER hay BYPASSRLS', async () => {
    const sessionRows = await sql<{ current_role: string }>`select current_user as current_role`.execute(harness.ordinaryDb);
    expect(sessionRows.rows[0]!.current_role).toBe(ORDINARY_ROLE);

    const roleRows = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`select rolsuper, rolbypassrls from pg_roles where rolname = ${ORDINARY_ROLE}`.execute(harness.adminDb);
    const role = roleRows.rows[0]!;
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });

  it('ngoài ngữ cảnh tenant, kết nối module không thấy lớp tenant nào (RLS fail-closed)', async () => {
    const hidden = await harness.ordinaryDb.selectFrom('classes').selectAll().where('id', '=', classId).execute();
    expect(hidden).toHaveLength(0);

    const visible = await harness.adminDb.selectFrom('classes').selectAll().where('id', '=', classId).execute();
    expect(visible).toHaveLength(1);
  });
});
