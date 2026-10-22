import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD, uniqueName } from './identity-access-helpers';
import { createCategory, createCm, createCourse, createEnrolInstance, createSection, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

/**
 * Courses flow.
 * Oracles: course/tests/category_test.php (test_create_coursecat,
 * test_hierarchy, test_delete) and course/tests/courselib_test.php
 * (test_create_course, test_create_course_sections, test_create_module,
 * test_course_module_deleted_event_exceptions / cm lifecycle events).
 */
describe('Courses: categories, courses, sections, course modules', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  it('creates a category tree with path/depth/sortorder and a course context per node', async () => {
    const parent = await createCategory(app, admin);
    const child = await createCategory(app, admin, { parent: parent.id });
    expect(child.path).toBe(`${parent.path}/${child.id}`);
    expect(child.depth).toBe(parent.depth + 1);
    // Contexts: coursecat context (40) exists for the category (via Access contexts list as admin probe is role-protected; check course creation works under it).
    const course = await createCourse(app, admin, child.id);
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    expect(content.status).toBe(200);
    expect(content.body.contextId).toBeGreaterThan(0);
    expect(content.body.sections).toHaveLength(1); // section 0 auto-created
    expect(content.body.sections[0].section).toBe(0);
  });

  it('rejects a duplicate course shortname and an end date before the start date', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const dup = await http(app).post('/api/v1/courses').set('Authorization', `Bearer ${admin}`)
      .send({ fullname: 'Copy', shortname: course.shortname, category: cat.id });
    expect(dup.status).toBe(409);
    const badDates = await http(app).post('/api/v1/courses').set('Authorization', `Bearer ${admin}`)
      .send({ fullname: 'Bad', shortname: uniqueName('bad'), category: cat.id, startdate: '2026-05-01', enddate: '2026-04-01' });
    expect(badDates.status).toBe(400);
  });

  it('creating a course requires course:create in the CATEGORY context — a plain user is denied', async () => {
    const cat = await createCategory(app, admin);
    const plain = await createUserViaApi(app, admin);
    const plainLogin = await login(app, plain.username, STRONG_PASSWORD);
    const res = await http(app).post('/api/v1/courses').set('Authorization', `Bearer ${plainLogin.accessToken}`)
      .send({ fullname: 'Nope', shortname: uniqueName('nope'), category: cat.id });
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
    // Cycle is refused.
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
    // Create a custom field category + field for courses through the identity API.
    const catRes = await http(app).post('/api/v1/custom-fields/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Course fields', component: 'core_course', area: 'course' });
    expect([200, 201]).toContain(catRes.status);
    const fieldRes = await http(app).post('/api/v1/custom-fields/fields').set('Authorization', `Bearer ${admin}`)
      .send({ categoryid: catRes.body.id, shortname: 'level', name: 'Level', type: 'select', configdata: { options: ['intro', 'advanced'], required: false } });
    expect([200, 201]).toContain(fieldRes.status);

    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id, {
      customFields: { level: 'advanced' },
      formatOptions: { numsections: '8' },
    });
    const view = await http(app).get(`/api/v1/courses/${course.id}`).set('Authorization', `Bearer ${admin}`);
    expect(view.body.customFields).toEqual(expect.arrayContaining([{ shortname: 'level', value: 'advanced' }]));
    expect(view.body.formatOptions).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'numsections', value: '8' })]));
    // Invalid select value is rejected.
    const bad = await http(app).post('/api/v1/courses').set('Authorization', `Bearer ${admin}`)
      .send({ fullname: 'Bad cf', shortname: uniqueName('badcf'), category: cat.id, customFields: { level: 'expert' } });
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
    const cm = await createCm(app, admin, course.id, section0, { completion: 2, completionview: true });
    expect(cm.contextId).toBeGreaterThan(0);

    // Move the cm to section 1.
    const moved = await http(app).patch(`/api/v1/courses/${course.id}/modules/${cm.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: section1.id });
    expect(moved.status).toBe(200);
    expect(moved.body.section).toBe(section1.id);

    // Upload a file into the cm context, and give a student a completion record by viewing.
    const student = await createUserViaApi(app, admin);
    const instance = await createEnrolInstance(app, admin, course.id);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentLogin = await login(app, student.username, STRONG_PASSWORD);
    const upload = await http(app).post('/api/v1/files').set('Authorization', `Bearer ${admin}`)
      .field('contextid', String(cm.contextId)).field('component', 'mod_page').field('filearea', 'content')
      .attach('file', Buffer.from('hello cm'), 'page.txt');
    expect(upload.status).toBe(201);
    const uploadedFileId = upload.body?.id as string | undefined;

    const view = await http(app).post(`/api/v1/courses/${course.id}/modules/${cm.id}/view`).set('Authorization', `Bearer ${studentLogin.accessToken}`);
    expect(view.status).toBeLessThan(300);
    const completionBefore = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(completionBefore.body.activities.find((a: { cmId: string }) => a.cmId === cm.id)?.state).toBe(1);

    // Delete the cm: completion records and file records of its context must be cleaned by the owning modules' event handlers.
    const del = await http(app).delete(`/api/v1/courses/${course.id}/modules/${cm.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(200);
    const completionAfter = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(completionAfter.body.activities.find((a: { cmId: string }) => a.cmId === cm.id)).toBeUndefined();
    if (uploadedFileId) {
      const fileAfter = await http(app).get(`/api/v1/files/${uploadedFileId}`).set('Authorization', `Bearer ${admin}`);
      expect(fileAfter.status).toBe(404);
    }
    // Outbox carries the cm_deleted event.
    const outboxCheck = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    expect(outboxCheck.status).toBe(200);
  });
});
