import type { INestApplication } from '@nestjs/common';
import { http, uniqueName } from './identity-access-helpers';

export async function createCategory(app: INestApplication, token: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; name: string; parent: string; path: string; depth: number }> {
  const name = uniqueName('cat');
  const res = await http(app).post('/api/v1/courses/categories').set('Authorization', `Bearer ${token}`)
    .send({ name, ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create category failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function createClass(app: INestApplication, token: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; name: string }> {
  const name = uniqueName('cls');
  const res = await http(app).post('/api/v1/classes').set('Authorization', `Bearer ${token}`)
    .send({ name, ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create class failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * Lớp fixture dùng chung cho createCourse: từ cửa sổ đóng gói CLASS-0
 * (PR #200), khoá dạy thật BẮT BUỘC thuộc một lớp (`course.class_required`
 * + CHECK ở DB) nên helper tạo khoá phải cấp một lớp cho token nếu
 * overrides chưa mang classId. Cache theo (app, token): một lớp cho mỗi
 * danh tính/tenant hiệu lực — token khác nhau (hoặc sau switch-tenant)
 * là lớp khác nhau.
 */
const fixtureClassByToken = new WeakMap<INestApplication, Map<string, Promise<string>>>();

export function fixtureClassId(app: INestApplication, token: string): Promise<string> {
  let byToken = fixtureClassByToken.get(app);
  if (!byToken) {
    byToken = new Map();
    fixtureClassByToken.set(app, byToken);
  }
  let pending = byToken.get(token);
  if (!pending) {
    pending = createClass(app, token).then((c) => c.id);
    byToken.set(token, pending);
  }
  return pending;
}

export async function createCourse(app: INestApplication, token: string, category: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; fullName: string; shortName: string; category: string }> {
  const shortName = uniqueName('crs');
  const withClass = 'classId' in overrides ? overrides : { ...overrides, classId: await fixtureClassId(app, token) };
  const res = await http(app).post('/api/v1/courses').set('Authorization', `Bearer ${token}`)
    .send({ fullName: `Course ${shortName}`, shortName, category, ...withClass });
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

export async function enrolUser(app: INestApplication, token: string, courseId: string, instanceId: string, userId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; status: number }> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/enrol/instances/${instanceId}/enrol`).set('Authorization', `Bearer ${token}`)
    .send({ userId, ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`enrol failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
