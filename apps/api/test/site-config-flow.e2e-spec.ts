import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from './identity-access-helpers';

/**
 * Site Config flow (admin settings).
 * Oracle: blueprint §2#30 (Config/Admin) — config phân tầng: mặc định code
 * < giá trị admin lưu DB < config theo plugin (`component + name`); mọi
 * thay đổi qua UI/API đều qua capability `site:config` và có vết.
 * Hành vi tương ứng phía Moodle: get_config/set_config (config + config_plugins)
 * và admin setting tree chỉ dành cho user có site:config.
 */
describe('Site config (admin settings)', () => {
  let app: INestApplication;
  let admin: string;
  let adminId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const me = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${admin}`);
    adminId = me.body.id as string;
  });
  afterAll(async () => { await app.close(); });

  it('unset settings resolve to their code defaults, for core and plugin components alike', async () => {
    const list = await http(app).get('/api/v1/site-config').set('Authorization', `Bearer ${admin}`);
    expect(list.status).toBe(200);
    const byKey = new Map((list.body as { component: string; name: string }[]).map((s) => [`${s.component}/${s.name}`, s]));
    expect(byKey.get('core/fullname')).toMatchObject({ value: 'LMS', defaultValue: 'LMS', source: 'default' });
    expect(byKey.get('core/lang')).toMatchObject({ value: 'vi', source: 'default' });
    expect(byKey.get('core/messagingallusers')).toMatchObject({ value: false, source: 'default' });
    expect(byKey.get('badges/enabled')).toMatchObject({ value: true, source: 'default' });
  });

  it('an admin override wins over the default, is audited, and clearing it restores the default', async () => {
    const put = await http(app).put('/api/v1/site-config/core/fullname')
      .set('Authorization', `Bearer ${admin}`).send({ value: 'Trường Học Số' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ value: 'Trường Học Số', source: 'database' });

    const get = await http(app).get('/api/v1/site-config/core/fullname').set('Authorization', `Bearer ${admin}`);
    expect(get.body.value).toBe('Trường Học Số');

    const audit = await http(app).get('/api/v1/site-config/audit')
      .query({ settingKey: 'core/fullname' }).set('Authorization', `Bearer ${admin}`);
    expect(audit.status).toBe(200);
    const entry = (audit.body as { oldValue: unknown; newValue: unknown; changedBy: string }[])
      .find((a) => a.newValue === 'Trường Học Số');
    expect(entry).toBeDefined();
    expect(entry!.oldValue).toBe('LMS');
    expect(entry!.changedBy).toBe(adminId);

    const cleared = await http(app).delete('/api/v1/site-config/core/fullname').set('Authorization', `Bearer ${admin}`);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ value: 'LMS', source: 'default' });

    const clearAgain = await http(app).delete('/api/v1/site-config/core/fullname').set('Authorization', `Bearer ${admin}`);
    expect(clearAgain.status).toBe(404);
    expect(clearAgain.body.code).toBe('site_config.override_not_found');
  });

  it('plugin settings live in their own namespace, independent from core keys of the same name', async () => {
    const put = await http(app).put('/api/v1/site-config/badges/enabled')
      .set('Authorization', `Bearer ${admin}`).send({ value: false });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ component: 'badges', value: false, source: 'database' });
    const core = await http(app).get('/api/v1/site-config/core/fullname').set('Authorization', `Bearer ${admin}`);
    expect(core.body.value).toBe('LMS');
    await http(app).delete('/api/v1/site-config/badges/enabled').set('Authorization', `Bearer ${admin}`);
  });

  it('values are validated against the registered type: wrong type and out-of-enum values are refused, unknown keys are refused', async () => {
    const badBool = await http(app).put('/api/v1/site-config/core/messagingallusers')
      .set('Authorization', `Bearer ${admin}`).send({ value: 'yes' });
    expect(badBool.status).toBe(400);
    expect(badBool.body.code).toBe('site_config.invalid_value');

    const badEnum = await http(app).put('/api/v1/site-config/core/lang')
      .set('Authorization', `Bearer ${admin}`).send({ value: 'fr' });
    expect(badEnum.status).toBe(400);
    expect(badEnum.body.code).toBe('site_config.invalid_value');

    const unknown = await http(app).put('/api/v1/site-config/core/no_such_setting')
      .set('Authorization', `Bearer ${admin}`).send({ value: 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('site_config.unknown_setting');
  });

  it('users without site:config can neither read nor write site configuration', async () => {
    const plain = await createUserViaApi(app, admin);
    const plainLogin = await login(app, plain.username, STRONG_PASSWORD);
    const read = await http(app).get('/api/v1/site-config').set('Authorization', `Bearer ${plainLogin.accessToken}`);
    expect(read.status).toBe(403);
    const write = await http(app).put('/api/v1/site-config/core/fullname')
      .set('Authorization', `Bearer ${plainLogin.accessToken}`).send({ value: 'Hacked' });
    expect(write.status).toBe(403);
    const unchanged = await http(app).get('/api/v1/site-config/core/fullname').set('Authorization', `Bearer ${admin}`);
    expect(unchanged.body.value).toBe('LMS');
  });
});
