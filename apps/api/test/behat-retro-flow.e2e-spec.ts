import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance } from './course-enrolment-helpers';
import { createGradeItem, setGrade, getGradebook } from './assessment-helpers';
import { createGroupViaApi } from './engagement-helpers';

/**
 * Rà soát ngược oracle Behat (MOODLE_503_STABLE): các scenario hành trình có ý nghĩa
 * nghiệp vụ mà bộ e2e trước đây chưa phủ. Các bước gắn với giao diện PHP (bấm nút,
 * điền form) được bỏ qua theo quy ước; chỉ dịch bước nghiệp vụ + kết quả kỳ vọng
 * thành lời gọi HTTP. Nguồn đối chiếu ghi tại từng test.
 */
describe('Behat retro-audit journeys', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  it('cohort enrolment places synced members into the instance group (Behat: enrol/cohort/tests/behat/enrolcohorts.feature — "Course cohort enrolment creates a new group"; ở hệ này instance trỏ tới một group có sẵn qua groupId)', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const group = await createGroupViaApi(app, admin, course.id, 'Cohort class A');
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Sync group cohort' });
    expect(cohortRes.status).toBe(201);
    const cohortId = cohortRes.body.id as string;
    await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId, groupId: group.id });
    const user = await createUserViaApi(app, admin);
    // Vào cohort ⇒ được ghi danh qua cohort sync VÀ vào group của instance.
    await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });
    const userToken = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    const mine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${userToken}`);
    expect(mine.body).toMatchObject({ enrolled: true, active: true });
    const members = await http(app).get(`/api/v1/courses/${course.id}/groups/${group.id}/members`).set('Authorization', `Bearer ${admin}`);
    expect(members.status).toBe(200);
    expect((members.body as { userId: string }[]).some((m) => m.userId === user.id)).toBe(true);
  });

  it('badge criteria can require another badge: badge B is issued only after badge A (Behat: badges/tests/behat/criteria_*.feature họ tiêu chí; lá "badge" của evaluator)', async () => {
    const student = await createUserViaApi(app, admin);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    // Badge A: tiêu chí manual, cấp thủ công.
    const aRes = await http(app).post('/api/v1/badges').set('Authorization', `Bearer ${admin}`).send({ name: 'Step one', type: 1, issuerName: 'LMS HQ' });
    const aId = aRes.body.id as string;
    await http(app).put(`/api/v1/badges/${aId}/criteria`).set('Authorization', `Bearer ${admin}`).send({ method: 1, criteria: [{ criteriaType: 'manual', params: {} }] });
    await http(app).post(`/api/v1/badges/${aId}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 1 });
    // Badge B: yêu cầu đã có badge A.
    const bRes = await http(app).post('/api/v1/badges').set('Authorization', `Bearer ${admin}`).send({ name: 'Step two', type: 1, issuerName: 'LMS HQ' });
    const bId = bRes.body.id as string;
    await http(app).put(`/api/v1/badges/${bId}/criteria`).set('Authorization', `Bearer ${admin}`).send({ method: 1, criteria: [{ criteriaType: 'badge', params: { badgeId: aId } }] });
    await http(app).post(`/api/v1/badges/${bId}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 1 });
    // Chưa có A ⇒ đánh giá B không đạt, B chưa được cấp.
    const evaluation = await http(app).post(`/api/v1/badges/${bId}/evaluate`).set('Authorization', `Bearer ${admin}`).send({ userId: student.id });
    expect(evaluation.body.satisfied).toBe(false);
    // Cấp A thủ công ⇒ lần đánh giá toàn cục tiếp theo cấp B.
    await http(app).post(`/api/v1/badges/${aId}/award`).set('Authorization', `Bearer ${admin}`).send({ userId: student.id });
    await http(app).post('/api/v1/badges/evaluate-user').set('Authorization', `Bearer ${admin}`).send({ userId: student.id });
    const mine = await http(app).get('/api/v1/badges/mine').set('Authorization', `Bearer ${studentToken}`);
    const ids = (mine.body as { badgeId: string }[]).map((r) => r.badgeId);
    expect(ids).toContain(aId);
    expect(ids).toContain(bId);
  });

  it('deleting a calendar event removes it from the owner listing (Behat: calendar/tests/behat/calendar.feature — "Delete an event")', async () => {
    const user = await createUserViaApi(app, admin);
    const userToken = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const created = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Dentist appointment', eventType: 'user', timeStart: soon });
    expect(created.status).toBe(201);
    const eventId = created.body.event.id as string;
    let list = await http(app).get('/api/v1/calendar/events').set('Authorization', `Bearer ${userToken}`);
    expect((list.body as { id: string }[]).some((e) => e.id === eventId)).toBe(true);
    const removed = await http(app).delete(`/api/v1/calendar/events/${eventId}`).set('Authorization', `Bearer ${userToken}`);
    expect(removed.status).toBe(200);
    list = await http(app).get('/api/v1/calendar/events').set('Authorization', `Bearer ${userToken}`);
    expect((list.body as { id: string }[]).some((e) => e.id === eventId)).toBe(false);
  });

  it('grade scales: a scale item takes index grades and reports them in the gradebook (Behat: grade/tests/behat/grade_scales.feature)', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const scaleRes = await http(app).post(`/api/v1/courses/${course.id}/grades/scales`).set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Quality scale', scale: 'Poor,OK,Good,Excellent' });
    expect(scaleRes.status).toBe(201);
    const scaleId = scaleRes.body.id as string;
    const listed = await http(app).get(`/api/v1/courses/${course.id}/grades/scales`).set('Authorization', `Bearer ${admin}`);
    expect((listed.body as { id: string }[]).some((s) => s.id === scaleId)).toBe(true);
    // Item dùng scale: gradeMax bằng số mức của scale (4).
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Essay quality', scaleId, gradeMax: 4 });
    const student = await createUserViaApi(app, admin);
    const instance = await createEnrolInstance(app, admin, course.id);
    await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/enrol`).set('Authorization', `Bearer ${admin}`).send({ userId: student.id });
    const grade = await setGrade(app, admin, item.id, student.id, 3);
    expect(grade.finalGrade).toBe(3);
    const book = await getGradebook(app, admin, course.id, student.id);
    const allItems = book.categories.flatMap((c) => c.items);
    const row = allItems.find((i) => i.item.id === item.id);
    expect(row?.grade?.finalGrade).toBe(3);
  });
});
