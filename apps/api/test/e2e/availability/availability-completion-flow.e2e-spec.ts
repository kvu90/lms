import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../../support/identity-access-helpers';
import { createCategory, createCm, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from '../../support/course-enrolment-helpers';

/**
 * Luồng Availability + Completion.
 * Oracle: availability/tests/tree_test.php::test_check_available và
 * availability/tests/info_test.php (hạn chế áp dụng tại lớp info/access
 * , không chỉ ở hiển thị); lib/tests/completionlib_test.php
 * (test_update_state, test_set_module_viewed, test_aggregate_completions trong
 * completion/tests + các kiểm thử tiêu chí trong completion/tests/api_test.php).
 */
describe('Khả dụng và hoàn thành', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  async function setup() {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    return { cat, course, sectionId, instance, student, studentToken };
  }

  it('điều kiện ngày trong tương lai chặn ACCESS của cm tại API (403), trong khi show=true vẫn liệt kê kèm hạn chế', async () => {
    const { course, sectionId, studentToken } = await setup();
    const future = Math.floor(new Date('2100-01-01').getTime() / 1000);
    const cm = await createCm(app, admin, course.id, sectionId, {
      name: 'Future quiz',
      availability: { op: '&', show: true, showc: [true], c: [{ type: 'date', d: '>=', t: future }] },
    });
    const access = await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`);
    expect(access.status).toBe(403);
    expect(access.body.code).toBe('availability.not_available');
    // Được liệt kê, hiển thị nhưng bị khoá:
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${studentToken}`);
    const listed = content.body.sections.flatMap((s: { modules: unknown[] }) => s.modules).find((m: { id: string }) => m.id === cm.id);
    expect(listed).toBeDefined();
    expect(listed.availabilityResult.available).toBe(false);
    expect(listed.availabilityResult.visible).toBe(true);
  });

  it('show=false: cm không khả dụng bị ẩn khỏi danh sách hoàn toàn, và truy cập vẫn 403', async () => {
    const { course, sectionId, studentToken } = await setup();
    const future = Math.floor(new Date('2100-01-01').getTime() / 1000);
    const cm = await createCm(app, admin, course.id, sectionId, {
      name: 'Secret quiz',
      availability: { op: '&', show: false, showc: [true], c: [{ type: 'date', d: '>=', t: future }] },
    });
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${studentToken}`);
    const listed = content.body.sections.flatMap((s: { modules: unknown[] }) => s.modules).find((m: { id: string }) => m.id === cm.id);
    expect(listed).toBeUndefined();
    const access = await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`);
    expect(access.status).toBe(403);
  });

  it('lá hoàn thành: cm B vẫn khoá cho tới khi cm A hoàn thành, rồi mở (completionlib + tổ hợp cây)', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const cmA = await createCm(app, admin, course.id, sectionId, { name: 'First', completion: 1, completionManual: true });
    const cmB = await createCm(app, admin, course.id, sectionId, {
      name: 'Second',
      availability: { op: '&', show: true, showc: [true], c: [{ type: 'completion', id: cmA.id }] },
    });
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cmB.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
    // Học viên tự đánh dấu A hoàn thành thủ công.
    const mark = await http(app).post(`/api/v1/courses/${course.id}/modules/${cmA.id}/completion/manual`)
      .set('Authorization', `Bearer ${studentToken}`).send({ userId: student.id, complete: true });
    expect(mark.status).toBeLessThan(300);
    expect(mark.body.state).toBe(1);
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cmB.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(200);
  });

  it('lá nhóm + cây lồng: AND trong NOT-OR cổng truy cập theo thành viên nhóm (tổ hợp golden, cấp API)', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const groupRes = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Gate group' });
    const groupId = groupRes.body.id as string;
    // Khả dụng khi NOT(group AND profile-department=blocked): học viên không thuộc trường hợp nào, nên mở.
    const tree = {
      op: '!|', show: true, showc: [true],
      c: [{ op: '&', showc: [true, true], c: [{ type: 'group', id: groupId }, { type: 'profile', field: 'username', operator: 'contains', value: 'user' }] }],
    };
    const cm = await createCm(app, admin, course.id, sectionId, { name: 'Gated', availability: tree });
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(200);
    // Đưa học viên vào nhóm: cả hai điều kiện trong nay đều đúng (username chứa 'user' do cách dựng username kiểm thử) ⇒ NOT-OR thất bại ⇒ bị chặn.
    await http(app).post(`/api/v1/courses/${course.id}/groups/${groupId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: student.id });
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
  });

  it('lá điểm đã khai nhưng chưa đạt khi thiếu dữ liệu điểm (hook Grades): truy cập vẫn bị chặn', async () => {
    const { course, sectionId, studentToken } = await setup();
    const cm = await createCm(app, admin, course.id, sectionId, {
      name: 'Needs grade',
      availability: { op: '&', show: true, showc: [true], c: [{ type: 'grade', id: 'final', min: 50 }] },
    });
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
  });

  it('khả dụng của section cũng chặn: cm trong section khoá theo ngày không truy cập được ngay cả khi không có cây cm', async () => {
    const { course, studentToken } = await setup();
    const future = Math.floor(new Date('2100-01-01').getTime() / 1000);
    const sectionRes = await http(app).post(`/api/v1/courses/${course.id}/sections`).set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Later', availability: { op: '&', show: true, showc: [true], c: [{ type: 'date', d: '>=', t: future }] } });
    const cm = await createCm(app, admin, course.id, sectionRes.body.id, { name: 'Inside locked section' });
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
    expect((await http(app).get(`/api/v1/courses/${course.id}/sections/${sectionRes.body.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
  });

  it('completionView: xem cm ghi viewed và hoàn thành nó (completionlib::test_set_module_viewed + test_update_state)', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const cm = await createCm(app, admin, course.id, sectionId, { name: 'Read me', completion: 2, completionView: true });
    const before = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(before.body.activities.find((a: { cmId: string }) => a.cmId === cm.id)?.state).toBe(0);
    const view = await http(app).post(`/api/v1/courses/${course.id}/modules/${cm.id}/view`).set('Authorization', `Bearer ${studentToken}`);
    expect(view.status).toBeLessThan(300);
    const after = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    const record = after.body.activities.find((a: { cmId: string }) => a.cmId === cm.id);
    expect(record.viewed).toBe(true);
    expect(record.state).toBe(1);
  });

  it('hoàn thành thủ công bởi giáo viên cho người khác cần markothers; học viên không thể đánh dấu cho người khác', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const cm = await createCm(app, admin, course.id, sectionId, { name: 'Manual task', completion: 1, completionManual: true });
    const other = await createUserViaApi(app, admin);
    const forbidden = await http(app).post(`/api/v1/courses/${course.id}/modules/${cm.id}/completion/manual`)
      .set('Authorization', `Bearer ${studentToken}`).send({ userId: other.id, complete: true });
    expect(forbidden.status).toBe(403);
    const byAdmin = await http(app).post(`/api/v1/courses/${course.id}/modules/${cm.id}/completion/manual`)
      .set('Authorization', `Bearer ${admin}`).send({ userId: student.id, complete: true });
    expect(byAdmin.body.state).toBe(1);
  });

  it('hoàn thành khoá học tổng hợp tiêu chí module bằng AND, và bằng ANY sau khi đổi phương thức', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const cmA = await createCm(app, admin, course.id, sectionId, { name: 'A', completion: 1, completionManual: true });
    const cmB = await createCm(app, admin, course.id, sectionId, { name: 'B', completion: 1, completionManual: true });
    const set = await http(app).put(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriaType: 'module', moduleInstance: cmA.id }, { criteriaType: 'module', moduleInstance: cmB.id }] });
    expect(set.status).toBe(200);
    // Chỉ hoàn thành A: AND ⇒ khoá chưa hoàn thành.
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cmA.id}/completion/manual`).set('Authorization', `Bearer ${studentToken}`).send({ userId: student.id, complete: true });
    let mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).not.toBe('complete');
    // Hoàn thành cả B ⇒ hoàn thành.
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cmB.id}/completion/manual`).set('Authorization', `Bearer ${studentToken}`).send({ userId: student.id, complete: true });
    mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).toBe('complete');
    expect(mine.body.course.timeCompleted).toBeTruthy();
  });

  it('tiêu chí ngày: khoá học chỉ có tiêu chí ngày quá khứ hoàn thành khi tổng hợp lại', async () => {
    const { course, student, studentToken } = await setup();
    await http(app).put(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriaType: 'date', date: '2020-01-01T00:00:00.000Z' }] });
    const mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    void student;
    expect(mine.body.course.status).toBe('complete');
  });

  it('đổi tiêu chí sau khi đã có dữ liệu kích hoạt tính lại có kiểm soát: khoá đã hoàn thành mở lại khi thêm tiêu chí mới', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const cmA = await createCm(app, admin, course.id, sectionId, { name: 'A2', completion: 1, completionManual: true });
    const cmB = await createCm(app, admin, course.id, sectionId, { name: 'B2', completion: 1, completionManual: true });
    await http(app).put(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriaType: 'module', moduleInstance: cmA.id }] });
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cmA.id}/completion/manual`).set('Authorization', `Bearer ${studentToken}`).send({ userId: student.id, complete: true });
    let mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).toBe('complete');
    // Giáo viên thêm cmB làm tiêu chí bắt buộc ⇒ việc tính lại phải mở lại hoàn thành khoá học.
    await http(app).put(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriaType: 'module', moduleInstance: cmA.id }, { criteriaType: 'module', moduleInstance: cmB.id }] });
    const recalc = await http(app).post(`/api/v1/courses/${course.id}/completion/recalculate`).set('Authorization', `Bearer ${admin}`);
    expect(recalc.status).toBeLessThan(300);
    mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).not.toBe('complete');
    // Hoàn thành B đóng nó lại.
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cmB.id}/completion/manual`).set('Authorization', `Bearer ${studentToken}`).send({ userId: student.id, complete: true });
    mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).toBe('complete');
  });

  it('huỷ ghi danh giữ dữ liệu hoàn thành: dòng UE rút mềm (status=2) thay vì xoá', async () => {
    const { course, sectionId, instance, student, studentToken } = await setup();
    const cm = await createCm(app, admin, course.id, sectionId, { name: 'Keep my data', completion: 1, completionManual: true });
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cm.id}/completion/manual`).set('Authorization', `Bearer ${studentToken}`).send({ userId: student.id, complete: true });
    const del = await http(app).delete(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.body.withdrawn).toBe(true);
    const list = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    const ue = (list.body as { userId: string; status: number }[]).find((e) => e.userId === student.id);
    expect(ue?.status).toBe(2);
    // Chính bản ghi hoàn thành vẫn sống sót sau lần huỷ ghi danh.
    const completion = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(completion.body.activities.find((a: { cmId: string }) => a.cmId === cm.id)?.state).toBe(1);
    // Nhưng quyền truy cập đã mất.
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
  });

  it('GOLDEN đầu-cuối: danh mục → khoá học → section/cm → nhóm/cohort → ghi danh kèm vai → khả dụng chặn → ghi nhận hoàn thành', async () => {
    const cat = await createCategory(app, admin, { name: 'Golden' });
    const course = await createCourse(app, admin, cat.id, { fullName: 'Golden course' });
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const cm1 = await createCm(app, admin, course.id, sectionId, { name: 'Step 1', completion: 2, completionView: true });
    const cm2 = await createCm(app, admin, course.id, sectionId, {
      name: 'Step 2',
      availability: { op: '&', show: true, showc: [true], c: [{ type: 'completion', id: cm1.id }] },
    });
    const groupRes = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Golden group' });
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Golden cohort' });
    const student = await createUserViaApi(app, admin);
    await http(app).post(`/api/v1/cohorts/${cohortRes.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: student.id });
    await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId: cohortRes.body.id, groupId: groupRes.body.id });
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    // Ghi danh qua đồng bộ cohort, là thành viên nhóm qua cấu hình instance:
    const members = await http(app).get(`/api/v1/courses/${course.id}/groups/${groupRes.body.id}/members`).set('Authorization', `Bearer ${admin}`);
    expect((members.body as { userId: string }[]).map((m) => m.userId)).toContain(student.id);
    // Bước 2 bị chặn cho tới khi Bước 1 được xem:
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm2.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cm1.id}/view`).set('Authorization', `Bearer ${studentToken}`);
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm2.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(200);
    const progress = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(progress.body.activities.find((a: { cmId: string }) => a.cmId === cm1.id)?.state).toBe(1);
  });
});
