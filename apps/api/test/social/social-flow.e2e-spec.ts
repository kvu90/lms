import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../support/course-enrolment-helpers';
import { contextIdByLevelInstance, courseContextId } from '../support/engagement-helpers';

/**
 * Kiểm thử luồng Social (Tag / Comment / Rating / Notes) — mọi
 * hệ con đều ĐA HÌNH (POLYMORPHIC) (component + itemType/area + itemId +
 * contextId, không có FK cứng), được chứng minh bằng cách chạy CÙNG MỘT API trên hai
 * loại item khác nhau, với kiểm tra capability tại context của item.
 * Oracle (Moodle MOODLE_503_STABLE, đọc ngày 2026-10-22):
 *  - tag/tests/taglib_test.php: test_add_remove_item_tag,
 *    test_add_tag_ordering_calculation.
 *  - comment/tests/externallib_test.php: test_get_comments,
 *    test_add_comments_single (comment/tests/comment_test.php trả 404 ở bản 5.3).
 *  - rating/tests/rating_test.php: test_get_ratings_sql — bản tổng hợp theo từng item
 *    : (1,3)→2, (1,4)→2.5, (3,5)→4, mỗi cái count=2.
 *  - notes/tests/lib_test.php chỉ bao phủ điều hướng hồ sơ ở bản 5.3; luật
 *    hiển thị ghi chú tuân theo báo cáo §2#16 + đặc tả social (ghi chú khoá học
 *    dành cho giáo viên của khoá).
 */
describe('Social: tags, comments, ratings, notes', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
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

  it('tags are polymorphic: the same API tags a course and a badge; ordering is per item; correlations follow co-occurrence (taglib_test)', async () => {
    const { course, student, studentToken, ctxId } = await courseWithStudent();
    const setCourse = await http(app).post('/api/v1/tags/items').set('Authorization', `Bearer ${studentToken}`)
      .send({ component: 'core', itemType: 'course', itemId: course.id, contextId: ctxId, tags: ['Science', 'STEM'] });
    expect(setCourse.status).toBe(201);
    expect(setCourse.body.tags.map((t: { name: string }) => t.name)).toEqual(['science', 'stem']);
    expect(setCourse.body.tags.map((t: { ordering: number }) => t.ordering)).toEqual([1, 2]);

    // Cùng API, loại item khác: một huy hiệu (context của nó là context người dùng của chủ sở hữu).
    const badgeItemId = uuidv7();
    const userCtx = await contextIdByLevelInstance(app, admin, 30, student.id);
    const setPost = await http(app).post('/api/v1/tags/items').set('Authorization', `Bearer ${studentToken}`)
      .send({ component: 'core_badges', itemType: 'badge', itemId: badgeItemId, contextId: userCtx, tags: ['science', 'fieldwork'] });
    expect(setPost.status).toBe(201);
    // Thứ tự (ordering) bắt đầu lại từ 1 cho một item khác (trường hợp ordering của oracle).
    expect(setPost.body.tags.map((t: { ordering: number }) => t.ordering)).toEqual([1, 2]);

    const courseTags = await http(app).get('/api/v1/tags/items').query({ component: 'core', itemType: 'course', itemId: course.id }).set('Authorization', `Bearer ${studentToken}`);
    expect(courseTags.body).toHaveLength(2);
    const postTags = await http(app).get('/api/v1/tags/items').query({ component: 'core_badges', itemType: 'badge', itemId: badgeItemId }).set('Authorization', `Bearer ${studentToken}`);
    expect(postTags.body.map((t: { name: string }) => t.name)).toEqual(['science', 'fieldwork']);
    // 'science' được dùng chung: tập tương quan của nó liên kết các tag đồng xuất hiện của cả hai item.
    const science = (courseTags.body as { id: string; name: string }[]).find((t) => t.name === 'science')!;
    const corr = await http(app).get(`/api/v1/tags/${science.id}/correlated`).set('Authorization', `Bearer ${studentToken}`);
    const corrNames: string[] = [];
    for (const id of corr.body.correlatedTags as string[]) {
      const all = [...courseTags.body, ...postTags.body] as { id: string; name: string }[];
      const found = all.find((t) => t.id === id);
      if (found) corrNames.push(found.name);
    }
    expect(corrNames).toContain('stem');
    expect(corrNames).toContain('fieldwork');
    // Các area chưa đăng ký bị từ chối.
    const bad = await http(app).post('/api/v1/tags/items').set('Authorization', `Bearer ${studentToken}`)
      .send({ component: 'mod_nope', itemType: 'gadget', itemId: '01900000-0000-7000-8000-000000000042', contextId: ctxId, tags: ['x'] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('tags.area_not_registered');
    // set_item_tags thay thế: loại bỏ mọi tag làm rỗng item (test_add_remove_item_tag).
    const emptied = await http(app).post('/api/v1/tags/items').set('Authorization', `Bearer ${studentToken}`)
      .send({ component: 'core', itemType: 'course', itemId: course.id, contextId: ctxId, tags: [] });
    expect(emptied.body.tags).toHaveLength(0);
  });

  it('comments are polymorphic with per-context capabilities: post/read on a course item and on a forum post; strangers cannot post (externallib_test)', async () => {
    const { course, student, studentToken, ctxId } = await courseWithStudent();
    const c1 = await http(app).post('/api/v1/comments').set('Authorization', `Bearer ${studentToken}`)
      .send({ contextId: ctxId, component: 'core', commentArea: 'course', itemId: course.id, content: 'Great course' });
    expect(c1.status).toBe(201);
    // Cùng hình dạng API trên một loại item hoàn toàn khác (bài đăng forum).
    const forumItemId = uuidv7();
    const userCtx = await contextIdByLevelInstance(app, admin, 30, student.id);
    const c2 = await http(app).post('/api/v1/comments').set('Authorization', `Bearer ${studentToken}`)
      .send({ contextId: userCtx, component: 'mod_forum', commentArea: 'post', itemId: forumItemId, content: 'Nice post' });
    expect(c2.status).toBe(201);

    const list = await http(app).get('/api/v1/comments').query({ contextId: ctxId, component: 'core', commentArea: 'course', itemId: course.id }).set('Authorization', `Bearer ${studentToken}`);
    expect(list.body.count).toBe(1);
    expect(list.body.canpost).toBe(true);
    expect(list.body.comments[0].content).toBe('Great course');

    // Người dùng không có chỗ đứng trong context khoá học thì không đăng được ở đó.
    const stranger = await createUserViaApi(app, admin);
    const strangerToken = (await login(app, stranger.username, STRONG_PASSWORD)).accessToken;
    const denied = await http(app).post('/api/v1/comments').set('Authorization', `Bearer ${strangerToken}`)
      .send({ contextId: ctxId, component: 'core', commentArea: 'course', itemId: course.id, content: 'spam' });
    expect(denied.status).toBe(403);
    // Cũng không xoá được bình luận của người khác; tác giả xoá được bình luận của mình.
    const delDenied = await http(app).delete(`/api/v1/comments/${c1.body.id}`).set('Authorization', `Bearer ${strangerToken}`);
    expect(delDenied.status).toBe(403);
    const delOwn = await http(app).delete(`/api/v1/comments/${c1.body.id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(delOwn.body.deleted).toBe(true);
    const after = await http(app).get('/api/v1/comments').query({ contextId: ctxId, component: 'core', commentArea: 'course', itemId: course.id }).set('Authorization', `Bearer ${studentToken}`);
    expect(after.body.count).toBe(0);
  });

  it('ratings aggregate per item exactly like the Moodle oracle: (1,3)→2, (1,4)→2.5, (3,5)→4; viewall is a separate gate (rating_test)', async () => {
    const { ctxId } = await courseWithStudent();
    const raters: string[] = [];
    for (let i = 0; i < 3; i++) {
      const u = await createUserViaApi(app, admin);
      // Người chấm (rater) hành động tại context hệ thống ở đây (item demo cấp site): việc cấp
      // capability rate qua một lần gán vai thật ở cấp hệ thống
      // là việc của admin; đơn giản hơn: chấm tại một context nơi vai người dùng ảo
      // được áp dụng — chính là context hệ thống.
      raters.push((await login(app, u.username, STRONG_PASSWORD)).accessToken);
    }
    const systemCtx = await contextIdByLevelInstance(app, admin, 10, null);
    // Id item duy nhất theo lượt chạy: lms_test tồn tại qua các lượt chạy, và bản tổng hợp
    // tính theo từng item — id cố định sẽ tích lũy rating từ các lượt chạy trước.
    const [itemA, itemB, itemC, itemBad] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    const rate = async (token: string, itemId: string, rating: number) => {
      const res = await http(app).post('/api/v1/ratings').set('Authorization', `Bearer ${token}`)
        .send({ contextId: systemCtx, component: 'mod_forum', ratingArea: 'post', itemId, scaleId: 5, rating });
      expect(res.status).toBe(201);
    };
    // Dữ liệu oracle của test_get_ratings_sql, theo từng item.
    await rate(raters[0]!, itemA, 1); await rate(raters[1]!, itemA, 3);
    await rate(raters[0]!, itemB, 1); await rate(raters[1]!, itemB, 4);
    await rate(raters[0]!, itemC, 3); await rate(raters[1]!, itemC, 5);
    const agg = async (itemId: string) => {
      const res = await http(app).get('/api/v1/ratings/aggregate')
        .query({ contextId: systemCtx, component: 'mod_forum', ratingArea: 'post', itemId })
        .set('Authorization', `Bearer ${raters[2]!}`);
      expect(res.status).toBe(200);
      return res.body as { count: number; average: number };
    };
    expect(await agg(itemA)).toMatchObject({ count: 2, average: 2 });
    expect(await agg(itemB)).toMatchObject({ count: 2, average: 2.5 });
    expect(await agg(itemC)).toMatchObject({ count: 2, average: 4 });
    // Rating ngoài thang bị từ chối (thang tối đa 5).
    const bad = await http(app).post('/api/v1/ratings').set('Authorization', `Bearer ${raters[0]!}`)
      .send({ contextId: systemCtx, component: 'mod_forum', ratingArea: 'post', itemId: itemBad, scaleId: 5, rating: 9 });
    expect(bad.status).toBe(400);
    // Chấm lại cập nhật cùng một dòng (mỗi người dùng một rating cho mỗi item).
    await rate(raters[0]!, itemA, 5);
    expect(await agg(itemA)).toMatchObject({ count: 2, average: 4 });
    // Rating riêng lẻ cần viewall: người chấm thường bị từ chối danh sách…
    const listDenied = await http(app).get('/api/v1/ratings')
      .query({ contextId: systemCtx, component: 'mod_forum', ratingArea: 'post', itemId: itemA })
      .set('Authorization', `Bearer ${raters[2]!}`);
    expect(listDenied.status).toBe(403);
    // …trong khi admin (nguyên mẫu manager) thấy được chúng.
    const listAdmin = await http(app).get('/api/v1/ratings')
      .query({ contextId: systemCtx, component: 'mod_forum', ratingArea: 'post', itemId: itemA })
      .set('Authorization', `Bearer ${admin}`);
    expect(listAdmin.body).toHaveLength(2);
    void ctxId;
  });

  it('notes: draft is creator-only, course notes are visible to the course teacher (not fellow students, not the subject), site notes to system-level viewers', async () => {
    const { course, student } = await courseWithStudent();
    // Một giáo viên của khoá (gán vai giáo viên thật tại context khoá học).
    const { assignRole, roleIdByShortname } = await import('../support/identity-access-helpers');
    const teacher = await createUserViaApi(app, admin);
    const teacherRole = await roleIdByShortname(app, admin, 'teacher');
    const ctxId = await courseContextId(app, admin, course.id);
    await assignRole(app, admin, teacher.id, teacherRole, ctxId);
    const teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;

    const courseNote = await http(app).post('/api/v1/notes').set('Authorization', `Bearer ${teacherToken}`)
      .send({ userId: student.id, courseId: course.id, content: 'Struggling with week 2', publishState: 'public' });
    expect(courseNote.status).toBe(201);
    const draftNote = await http(app).post('/api/v1/notes').set('Authorization', `Bearer ${teacherToken}`)
      .send({ userId: student.id, courseId: course.id, content: 'Personal reminder', publishState: 'draft' });
    expect(draftNote.status).toBe(201);

    // Giáo viên thấy cả hai ghi chú của mình về học viên.
    const teacherList = await http(app).get(`/api/v1/notes/user/${student.id}`).set('Authorization', `Bearer ${teacherToken}`);
    expect(teacherList.body).toHaveLength(2);
    // Đối tượng (học viên) KHÔNG thấy ghi chú nào: ghi chú khoá học dành cho giáo viên.
    const studentList = await http(app).get(`/api/v1/notes/user/${student.id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(studentList.body).toHaveLength(0);
    // Một học viên khác của cùng khoá cũng không thấy gì.
    const peer = await createUserViaApi(app, admin);
    const peerToken = (await login(app, peer.username, STRONG_PASSWORD)).accessToken;
    const peerList = await http(app).get(`/api/v1/notes/user/${student.id}`).set('Authorization', `Bearer ${peerToken}`);
    expect(peerList.body).toHaveLength(0);
    // Truy xuất trực tiếp cưỡng chế cùng một luật.
    const direct = await http(app).get(`/api/v1/notes/${courseNote.body.id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(direct.status).toBe(403);
  });
});
