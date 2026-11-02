import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, uniqueName } from '../../support/identity-access-helpers';
import { UsersRepository } from '@lms/db/repositories/users';

/**
 * Issue #560 (đợt 1 backend của đợt danh sách thành viên, cha #559): hợp đồng
 * truy vấn của `GET /users` — lọc theo trạng thái suy ra từ hai cờ
 * suspended/deleted (mặc định ẩn tài khoản đã xoá, tài khoản đã xoá chỉ hiện
 * khi lọc đích danh), sắp xếp theo tập trường đóng (name/createdAt/lastLogin)
 * ở cả hai chiều với thứ tự mặc định theo id được giữ nguyên khi không truyền
 * tham số, và trần pageSize 100 bị chặn ở validation. Mọi ca lái qua HTTP
 * thật; trạng thái và mốc thời gian của dữ kiện được đặt thẳng qua repository
 * để kết quả tất định, và mỗi ca tự cô lập bằng tiền tố username duy nhất
 * truyền qua `search`.
 */
describe('Danh sách người dùng: lọc trạng thái, sắp xếp và trần pageSize (issue #560)', () => {
  let app: INestApplication;
  let admin: string;
  let repo: UsersRepository;

  const list = (query: Record<string, string | number>) =>
    http(app).get('/api/v1/users').query(query).set('Authorization', `Bearer ${admin}`);

  const idsOf = (body: { users: { id: string }[] }) => body.users.map((u) => u.id);

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    repo = app.get(UsersRepository);
  });
  afterAll(async () => { await app.close(); });

  it('không truyền trạng thái thì ẩn tài khoản đã xoá và giữ thứ tự theo id; lọc từng trạng thái trả đúng nhóm của nó', async () => {
    const marker = uniqueName('st560');
    const active = await createUserViaApi(app, admin, { username: `${marker}active` });
    const suspended = await createUserViaApi(app, admin, { username: `${marker}susp` });
    const deleted = await createUserViaApi(app, admin, { username: `${marker}del` });
    await repo.updateUser(suspended.id, { suspended: true });
    await repo.updateUser(deleted.id, { deleted: true });

    // Mặc định: tài khoản đã xoá vắng mặt, hai tài khoản còn lại theo thứ tự id (thứ tự tạo).
    const byDefault = await list({ search: marker });
    expect(byDefault.status).toBe(200);
    expect(byDefault.body.total).toBe(2);
    expect(idsOf(byDefault.body)).toEqual([active.id, suspended.id]);

    // Từng trạng thái trả đúng nhóm của nó, tổng khớp số dòng.
    const byActive = await list({ search: marker, status: 'active' });
    expect(byActive.body.total).toBe(1);
    expect(idsOf(byActive.body)).toEqual([active.id]);

    const bySuspended = await list({ search: marker, status: 'suspended' });
    expect(bySuspended.body.total).toBe(1);
    expect(idsOf(bySuspended.body)).toEqual([suspended.id]);

    // Tài khoản đã xoá chỉ xuất hiện khi lọc đích danh theo trạng thái đã xoá.
    const byDeleted = await list({ search: marker, status: 'deleted' });
    expect(byDeleted.body.total).toBe(1);
    expect(idsOf(byDeleted.body)).toEqual([deleted.id]);
    expect(byDeleted.body.users[0].deleted).toBe(true);
  });

  it('sắp xếp theo tên theo firstName rồi lastName, đúng cả chiều tăng và chiều giảm', async () => {
    const marker = uniqueName('nm560');
    const binh = await createUserViaApi(app, admin, { username: `${marker}binh`, firstName: 'Binh', lastName: 'Zulu' });
    const anY = await createUserViaApi(app, admin, { username: `${marker}any`, firstName: 'An', lastName: 'Yankee' });
    const anA = await createUserViaApi(app, admin, { username: `${marker}ana`, firstName: 'An', lastName: 'Alpha' });

    // Tăng dần: An Alpha, An Yankee, Binh Zulu — trùng firstName thì lastName phân định.
    const asc = await list({ search: marker, sortBy: 'name', sortDirection: 'asc' });
    expect(asc.status).toBe(200);
    expect(idsOf(asc.body)).toEqual([anA.id, anY.id, binh.id]);

    // Giảm dần đảo ngược đúng thứ tự trên.
    const desc = await list({ search: marker, sortBy: 'name', sortDirection: 'desc' });
    expect(idsOf(desc.body)).toEqual([binh.id, anY.id, anA.id]);

    // Có sortBy mà không truyền chiều thì mặc định tăng dần.
    const defaultDirection = await list({ search: marker, sortBy: 'name' });
    expect(idsOf(defaultDirection.body)).toEqual([anA.id, anY.id, binh.id]);
  });

  it('sắp xếp theo ngày tạo tài khoản đúng cả chiều tăng và chiều giảm', async () => {
    const marker = uniqueName('ct560');
    const first = await createUserViaApi(app, admin, { username: `${marker}one` });
    const second = await createUserViaApi(app, admin, { username: `${marker}two` });
    const third = await createUserViaApi(app, admin, { username: `${marker}three` });
    await repo.updateUser(first.id, { createdAt: new Date('2026-01-01T00:00:00.000Z') });
    await repo.updateUser(second.id, { createdAt: new Date('2026-01-03T00:00:00.000Z') });
    await repo.updateUser(third.id, { createdAt: new Date('2026-01-02T00:00:00.000Z') });

    const asc = await list({ search: marker, sortBy: 'createdAt', sortDirection: 'asc' });
    expect(idsOf(asc.body)).toEqual([first.id, third.id, second.id]);
    const desc = await list({ search: marker, sortBy: 'createdAt', sortDirection: 'desc' });
    expect(idsOf(desc.body)).toEqual([second.id, third.id, first.id]);
  });

  it('sắp xếp theo lần đăng nhập gần nhất đúng cả hai chiều; tài khoản chưa từng đăng nhập đứng cuối khi tăng dần và đầu khi giảm dần', async () => {
    const marker = uniqueName('ll560');
    const early = await createUserViaApi(app, admin, { username: `${marker}early` });
    const never = await createUserViaApi(app, admin, { username: `${marker}never` });
    const late = await createUserViaApi(app, admin, { username: `${marker}late` });
    await repo.updateUser(early.id, { lastLogin: new Date('2026-02-01T00:00:00.000Z') });
    await repo.updateUser(late.id, { lastLogin: new Date('2026-02-03T00:00:00.000Z') });
    // `never` giữ lastLogin null như tài khoản mới tạo chưa từng đăng nhập.

    // Postgres: tăng dần thì NULL đứng cuối, giảm dần thì NULL đứng đầu.
    const asc = await list({ search: marker, sortBy: 'lastLogin', sortDirection: 'asc' });
    expect(idsOf(asc.body)).toEqual([early.id, late.id, never.id]);
    const desc = await list({ search: marker, sortBy: 'lastLogin', sortDirection: 'desc' });
    expect(idsOf(desc.body)).toEqual([never.id, late.id, early.id]);
  });

  it('giá trị ngoài tập hợp đồng và pageSize vượt trần 100 bị validation chặn với 400; pageSize đúng trần vẫn chạy', async () => {
    const marker = uniqueName('vd560');
    await createUserViaApi(app, admin, { username: `${marker}one` });

    expect((await list({ search: marker, sortBy: 'email' })).status).toBe(400);
    expect((await list({ search: marker, sortDirection: 'up' })).status).toBe(400);
    expect((await list({ search: marker, status: 'archived' })).status).toBe(400);
    expect((await list({ search: marker, pageSize: 101 })).status).toBe(400);

    const atCap = await list({ search: marker, pageSize: 100 });
    expect(atCap.status).toBe(200);
    expect(atCap.body.pageSize).toBe(100);
    expect(atCap.body.total).toBe(1);
  });
});
