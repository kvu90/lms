import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD, uniqueName } from './identity-access-helpers';

/**
 * Custom field flow tests (user profile scope).
 * Oracle: public/customfield/tests/api_test.php (MOODLE_503_STABLE) —
 * test_create_category, test_delete_category_with_fields, category/field CRUD;
 * value validation follows each field type's declaration (core_customfield handlers).
 */
describe('CustomFields: profile fields are defined as metadata and validated on save', () => {
  let app: INestApplication;
  let admin: string;
  let categoryId: number;
  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const cat = await http(app).post('/api/v1/custom-fields/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Profile extras', component: 'core_user', area: 'user' });
    expect(cat.status).toBe(201);
    categoryId = cat.body.id;
    const mk = async (body: Record<string, unknown>) => {
      const res = await http(app).post('/api/v1/custom-fields/fields').set('Authorization', `Bearer ${admin}`).send({ categoryid: categoryId, ...body });
      expect(res.status).toBe(201);
      return res.body;
    };
    await mk({ shortname: 'department', name: 'Department', type: 'select', configdata: { options: ['Engineering', 'Sales'], required: true } });
    await mk({ shortname: 'bio', name: 'Bio', type: 'textarea', configdata: {} });
    await mk({ shortname: 'newsletter', name: 'Newsletter', type: 'checkbox', configdata: {} });
    await mk({ shortname: 'birthdate', name: 'Birth date', type: 'date', configdata: {} });
  });
  afterAll(async () => { await app.close(); });

  it('stores valid values and returns them with the profile', async () => {
    const user = await createUserViaApi(app, admin, {
      customFields: { department: 'Engineering', bio: 'hello', newsletter: '1', birthdate: '2000-01-15' },
    });
    const profile = await http(app).get(`/api/v1/users/${user.id}`).set('Authorization', `Bearer ${admin}`);
    const fields = Object.fromEntries((profile.body.customFields as { shortname: string; value: string | null }[]).map((f) => [f.shortname, f.value]));
    expect(fields.department).toBe('Engineering');
    expect(fields.newsletter).toBe('1');
    expect(fields.birthdate).toBe('2000-01-15');
  });

  it('rejects a select value outside the declared options', async () => {
    const res = await http(app).post('/api/v1/users').set('Authorization', `Bearer ${admin}`)
            .send({ username: uniqueName('badselect'), email: `${uniqueName('badselect')}@example.com`, password: STRONG_PASSWORD, customFields: { department: 'Legal' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('customfield.validation_failed');
  });

  it('rejects a profile missing a required field on update', async () => {
    const user = await createUserViaApi(app, admin, { customFields: { department: 'Sales' } });
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).patch(`/api/v1/users/${user.id}`).set('Authorization', `Bearer ${accessToken}`)
      .send({ customFields: { department: '' } });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid date value', async () => {
    const res = await http(app).post('/api/v1/users').set('Authorization', `Bearer ${admin}`)
            .send({ username: uniqueName('baddate'), email: `${uniqueName('baddate')}@example.com`, password: STRONG_PASSWORD, customFields: { department: 'Sales', birthdate: 'not-a-date' } });
    expect(res.status).toBe(400);
  });

  it('only capability holders can manage field definitions', async () => {
    const user = await createUserViaApi(app, admin, { customFields: { department: 'Sales' } });
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).post('/api/v1/custom-fields/fields').set('Authorization', `Bearer ${accessToken}`)
      .send({ categoryid: categoryId, shortname: 'evil', name: 'Evil', type: 'text', configdata: {} });
    expect(res.status).toBe(403);
  });

  it('deleting a category removes its fields (api_test::test_delete_category_with_fields)', async () => {
    const cat = await http(app).post('/api/v1/custom-fields/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Temp', component: 'core_user', area: 'user' });
    const field = await http(app).post('/api/v1/custom-fields/fields').set('Authorization', `Bearer ${admin}`)
      .send({ categoryid: cat.body.id, shortname: 'tempfield', name: 'Temp', type: 'text', configdata: {} });
    expect(field.status).toBe(201);
    const del = await http(app).delete(`/api/v1/custom-fields/categories/${cat.body.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(200);
    const fields = await http(app).get('/api/v1/custom-fields/fields').set('Authorization', `Bearer ${admin}`);
    expect((fields.body as { shortname: string }[]).some((f) => f.shortname === 'tempfield')).toBe(false);
  });
});
