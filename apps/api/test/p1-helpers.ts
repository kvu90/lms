import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ProblemDetailsFilter } from '../src/common/problem-details.filter';

process.env.FILE_STORAGE_DIR = process.env.FILE_STORAGE_DIR ?? '/tmp/lms-test-files';

export const ADMIN = { username: 'admin', password: 'Admin123!' };
export const STRONG_PASSWORD = 'Passw0rd!';

export async function createP1TestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  return app;
}

export function http(app: INestApplication) { return request(app.getHttpServer()); }

export async function login(app: INestApplication, username: string, password: string): Promise<{ accessToken: string; refreshToken: string; userId: number }> {
  const res = await http(app).post('/api/v1/auth/token').send({ username, password });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return { accessToken: res.body.accessToken, refreshToken: res.body.refreshToken, userId: res.body.user.id };
}

export async function adminToken(app: INestApplication): Promise<string> {
  return (await login(app, ADMIN.username, ADMIN.password)).accessToken;
}

let counter = 0;
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

export async function createUserViaApi(app: INestApplication, token: string, overrides: Record<string, unknown> = {}): Promise<{ id: number; username: string; email: string }> {
  const username = uniqueName('user');
  const res = await http(app).post('/api/v1/users').set('Authorization', `Bearer ${token}`)
    .send({ username, email: `${username}@example.com`, password: STRONG_PASSWORD, firstname: 'Test', lastname: 'User', ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create user failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function createContextViaApi(app: INestApplication, token: string, contextlevel: number, instanceid: number, parentId?: number): Promise<{ id: number; path: string }> {
  const res = await http(app).post('/api/v1/access/contexts').set('Authorization', `Bearer ${token}`)
    .send({ contextlevel, instanceid, parentId });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create context failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function systemContextId(app: INestApplication, token: string): Promise<number> {
  const res = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${token}`);
  const system = (res.body as { id: number; contextlevel: number }[]).find((c) => c.contextlevel === 10);
  if (!system) throw new Error('system context missing');
  return system.id;
}

export async function roleIdByShortname(app: INestApplication, token: string, shortname: string): Promise<number> {
  const res = await http(app).get('/api/v1/access/roles').set('Authorization', `Bearer ${token}`);
  const roleRow = (res.body as { id: number; shortname: string }[]).find((r) => r.shortname === shortname);
  if (!roleRow) throw new Error(`role ${shortname} missing`);
  return roleRow.id;
}

export async function createRoleViaApi(app: INestApplication, token: string): Promise<number> {
  const shortname = uniqueName('role');
  const res = await http(app).post('/api/v1/access/roles').set('Authorization', `Bearer ${token}`)
    .send({ name: `Role ${shortname}`, shortname });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create role failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

export async function assignRole(app: INestApplication, token: string, userid: number, roleid: number, contextid: number): Promise<void> {
  const res = await http(app).post('/api/v1/access/assignments').set('Authorization', `Bearer ${token}`).send({ userid, roleid, contextid });
  if (res.status !== 200 && res.status !== 201) throw new Error(`assign failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export async function setOverride(app: INestApplication, token: string, roleid: number, capability: string, contextid: number, permission: number): Promise<void> {
  const res = await http(app).post('/api/v1/access/overrides').set('Authorization', `Bearer ${token}`).send({ roleid, capability, contextid, permission });
  if (res.status !== 200 && res.status !== 201) throw new Error(`override failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export async function hasCapability(app: INestApplication, token: string, userid: number, capability: string, contextid: number): Promise<boolean> {
  const res = await http(app).get('/api/v1/access/has-capability').query({ userid, capability, contextid }).set('Authorization', `Bearer ${token}`);
  if (res.status !== 200) throw new Error(`has-capability failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.allowed as boolean;
}
