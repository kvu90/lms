import type { INestApplication } from '@nestjs/common';
import { http } from './identity-access-helpers';

export async function createGradeCategory(app: INestApplication, token: string, courseId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; fullName: string; aggregation: string }> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/grades/categories`).set('Authorization', `Bearer ${token}`)
    .send({ fullName: 'Category', ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create grade category failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function createGradeItem(app: INestApplication, token: string, courseId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; itemName: string; gradeMax: number }> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/grades/items`).set('Authorization', `Bearer ${token}`)
    .send({ itemName: 'Item', ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create grade item failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function setGrade(app: INestApplication, token: string, itemId: string, userId: string, rawGrade: number | null, feedback?: string): Promise<{ id: string; finalGrade: number | null; frozen: boolean }> {
  const res = await http(app).post(`/api/v1/courses/grades/items/${itemId}/grades`).set('Authorization', `Bearer ${token}`)
    .send({ userId, rawGrade, feedback });
  if (res.status !== 200 && res.status !== 201) throw new Error(`set grade failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function getGradebook(app: INestApplication, token: string, courseId: string, userId?: string): Promise<{
  courseId: string; userId: string;
  categories: { category: { id: string }; total: { item: { id: string; gradeMax: number }; grade: { finalGrade: number | null; letter: string | null } | null } | null; items: { item: { id: string; itemName: string }; grade: { id: string; finalGrade: number | null; letter: string | null } | null }[]; children: unknown[] }[];
  courseTotal: { grade: { finalGrade: number | null; letter: string | null } | null } | null;
}> {
  const res = await http(app).get(`/api/v1/courses/${courseId}/gradebook`).query(userId ? { userId } : {}).set('Authorization', `Bearer ${token}`);
  if (res.status !== 200) throw new Error(`gradebook failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function courseTotalOf(app: INestApplication, token: string, courseId: string, userId: string): Promise<number | null> {
  const book = await getGradebook(app, token, courseId, userId);
  return book.courseTotal?.grade?.finalGrade ?? null;
}
