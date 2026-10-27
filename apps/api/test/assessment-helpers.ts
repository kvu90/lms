import type { INestApplication } from '@nestjs/common';
import { http } from './identity-access-helpers';

export async function createGradeItem(app: INestApplication, token: string, courseId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; itemName: string; gradeMax: number }> {
  const res = await http(app).post(`/api/v1/courses/${courseId}/grade-items`).set('Authorization', `Bearer ${token}`)
    .send({ itemName: 'Item', ...overrides });
  if (res.status !== 200 && res.status !== 201) throw new Error(`create grade item failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function setGrade(app: INestApplication, token: string, itemId: string, userId: string, rawGrade: number | null, feedback?: string): Promise<{ id: string; finalGrade: number | null; frozen: boolean }> {
  const res = await http(app).post(`/api/v1/grade-items/${itemId}/grades`).set('Authorization', `Bearer ${token}`)
    .send({ userId, rawGrade, feedback });
  if (res.status !== 200 && res.status !== 201) throw new Error(`set grade failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Điểm theo từng bài của một học sinh trong khoá (GET gradebook — hình mới từ issue #224: không còn categories/courseTotal). */
export async function getGradebook(app: INestApplication, token: string, courseId: string, userId?: string): Promise<{
  courseId: string; userId: string;
  activities: {
    item: { id: string; itemName: string; itemType: string; itemInstance: string | null; gradeMax: number; hidden: boolean };
    grade: { id: string; finalGrade: number | null; feedback: string | null } | null;
    publication: { policy: string; published: boolean };
  }[];
}> {
  const res = await http(app).get(`/api/v1/courses/${courseId}/gradebook`).query(userId ? { userId } : {}).set('Authorization', `Bearer ${token}`);
  if (res.status !== 200) throw new Error(`gradebook failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
