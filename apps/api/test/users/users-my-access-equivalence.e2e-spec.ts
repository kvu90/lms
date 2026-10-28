import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPABILITY_DEFINITIONS } from '../../src/modules/access/domain/capabilities';
import {
  adminToken, assignRole, createContextViaApi, createRoleViaApi, createTestApp, createUserViaApi,
  hasCapability, http, login, roleIdByShortname, setOverride, STRONG_PASSWORD, systemContextId, uniqueName,
} from '../support/identity-access-helpers';
import { EXPECTED_SNAPSHOTS } from '../support/users-my-access-snapshot.fixture';

/**
 * Tương đương phân giải của ảnh chụp quyền (`GET /users/me/capabilities`)
 * sau khi chuyển sang phân giải THEO LÔ (issue: tăng tốc endpoint này):
 *   1. Chụp đáp ứng: với bộ dữ kiện dựng cố định (cây context khoá/lớp,
 *      override PROHIBIT/PREVENT/ALLOW trên một vai tuỳ chỉnh, các gán
 *      vai mẫu), đáp ứng cho từng vai mẫu phải khớp TỪNG TRƯỜNG với mốc
 *      đã chụp từ cài đặt cũ (đường gọi `hasCapability` tuần tự) — xem
 *      `users-my-access-snapshot.fixture.ts`.
 *   2. Đối chiếu oracle: tại các context nhạy cảm (gồm cây tenant có
 *      cổng membership), tập capability trong ảnh chụp phải bằng đúng
 *      tập suy từ endpoint kiểm tra quyền hiện hành
 *      `GET /access/has-capability` (đường `PermissionEvaluator` gốc)
 *      cho TỪNG capability đã đăng ký.
 *   3. Cổng tenant: người ngoài tenant bị chặn tuyệt đối trong cây
 *      tenant; site admin ở trong cây tenant KHÔNG có lối tắt — chỉ
 *      được phân giải như người thường theo gán vai neo trong tenant.
 */
describe('Users: my-access batch resolution equivalence', () => {
  let app: INestApplication;
  let admin: string;
  let adminId: string;
  const contextLabels = new Map<string, string>();
  const tokens = new Map<string, string>();
  let customRoleShortname = '';

  async function addUser(key: string): Promise<{ id: string; username: string }> {
    const created = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, created.username, STRONG_PASSWORD);
    tokens.set(key, accessToken);
    return created;
  }

  async function snapshotOf(key: string) {
    const res = await http(app).get('/api/v1/users/me/capabilities').set('Authorization', `Bearer ${tokens.get(key)}`);
    expect(res.status).toBe(200);
    return res.body as {
      userId: string; isSiteAdmin: boolean; hasLearnerArtifacts: boolean;
      assignments: { roleShortname: string; contextId: string }[];
      contexts: { contextId: string; contextLevel: number; capabilities: string[] }[];
    };
  }

  function normalize(body: Awaited<ReturnType<typeof snapshotOf>>) {
    return {
      isSiteAdmin: body.isSiteAdmin,
      hasLearnerArtifacts: body.hasLearnerArtifacts,
      assignments: body.assignments
        .map((a) => ({
          role: a.roleShortname === customRoleShortname ? 'customrole' : a.roleShortname,
          context: contextLabels.get(a.contextId) ?? a.contextId,
        }))
        .sort((x, y) => `${x.role}@${x.context}`.localeCompare(`${y.role}@${y.context}`)),
      contexts: body.contexts
        .map((c) => ({ context: contextLabels.get(c.contextId) ?? c.contextId, level: c.contextLevel, capabilities: c.capabilities }))
        .sort((x, y) => x.context.localeCompare(y.context)),
    };
  }

  /** Tập capability theo oracle hiện hành cho một (user, context): gọi has-capability cho TỪNG capability đã đăng ký. */
  async function oracleCapabilities(userId: string, contextId: string): Promise<string[]> {
    const granted: string[] = [];
    for (const def of CAPABILITY_DEFINITIONS) {
      if (await hasCapability(app, admin, userId, def.name, contextId)) granted.push(def.name);
    }
    return granted;
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    adminId = (await login(app, 'admin', 'Admin123!')).userId;
    const systemId = await systemContextId(app, admin);
    contextLabels.set(systemId, 'system');

    const coursecat = await createContextViaApi(app, admin, 40, randomUUID(), systemId);
    contextLabels.set(coursecat.id, 'coursecat');
    const course = await createContextViaApi(app, admin, 50, randomUUID(), coursecat.id);
    contextLabels.set(course.id, 'course');
    const course2 = await createContextViaApi(app, admin, 50, randomUUID(), coursecat.id);
    contextLabels.set(course2.id, 'course2');
    const klass = await createContextViaApi(app, admin, 45, randomUUID(), systemId);
    contextLabels.set(klass.id, 'class');

    const customRole = await createRoleViaApi(app, admin);
    const rolesRes = await http(app).get('/api/v1/access/roles').set('Authorization', `Bearer ${admin}`);
    customRoleShortname = (rolesRes.body as { id: string; shortName: string }[]).find((r) => r.id === customRole)?.shortName ?? '';
    // Bộ override phủ các nhánh ngữ nghĩa: ALLOW tại gốc, PREVENT tại tổ
    // tiên giữa, ALLOW tại lá, PROHIBIT tại lá, ALLOW tại lớp.
    await setOverride(app, admin, customRole, 'question:add', systemId, 1);
    await setOverride(app, admin, customRole, 'question:add', coursecat.id, -1);
    await setOverride(app, admin, customRole, 'question:add', course.id, 1);
    await setOverride(app, admin, customRole, 'site:config', systemId, 1);
    await setOverride(app, admin, customRole, 'site:config', course.id, -1000);
    await setOverride(app, admin, customRole, 'course:view', klass.id, 1);

    const editingteacher = await roleIdByShortname(app, admin, 'editingteacher');
    const teacher = await roleIdByShortname(app, admin, 'teacher');
    const student = await roleIdByShortname(app, admin, 'student');

    const teacherMulti = await addUser('teacherMulti');
    await assignRole(app, admin, teacherMulti.id, editingteacher, course.id);
    await assignRole(app, admin, teacherMulti.id, customRole, course.id);
    await assignRole(app, admin, teacherMulti.id, customRole, klass.id);
    await assignRole(app, admin, teacherMulti.id, teacher, klass.id);

    const teacherOne = await addUser('teacherOne');
    await assignRole(app, admin, teacherOne.id, editingteacher, course2.id);

    const studentPlain = await addUser('studentPlain');
    await assignRole(app, admin, studentPlain.id, student, systemId);

    await addUser('plainUser');

    // --- Dữ kiện cây tenant (cổng membership) dùng vai tuỳ chỉnh chung ---
    const slug = uniqueName('tenant').toLowerCase();
    const tenantRes = await http(app).post('/api/v1/tenants').set('Authorization', `Bearer ${admin}`)
      .send({ slug, name: `Trung tâm ${slug}`, kind: 'center' });
    expect([200, 201]).toContain(tenantRes.status);
    const tenantId = (tenantRes.body as { id: string }).id;
    const contextsRes = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const tenantCtx = (contextsRes.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 20 && c.instanceId === tenantId);
    expect(tenantCtx).toBeDefined();
    contextLabels.set(tenantCtx!.id, 'tenant');
    const tenantCourse = await createContextViaApi(app, admin, 50, randomUUID(), tenantCtx!.id);
    contextLabels.set(tenantCourse.id, 'tenantCourse');

    const member = await addUser('tenantMember');
    await assignRole(app, admin, member.id, customRole, tenantCourse.id);
    await assignRole(app, admin, member.id, customRole, systemId);
    const memberRes = await http(app).post(`/api/v1/tenants/${tenantId}/members`).set('Authorization', `Bearer ${admin}`)
      .send({ userId: member.id });
    expect([200, 201]).toContain(memberRes.status);

    const outsider = await addUser('tenantOutsider');
    await assignRole(app, admin, outsider.id, customRole, tenantCourse.id);

    tokens.set('admin', admin);
    // Site admin nhận một gán vai trong cây tenant nhưng (chưa) có
    // membership — ca kiểm chứng cổng chặn + không lối tắt ở các test dưới.
    await assignRole(app, admin, adminId, customRole, tenantCourse.id);
    (globalThis as Record<string, unknown>).__perfTenant = { tenantId, tenantCourseId: tenantCourse.id, tenantCtxId: tenantCtx!.id, memberId: member.id, outsiderId: outsider.id };
  }, 300000);

  afterAll(async () => { await app.close(); });

  it('reproduces the recorded pre-change snapshots field-for-field for the sample roles', async () => {
    for (const key of ['teacherMulti', 'teacherOne', 'studentPlain', 'plainUser'] as const) {
      const normalized = normalize(await snapshotOf(key));
      expect(normalized, `snapshot mismatch for ${key}`).toEqual(EXPECTED_SNAPSHOTS[key]);
    }
  }, 120000);

  it('matches the legacy has-capability oracle on every capability at the sensitive contexts', async () => {
    const teacherMulti = normalize(await snapshotOf('teacherMulti'));
    const userIds = new Map<string, string>();
    // Lấy userId thật từ chính đáp ứng (snapshotOf không trả userId ra ngoài normalize).
    for (const key of ['teacherMulti', 'studentPlain']) {
      const res = await http(app).get('/api/v1/users/me/capabilities').set('Authorization', `Bearer ${tokens.get(key)}`);
      userIds.set(key, (res.body as { userId: string }).userId);
    }
    const byLabel = new Map(teacherMulti.contexts.map((c) => [c.context, c]));
    const labelToId = new Map([...contextLabels.entries()].map(([id, label]) => [label, id]));
    for (const label of ['course', 'system', 'class', 'coursecat']) {
      const oracle = await oracleCapabilities(userIds.get('teacherMulti')!, labelToId.get(label)!);
      expect(byLabel.get(label)!.capabilities, `oracle mismatch teacherMulti @ ${label}`).toEqual(oracle);
    }
    const student = normalize(await snapshotOf('studentPlain'));
    const studentSystem = student.contexts.find((c) => c.context === 'system')!;
    expect(studentSystem.capabilities).toEqual(await oracleCapabilities(userIds.get('studentPlain')!, labelToId.get('system')!));
  }, 600000);

  it('applies the tenant gate in the snapshot exactly like the legacy path', async () => {
    const t = (globalThis as Record<string, unknown>).__perfTenant as {
      tenantId: string; tenantCourseId: string; tenantCtxId: string; memberId: string; outsiderId: string;
    };
    // Người ngoài tenant: bị chặn tuyệt đối ở cả context tenant lẫn khoá trong tenant.
    const outsider = await snapshotOf('tenantOutsider');
    expect(outsider.contexts.find((c) => c.contextId === t.tenantCourseId)?.capabilities).toEqual([]);
    expect(outsider.contexts.find((c) => c.contextId === t.tenantCtxId)?.capabilities).toEqual([]);

    // Thành viên có gán vai trong tenant: phân giải thật, bằng oracle cho từng capability.
    const member = await snapshotOf('tenantMember');
    const memberCourse = member.contexts.find((c) => c.contextId === t.tenantCourseId)!;
    expect(memberCourse.capabilities).toEqual(await oracleCapabilities(t.memberId, t.tenantCourseId));
    // Tại context hệ thống (ngoài cây tenant), gán vai tại hệ thống có hiệu lực bình thường.
    const memberSystem = member.contexts.find((c) => c.contextLevel === 10)!;
    expect(memberSystem.capabilities).toContain('question:add');

    // Site admin chưa có membership: cổng chặn cả admin trong cây tenant.
    const adminBefore = await snapshotOf('admin');
    expect(adminBefore.contexts.find((c) => c.contextId === t.tenantCourseId)?.capabilities).toEqual([]);
    // Sau khi thành thành viên: vẫn KHÔNG có lối tắt admin — tập
    // capability là phép phân giải thật theo gán vai, hẹp hơn trọn bộ
    // 124 capability và bằng đúng oracle.
    const addRes = await http(app).post(`/api/v1/tenants/${t.tenantId}/members`).set('Authorization', `Bearer ${admin}`)
      .send({ userId: adminId });
    expect([200, 201]).toContain(addRes.status);
    const adminAfter = await snapshotOf('admin');
    const adminCourse = adminAfter.contexts.find((c) => c.contextId === t.tenantCourseId)!;
    expect(adminCourse.capabilities).toEqual(await oracleCapabilities(adminId, t.tenantCourseId));
    expect(adminCourse.capabilities.length).toBeLessThan(CAPABILITY_DEFINITIONS.length);
    expect(adminCourse.capabilities.length).toBeGreaterThan(0);
  }, 600000);
});
