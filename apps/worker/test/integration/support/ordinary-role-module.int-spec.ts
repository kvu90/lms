import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq, sql } from 'drizzle-orm';
import { classes, cohort, users } from '@lms/db';
import { ORDINARY_ROLE } from '../../support/ordinary-role';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Kiểm chứng harness boot module bằng role thường (lát 2 của issue
 * #294, `test/ordinary-worker-module.ts`).
 *
 * Harness chỉ có giá trị nếu kết nối mà `WorkerModule` nhận qua
 * token Drizzle thật sự là phiên đăng nhập của role thường
 * NOSUPERUSER/NOBYPASSRLS và thật sự chịu RLS như production. Ba ca
 * ở đây khoá đúng ba tính chất đó:
 *
 *   - module nhận đúng kết nối role thường qua ghi đè provider
 *     (không phải kết nối superuser do `DrizzleModule` tự dựng);
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

    await db.execute(sql`insert into tenants (slug, name, kind, status) values (${`harness-294-${suffix}`}, 'Ordinary harness fixture tenant', 'school', 'active') on conflict (slug) do nothing`);
    const tenantRows = (await db.execute(sql`select id from tenants where slug = ${`harness-294-${suffix}`} `)) as unknown as { rows: { id: string }[] };
    const tenantId = tenantRows.rows[0].id;

    const ownerId = '01900000-0000-7000-8000-000000029401';
    await db.insert(users).values({
      id: ownerId, username: `harness-294-owner-${suffix}`, email: `harness-294-owner-${suffix}@example.com`,
    }).onConflictDoNothing();

    const [cohortRow] = await db.insert(cohort).values({
      tenantId, name: `harness-294-cohort-${suffix}`, contextId: ownerId, component: 'class', visible: false,
    }).returning();

    const [classRow] = await db.insert(classes).values({
      tenantId, name: `Lớp harness 294 ${suffix}`, ownerId, cohortId: cohortRow.id, status: 'active',
    }).returning();
    classId = classRow.id;
  });

  afterAll(async () => { await harness.close(); });

  it('module nhận kết nối vai trò thường qua drizzle token', () => {
    expect(harness.context.get(getDrizzleToken())).toBe(harness.ordinaryDb);
  });

  it('phiên module đăng nhập với vai trò thường, không có SUPERUSER hay BYPASSRLS', async () => {
    const sessionRows = (await harness.ordinaryDb.execute(sql`select current_user as current_role`)) as unknown as { rows: { current_role: string }[] };
    expect(sessionRows.rows[0].current_role).toBe(ORDINARY_ROLE);

    const roleRows = (await harness.adminDb.execute(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = ${ORDINARY_ROLE}`,
    )) as unknown as { rows: { rolsuper: boolean; rolbypassrls: boolean }[] };
    const role = roleRows.rows[0];
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });

  it('ngoài ngữ cảnh tenant, kết nối module không thấy lớp tenant nào (RLS fail-closed)', async () => {
    const hidden = await harness.ordinaryDb.select().from(classes).where(eq(classes.id, classId));
    expect(hidden).toHaveLength(0);

    const visible = await harness.adminDb.select().from(classes).where(eq(classes.id, classId));
    expect(visible).toHaveLength(1);
  });
});
