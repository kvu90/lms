import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomFieldsService } from '../../../src/modules/custom-fields/custom-fields.service';
import { UsersController } from '../../../src/modules/users/users.controller';
import { UsersService } from '../../../src/modules/users/users.service';
import { USER_AREA, USER_COMPONENT } from '../../../src/modules/users/users.service';
import {
  STRONG_PASSWORD, adminToken, createTestApp, createUserViaApi, login, uniqueName,
} from '../../support/identity-access-helpers';

/**
 * Đặc trưng hoá DL-07 (issue #489): đường đọc danh sách user lắp
 * profile view cho từng user — hình dạng view, thứ tự theo phân trang
 * của repository, luật lộ email theo từng người xem và giá trị trường
 * tuỳ chỉnh phải giữ nguyên khi chuyển sang loader theo lô. Mọi khẳng
 * định ở đây chạy trên hành vi HIỆN TẠI và phải vẫn đạt sau refactor.
 */
describe('Users: đặc trưng hoá danh sách hồ sơ người dùng (DL-07, issue #489)', () => {
  let app: INestApplication;
  let users: UsersService;
  let controller: UsersController;
  let adminId: string;
  const created: { id: string; username: string; email: string }[] = [];
  let fieldShortName: string;
  let viewerId: string;
  // Tiền tố username duy nhất của lượt chạy này: DB test dùng chung
  // giữa các suite nên danh sách user toàn cục rất dài — spec chỉ
  // đọc trang chứa đúng các user của mình qua bộ lọc search.
  const usernamePrefix = uniqueName('dl07user');

  beforeAll(async () => {
    app = await createTestApp();
    users = app.get(UsersService);
    controller = app.get(UsersController);
    const admin = await adminToken(app);
    const me = await app.get(UsersService).getByUsername('admin');
    adminId = me!.id;

    // Ba user mới: hai user có giá trị trường tuỳ chỉnh, một user không.
    for (let i = 0; i < 3; i += 1) {
      created.push(await createUserViaApi(app, admin, { username: `${usernamePrefix}${i}` }));
    }
    viewerId = created[2]!.id;

    const customFields = app.get(CustomFieldsService, { strict: false });
    fieldShortName = uniqueName('dl07field').replace(/[^a-z0-9_]/gi, '_');
    const category = await customFields.createCategory({
      name: uniqueName('dl07cat'), component: USER_COMPONENT, area: USER_AREA,
    }) as { id: string };
    await customFields.createField(category.id, {
      shortName: fieldShortName, name: 'Trường đặc trưng DL-07', type: 'text',
    });
    // DB test dùng chung giữa các suite: khu vực hồ sơ có thể đã có
    // field bắt buộc do suite khác tạo (vd field department, khai
    // required trong configData) — khi ghi giá trị phải cấp đủ mọi
    // field bắt buộc hiện có với giá trị hợp lệ theo type của field,
    // nếu không setValuesForInstance chặn cả lượt ghi.
    const allFields = await customFields.listFields(USER_COMPONENT, USER_AREA);
    const requiredFill: Record<string, string> = {};
    for (const f of allFields) {
      const config = (f.configData ?? {}) as { required?: boolean; options?: string[]; maxlength?: number };
      if (!config.required || f.shortName === fieldShortName) continue;
      if (f.type === 'select') requiredFill[f.shortName] = config.options?.[0] ?? 'x';
      else if (f.type === 'checkbox') requiredFill[f.shortName] = '1';
      else if (f.type === 'date') requiredFill[f.shortName] = '2026-01-01';
      else requiredFill[f.shortName] = config.maxlength ? 'x'.repeat(Math.min(4, config.maxlength)) : 'giá trị bổ sung';
    }
    await customFields.setValuesForInstance(USER_COMPONENT, USER_AREA, created[0]!.id, { ...requiredFill, [fieldShortName]: 'giá trị một' });
    await customFields.setValuesForInstance(USER_COMPONENT, USER_AREA, created[1]!.id, { ...requiredFill, [fieldShortName]: 'giá trị hai' });
    void STRONG_PASSWORD;
  });
  afterAll(async () => { await app.close(); });

  async function listMine() {
    return controller.list(
      { search: usernamePrefix, page: 1, pageSize: 50 },
      { id: adminId, username: 'admin' },
    );
  }

  it('danh sách qua controller giữ đúng thứ tự phân trang và hình dạng view của từng user', async () => {
    const page = await users.listUsers(usernamePrefix, 1, 50);
    const result = await listMine();
    expect(result.total).toBe(page.total);
    expect(result.total).toBe(created.length);
    expect(result.users.map((v) => v.id)).toEqual(page.users.map((u) => u.id));
    for (const view of result.users) {
      expect(Object.keys(view).sort()).toContain('customFields');
      expect(view.username).toBeTruthy();
      // Người xem là quản trị hệ thống: email của mọi user đều lộ.
      expect(view.email).toBeTruthy();
    }
  });

  it('view trong danh sách khớp view đọc lẻ của cùng một user với cùng người xem', async () => {
    const result = await listMine();
    for (const createdUser of created) {
      const inList = result.users.find((v) => v.id === createdUser.id);
      const single = await users.getProfileView(createdUser.id, adminId);
      expect(inList).toEqual(single);
    }
  });

  it('giá trị trường tuỳ chỉnh đi theo đúng user, user chưa có giá trị thì nhận null', async () => {
    const result = await listMine();
    const valueOf = (userId: string) => result.users.find((v) => v.id === userId)
      ?.customFields.find((f) => f.shortName === fieldShortName)?.value;
    expect(valueOf(created[0]!.id)).toBe('giá trị một');
    expect(valueOf(created[1]!.id)).toBe('giá trị hai');
    expect(valueOf(created[2]!.id)).toBeNull();
  });

  it('email chỉ lộ cho chính chủ hoặc người có quyền xem định danh, ẩn với người xem thường khác', async () => {
    const other = await users.getProfileView(created[0]!.id, viewerId);
    expect(other.email).toBeUndefined();
    expect('email' in other).toBe(false);
    const self = await users.getProfileView(viewerId, viewerId);
    expect(self.email).toBe(created[2]!.email);
    const byAdmin = await users.getProfileView(created[0]!.id, adminId);
    expect(byAdmin.email).toBe(created[0]!.email);
  });

  it('người xem thường tự đăng nhập được và hồ sơ của chính mình qua controller me vẫn có email', async () => {
    const session = await login(app, created[2]!.username, STRONG_PASSWORD);
    expect(session.userId).toBe(viewerId);
    const mine = await controller.me({ id: viewerId, username: created[2]!.username });
    expect(mine.email).toBe(created[2]!.email);
  });
});
