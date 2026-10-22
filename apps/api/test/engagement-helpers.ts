import type { INestApplication } from '@nestjs/common';
import { http } from './identity-access-helpers';

export async function contextIdByLevelInstance(app: INestApplication, token: string, contextlevel: number, instanceid: string | null): Promise<string> {
  const res = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${token}`);
  const ctx = (res.body as { id: string; contextlevel: number; instanceid: string }[])
    .find((c) => c.contextlevel === contextlevel && c.instanceid === instanceid);
  if (!ctx) throw new Error(`context ${contextlevel}/${instanceid} not found`);
  return ctx.id;
}

export async function courseContextId(app: INestApplication, token: string, courseId: string): Promise<string> {
  const res = await http(app).get(`/api/v1/courses/${courseId}/content`).set('Authorization', `Bearer ${token}`);
  if (res.status !== 200) throw new Error(`course content failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.contextId as string;
}

export async function createGroupViaApi(app: INestApplication, token: string, courseId: string, name: string): Promise<{ id: string }> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/groups`).set('Authorization', `Bearer ${token}`).send({ name });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create group failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function addGroupMember(app: INestApplication, token: string, courseId: string, groupId: string, userid: string): Promise<void> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/groups/${groupId}/members`).set('Authorization', `Bearer ${token}`).send({ userid });
  if (res.status !== 200 && res.status !== 201) throw new Error(`add group member failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export async function createCohortViaApi(app: INestApplication, token: string, name: string): Promise<{ id: string }> {
  const res = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${token}`).send({ name });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create cohort failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function addCohortMember(app: INestApplication, token: string, cohortId: string, userid: string): Promise<void> {
  const res = await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set('Authorization', `Bearer ${token}`).send({ userid });
  if (res.status !== 200 && res.status !== 201) throw new Error(`add cohort member failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export async function setCourseCompletionCriteria(app: INestApplication, token: string, courseId: string, criteria: unknown[], method = 1): Promise<void> {
  const res = await http(app).put(`/api/v1/courses/${courseId}/completion/criteria`).set('Authorization', `Bearer ${token}`)
    .send({ method, criteria });
  if (res.status !== 200 && res.status !== 201) throw new Error(`set criteria failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export async function markCmComplete(app: INestApplication, token: string, courseId: string, cmId: string, userid: string): Promise<void> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/modules/${cmId}/completion/manual`).set('Authorization', `Bearer ${token}`)
    .send({ userid, complete: true });
  if (res.status !== 200 && res.status !== 201) throw new Error(`mark complete failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export async function suspendUser(app: INestApplication, token: string, userId: string): Promise<void> {
  const res = await http(app).post(`/api/v1/users/${userId}/suspend`).set('Authorization', `Bearer ${token}`).send({});
  if (res.status !== 200 && res.status !== 201) throw new Error(`suspend failed: ${res.status} ${JSON.stringify(res.body)}`);
}
