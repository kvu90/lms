import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  adminToken, assignRole, createContextViaApi, createRoleViaApi, createTestApp, createUserViaApi, http, login, systemContextId, uniqueName,
} from '../../support/identity-access-helpers';
import { UsersRepository } from '../../../src/modules/users/users.repository';

/**
 * Issue #568 (con C-backend của đợt #571): endpoint đọc gộp
 * `GET /access/users-with-assignments` cho bảng người dùng của trang vai
 * trò — phân trang theo NGƯỜI DÙNG (không theo dòng gán), `total` đếm
 * người dùng khớp lọc, ba bộ lọc tìm kiếm + vai trò + trạng thái áp đồng
 * thời phía server, và mảng gán của mỗi người mang tên vai, số cấp
 * context cùng `component` để nhận biết gán do ghi danh. Các endpoint
 * hiện hành không dựng được bảng này: `GET /users` không trả dữ kiện
 * vai và không lọc theo vai, còn `GET /access/assignments` phân trang
 * theo dòng gán và không mang cờ trạng thái người dùng. Mọi ca lái qua
 * HTTP thật; cờ trạng thái đặt thẳng qua repository và dòng gán ghi
 * danh chèn thẳng qua SQL để kết quả tất định; mỗi ca tự cô lập bằng
 * tiền tố duy nhất truyền qua `search`.
 */
describe('Access: danh sách người dùng kèm gán vai cho trang vai trò (issue #568)', () => {
  let app: INestApplication;
  let pg: Client;
  let admin: string;
  let systemId: string;
  let usersRepo: UsersRepository;

  const list = (query: Record<string, string | number>) =>
    http(app).get('/api/v1/access/users-with-assignments').query(query).set('Authorization', `Bearer ${admin}`);

  type ListedUser = {
    id: string; username: string; firstName: string; lastName: string; email: string;
    suspended: boolean; deleted: boolean; createdAt: string;
    assignments: { id: string; roleId: string; roleName: string; contextId: string; contextLevel: number; component: string }[];
  };
  const usersOf = (body: unknown) => (body as { users: ListedUser[] }).users;

  async function roleNameById(roleId: string): Promise<string> {
    const res = await http(app).get('/api/v1/access/roles').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    const row = (res.body as { id: string; name: string }[]).find((r) => r.id === roleId);
    if (!row) throw new Error(`role ${roleId} vắng mặt trong danh sách vai`);
    return row.name;
  }

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    admin = await adminToken(app);
    systemId = await systemContextId(app, admin);
    usersRepo = app.get(UsersRepository);
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('phân trang theo người dùng: pageSize 10 trả đúng 10 người, total đếm người dùng khớp lọc và hai trang không trùng nhau', async () => {
    const marker = uniqueName('pg568');
    const created: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const user = await createUserViaApi(app, admin, { username: `${marker}u${String(i).padStart(2, '0')}` });
      created.push(user.id);
    }

    const pageOne = await list({ search: marker, page: 1, pageSize: 10 });
    expect(pageOne.status).toBe(200);
    expect(pageOne.body.total).toBe(12);
    expect(pageOne.body.page).toBe(1);
    expect(pageOne.body.pageSize).toBe(10);
    expect(usersOf(pageOne.body)).toHaveLength(10);

    const pageTwo = await list({ search: marker, page: 2, pageSize: 10 });
    expect(pageTwo.body.total).toBe(12);
    expect(usersOf(pageTwo.body)).toHaveLength(2);

    // Hai trang gộp lại đủ 12 người đã tạo, không trùng, thứ tự theo id tăng dần.
    const all = [...usersOf(pageOne.body), ...usersOf(pageTwo.body)];
    expect(new Set(all.map((u) => u.id)).size).toBe(12);
    expect(new Set(all.map((u) => u.id))).toEqual(new Set(created));
    const ids = all.map((u) => u.id);
    expect(ids).toEqual([...ids].sort());

    // Mỗi phần tử mang đủ thông tin tài khoản cho một dòng bảng, kèm
    // createdAt dạng chuỗi thời gian và mảng gán (rỗng khi chưa giữ vai).
    for (const user of all) {
      expect(user.username.startsWith(marker)).toBe(true);
      expect(typeof user.firstName).toBe('string');
      expect(typeof user.lastName).toBe('string');
      expect(user.email).toContain('@example.com');
      expect(user.suspended).toBe(false);
      expect(user.deleted).toBe(false);
      expect(typeof user.createdAt).toBe('string');
      expect(Number.isNaN(Date.parse(user.createdAt))).toBe(false);
      expect(user.assignments).toEqual([]);
    }
  });

  it('một người giữ nhiều vai ở nhiều context chỉ chiếm một dòng và mang toàn bộ gán kèm tên vai và số cấp context', async () => {
    const marker = uniqueName('multi568');
    const roleA = await createRoleViaApi(app, admin);
    const roleB = await createRoleViaApi(app, admin);
    const catContextId = (await createContextViaApi(app, admin, 40, uuidv7(), systemId)).id;
    const user = await createUserViaApi(app, admin, { username: `${marker}one`, email: `${marker}@example.com` });
    await assignRole(app, admin, user.id, roleA, systemId);
    await assignRole(app, admin, user.id, roleA, catContextId);
    await assignRole(app, admin, user.id, roleB, systemId);

    const res = await list({ search: marker });
    expect(res.status).toBe(200);
    // Ba dòng gán nhưng total vẫn là 1: đơn vị đếm là người dùng.
    expect(res.body.total).toBe(1);
    const rows = usersOf(res.body);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(user.id);
    expect(rows[0].assignments).toHaveLength(3);

    const nameA = await roleNameById(roleA);
    const nameB = await roleNameById(roleB);
    const byKey = new Map(rows[0].assignments.map((a) => [`${a.roleId}:${a.contextId}`, a]));
    const atSystemA = byKey.get(`${roleA}:${systemId}`);
    expect(atSystemA?.roleName).toBe(nameA);
    expect(atSystemA?.contextLevel).toBe(10);
    expect(atSystemA?.component).toBe('');
    const atCatA = byKey.get(`${roleA}:${catContextId}`);
    expect(atCatA?.roleName).toBe(nameA);
    expect(atCatA?.contextLevel).toBe(40);
    const atSystemB = byKey.get(`${roleB}:${systemId}`);
    expect(atSystemB?.roleName).toBe(nameB);
    expect(atSystemB?.contextLevel).toBe(10);
    for (const entry of rows[0].assignments) expect(typeof entry.id).toBe('string');
  });

  it('lọc theo vai trò chỉ giữ người có ít nhất một gán với vai đó và mảng gán của họ vẫn chứa các vai khác', async () => {
    const marker = uniqueName('role568');
    const roleX = await createRoleViaApi(app, admin);
    const roleY = await createRoleViaApi(app, admin);
    const userA = await createUserViaApi(app, admin, { username: `${marker}a` });
    const userB = await createUserViaApi(app, admin, { username: `${marker}b` });
    await createUserViaApi(app, admin, { username: `${marker}c` });
    await assignRole(app, admin, userA.id, roleX, systemId);
    await assignRole(app, admin, userA.id, roleY, systemId);
    await assignRole(app, admin, userB.id, roleY, systemId);

    // Lọc vai X: chỉ người A khớp, và mảng gán của A vẫn đủ cả X và Y
    // (bộ lọc vai không cắt mảng gán theo vai đang lọc).
    const byX = await list({ search: marker, roleId: roleX });
    expect(byX.status).toBe(200);
    expect(byX.body.total).toBe(1);
    const rowsX = usersOf(byX.body);
    expect(rowsX).toHaveLength(1);
    expect(rowsX[0].id).toBe(userA.id);
    expect(rowsX[0].assignments.map((a) => a.roleId).sort()).toEqual([roleX, roleY].sort());

    // Lọc vai Y: cả A và B đều khớp.
    const byY = await list({ search: marker, roleId: roleY });
    expect(byY.body.total).toBe(2);
    expect(usersOf(byY.body).map((u) => u.id).sort()).toEqual([userA.id, userB.id].sort());
  });

  it('lọc theo trạng thái: mặc định ẩn tài khoản đã xoá; active, suspended và deleted trả đúng nhóm của chúng', async () => {
    const marker = uniqueName('st568');
    const active = await createUserViaApi(app, admin, { username: `${marker}active` });
    const suspended = await createUserViaApi(app, admin, { username: `${marker}susp` });
    const deleted = await createUserViaApi(app, admin, { username: `${marker}del` });
    await usersRepo.updateUser(suspended.id, { suspended: true });
    await usersRepo.updateUser(deleted.id, { deleted: true });

    const byDefault = await list({ search: marker });
    expect(byDefault.status).toBe(200);
    expect(byDefault.body.total).toBe(2);
    expect(usersOf(byDefault.body).map((u) => u.id).sort()).toEqual([active.id, suspended.id].sort());
    expect(usersOf(byDefault.body).map((u) => u.id)).not.toContain(deleted.id);

    const byActive = await list({ search: marker, status: 'active' });
    expect(byActive.body.total).toBe(1);
    expect(usersOf(byActive.body)[0].id).toBe(active.id);
    expect(usersOf(byActive.body)[0].suspended).toBe(false);

    const bySuspended = await list({ search: marker, status: 'suspended' });
    expect(bySuspended.body.total).toBe(1);
    expect(usersOf(bySuspended.body)[0].id).toBe(suspended.id);
    expect(usersOf(bySuspended.body)[0].suspended).toBe(true);

    const byDeleted = await list({ search: marker, status: 'deleted' });
    expect(byDeleted.body.total).toBe(1);
    expect(usersOf(byDeleted.body)[0].id).toBe(deleted.id);
    expect(usersOf(byDeleted.body)[0].deleted).toBe(true);
  });

  it('tìm kiếm khớp theo họ, tên đầy đủ, email và tên đăng nhập; từ khoá không khớp trả rỗng', async () => {
    const marker = uniqueName('find568');
    const user = await createUserViaApi(app, admin, {
      username: `${marker}user`,
      firstName: 'Tim568',
      lastName: 'Kiem568',
      email: `${marker}@example.com`,
    });

    for (const term of ['Kiem568', 'Tim568 Kiem568', `${marker}@example.com`, `${marker}user`]) {
      const res = await list({ search: term });
      expect(res.status).toBe(200);
      expect(usersOf(res.body).map((u) => u.id)).toContain(user.id);
    }
    // Tìm theo họ tên đầy đủ chỉ ra đúng người này trong nhóm đánh dấu.
    const byFullName = await list({ search: 'Tim568 Kiem568' });
    expect(usersOf(byFullName.body)).toHaveLength(1);

    const noMatch = await list({ search: `${marker}khongtontai` });
    expect(noMatch.body.total).toBe(0);
    expect(noMatch.body.users).toEqual([]);
  });

  it('gán do ghi danh mang component enrol phân biệt được với gán tay có component rỗng', async () => {
    const marker = uniqueName('enrol568');
    const enrolRole = await createRoleViaApi(app, admin);
    const manualRole = await createRoleViaApi(app, admin);
    const user = await createUserViaApi(app, admin, { username: `${marker}one` });
    await assignRole(app, admin, user.id, manualRole, systemId);
    // Gán do ghi danh không đi qua API gán tay (API luôn để component
    // rỗng) nên chèn thẳng một dòng với component 'enrol' như enrol
    // plugin ghi, kèm itemId là id của enrol instance.
    await pg.query(
      'insert into role_assignments (role_id, user_id, context_id, component, item_id) values ($1, $2, $3, $4, $5)',
      [enrolRole, user.id, systemId, 'enrol', uuidv7()],
    );

    const res = await list({ search: marker });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const assignments = usersOf(res.body)[0].assignments;
    expect(assignments).toHaveLength(2);
    const enrolEntry = assignments.find((a) => a.roleId === enrolRole);
    expect(enrolEntry?.component).toBe('enrol');
    const manualEntry = assignments.find((a) => a.roleId === manualRole);
    expect(manualEntry?.component).toBe('');
  });

  it('người gọi thiếu năng lực role:assign bị chặn 403 theo dạng lỗi chuẩn; truy vấn phá hợp đồng bị chặn 400', async () => {
    const plain = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, plain.username, 'Passw0rd!');
    const denied = await http(app).get('/api/v1/access/users-with-assignments')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('access.capability_denied');
    expect(denied.headers['content-type']).toContain('application/problem+json');

    // Trạng thái ngoài tập đóng và pageSize vượt trần 100 bị validation
    // chặn bằng mã lỗi thật của cơ chế ProblemDetails.
    const badStatus = await list({ status: 'archived' });
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.code).toBe('http.validation_failed');
    const overCap = await list({ pageSize: 101 });
    expect(overCap.status).toBe(400);
    expect(overCap.body.code).toBe('http.validation_failed');
    const atCap = await list({ pageSize: 100 });
    expect(atCap.status).toBe(200);
    expect(atCap.body.pageSize).toBe(100);
  });
});
