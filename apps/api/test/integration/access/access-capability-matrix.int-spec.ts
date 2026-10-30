import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  STRONG_PASSWORD,
  adminToken,
  assignRole,
  createContextViaApi,
  createRoleViaApi,
  createTestApp,
  createUserViaApi,
  http,
  login,
  setOverride,
  systemContextId,
} from '../../support/identity-access-helpers';

/**
 * Issue #567 (con A của đợt trang Permissions #571): endpoint đọc ma
 * trận quyền mọi vai tại một context `GET /access/capability-matrix`
 * và test ghim ngữ nghĩa Kế thừa của `POST /access/overrides`. Mọi ca
 * lái qua HTTP thật; kết quả của endpoint mới được đối chiếu chéo với
 * đường đọc ma trận từng vai hiện hành và với bảng gốc
 * `role_capabilities` bằng SQL độc lập.
 */
describe('Access: ma trận quyền mọi vai theo context và ngữ nghĩa Kế thừa của đặt một ô (issue #567)', () => {
  let app: INestApplication;
  let pg: Client;
  let admin: string;
  let systemId: string;
  let catalog: { name: string; capType: string }[];

  interface MatrixRole {
    id: string;
    name: string;
    userCount: number;
    overrides: { capability: string; permission: number }[];
  }

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    admin = await adminToken(app);
    systemId = await systemContextId(app, admin);
    const capsRes = await http(app).get('/api/v1/access/capabilities').set('Authorization', `Bearer ${admin}`);
    if (capsRes.status !== 200) throw new Error(`không nạp được danh mục năng lực: HTTP ${capsRes.status}`);
    catalog = capsRes.body as { name: string; capType: string }[];
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  const matrix = (contextId: string, token = admin) => http(app)
    .get('/api/v1/access/capability-matrix')
    .query({ contextId })
    .set('Authorization', `Bearer ${token}`);

  /** Dòng của một vai trong ma trận tại một context (ném lỗi khi vai vắng mặt). */
  async function matrixRole(contextId: string, roleId: string): Promise<MatrixRole> {
    const res = await matrix(contextId);
    expect(res.status).toBe(200);
    expect(res.body.contextId).toBe(contextId);
    const row = (res.body.roles as MatrixRole[]).find((r) => r.id === roleId);
    if (!row) throw new Error(`role ${roleId} vắng mặt trong ma trận`);
    return row;
  }

  /**
   * Tập ghi đè đã lưu của MỘT vai tại MỘT context, đọc qua đường đọc
   * từng vai hiện hành rồi lọc tay theo context — nguồn đối chiếu
   * độc lập với endpoint ma trận mới.
   */
  async function savedOverridesAt(roleId: string, contextId: string): Promise<{ capability: string; permission: number }[]> {
    const res = await http(app).get(`/api/v1/access/roles/${roleId}/capabilities`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    return (res.body as { contextId: string; capability: string; permission: number }[])
      .filter((row) => row.contextId === contextId)
      .map((row) => ({ capability: row.capability, permission: row.permission }))
      .sort((a, b) => a.capability.localeCompare(b.capability));
  }

  it('ma trận tại context hệ thống trả đủ mọi vai và tập ghi đè khớp đường đọc từng vai cho ít nhất hai vai', async () => {
    const [capA, capB] = [...catalog].sort((a, b) => a.name.localeCompare(b.name));
    const roleOne = await createRoleViaApi(app, admin);
    const roleTwo = await createRoleViaApi(app, admin);
    await setOverride(app, admin, roleOne, capA.name, systemId, 1);
    await setOverride(app, admin, roleOne, capB.name, systemId, -1000);
    await setOverride(app, admin, roleTwo, capA.name, systemId, -1);

    const res = await matrix(systemId);
    expect(res.status).toBe(200);
    // Đủ mọi vai: số dòng của ma trận bằng đúng số vai của danh sách vai.
    const rolesRes = await http(app).get('/api/v1/access/roles').set('Authorization', `Bearer ${admin}`);
    expect(rolesRes.status).toBe(200);
    expect((res.body.roles as MatrixRole[]).length).toBe((rolesRes.body as unknown[]).length);

    // Hai vai mẫu: tập ghi đè trong ma trận khớp đúng đường đọc từng
    // vai lọc tay theo context, và khớp giá trị đã đặt.
    expect((await matrixRole(systemId, roleOne)).overrides).toEqual(await savedOverridesAt(roleOne, systemId));
    expect((await matrixRole(systemId, roleTwo)).overrides).toEqual(await savedOverridesAt(roleTwo, systemId));
    expect((await matrixRole(systemId, roleOne)).overrides).toEqual([
      { capability: capA.name, permission: 1 },
      { capability: capB.name, permission: -1000 },
    ]);
    expect((await matrixRole(systemId, roleTwo)).overrides).toEqual([
      { capability: capA.name, permission: -1 },
    ]);
  });

  it('ghi đè của context khác không rò vào ma trận; vai không có ghi đè tại context được hỏi mang tập rỗng và số người giữ phân biệt đúng', async () => {
    const cap = catalog[0].name;
    const roleId = await createRoleViaApi(app, admin);
    const otherContextId = (await createContextViaApi(app, admin, 40, uuidv7(), systemId)).id;
    await setOverride(app, admin, roleId, cap, otherContextId, 1);

    // Tại context hệ thống: vai vẫn xuất hiện nhưng tập ghi đè rỗng —
    // ghi đè duy nhất của vai nằm ở context khác.
    expect((await matrixRole(systemId, roleId)).overrides).toEqual([]);
    // Tại đúng context kia: ghi đè xuất hiện nguyên vẹn.
    expect((await matrixRole(otherContextId, roleId)).overrides).toEqual([
      { capability: cap, permission: 1 },
    ]);

    // Số người giữ đếm PHÂN BIỆT: hai người giữ vai, trong đó một
    // người giữ ở cả hai context — đếm vẫn là 2.
    const userA = await createUserViaApi(app, admin);
    const userB = await createUserViaApi(app, admin);
    await assignRole(app, admin, userA.id, roleId, systemId);
    await assignRole(app, admin, userA.id, roleId, otherContextId);
    await assignRole(app, admin, userB.id, roleId, systemId);
    expect((await matrixRole(systemId, roleId)).userCount).toBe(2);
  });

  it('cổng role:manage chặn người gọi không có năng lực; context không tồn tại trả 404 và contextId sai khuôn trả 400', async () => {
    const plainUser = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, plainUser.username, STRONG_PASSWORD);
    const denied = await matrix(systemId, accessToken);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('access.capability_denied');
    expect(denied.headers['content-type']).toContain('application/problem+json');

    // Context đúng khuôn UUID nhưng không tồn tại: cùng hành vi 404
    // của các đường đọc hiện hành trong module.
    const missing = await matrix(uuidv7());
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('access.context_not_found');

    // contextId sai khuôn UUID bị chặn ở tầng kiểm chứng hợp đồng.
    const malformed = await matrix('khong-phai-uuid');
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('http.validation_failed');
  });

  it('đặt một ô về Kế thừa thì dòng ghi đè biến mất; đặt Kế thừa trên ô chưa có ghi đè không tạo dòng nào', async () => {
    const cap = catalog[0].name;
    const roleId = await createRoleViaApi(app, admin);

    // Đặt Cho phép rồi đặt lại Kế thừa qua chính endpoint đặt một ô:
    // ô trở về kế thừa là dòng ghi đè bị xoá, không phải một dòng 0.
    await setOverride(app, admin, roleId, cap, systemId, 1);
    expect((await matrixRole(systemId, roleId)).overrides).toEqual([
      { capability: cap, permission: 1 },
    ]);
    await setOverride(app, admin, roleId, cap, systemId, 0);
    expect((await matrixRole(systemId, roleId)).overrides).toEqual([]);
    expect(await savedOverridesAt(roleId, systemId)).toEqual([]);
    const afterInherit = await pg.query<{ n: string }>(
      'select count(*) as n from role_capabilities where role_id = $1 and context_id = $2 and capability = $3',
      [roleId, systemId, cap]);
    expect(Number(afterInherit.rows[0].n)).toBe(0);

    // Ô chưa từng có ghi đè: đặt Kế thừa vẫn thành công (helper ném
    // lỗi nếu HTTP khác 2xx) và không sinh dòng nào.
    const freshRoleId = await createRoleViaApi(app, admin);
    await setOverride(app, admin, freshRoleId, cap, systemId, 0);
    expect((await matrixRole(systemId, freshRoleId)).overrides).toEqual([]);
    const freshCount = await pg.query<{ n: string }>(
      'select count(*) as n from role_capabilities where role_id = $1 and context_id = $2',
      [freshRoleId, systemId]);
    expect(Number(freshCount.rows[0].n)).toBe(0);
  });
});
