import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD,
} from '../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../support/course-enrolment-helpers';

/**
 * Luồng Enrol + Groups/Cohort.
 * Oracle: enrol/tests/enrollib_test.php (test_user_enrolment_created_event,
 * test_enrol_get_my_courses_only_enrolled_courses, ngữ nghĩa đình chỉ từ
 * lib/tests/enrollib trong báo cáo §2#5), group/tests/lib_test.php
 * (test_member_added_event, test_groups_delete_groupings_groups,
 * tư cách thành viên nhóm), hành vi đồng bộ cohort từ ngữ nghĩa của plugin enrol_cohort
 * như mô tả trong báo cáo §2#6.
 * Oracle Behat (đợt business-gaps): enrol/self/tests/behat/
 * self_enrolment.feature ("Self-enrolment enabled requiring an enrolment
 * key", "...requiring a group enrolment key", "Self unenrol as a
 * self-enrolled student"), các kịch bản welcome-message của enrol/self + enrol/manual
 * , enrol/cohort/tests/behat/enrolcohorts.feature ("Editing a
 * cohort enrolment method's role should change participants' role").
 */
describe('Enrol & groups/cohorts', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  async function setupCourse(groupMode = 0) {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id, { groupMode });
    const instance = await createEnrolInstance(app, admin, course.id);
    return { cat, course, instance };
  }

  it('enrolling grants the student role at the course context, emits user_enrolled, and isEnrolled separates enrol from capability', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    const ue = await enrolUser(app, admin, course.id, instance.id, user.id);
    expect(ue.status).toBe(0);
    // Gán vai tại context khoá học:
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    const assignments = await http(app).get('/api/v1/access/assignments')
      .query({ userId: user.id, contextId: content.body.contextId }).set('Authorization', `Bearer ${admin}`);
    const studentRole = await roleIdByShortname(app, admin, 'student');
    expect((assignments.body as { roleId: string }[]).some((a) => a.roleId === studentRole)).toBe(true);
    // Góc nhìn facade isEnrolled:
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const mine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(mine.body).toMatchObject({ enrolled: true, active: true });
    // Và người dùng thực sự truy cập được nội dung khoá học.
    const asUser = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(asUser.status).toBe(200);
    // Người dùng chưa ghi danh bị từ chối dù vai `user` ảo cấp course:view trong bộ đánh giá (evaluator):
    const outsider = await createUserViaApi(app, admin);
    const outsiderLogin = await login(app, outsider.username, STRONG_PASSWORD);
    const asOutsider = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${outsiderLogin.accessToken}`);
    expect(asOutsider.status).toBe(403);
  });

  it('SUSPENDED user is blocked from course content despite holding the student role; reactivation restores access', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const suspend = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${user.id}/suspend`)
      .set('Authorization', `Bearer ${admin}`);
    expect(suspend.body.status).toBe(1);
    const blocked = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(blocked.status).toBe(403);
    const mine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(mine.body).toMatchObject({ enrolled: true, active: false });
    const reactivate = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${user.id}/reactivate`)
      .set('Authorization', `Bearer ${admin}`);
    expect(reactivate.body.status).toBe(0);
    const restored = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(restored.status).toBe(200);
  });

  it('a suspended user who ALSO holds a real teacher assignment still gets in via course:view (the documented exception)', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    const teacherRole = await roleIdByShortname(app, admin, 'teacher');
    // Thứ tự fixture: đình chỉ ghi danh TRƯỚC khi gán vai giáo viên.
    // Từ issue #425, gán vai giảng dạy cho học viên đang học ĐANG
    // HOẠT ĐỘNG trong chính khoá đó bị chốt tách vai chặn (lẫn vai
    // cùng khoá); ghi danh đã đình chỉ (status khác 0) không thuộc
    // định nghĩa lẫn vai nên trạng thái "đã đình chỉ + có gán vai
    // thật" của ca này vẫn dựng được nguyên vẹn.
    await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${user.id}/suspend`).set('Authorization', `Bearer ${admin}`);
    await assignRole(app, admin, user.id, teacherRole, content.body.contextId);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(res.status).toBe(200);
  });

  it('unenrol without related data removes the enrolment and the granted role; user_unenrolled is emitted', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);
    const del = await http(app).delete(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${user.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.body.withdrawn).toBe(false);
    const list = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list.body as { userId: string }[]).some((e) => e.userId === user.id)).toBe(false);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('groups + groupings: membership, grouping links, and deleting a group cleans its links (lib_test::test_groups_delete_*)', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);
    const gA = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Team A' });
    const gB = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Team B' });
    expect(gA.status).toBe(201);
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });
    const members = await http(app).get(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${admin}`);
    expect((members.body as { userId: string }[]).map((m) => m.userId)).toContain(user.id);
    const grouping = await http(app).post(`/api/v1/courses/${course.id}/groupings`).set('Authorization', `Bearer ${admin}`).send({ name: 'All teams' });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupId: gA.body.id });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupId: gB.body.id });
    const inGrouping = await http(app).get(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((inGrouping.body as { id: string }[]).map((g) => g.id).sort()).toEqual([gA.body.id, gB.body.id].sort());
    // Xoá nhóm A loại nó khỏi grouping.
    await http(app).delete(`/api/v1/courses/${course.id}/groups/${gA.body.id}`).set('Authorization', `Bearer ${admin}`);
    const after = await http(app).get(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((after.body as { id: string }[]).map((g) => g.id)).toEqual([gB.body.id]);
  });

  it('SEPARATE GROUPS is a server-side data law: a student in group A gets 403 for group B members and never sees them in lists', async () => {
    const { course, instance } = await setupCourse(1); // SEPARATEGROUPS
    const alice = await createUserViaApi(app, admin);
    const bob = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, alice.id);
    await enrolUser(app, admin, course.id, instance.id, bob.id);
    const gA = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Alpha' });
    const gB = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Beta' });
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: alice.id });
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gB.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: bob.id });

    const aliceLogin = await login(app, alice.username, STRONG_PASSWORD);
    // Yêu cầu trực tiếp lấy thành viên của nhóm khác bị chặn tại máy chủ.
    const forbidden = await http(app).get(`/api/v1/courses/${course.id}/groups/${gB.body.id}/members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('group.separate_groups_denied');
    // Nhóm của chính cô ấy thì được phép.
    const own = await http(app).get(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect(own.status).toBe(200);
    // Danh sách nhóm CHỈ chứa nhóm của cô ấy.
    const list = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((list.body as { id: string }[]).map((g) => g.id)).toEqual([gA.body.id]);
    // Bản tổng hợp thành viên hiển thị chỉ chứa tư cách thành viên của chính cô ấy.
    const visibleMembers = await http(app).get(`/api/v1/courses/${course.id}/groups/visible-members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect(visibleMembers.body).toEqual([{ groupId: gA.body.id, userId: alice.id }]);
    // Admin (accessallgroups via manager/siteadmin) sees everything —
    // gồm cả nhóm "Cả lớp" tự sinh của CLASS-0 khi khoá nằm trong lớp
    // (đóng gói PR #200: mọi khoá dạy thật đều thuộc một lớp).
    const adminList = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((adminList.body as unknown[]).length).toBe(3);
  });

  it('cohort sync: adding a user to a cohort enrols them into linked courses; removing suspends by default and unenrols when configured', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Class of 2026' });
    expect(cohortRes.status).toBe(201);
    const cohortId = cohortRes.body.id as string;
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId });
    const user = await createUserViaApi(app, admin);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);

    // Thêm vào cohort ⇒ đã ghi danh + truy cập được.
    await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });
    const enrolled = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolled.body as { userId: string; status: number }[]).find((e) => e.userId === user.id)?.status).toBe(0);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);

    // Loại khỏi cohort ⇒ bị đình chỉ (chế độ đồng bộ mặc định), truy cập bị chặn.
    await http(app).delete(`/api/v1/cohorts/${cohortId}/members/${user.id}`).set('Authorization', `Bearer ${admin}`);
    const afterRemove = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((afterRemove.body as { userId: string; status: number }[]).find((e) => e.userId === user.id)?.status).toBe(1);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(403);

    // Khoá thứ hai với onCohortLeave=unenrol: việc loại bỏ rút toàn bộ ghi danh.
    const course2 = await createCourse(app, admin, cat.id);
    const cohort2 = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Strict cohort' });
    await createEnrolInstance(app, admin, course2.id, { method: 'cohort', cohortId: cohort2.body.id, onCohortLeave: 'unenrol' });
    void instance;
    await http(app).post(`/api/v1/cohorts/${cohort2.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });
    let list2 = await http(app).get(`/api/v1/courses/${course2.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list2.body as { userId: string }[]).some((e) => e.userId === user.id)).toBe(true);
    await http(app).delete(`/api/v1/cohorts/${cohort2.body.id}/members/${user.id}`).set('Authorization', `Bearer ${admin}`);
    list2 = await http(app).get(`/api/v1/courses/${course2.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list2.body as { userId: string }[]).some((e) => e.userId === user.id)).toBe(false);
  });

  it('a cohort enrol instance created AFTER users joined the cohort syncs the existing members', async () => {
    const cat = await createCategory(app, admin);
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Early joiners' });
    const user = await createUserViaApi(app, admin);
    await http(app).post(`/api/v1/cohorts/${cohortRes.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });
    const course = await createCourse(app, admin, cat.id);
    await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId: cohortRes.body.id });
    const list = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list.body as { userId: string; status: number }[]).find((e) => e.userId === user.id)?.status).toBe(0);
  });

  it('expired enrolment (timeEnd in the past) is not active: access blocked before any sweep runs', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    await enrolUser(app, admin, course.id, instance.id, user.id, { timeStart: twoDaysAgo, timeEnd: yesterday });
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const mine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(mine.body).toMatchObject({ enrolled: true, active: false });
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(403);
  });

  it('self enrol instance: a user can self-enrol; a manual instance refuses self-enrol', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const selfInstance = await createEnrolInstance(app, admin, course.id, { method: 'self' });
    const manualInstance = await createEnrolInstance(app, admin, course.id, { method: 'manual' });
    const user = await createUserViaApi(app, admin);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const bad = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${manualInstance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect(bad.status).toBe(400);
    const ok = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${selfInstance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect(ok.status).toBeLessThan(300);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);
  });

  it('enrolment key: a keyed self instance refuses missing/wrong keys with 400 and enrols nobody, enrols with the correct key, and never leaks the key to non-managers (Behat self_enrolment.feature "Self-enrolment enabled requiring an enrolment key")', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'self', enrolmentKey: 's3cret-key' }) as unknown as { id: string; enrolmentKey: string | null };
    // Người quản lý đã tạo instance thấy được khoá.
    expect(instance.enrolmentKey).toBe('s3cret-key');
    const user = await createUserViaApi(app, admin);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    // Người không phải quản lý khi liệt kê instance không bao giờ thấy giá trị khoá.
    const listed = await http(app).get(`/api/v1/courses/${course.id}/enrol/instances`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect((listed.body as { id: string; enrolmentKey: string | null }[]).find((i) => i.id === instance.id)?.enrolmentKey).toBeNull();
    const listedAdmin = await http(app).get(`/api/v1/courses/${course.id}/enrol/instances`).set('Authorization', `Bearer ${admin}`);
    expect((listedAdmin.body as { id: string; enrolmentKey: string | null }[]).find((i) => i.id === instance.id)?.enrolmentKey).toBe('s3cret-key');
    // Thiếu khoá ⇒ 400 enrol.enrolment_key_required, không ghi danh nào được tạo.
    const missing = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('enrol.enrolment_key_required');
    // Sai khoá ⇒ 400 enrol.invalid_enrolment_key, vẫn không có ghi danh.
    const wrong = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({ enrolmentKey: 'not-the-key' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('enrol.invalid_enrolment_key');
    const enrolments = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolments.body as { userId: string }[]).some((e) => e.userId === user.id)).toBe(false);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(403);
    // Đúng khoá ⇒ đã ghi danh và truy cập được khoá học.
    const ok = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({ enrolmentKey: 's3cret-key' });
    expect(ok.status).toBeLessThan(300);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);
  });

  it('group enrolment key: a key matching a course group enrols AND places the learner in that group, while the instance key enrols without group placement (Behat self_enrolment.feature "...requiring a group enrolment key")', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const group = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Keyed team', enrolmentKey: 'group-key-1' });
    expect(group.status).toBe(201);
    expect(group.body.enrolmentKey).toBe('group-key-1');
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'self', enrolmentKey: 'course-key' });

    // Alice dùng khoá NHÓM: đã ghi danh + là thành viên của nhóm.
    const alice = await createUserViaApi(app, admin);
    const aliceLogin = await login(app, alice.username, STRONG_PASSWORD);
    const aliceRes = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/self-enrol`).set('Authorization', `Bearer ${aliceLogin.accessToken}`).send({ enrolmentKey: 'group-key-1' });
    expect(aliceRes.status).toBeLessThan(300);
    const members = await http(app).get(`/api/v1/courses/${course.id}/groups/${group.body.id}/members`).set('Authorization', `Bearer ${admin}`);
    expect((members.body as { userId: string }[]).map((m) => m.userId)).toContain(alice.id);
    // Khoá nhóm bị ẩn khỏi học viên đã ghi danh.
    const aliceGroups = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((aliceGroups.body as { id: string; enrolmentKey: string | null }[]).find((g) => g.id === group.body.id)?.enrolmentKey).toBeNull();

    // Bob dùng khoá INSTANCE: đã ghi danh, nhưng KHÔNG được xếp vào nhóm.
    const bob = await createUserViaApi(app, admin);
    const bobLogin = await login(app, bob.username, STRONG_PASSWORD);
    const bobRes = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/self-enrol`).set('Authorization', `Bearer ${bobLogin.accessToken}`).send({ enrolmentKey: 'course-key' });
    expect(bobRes.status).toBeLessThan(300);
    const membersAfter = await http(app).get(`/api/v1/courses/${course.id}/groups/${group.body.id}/members`).set('Authorization', `Bearer ${admin}`);
    expect((membersAfter.body as { userId: string }[]).map((m) => m.userId)).not.toContain(bob.id);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${bobLogin.accessToken}`)).status).toBe(200);
  });

  it('self-unenrol: a self-enrolled student can unenrol themselves (role removed, access lost), while an enrolment from another method refuses self-unenrol (Behat self_enrolment.feature "Self unenrol as a self-enrolled student")', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const selfInstance = await createEnrolInstance(app, admin, course.id, { method: 'self' });
    const manualInstance = await createEnrolInstance(app, admin, course.id, { method: 'manual' });

    // Học viên được ghi danh thủ công không thể tự huỷ ghi danh: ghi danh đó không thuộc quyền của họ để kết thúc qua endpoint này.
    const other = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, manualInstance.id, other.id);
    const otherLogin = await login(app, other.username, STRONG_PASSWORD);
    const refused = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${manualInstance.id}/self-unenrol`).set('Authorization', `Bearer ${otherLogin.accessToken}`).send({});
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('enrol.self_unenrol_not_allowed');
    const otherMine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${otherLogin.accessToken}`);
    expect(otherMine.body).toMatchObject({ enrolled: true, active: true });

    // Học viên tự ghi danh tự huỷ ghi danh qua cùng đường huỷ ghi danh như admin.
    const user = await createUserViaApi(app, admin);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${selfInstance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);
    const un = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${selfInstance.id}/self-unenrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect(un.status).toBeLessThan(300);
    expect(un.body.withdrawn).toBe(false);
    const list = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list.body as { userId: string }[]).some((e) => e.userId === user.id)).toBe(false);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(403);
    // Lần tự huỷ ghi danh thứ hai không tìm thấy ghi danh nào để kết thúc.
    const again = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${selfInstance.id}/self-unenrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('enrol.user_not_enrolled');
  });

  it('welcome message: self enrol sends the configured welcome notification through Messaging, manual enrol only when the instance enables it (default off) (Behat enrol/self + enrol/manual welcome-message scenarios)', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const selfInstance = await createEnrolInstance(app, admin, course.id, { method: 'self', welcomeMessage: 'Xin chào! Chào mừng bạn tới {coursename}.' }) as unknown as { id: string; sendWelcomeMessage: boolean };
    // Mặc định của Moodle: tự ghi danh gửi tin nhắn chào mừng, ghi danh thủ công thì không.
    expect(selfInstance.sendWelcomeMessage).toBe(true);
    const manualInstance = await createEnrolInstance(app, admin, course.id, { method: 'manual' }) as unknown as { id: string; sendWelcomeMessage: boolean };
    expect(manualInstance.sendWelcomeMessage).toBe(false);
    const manualWelcomeInstance = await createEnrolInstance(app, admin, course.id, { method: 'manual', sendWelcomeMessage: true, welcomeMessage: 'Manual welcome for {coursename}' });

    // Tự ghi danh ⇒ thông báo chào mừng mang nội dung tuỳ chỉnh của instance.
    const alice = await createUserViaApi(app, admin);
    const aliceLogin = await login(app, alice.username, STRONG_PASSWORD);
    await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${selfInstance.id}/self-enrol`).set('Authorization', `Bearer ${aliceLogin.accessToken}`).send({});
    const aliceNotifs = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    const aliceWelcome = (aliceNotifs.body.items as { eventType: string; fullMessage: string }[]).find((n) => n.eventType === 'enrol_welcome');
    expect(aliceWelcome).toBeDefined();
    expect(aliceWelcome!.fullMessage).toContain('Xin chào! Chào mừng bạn tới');

    // Ghi danh thủ công với cấu hình mặc định ⇒ không có thông báo chào mừng.
    const bob = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, manualInstance.id, bob.id);
    const bobLogin = await login(app, bob.username, STRONG_PASSWORD);
    const bobNotifs = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${bobLogin.accessToken}`);
    expect((bobNotifs.body.items as { eventType: string }[]).some((n) => n.eventType === 'enrol_welcome')).toBe(false);

    // Ghi danh thủ công với chào mừng được bật tường minh ⇒ chào mừng kèm nội dung tuỳ chỉnh.
    const carol = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, manualWelcomeInstance.id, carol.id);
    const carolLogin = await login(app, carol.username, STRONG_PASSWORD);
    const carolNotifs = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${carolLogin.accessToken}`);
    const carolWelcome = (carolNotifs.body.items as { eventType: string; fullMessage: string }[]).find((n) => n.eventType === 'enrol_welcome');
    expect(carolWelcome).toBeDefined();
    expect(carolWelcome!.fullMessage).toContain('Manual welcome for');
  });

  it('cohort role reassignment: editing a cohort enrolment method role re-assigns already-enrolled participants to the new role and keeps their enrolment (Behat enrolcohorts.feature "Editing a cohort enrolment method\'s role should change participants\' role")', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Role change cohort' });
    const cohortId = cohortRes.body.id as string;
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId, roleShortname: 'student' });
    const user = await createUserViaApi(app, admin);
    await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });

    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    const studentRole = await roleIdByShortname(app, admin, 'student');
    const teacherRole = await roleIdByShortname(app, admin, 'teacher');
    const assignmentsOf = async () => {
      const res = await http(app).get('/api/v1/access/assignments').query({ userId: user.id, contextId: content.body.contextId }).set('Authorization', `Bearer ${admin}`);
      return (res.body as { roleId: string }[]).map((a) => a.roleId);
    };
    expect(await assignmentsOf()).toContain(studentRole);
    expect(await assignmentsOf()).not.toContain(teacherRole);

    // Sửa vai của instance ⇒ vai của người tham gia theo đó, ghi danh không bị đụng tới.
    const patched = await http(app).patch(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}`).set('Authorization', `Bearer ${admin}`).send({ roleShortname: 'teacher' });
    expect(patched.status).toBe(200);
    expect(patched.body.roleId).toBe(teacherRole);
    expect(await assignmentsOf()).toContain(teacherRole);
    expect(await assignmentsOf()).not.toContain(studentRole);
    const enrolments = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolments.body as { userId: string; status: number }[]).find((e) => e.userId === user.id)?.status).toBe(0);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);
  });

  // Các chế độ hiển thị nhóm (separate/visible) — đợt business-gaps.
  // Oracle: MoodleDocs "Groups" (separate groups: mỗi nhóm chỉ thấy được
  // nhóm của mình, các nhóm khác vô hình; visible groups: mỗi nhóm làm việc
  // trong nhóm của mình nhưng cũng thấy được các nhóm khác — chỉ đọc) và Behat
  // mod/assign/tests/behat/assign_group_override.feature ("A teacher without
  // accessallgroups permission should only be able to add group override for
  // groups that he/she is a member of, when the activity's group mode is
  // 'separate groups'" — tức hạn chế separate-groups được gỡ bỏ bởi
  // các capability của nhân sự accessallgroups/managegroups).
  async function setupTwoGroups(groupMode: number) {
    const { course, instance } = await setupCourse(groupMode);
    const alice = await createUserViaApi(app, admin);
    const bob = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, alice.id);
    await enrolUser(app, admin, course.id, instance.id, bob.id);
    const gA = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Alpha' });
    const gB = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Beta' });
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: alice.id });
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gB.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: bob.id });
    const aliceLogin = await login(app, alice.username, STRONG_PASSWORD);
    return { course, alice, bob, gA: gA.body, gB: gB.body, aliceLogin };
  }

  it('VISIBLE GROUPS: a student in group A sees BOTH groups and the members of group B, but write operations stay capability-gated (MoodleDocs Groups — visible groups are read-only for other groups)', async () => {
    const { course, bob, gA, gB, aliceLogin } = await setupTwoGroups(2); // VISIBLEGROUPS
    // Group list contains both groups — cộng nhóm "Cả lớp" tự sinh của
    // CLASS-0 (khoá thuộc lớp thì có thêm nhóm này, PR #200).
    const adminGroups = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`);
    const classGroupId = (adminGroups.body as { id: string; name: string }[]).find((g) => g.name === 'Cả lớp')!.id;
    const list = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((list.body as { id: string }[]).map((g) => g.id).sort()).toEqual([gA.id, gB.id, classGroupId].sort());
    // Thành viên của nhóm KHÁC đọc được ở chế độ visible.
    const otherMembers = await http(app).get(`/api/v1/courses/${course.id}/groups/${gB.id}/members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect(otherMembers.status).toBe(200);
    expect((otherMembers.body as { userId: string }[]).map((m) => m.userId)).toContain(bob.id);
    // Bản tổng hợp thành viên hiển thị bao phủ cả hai nhóm.
    const visibleMembers = await http(app).get(`/api/v1/courses/${course.id}/groups/visible-members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((visibleMembers.body as { groupId: string }[]).map((r) => r.groupId).sort()).toEqual([gA.id, gB.id].sort());
    // Chỉ đọc nghĩa là chỉ đọc: việc thêm thành viên vào nhóm B vẫn bị gác bởi course:managegroups.
    const write = await http(app).post(`/api/v1/courses/${course.id}/groups/${gB.id}/members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`).send({ userId: bob.id });
    expect(write.status).toBe(403);
    const create = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`).send({ name: 'Gamma' });
    expect(create.status).toBe(403);
  });

  it('SEPARATE GROUPS applies to groupings too: a student only sees groupings containing her group, and only her group inside a shared grouping', async () => {
    const { course, gA, gB, aliceLogin } = await setupTwoGroups(1); // SEPARATEGROUPS
    const shared = await http(app).post(`/api/v1/courses/${course.id}/groupings`).set('Authorization', `Bearer ${admin}`).send({ name: 'Both teams' });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${shared.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupId: gA.id });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${shared.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupId: gB.id });
    const betaOnly = await http(app).post(`/api/v1/courses/${course.id}/groupings`).set('Authorization', `Bearer ${admin}`).send({ name: 'Beta only' });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${betaOnly.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupId: gB.id });

    // Danh sách grouping: grouping chỉ dành cho Beta vô hình với Alice.
    const groupingList = await http(app).get(`/api/v1/courses/${course.id}/groupings`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((groupingList.body as { id: string }[]).map((g) => g.id)).toEqual([shared.body.id]);
    // Bên trong grouping dùng chung, cô ấy chỉ thấy nhóm của mình.
    const inShared = await http(app).get(`/api/v1/courses/${course.id}/groupings/${shared.body.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((inShared.body as { id: string }[]).map((g) => g.id)).toEqual([gA.id]);
    // Grouping chỉ dành cho Beta không cho ra nhóm nào cả đối với cô ấy.
    const inBetaOnly = await http(app).get(`/api/v1/courses/${course.id}/groupings/${betaOnly.body.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect(inBetaOnly.body).toEqual([]);
    // Admin thấy cả hai grouping và cả hai nhóm bên trong grouping dùng chung.
    const adminGroupings = await http(app).get(`/api/v1/courses/${course.id}/groupings`).set('Authorization', `Bearer ${admin}`);
    expect((adminGroupings.body as unknown[]).length).toBe(2);
    const adminInShared = await http(app).get(`/api/v1/courses/${course.id}/groupings/${shared.body.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((adminInShared.body as { id: string }[]).map((g) => g.id).sort()).toEqual([gA.id, gB.id].sort());
  });

  it('a teacher with course:managegroups sees ALL groups and members in BOTH separate and visible mode, without being a group member', async () => {
    for (const mode of [1, 2]) {
      const { course, gA, gB } = await setupTwoGroups(mode);
      const teacher = await createUserViaApi(app, admin);
      const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
      const editingTeacherRole = await roleIdByShortname(app, admin, 'editingteacher');
      await assignRole(app, admin, teacher.id, editingTeacherRole, content.body.contextId);
      const teacherLogin = await login(app, teacher.username, STRONG_PASSWORD);
      const adminGroups = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`);
      const classGroupId = (adminGroups.body as { id: string; name: string }[]).find((g) => g.name === 'Cả lớp')!.id;
      const list = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${teacherLogin.accessToken}`);
      expect((list.body as { id: string }[]).map((g) => g.id).sort()).toEqual([gA.id, gB.id, classGroupId].sort());
      const membersB = await http(app).get(`/api/v1/courses/${course.id}/groups/${gB.id}/members`).set('Authorization', `Bearer ${teacherLogin.accessToken}`);
      expect(membersB.status).toBe(200);
      expect((membersB.body as unknown[]).length).toBe(1);
    }
  });

  it('groupModeForce round-trips through course create/update and the course payload (Moodle course settings: "Force group mode" applies the course mode to every activity)', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id, { groupMode: 1, groupModeForce: true }) as unknown as { id: string; groupMode: number; groupModeForce: boolean };
    expect(course.groupMode).toBe(1);
    expect(course.groupModeForce).toBe(true);
    const patched = await http(app).patch(`/api/v1/courses/${course.id}`).set('Authorization', `Bearer ${admin}`).send({ groupModeForce: false });
    expect(patched.status).toBe(200);
    expect(patched.body.groupModeForce).toBe(false);
    // Giá trị mặc định vẫn tắt khi không được yêu cầu.
    const plain = await createCourse(app, admin, cat.id) as unknown as { groupModeForce: boolean };
    expect(plain.groupModeForce).toBe(false);
  });

  it('group update + delete over HTTP: PATCH renames a group and clears its enrolment key; DELETE removes the group (memberships go with it)', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);
    const created = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Old name', enrolmentKey: 'team-key' });
    expect(created.status).toBe(201);
    const groupId = created.body.id as string;
    await http(app).post(`/api/v1/courses/${course.id}/groups/${groupId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });

    // PATCH đổi tên nhóm và sửa mô tả của nó; khoá vẫn sống sót sau một lần sửa không liên quan.
    const renamed = await http(app).patch(`/api/v1/courses/${course.id}/groups/${groupId}`).set('Authorization', `Bearer ${admin}`).send({ name: 'New name', description: 'Đội tuyển' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('New name');
    expect(renamed.body.description).toBe('Đội tuyển');
    expect(renamed.body.enrolmentKey).toBe('team-key');

    // PATCH với enrolmentKey: null xoá khoá ghi danh của nhóm.
    const cleared = await http(app).patch(`/api/v1/courses/${course.id}/groups/${groupId}`).set('Authorization', `Bearer ${admin}`).send({ enrolmentKey: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.enrolmentKey).toBeNull();
    const listed = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((listed.body as { id: string; name: string }[]).find((g) => g.id === groupId)?.name).toBe('New name');

    // DELETE loại bỏ nhóm: nó rời khỏi danh sách khoá học và danh sách thành viên của nó cũng biến mất theo.
    const deleted = await http(app).delete(`/api/v1/courses/${course.id}/groups/${groupId}`).set('Authorization', `Bearer ${admin}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });
    const afterList = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((afterList.body as { id: string }[]).some((g) => g.id === groupId)).toBe(false);
    const membersAfter = await http(app).get(`/api/v1/courses/${course.id}/groups/${groupId}/members`).set('Authorization', `Bearer ${admin}`);
    expect(membersAfter.status).toBe(404);
    expect(membersAfter.body.code).toBe('group.not_found');
  });

  it('adding a group member requires an ACTIVE enrolment in the course: never-enrolled, withdrawn and suspended users are refused with 400 group.member_not_enrolled (GN-2, issue #234)', async () => {
    const { course, instance } = await setupCourse();
    const group = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Guarded team' });
    expect(group.status).toBe(201);
    const groupId = group.body.id as string;
    const add = (userId: string) => http(app).post(`/api/v1/courses/${course.id}/groups/${groupId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId });
    const memberIds = async () => {
      const res = await http(app).get(`/api/v1/courses/${course.id}/groups/${groupId}/members`).set('Authorization', `Bearer ${admin}`);
      return (res.body as { userId: string }[]).map((m) => m.userId);
    };

    // Người dùng chưa từng ghi danh vào khoá học không thể được xếp vào các nhóm của khoá.
    const outsider = await createUserViaApi(app, admin);
    const refusedOutsider = await add(outsider.id);
    expect(refusedOutsider.status).toBe(400);
    expect(refusedOutsider.body.code).toBe('group.member_not_enrolled');
    expect(await memberIds()).not.toContain(outsider.id);

    // Người dùng có ghi danh đã bị rút cũng bị từ chối theo cùng cách.
    const withdrawn = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, withdrawn.id);
    await http(app).delete(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${withdrawn.id}`).set('Authorization', `Bearer ${admin}`);
    const refusedWithdrawn = await add(withdrawn.id);
    expect(refusedWithdrawn.status).toBe(400);
    expect(refusedWithdrawn.body.code).toBe('group.member_not_enrolled');
    expect(await memberIds()).not.toContain(withdrawn.id);

    // Ghi danh bị đình chỉ thì không hoạt động, nên thao tác thêm bị từ chối — nhưng chính
    // thao tác thêm đó thành công khi ghi danh được kích hoạt lại.
    const suspended = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, suspended.id);
    await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${suspended.id}/suspend`).set('Authorization', `Bearer ${admin}`);
    const refusedSuspended = await add(suspended.id);
    expect(refusedSuspended.status).toBe(400);
    expect(refusedSuspended.body.code).toBe('group.member_not_enrolled');
    await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${suspended.id}/reactivate`).set('Authorization', `Bearer ${admin}`);
    const okAfterReactivate = await add(suspended.id);
    expect(okAfterReactivate.status).toBe(201);
    expect(await memberIds()).toContain(suspended.id);

    // Học viên đang ghi danh tích cực được thêm như trước.
    const active = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, active.id);
    const ok = await add(active.id);
    expect(ok.status).toBe(201);
    expect(await memberIds()).toContain(active.id);
  });
});
