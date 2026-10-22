import type { INestApplication } from '@nestjs/common';
import { http, uniqueName } from './identity-access-helpers';

export async function createCategory(app: INestApplication, token: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; name: string; parent: string; path: string; depth: number }> {
  const name = uniqueName('cat');
  const res = await http(app).post('/api/v1/courses/categories').set('Authorization', `Bearer ${token}`)
    .send({ name, ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create category failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function createCourse(app: INestApplication, token: string, category: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; fullname: string; shortname: string; category: string }> {
  const shortname = uniqueName('crs');
  const res = await http(app).post('/api/v1/courses').set('Authorization', `Bearer ${token}`)
    .send({ fullname: `Course ${shortname}`, shortname, category, ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create course failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function createSection(app: INestApplication, token: string, courseId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; section: number }> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/sections`).set('Authorization', `Bearer ${token}`).send(overrides);
  if (res.status !== 200 && res.status !== 201) throw new Error(`create section failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function getFirstSectionId(app: INestApplication, token: string, courseId: string): Promise<string> {
  const res = await http(app).get(`/api/v1/courses/${courseId}/content`).set('Authorization', `Bearer ${token}`);
  if (res.status !== 200) throw new Error(`content failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.sections[0].id as string;
}

export async function createCm(app: INestApplication, token: string, courseId: string, sectionId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; contextId?: string }> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/modules`).set('Authorization', `Bearer ${token}`)
    .send({ sectionId, component: 'mod_page', name: 'A page', ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create cm failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function createEnrolInstance(app: INestApplication, token: string, courseId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; enrol: string }> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/enrol/instances`).set('Authorization', `Bearer ${token}`)
    .send({ method: 'manual', ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create enrol instance failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function enrolUser(app: INestApplication, token: string, courseId: string, instanceId: string, userid: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; status: number }> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/enrol/instances/${instanceId}/enrol`).set('Authorization', `Bearer ${token}`)
    .send({ userid, ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`enrol failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
