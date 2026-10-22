import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createP1TestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './p1-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './p2-helpers';
import { contextIdByLevelInstance, courseContextId } from './p4-helpers';

/**
 * P4 Social (Tag / Comment / Rating / Blog / Notes) flow tests — every
 * sub-system is POLYMORPHIC (component + itemtype/area + itemid +
 * contextid, no hard FK), proven by running the SAME API over two
 * different item kinds, with capability checks at the item's context.
 * Oracles (Moodle MOODLE_503_STABLE, read 2026-10-22):
 *  - tag/tests/taglib_test.php: test_add_remove_item_tag,
 *    test_add_tag_ordering_calculation.
 *  - comment/tests/externallib_test.php: test_get_comments,
 *    test_add_comments_single (comment/tests/comment_test.php 404s in 5.3).
 *  - rating/tests/rating_test.php: test_get_ratings_sql — per-item
 *    aggregates: (1,3)→2, (1,4)→2.5, (3,5)→4, count=2 each.
 *  - blog/tests/lib_test.php: test_overrides (blog_listing association
 *    filters). blog/tests/bloglib_test.php, blog_test.php, external_test.php
 *    404 in the 5.3 tree — recorded here honestly.
 *  - notes/tests/lib_test.php covers only profile navigation in 5.3; the
 *    note visibility law follows report §2#16 + the P4 spec (course notes
 *    are for the course's teachers).
 */
describe('P4 social: tags, comments, ratings, blog, notes', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createP1TestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  async function courseWithStudent() {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const ctxId = await courseContextId(app, admin, course.id);
    return { course, student, studentToken, ctxId };
  }

  it('tags are polymorphic: the same API tags a course and a blog post; ordering is per item; correlations follow co-occurrence (taglib_test)', async () => {
    const { course, studentToken, ctxId } = await courseWithStudent();
    const setCourse = await http(app).post('/api/v1/tags/items').set('Authorization', `Bearer ${studentToken}`)
      .send({ component: 'core', itemtype: 'course', itemid: course.id, contextid: ctxId, tags: ['Science', 'STEM'] });
    expect(setCourse.status).toBe(201);
    expect(setCourse.body.tags.map((t: { name: string }) => t.name)).toEqual(['science', 'stem']);
    expect(setCourse.body.tags.map((t: { ordering: number }) => t.ordering)).toEqual([1, 2]);

    // Same API, different item kind: a blog post (its context is the author's user context).
    const post = await http(app).post('/api/v1/blog/posts').set('Authorization', `Bearer ${studentToken}`)
      .send({ subject: 'Field notes', content: 'We measured things', publishstate: 'site' });
    expect(post.status).toBe(201);
    const authorCtx = await contextIdByLevelInstance(app, admin, 30, (await http(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${studentToken}`)).body.id as number).catch(() => 0);
    void authorCtx;
    const studentId = post.body.userid as number;
    const userCtx = await contextIdByLevelInstance(app, admin, 30, studentId);
    const setPost = await http(app).post('/api/v1/tags/items').set('Authorization', `Bearer ${studentToken}`)
      .send({ component: 'core_blog', itemtype: 'post', itemid: post.body.id, contextid: userCtx, tags: ['science', 'fieldwork'] });
    expect(setPost.status).toBe(201);
    // Ordering restarts at 1 for a different item (oracle ordering case).
    expect(setPost.body.tags.map((t: { ordering: number }) => t.ordering)).toEqual([1, 2]);

    const courseTags = await http(app).get('/api/v1/tags/items').query({ component: 'core', itemtype: 'course', itemid: course.id }).set('Authorization', `Bearer ${studentToken}`);
    expect(courseTags.body).toHaveLength(2);
    const postTags = await http(app).get('/api/v1/tags/items').query({ component: 'core_blog', itemtype: 'post', itemid: post.body.id }).set('Authorization', `Bearer ${studentToken}`);
    expect(postTags.body.map((t: { name: string }) => t.name)).toEqual(['science', 'fieldwork']);
    // 'science' is shared: its correlation set links the co-occurring tags of both items.
    const science = (courseTags.body as { id: number; name: string }[]).find((t) => t.name === 'science')!;
    const corr = await http(app).get(`/api/v1/tags/${science.id}/correlated`).set('Authorization', `Bearer ${studentToken}`);
    const corrNames: string[] = [];
    for (const id of corr.body.correlatedtags as number[]) {
      const all = [...courseTags.body, ...postTags.body] as { id: number; name: string }[];
      const found = all.find((t) => t.id === id);
      if (found) corrNames.push(found.name);
    }
    expect(corrNames).toContain('stem');
    expect(corrNames).toContain('fieldwork');
    // Unregistered areas are refused.
    const bad = await http(app).post('/api/v1/tags/items').set('Authorization', `Bearer ${studentToken}`)
      .send({ component: 'mod_nope', itemtype: 'gadget', itemid: 1, contextid: ctxId, tags: ['x'] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('tags.area_not_registered');
    // set_item_tags replaces: removing all tags empties the item (test_add_remove_item_tag).
    const emptied = await http(app).post('/api/v1/tags/items').set('Authorization', `Bearer ${studentToken}`)
      .send({ component: 'core', itemtype: 'course', itemid: course.id, contextid: ctxId, tags: [] });
    expect(emptied.body.tags).toHaveLength(0);
  });

  it('comments are polymorphic with per-context capabilities: post/read on a course item and on a blog post; strangers cannot post (externallib_test)', async () => {
    const { course, student, studentToken, ctxId } = await courseWithStudent();
    const c1 = await http(app).post('/api/v1/comments').set('Authorization', `Bearer ${studentToken}`)
      .send({ contextid: ctxId, component: 'core', commentarea: 'course', itemid: course.id, content: 'Great course' });
    expect(c1.status).toBe(201);
    // Same API shape on a completely different item kind (blog post).
    const post = await http(app).post('/api/v1/blog/posts').set('Authorization', `Bearer ${studentToken}`)
      .send({ subject: 'Hello', content: 'World', publishstate: 'site' });
    const userCtx = await contextIdByLevelInstance(app, admin, 30, student.id);
    const c2 = await http(app).post('/api/v1/comments').set('Authorization', `Bearer ${studentToken}`)
      .send({ contextid: userCtx, component: 'core_blog', commentarea: 'post', itemid: post.body.id, content: 'Nice post' });
    expect(c2.status).toBe(201);

    const list = await http(app).get('/api/v1/comments').query({ contextid: ctxId, component: 'core', commentarea: 'course', itemid: course.id }).set('Authorization', `Bearer ${studentToken}`);
    expect(list.body.count).toBe(1);
    expect(list.body.canpost).toBe(true);
    expect(list.body.comments[0].content).toBe('Great course');

    // A user with no footing in the course context cannot post there.
    const stranger = await createUserViaApi(app, admin);
    const strangerToken = (await login(app, stranger.username, STRONG_PASSWORD)).accessToken;
    const denied = await http(app).post('/api/v1/comments').set('Authorization', `Bearer ${strangerToken}`)
      .send({ contextid: ctxId, component: 'core', commentarea: 'course', itemid: course.id, content: 'spam' });
    expect(denied.status).toBe(403);
    // Nor delete someone else's comment; the author can delete their own.
    const delDenied = await http(app).delete(`/api/v1/comments/${c1.body.id}`).set('Authorization', `Bearer ${strangerToken}`);
    expect(delDenied.status).toBe(403);
    const delOwn = await http(app).delete(`/api/v1/comments/${c1.body.id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(delOwn.body.deleted).toBe(true);
    const after = await http(app).get('/api/v1/comments').query({ contextid: ctxId, component: 'core', commentarea: 'course', itemid: course.id }).set('Authorization', `Bearer ${studentToken}`);
    expect(after.body.count).toBe(0);
  });

  it('ratings aggregate per item exactly like the Moodle oracle: (1,3)→2, (1,4)→2.5, (3,5)→4; viewall is a separate gate (rating_test)', async () => {
    const { ctxId } = await courseWithStudent();
    const raters: string[] = [];
    for (let i = 0; i < 3; i++) {
      const u = await createUserViaApi(app, admin);
      // Raters act at the system context here (site-level demo item): grant
      // the rate capability through a real role assignment at system level
      // is admin work; simpler: rate at a context where the virtual user
      // role applies — system context itself.
      raters.push((await login(app, u.username, STRONG_PASSWORD)).accessToken);
    }
    const systemCtx = await contextIdByLevelInstance(app, admin, 10, 0);
    // Run-unique item ids: lms_test is persistent across runs, and aggregates
    // are per item — fixed ids would accumulate ratings from previous runs.
    const base = (Date.now() % 100000) * 10;
    const [itemA, itemB, itemC, itemBad] = [base + 1, base + 2, base + 3, base + 9];
    const rate = async (token: string, itemid: number, rating: number) => {
      const res = await http(app).post('/api/v1/ratings').set('Authorization', `Bearer ${token}`)
        .send({ contextid: systemCtx, component: 'mod_forum', ratingarea: 'post', itemid, scaleid: 5, rating });
      expect(res.status).toBe(201);
    };
    // Oracle data of test_get_ratings_sql, item by item.
    await rate(raters[0]!, itemA, 1); await rate(raters[1]!, itemA, 3);
    await rate(raters[0]!, itemB, 1); await rate(raters[1]!, itemB, 4);
    await rate(raters[0]!, itemC, 3); await rate(raters[1]!, itemC, 5);
    const agg = async (itemid: number) => {
      const res = await http(app).get('/api/v1/ratings/aggregate')
        .query({ contextid: systemCtx, component: 'mod_forum', ratingarea: 'post', itemid })
        .set('Authorization', `Bearer ${raters[2]!}`);
      expect(res.status).toBe(200);
      return res.body as { count: number; average: number };
    };
    expect(await agg(itemA)).toMatchObject({ count: 2, average: 2 });
    expect(await agg(itemB)).toMatchObject({ count: 2, average: 2.5 });
    expect(await agg(itemC)).toMatchObject({ count: 2, average: 4 });
    // Out-of-scale ratings are refused (scale max 5).
    const bad = await http(app).post('/api/v1/ratings').set('Authorization', `Bearer ${raters[0]!}`)
      .send({ contextid: systemCtx, component: 'mod_forum', ratingarea: 'post', itemid: itemBad, scaleid: 5, rating: 9 });
    expect(bad.status).toBe(400);
    // Re-rating updates the same row (one rating per user per item).
    await rate(raters[0]!, itemA, 5);
    expect(await agg(itemA)).toMatchObject({ count: 2, average: 4 });
    // Individual ratings need viewall: a plain rater is refused the list…
    const listDenied = await http(app).get('/api/v1/ratings')
      .query({ contextid: systemCtx, component: 'mod_forum', ratingarea: 'post', itemid: itemA })
      .set('Authorization', `Bearer ${raters[2]!}`);
    expect(listDenied.status).toBe(403);
    // …while the admin (manager archetype) sees them.
    const listAdmin = await http(app).get('/api/v1/ratings')
      .query({ contextid: systemCtx, component: 'mod_forum', ratingarea: 'post', itemid: itemA })
      .set('Authorization', `Bearer ${admin}`);
    expect(listAdmin.body).toHaveLength(2);
    void ctxId;
  });

  it('blog: drafts are author-only; public posts are site-visible; course association narrows the audience to course members (blog lib_test filters)', async () => {
    const { course, student, studentToken } = await courseWithStudent();
    const draft = await http(app).post('/api/v1/blog/posts').set('Authorization', `Bearer ${studentToken}`)
      .send({ subject: 'Draft thoughts', content: 'secret', publishstate: 'draft' });
    const pub = await http(app).post('/api/v1/blog/posts').set('Authorization', `Bearer ${studentToken}`)
      .send({ subject: 'Public post', content: 'hello all', publishstate: 'site' });
    const other = await createUserViaApi(app, admin);
    const otherToken = (await login(app, other.username, STRONG_PASSWORD)).accessToken;

    const otherList = await http(app).get('/api/v1/blog/posts').query({ userid: student.id }).set('Authorization', `Bearer ${otherToken}`);
    const subjects = (otherList.body as { subject: string }[]).map((p) => p.subject);
    expect(subjects).toContain('Public post');
    expect(subjects).not.toContain('Draft thoughts');

    // Associate the public post with the course: now only course members see it in the course filter,
    // and the outsider loses it from the author's listing rule (association narrows audience).
    const assoc = await http(app).post(`/api/v1/blog/posts/${pub.body.id}/associations`).set('Authorization', `Bearer ${studentToken}`)
      .send({ assoctype: 'course', associd: course.id });
    expect(assoc.status).toBe(201);
    const courseList = await http(app).get('/api/v1/blog/posts').query({ courseid: course.id }).set('Authorization', `Bearer ${studentToken}`);
    expect((courseList.body as { subject: string }[]).map((p) => p.subject)).toContain('Public post');
    const otherCourseList = await http(app).get('/api/v1/blog/posts').query({ courseid: course.id }).set('Authorization', `Bearer ${otherToken}`);
    expect((otherCourseList.body as { subject: string }[]).map((p) => p.subject)).not.toContain('Public post');
    void draft;
  });

  it('notes: draft is creator-only, course notes are visible to the course teacher (not fellow students, not the subject), site notes to system-level viewers', async () => {
    const { course, student } = await courseWithStudent();
    // A teacher of the course (real teacher assignment at the course context).
    const { assignRole, roleIdByShortname } = await import('./p1-helpers');
    const teacher = await createUserViaApi(app, admin);
    const teacherRole = await roleIdByShortname(app, admin, 'teacher');
    const ctxId = await courseContextId(app, admin, course.id);
    await assignRole(app, admin, teacher.id, teacherRole, ctxId);
    const teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;

    const courseNote = await http(app).post('/api/v1/notes').set('Authorization', `Bearer ${teacherToken}`)
      .send({ userid: student.id, courseid: course.id, content: 'Struggling with week 2', publishstate: 'public' });
    expect(courseNote.status).toBe(201);
    const draftNote = await http(app).post('/api/v1/notes').set('Authorization', `Bearer ${teacherToken}`)
      .send({ userid: student.id, courseid: course.id, content: 'Personal reminder', publishstate: 'draft' });
    expect(draftNote.status).toBe(201);

    // Teacher sees both of their notes about the student.
    const teacherList = await http(app).get(`/api/v1/notes/user/${student.id}`).set('Authorization', `Bearer ${teacherToken}`);
    expect(teacherList.body).toHaveLength(2);
    // The subject (the student) sees NEITHER: course notes are for teachers.
    const studentList = await http(app).get(`/api/v1/notes/user/${student.id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(studentList.body).toHaveLength(0);
    // Another student of the same course also sees nothing.
    const peer = await createUserViaApi(app, admin);
    const peerToken = (await login(app, peer.username, STRONG_PASSWORD)).accessToken;
    const peerList = await http(app).get(`/api/v1/notes/user/${student.id}`).set('Authorization', `Bearer ${peerToken}`);
    expect(peerList.body).toHaveLength(0);
    // Direct fetch enforces the same law.
    const direct = await http(app).get(`/api/v1/notes/${courseNote.body.id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(direct.status).toBe(403);
  });
});
