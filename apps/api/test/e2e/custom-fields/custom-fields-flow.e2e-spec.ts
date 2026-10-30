import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD, uniqueName } from '../../support/identity-access-helpers';

/**
 * Kiểm thử luồng trường tuỳ chỉnh (phạm vi hồ sơ người dùng).
 * Oracle: public/customfield/tests/api_test.php (MOODLE_503_STABLE) —
 * test_create_category, test_delete_category_with_fields, CRUD danh mục/trường;
 * kiểm chứng giá trị tuân theo khai báo của từng loại trường (trình xử lý core_customfield).
 */
describe('CustomFields: trường hồ sơ định nghĩa dạng metadata và kiểm chứng khi lưu', () => {
  let app: INestApplication;
  let admin: string;
  let categoryId: string;
  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const cat = await http(app).post('/api/v1/custom-fields/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Profile extras', component: 'core_user', area: 'user' });
    expect(cat.status).toBe(201);
    categoryId = cat.body.id;
    const mk = async (body: Record<string, unknown>) => {
      const res = await http(app).post('/api/v1/custom-fields/fields').set('Authorization', `Bearer ${admin}`).send({ categoryId: categoryId, ...body });
      expect(res.status).toBe(201);
      return res.body;
    };
    await mk({ shortName: 'department', name: 'Department', type: 'select', configData: { options: ['Engineering', 'Sales'], required: true } });
    await mk({ shortName: 'bio', name: 'Bio', type: 'textarea', configData: {} });
    await mk({ shortName: 'newsletter', name: 'Newsletter', type: 'checkbox', configData: {} });
    await mk({ shortName: 'birthdate', name: 'Birth date', type: 'date', configData: {} });
  });
  afterAll(async () => { await app.close(); });

  it('lưu giá trị hợp lệ và trả chúng kèm hồ sơ', async () => {
    const user = await createUserViaApi(app, admin, {
      customFields: { department: 'Engineering', bio: 'hello', newsletter: '1', birthdate: '2000-01-15' },
    });
    const profile = await http(app).get(`/api/v1/users/${user.id}`).set('Authorization', `Bearer ${admin}`);
    const fields = Object.fromEntries((profile.body.customFields as { shortName: string; value: string | null }[]).map((f) => [f.shortName, f.value]));
    expect(fields.department).toBe('Engineering');
    expect(fields.newsletter).toBe('1');
    expect(fields.birthdate).toBe('2000-01-15');
  });

  it('từ chối giá trị select ngoài các tuỳ chọn đã khai', async () => {
    const res = await http(app).post('/api/v1/users').set('Authorization', `Bearer ${admin}`)
            .send({ username: uniqueName('badselect'), email: `${uniqueName('badselect')}@example.com`, password: STRONG_PASSWORD, customFields: { department: 'Legal' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('customfield.validation_failed');
  });

  it('từ chối hồ sơ thiếu trường bắt buộc khi cập nhật', async () => {
    const user = await createUserViaApi(app, admin, { customFields: { department: 'Sales' } });
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).patch(`/api/v1/users/${user.id}`).set('Authorization', `Bearer ${accessToken}`)
      .send({ customFields: { department: '' } });
    expect(res.status).toBe(400);
  });

  it('từ chối giá trị ngày không hợp lệ', async () => {
    const res = await http(app).post('/api/v1/users').set('Authorization', `Bearer ${admin}`)
            .send({ username: uniqueName('baddate'), email: `${uniqueName('baddate')}@example.com`, password: STRONG_PASSWORD, customFields: { department: 'Sales', birthdate: 'not-a-date' } });
    expect(res.status).toBe(400);
  });

  it('chỉ người có năng lực mới quản lý được định nghĩa trường', async () => {
    const user = await createUserViaApi(app, admin, { customFields: { department: 'Sales' } });
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).post('/api/v1/custom-fields/fields').set('Authorization', `Bearer ${accessToken}`)
      .send({ categoryId: categoryId, shortName: 'evil', name: 'Evil', type: 'text', configData: {} });
    expect(res.status).toBe(403);
  });

  it('xoá danh mục xoá luôn các trường của nó (api_test::test_delete_category_with_fields)', async () => {
    const cat = await http(app).post('/api/v1/custom-fields/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Temp', component: 'core_user', area: 'user' });
    const field = await http(app).post('/api/v1/custom-fields/fields').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: cat.body.id, shortName: 'tempfield', name: 'Temp', type: 'text', configData: {} });
    expect(field.status).toBe(201);
    const del = await http(app).delete(`/api/v1/custom-fields/categories/${cat.body.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(200);
    const fields = await http(app).get('/api/v1/custom-fields/fields').set('Authorization', `Bearer ${admin}`);
    expect((fields.body as { shortName: string }[]).some((f) => f.shortName === 'tempfield')).toBe(false);
  });
});
