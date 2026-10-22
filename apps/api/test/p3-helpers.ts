import type { INestApplication } from '@nestjs/common';
import { http } from './p1-helpers';

export async function createGradeCategory(app: INestApplication, token: string, courseId: number, overrides: Record<string, unknown> = {}): Promise<{ id: number; fullname: string; aggregation: string }> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/grades/categories`).set('Authorization', `Bearer ${token}`)
    .send({ fullname: 'Category', ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create grade category failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function createGradeItem(app: INestApplication, token: string, courseId: number, overrides: Record<string, unknown> = {}): Promise<{ id: number; itemname: string; grademax: number }> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/grades/items`).set('Authorization', `Bearer ${token}`)
    .send({ itemname: 'Item', ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create grade item failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function setGrade(app: INestApplication, token: string, itemId: number, userid: number, rawgrade: number | null, feedback?: string): Promise<{ id: number; finalgrade: number | null; frozen: boolean }> {
  const res = await http(app).post(`/api/v1/courses/grades/items/${itemId}/grades`).set('Authorization', `Bearer ${token}`)
    .send({ userid, rawgrade, feedback });
  if (res.status !== 200 && res.status !== 201) throw new Error(`set grade failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function getGradebook(app: INestApplication, token: string, courseId: number, userid?: number): Promise<{
  courseId: number; userId: number;
  categories: { category: { id: number }; total: { item: { id: number; grademax: number }; grade: { finalgrade: number | null; letter: string | null } | null } | null; items: { item: { id: number; itemname: string }; grade: { id: number; finalgrade: number | null; letter: string | null } | null }[]; children: unknown[] }[];
  courseTotal: { grade: { finalgrade: number | null; letter: string | null } | null } | null;
}> {
  const res = await http(app).get(`/api/v1/courses/${courseId}/gradebook`).query(userid ? { userid } : {}).set('Authorization', `Bearer ${token}`);
  if (res.status !== 200) throw new Error(`gradebook failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function courseTotalOf(app: INestApplication, token: string, courseId: number, userid: number): Promise<number | null> {
  const book = await getGradebook(app, token, courseId, userid);
  return book.courseTotal?.grade?.finalgrade ?? null;
}
