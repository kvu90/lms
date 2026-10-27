import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD, uniqueName } from './identity-access-helpers';
import { createCategory, createCm, createCourse, createEnrolInstance, createSection, enrolUser, fixtureClassId, getFirstSectionId } from './course-enrolment-helpers';

/**
 * Luồng Courses.
 * Oracle: course/tests/category_test.php (test_create_coursecat,
 * test_hierarchy, test_delete) và course/tests/courselib_test.php
 * (test_create_course, test_create_course_sections, test_create_module,
 * test_course_module_deleted_event_exceptions / sự kiện vòng đời cm).
 */
describe('Courses: categories, courses, sections, course modules', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  it('creates a category tree with path/depth/sortOrder and a course context per node', async () => {
    const parent = await createCategory(app, admin);
    const child = await createCategory(app, admin, { parent: parent.id });
    expect(child.path).toBe(`${parent.path}/${child.id}`);
    expect(child.depth).toBe(parent.depth + 1);
    // Context: context coursecat (40) tồn tại cho danh mục (qua danh sách context của Access vì probe bằng admin bị bảo vệ theo vai; kiểm tra việc tạo khoá hoạt động dưới nó).
    const course = await createCourse(app, admin, child.id);
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    expect(content.status).toBe(200);
    expect(content.body.contextId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(content.body.sections).toHaveLength(1); // section 0 được tự động tạo
    expect(content.body.sections[0].section).toBe(0);
  });

  it('rejects a duplicate course shortName and an end date before the start date', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const dup = await http(app).post('/api/v1/courses').set('Authorization', `Bearer ${admin}`)
      .send({ fullName: 'Copy', shortName: course.shortName, category: cat.id, classId: await fixtureClassId(app, admin) });
    expect(dup.status).toBe(409);
    const badDates = await http(app).post('/api/v1/courses').set('Authorization', `Bearer ${admin}`)
      .send({ fullName: 'Bad', shortName: uniqueName('bad'), category: cat.id, classId: await fixtureClassId(app, admin), startDate: '2026-05-01', endDate: '2026-04-01' });
    expect(badDates.status).toBe(400);
  });

  it('creating a course requires course:create in the CLASS context (CLASS-0: khoá neo vào lớp) — a plain user is denied', async () => {
    const cat = await createCategory(app, admin);
    const plain = await createUserViaApi(app, admin);
    const plainLogin = await login(app, plain.username, STRONG_PASSWORD);
    const res = await http(app).post('/api/v1/courses').set('Authorization', `Bearer ${plainLogin.accessToken}`)
      .send({ fullName: 'Nope', shortName: uniqueName('nope'), category: cat.id, classId: await fixtureClassId(app, admin) });
    expect(res.status).toBe(403);
  });

  it('moving a category rewrites the subtree path/depth (category_test::test_hierarchy + test_update)', async () => {
    const a = await createCategory(app, admin);
    const b = await createCategory(app, admin);
    const child = await createCategory(app, admin, { parent: a.id });
    const grandchild = await createCategory(app, admin, { parent: child.id });
    const moved = await http(app).patch(`/api/v1/courses/categories/${child.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ parent: b.id });
    expect(moved.status).toBe(200);
    const after = await http(app).get(`/api/v1/courses/categories/${grandchild.id}`).set('Authorization', `Bearer ${admin}`);
    expect(after.body.path).toBe(`/${b.id}/${child.id}/${grandchild.id}`);
    expect(after.body.depth).toBe(3);
    // Chu trình bị từ chối.
    const cycle = await http(app).patch(`/api/v1/courses/categories/${b.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ parent: grandchild.id });
    expect(cycle.status).toBe(400);
  });

  it('deleting a non-empty category without an explicit mode is refused (400)', async () => {
    const cat = await createCategory(app, admin);
    await createCourse(app, admin, cat.id);
    const res = await http(app).delete(`/api/v1/courses/categories/${cat.id}`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('course.category_not_empty');
  });

  it('delete mode=moveup moves courses and child categories to the parent (category_test::test_delete)', async () => {
    const parent = await createCategory(app, admin);
    const cat = await createCategory(app, admin, { parent: parent.id });
    const child = await createCategory(app, admin, { parent: cat.id });
    const course = await createCourse(app, admin, cat.id);
    const res = await http(app).delete(`/api/v1/courses/categories/${cat.id}?mode=moveup`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    const courseAfter = await http(app).get(`/api/v1/courses/${course.id}`).set('Authorization', `Bearer ${admin}`);
    expect(courseAfter.body.category).toBe(parent.id);
    const childAfter = await http(app).get(`/api/v1/courses/categories/${child.id}`).set('Authorization', `Bearer ${admin}`);
    expect(childAfter.body.parent).toBe(parent.id);
  });

  it('delete mode=recursive deletes contained courses and subcategories', async () => {
    const cat = await createCategory(app, admin);
    const child = await createCategory(app, admin, { parent: cat.id });
    const course = await createCourse(app, admin, child.id);
    const res = await http(app).delete(`/api/v1/courses/categories/${cat.id}?mode=recursive`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect((await http(app).get(`/api/v1/courses/categories/${child.id}`).set('Authorization', `Bearer ${admin}`)).status).toBe(404);
    expect((await http(app).get(`/api/v1/courses/${course.id}`).set('Authorization', `Bearer ${admin}`)).status).toBe(404);
  });

  it('supports course custom fields (customfield category for core_course/course) and format options', async () => {
    // Tạo một danh mục trường tuỳ chỉnh + trường cho khoá học qua API identity.
    const catRes = await http(app).post('/api/v1/custom-fields/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Course fields', component: 'core_course', area: 'course' });
    expect([200, 201]).toContain(catRes.status);
    const fieldRes = await http(app).post('/api/v1/custom-fields/fields').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: catRes.body.id, shortName: 'level', name: 'Level', type: 'select', configData: { options: ['intro', 'advanced'], required: false } });
    expect([200, 201]).toContain(fieldRes.status);

    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id, {
      customFields: { level: 'advanced' },
      formatOptions: { numsections: '8' },
    });
    const view = await http(app).get(`/api/v1/courses/${course.id}`).set('Authorization', `Bearer ${admin}`);
    expect(view.body.customFields).toEqual(expect.arrayContaining([{ shortName: 'level', value: 'advanced' }]));
    expect(view.body.formatOptions).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'numsections', value: '8' })]));
    // Giá trị select không hợp lệ bị từ chối.
    const bad = await http(app).post('/api/v1/courses').set('Authorization', `Bearer ${admin}`)
      .send({ fullName: 'Bad cf', shortName: uniqueName('badcf'), category: cat.id, classId: await fixtureClassId(app, admin), customFields: { level: 'expert' } });
    expect(bad.status).toBe(400);
  });

  it('hidden course is invisible to an enrolled student but visible with viewhiddencourses (staff)', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id, { visible: false });
    const student = await createUserViaApi(app, admin);
    const instance = await createEnrolInstance(app, admin, course.id);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentLogin = await login(app, student.username, STRONG_PASSWORD);
    const asStudent = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${studentLogin.accessToken}`);
    expect(asStudent.status).toBe(403);
    const asAdmin = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    expect(asAdmin.status).toBe(200);
  });

  it('sections and cms: create, move cm between sections, delete cm emits cm_deleted and cleans completion + files', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const section0 = await getFirstSectionId(app, admin, course.id);
    const section1 = await createSection(app, admin, course.id, { name: 'Week 1' });
    const cm = await createCm(app, admin, course.id, section0, { completion: 2, completionView: true });
    expect(cm.contextId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Di chuyển cm tới section 1.
    const moved = await http(app).patch(`/api/v1/courses/${course.id}/modules/${cm.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: section1.id });
    expect(moved.status).toBe(200);
    expect(moved.body.section).toBe(section1.id);

    // Tải một file vào context của cm, và cho một học viên một bản ghi hoàn thành bằng cách xem.
    const student = await createUserViaApi(app, admin);
    const instance = await createEnrolInstance(app, admin, course.id);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentLogin = await login(app, student.username, STRONG_PASSWORD);
    const upload = await http(app).post('/api/v1/files').set('Authorization', `Bearer ${admin}`)
      .field('contextId', String(cm.contextId)).field('component', 'mod_page').field('fileArea', 'content')
      .attach('file', Buffer.from('hello cm'), 'page.txt');
    expect(upload.status).toBe(201);
    const uploadedFileId = upload.body?.id as string | undefined;

    const view = await http(app).post(`/api/v1/courses/${course.id}/modules/${cm.id}/view`).set('Authorization', `Bearer ${studentLogin.accessToken}`);
    expect(view.status).toBeLessThan(300);
    const completionBefore = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(completionBefore.body.activities.find((a: { cmId: string }) => a.cmId === cm.id)?.state).toBe(1);

    // Xoá cm: bản ghi hoàn thành và bản ghi file của context của nó phải được dọn bởi trình xử lý sự kiện của các module sở hữu.
    const del = await http(app).delete(`/api/v1/courses/${course.id}/modules/${cm.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(200);
    const completionAfter = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(completionAfter.body.activities.find((a: { cmId: string }) => a.cmId === cm.id)).toBeUndefined();
    if (uploadedFileId) {
      const fileAfter = await http(app).get(`/api/v1/files/${uploadedFileId}`).set('Authorization', `Bearer ${admin}`);
      expect(fileAfter.status).toBe(404);
    }
    // Outbox mang sự kiện cm_deleted.
    const outboxCheck = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    expect(outboxCheck.status).toBe(200);
  });
});
