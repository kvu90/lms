import type { INestApplication } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, uniqueName,
} from './identity-access-helpers';
import { createCategory, createCm, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { contextIdByLevelInstance, courseContextId } from './engagement-helpers';

/**
 * Issue #48 — vá rò quyền đọc nội dung blog. Ba đường rò từ research
 * chuẩn Blog (blog-standard-research-2026-10-24.md, mục phát hiện bảo
 * mật) thành e2e hồi quy:
 *  1. GET /blog/posts/:id trả full content kèm visibleToMe=false →
 *     nay người không có quyền xem nhận 404 blog.not_found, response
 *     KHÔNG chứa nội dung, không phân biệt được với bài không tồn tại.
 *  2. Comment/tag/rating của blog không qua BlogService.canView → nay
 *     lớp phụ trợ thừa hưởng audience của bài (chỉ khi vật chủ là bài
 *     blog; component khác giữ nguyên hành vi — social-flow suite).
 *  3. Global search chỉ kiểm publishState + blog:view → nay kết quả
 *     blog re-check BlogService.canView theo từng người tìm.
 * Ca chặn nhầm bắt buộc: giáo viên được GÁN VAI tại context khoá nhưng
 * KHÔNG có ghi danh vẫn xem được bài gắn với khoá của mình (định nghĩa
 * "thuộc khoá" của #33/#44: ghi danh ∪ gán vai).
 * Hồi quy F1 (review độc lập): bài liên kết CHỈ qua coursemodule từng
 * thoát cổng — canView chỉ thu hẹp với association 'course', còn
 * 'coursemodule' bị bỏ qua nên bài bị coi là bài site không gắn khoá.
 * Nay module phân giải về khoá chứa nó rồi áp cùng kiểm tra thành viên,
 * ở cả ba đường; ngữ nghĩa nhiều association (hợp các khoá liên kết)
 * cũng có ca khoá chặt riêng.
 */
describe('Blog read gate (issue #48): post detail, auxiliary layer and search share the post audience', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface Cast {
    courseId: string;
    authorCtx: string;
    authorToken: string;
    memberToken: string;
    teacherToken: string;
    outsiderToken: string;
    postId: string;
    secretSubject: string;
    secretContent: string;
  }

  /** Tác giả + một thành viên ghi danh trong khoá; giáo viên chỉ gán vai; một người ngoài khoá. Bài site gắn với khoá. */
  async function setupCoursePost(): Promise<Cast> {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const author = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, author.id);
    const member = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, member.id);
    const teacher = await createUserViaApi(app, admin);
    const teacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    const ctxId = await courseContextId(app, admin, course.id);
    await assignRole(app, admin, teacher.id, teacherRole, ctxId);
    const outsider = await createUserViaApi(app, admin);

    const authorToken = (await login(app, author.username, STRONG_PASSWORD)).accessToken;
    const memberToken = (await login(app, member.username, STRONG_PASSWORD)).accessToken;
    const teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;

    const secretSubject = `GateSecret ${uniqueName('zzgate')}`;
    const secretContent = `GateSecretBody ${uniqueName('zzbody')}`;
    const post = await http(app).post('/api/v1/blog/posts').set(bearer(authorToken))
      .send({ subject: secretSubject, content: secretContent, publishState: 'site' });
    expect(post.status).toBe(201);
    const assoc = await http(app).post(`/api/v1/blog/posts/${post.body.id}/associations`).set(bearer(authorToken))
      .send({ assocType: 'course', assocId: course.id });
    expect(assoc.status).toBe(201);
    const authorCtx = await contextIdByLevelInstance(app, admin, 30, author.id);
    return {
      courseId: course.id, authorCtx, authorToken, memberToken, teacherToken, outsiderToken,
      postId: post.body.id as string, secretSubject, secretContent,
    };
  }

  it('direct GET: outsider gets a content-free 404 indistinguishable from a nonexistent post; members and the role-assigned teacher read it', async () => {
    const c = await setupCoursePost();
    const denied = await http(app).get(`/api/v1/blog/posts/${c.postId}`).set(bearer(c.outsiderToken));
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('blog.not_found');
    expect(JSON.stringify(denied.body)).not.toContain(c.secretSubject);
    expect(JSON.stringify(denied.body)).not.toContain(c.secretContent);

    // Không có oracle tồn tại: bài không tồn tại cho cùng một phản hồi.
    const ghost = await http(app).get(`/api/v1/blog/posts/${uuidv7()}`).set(bearer(c.outsiderToken));
    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe('blog.not_found');

    const member = await http(app).get(`/api/v1/blog/posts/${c.postId}`).set(bearer(c.memberToken));
    expect(member.status).toBe(200);
    expect(member.body.content).toBe(c.secretContent);
    // Giáo viên gán vai tại context khoá, không ghi danh: không được chặn nhầm.
    const teacher = await http(app).get(`/api/v1/blog/posts/${c.postId}`).set(bearer(c.teacherToken));
    expect(teacher.status).toBe(200);
    expect(teacher.body.content).toBe(c.secretContent);
    const author = await http(app).get(`/api/v1/blog/posts/${c.postId}`).set(bearer(c.authorToken));
    expect(author.status).toBe(200);
    const adminView = await http(app).get(`/api/v1/blog/posts/${c.postId}`).set(bearer(admin));
    expect(adminView.status).toBe(200);
  });

  it('draft post: direct GET and the auxiliary layer stay author-only', async () => {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const author = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, author.id);
    const other = await createUserViaApi(app, admin);
    const authorToken = (await login(app, author.username, STRONG_PASSWORD)).accessToken;
    const otherToken = (await login(app, other.username, STRONG_PASSWORD)).accessToken;
    const authorCtx = await contextIdByLevelInstance(app, admin, 30, author.id);

    const draftContent = `DraftSecret ${uniqueName('zzdraft')}`;
    const draft = await http(app).post('/api/v1/blog/posts').set(bearer(authorToken))
      .send({ subject: 'Draft gate', content: draftContent, publishState: 'draft' });
    expect(draft.status).toBe(201);

    const denied = await http(app).get(`/api/v1/blog/posts/${draft.body.id}`).set(bearer(otherToken));
    expect(denied.status).toBe(404);
    expect(JSON.stringify(denied.body)).not.toContain(draftContent);
    const own = await http(app).get(`/api/v1/blog/posts/${draft.body.id}`).set(bearer(authorToken));
    expect(own.status).toBe(200);
    expect(own.body.content).toBe(draftContent);

    const comments = await http(app).get('/api/v1/comments')
      .query({ contextId: authorCtx, component: 'core_blog', commentArea: 'post', itemId: draft.body.id })
      .set(bearer(otherToken));
    expect(comments.status).toBe(404);
    const tags = await http(app).get('/api/v1/tags/items')
      .query({ component: 'core_blog', itemType: 'post', itemId: draft.body.id })
      .set(bearer(otherToken));
    expect(tags.status).toBe(404);
    const aggregate = await http(app).get('/api/v1/ratings/aggregate')
      .query({ contextId: authorCtx, component: 'core_blog', ratingArea: 'post', itemId: draft.body.id })
      .set(bearer(otherToken));
    expect(aggregate.status).toBe(404);
  });

  it('comments inherit the post audience: outsider cannot read, post or delete; member and teacher can read', async () => {
    const c = await setupCoursePost();
    const memberComment = `MemberNote ${uniqueName('zzcmt')}`;
    const posted = await http(app).post('/api/v1/comments').set(bearer(c.memberToken))
      .send({ contextId: c.authorCtx, component: 'core_blog', commentArea: 'post', itemId: c.postId, content: memberComment });
    expect(posted.status).toBe(201);

    const deniedList = await http(app).get('/api/v1/comments')
      .query({ contextId: c.authorCtx, component: 'core_blog', commentArea: 'post', itemId: c.postId })
      .set(bearer(c.outsiderToken));
    expect(deniedList.status).toBe(404);
    expect(JSON.stringify(deniedList.body)).not.toContain(memberComment);

    const deniedPost = await http(app).post('/api/v1/comments').set(bearer(c.outsiderToken))
      .send({ contextId: c.authorCtx, component: 'core_blog', commentArea: 'post', itemId: c.postId, content: 'spam' });
    expect(deniedPost.status).toBe(404);

    const deniedDelete = await http(app).delete(`/api/v1/comments/${posted.body.id}`).set(bearer(c.outsiderToken));
    expect(deniedDelete.status).toBe(404);

    const memberList = await http(app).get('/api/v1/comments')
      .query({ contextId: c.authorCtx, component: 'core_blog', commentArea: 'post', itemId: c.postId })
      .set(bearer(c.memberToken));
    expect(memberList.status).toBe(200);
    expect(memberList.body.count).toBe(1);
    expect(memberList.body.comments[0].content).toBe(memberComment);
    const teacherList = await http(app).get('/api/v1/comments')
      .query({ contextId: c.authorCtx, component: 'core_blog', commentArea: 'post', itemId: c.postId })
      .set(bearer(c.teacherToken));
    expect(teacherList.status).toBe(200);
    expect(teacherList.body.count).toBe(1);
  });

  it('tags inherit the post audience: outsider cannot read or set; member can do both', async () => {
    const c = await setupCoursePost();
    const set = await http(app).post('/api/v1/tags/items').set(bearer(c.memberToken))
      .send({ component: 'core_blog', itemType: 'post', itemId: c.postId, contextId: c.authorCtx, tags: ['gatekept'] });
    expect(set.status).toBe(201);

    const deniedList = await http(app).get('/api/v1/tags/items')
      .query({ component: 'core_blog', itemType: 'post', itemId: c.postId })
      .set(bearer(c.outsiderToken));
    expect(deniedList.status).toBe(404);
    const deniedSet = await http(app).post('/api/v1/tags/items').set(bearer(c.outsiderToken))
      .send({ component: 'core_blog', itemType: 'post', itemId: c.postId, contextId: c.authorCtx, tags: ['pwned'] });
    expect(deniedSet.status).toBe(404);

    const memberList = await http(app).get('/api/v1/tags/items')
      .query({ component: 'core_blog', itemType: 'post', itemId: c.postId })
      .set(bearer(c.memberToken));
    expect(memberList.status).toBe(200);
    expect((memberList.body as { name: string }[]).map((t) => t.name)).toEqual(['gatekept']);
    const teacherList = await http(app).get('/api/v1/tags/items')
      .query({ component: 'core_blog', itemType: 'post', itemId: c.postId })
      .set(bearer(c.teacherToken));
    expect(teacherList.status).toBe(200);
  });

  it('ratings inherit the post audience: outsider cannot rate or read aggregates; member can', async () => {
    const c = await setupCoursePost();
    const rated = await http(app).post('/api/v1/ratings').set(bearer(c.memberToken))
      .send({ contextId: c.authorCtx, component: 'core_blog', ratingArea: 'post', itemId: c.postId, scaleId: -5, rating: 5 });
    expect(rated.status).toBe(201);

    const deniedRate = await http(app).post('/api/v1/ratings').set(bearer(c.outsiderToken))
      .send({ contextId: c.authorCtx, component: 'core_blog', ratingArea: 'post', itemId: c.postId, scaleId: -5, rating: 1 });
    expect(deniedRate.status).toBe(404);
    const deniedAggregate = await http(app).get('/api/v1/ratings/aggregate')
      .query({ contextId: c.authorCtx, component: 'core_blog', ratingArea: 'post', itemId: c.postId })
      .set(bearer(c.outsiderToken));
    expect(deniedAggregate.status).toBe(404);
    const deniedList = await http(app).get('/api/v1/ratings')
      .query({ contextId: c.authorCtx, component: 'core_blog', ratingArea: 'post', itemId: c.postId })
      .set(bearer(c.outsiderToken));
    expect(deniedList.status).toBe(404);

    const aggregate = await http(app).get('/api/v1/ratings/aggregate')
      .query({ contextId: c.authorCtx, component: 'core_blog', ratingArea: 'post', itemId: c.postId })
      .set(bearer(c.memberToken));
    expect(aggregate.status).toBe(200);
    expect(aggregate.body).toMatchObject({ count: 1, average: 5 });
  });

  it('global search: a course-narrowed post is only found by users inside its audience', async () => {
    const c = await setupCoursePost();
    const idx = await http(app).post('/api/v1/search/index').set(bearer(admin)).send({ area: 'blog', itemId: c.postId });
    expect(idx.body.indexed).toBe(true);
    const token = c.secretSubject.split(' ').pop()!;

    const outsiderRes = await http(app).get(`/api/v1/search?q=${encodeURIComponent(token)}`).set(bearer(c.outsiderToken));
    expect(outsiderRes.status).toBe(200);
    expect((outsiderRes.body as { itemId: string }[]).some((d) => d.itemId === c.postId)).toBe(false);
    expect(JSON.stringify(outsiderRes.body)).not.toContain(c.secretSubject);

    const memberRes = await http(app).get(`/api/v1/search?q=${encodeURIComponent(token)}`).set(bearer(c.memberToken));
    expect((memberRes.body as { itemId: string }[]).some((d) => d.itemId === c.postId)).toBe(true);
    const teacherRes = await http(app).get(`/api/v1/search?q=${encodeURIComponent(token)}`).set(bearer(c.teacherToken));
    expect((teacherRes.body as { itemId: string }[]).some((d) => d.itemId === c.postId)).toBe(true);
  });

  /** Như setupCoursePost nhưng bài CHỈ liên kết qua coursemodule của khoá (không liên kết trực tiếp với khoá). */
  async function setupModulePost(): Promise<Cast & { cmId: string }> {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const author = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, author.id);
    const member = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, member.id);
    const teacher = await createUserViaApi(app, admin);
    const teacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    const ctxId = await courseContextId(app, admin, course.id);
    await assignRole(app, admin, teacher.id, teacherRole, ctxId);
    const outsider = await createUserViaApi(app, admin);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const cm = await createCm(app, admin, course.id, sectionId);

    const authorToken = (await login(app, author.username, STRONG_PASSWORD)).accessToken;
    const memberToken = (await login(app, member.username, STRONG_PASSWORD)).accessToken;
    const teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;

    const secretSubject = `CmGateSecret ${uniqueName('zzcmgate')}`;
    const secretContent = `CmGateSecretBody ${uniqueName('zzcmbody')}`;
    const post = await http(app).post('/api/v1/blog/posts').set(bearer(authorToken))
      .send({ subject: secretSubject, content: secretContent, publishState: 'site' });
    expect(post.status).toBe(201);
    const assoc = await http(app).post(`/api/v1/blog/posts/${post.body.id}/associations`).set(bearer(authorToken))
      .send({ assocType: 'coursemodule', assocId: cm.id });
    expect(assoc.status).toBe(201);
    const authorCtx = await contextIdByLevelInstance(app, admin, 30, author.id);
    return {
      courseId: course.id, authorCtx, authorToken, memberToken, teacherToken, outsiderToken,
      postId: post.body.id as string, secretSubject, secretContent, cmId: cm.id,
    };
  }

  it('coursemodule-only association (F1): outsider is blocked on detail, comments, tags, ratings and search; members of the containing course read everything', async () => {
    const c = await setupModulePost();

    // Đường 1 — chi tiết bài: 404 không nội dung, không oracle.
    const denied = await http(app).get(`/api/v1/blog/posts/${c.postId}`).set(bearer(c.outsiderToken));
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('blog.not_found');
    expect(JSON.stringify(denied.body)).not.toContain(c.secretSubject);
    expect(JSON.stringify(denied.body)).not.toContain(c.secretContent);
    const memberRead = await http(app).get(`/api/v1/blog/posts/${c.postId}`).set(bearer(c.memberToken));
    expect(memberRead.status).toBe(200);
    expect(memberRead.body.content).toBe(c.secretContent);
    const teacherRead = await http(app).get(`/api/v1/blog/posts/${c.postId}`).set(bearer(c.teacherToken));
    expect(teacherRead.status).toBe(200);
    expect(teacherRead.body.content).toBe(c.secretContent);

    // Đường 2a — comment: thành viên bình luận được, người ngoài không đọc/gửi được.
    const memberComment = `CmMemberNote ${uniqueName('zzcmcmt')}`;
    const posted = await http(app).post('/api/v1/comments').set(bearer(c.memberToken))
      .send({ contextId: c.authorCtx, component: 'core_blog', commentArea: 'post', itemId: c.postId, content: memberComment });
    expect(posted.status).toBe(201);
    const deniedComments = await http(app).get('/api/v1/comments')
      .query({ contextId: c.authorCtx, component: 'core_blog', commentArea: 'post', itemId: c.postId })
      .set(bearer(c.outsiderToken));
    expect(deniedComments.status).toBe(404);
    expect(JSON.stringify(deniedComments.body)).not.toContain(memberComment);
    const deniedCommentPost = await http(app).post('/api/v1/comments').set(bearer(c.outsiderToken))
      .send({ contextId: c.authorCtx, component: 'core_blog', commentArea: 'post', itemId: c.postId, content: 'spam' });
    expect(deniedCommentPost.status).toBe(404);
    const memberComments = await http(app).get('/api/v1/comments')
      .query({ contextId: c.authorCtx, component: 'core_blog', commentArea: 'post', itemId: c.postId })
      .set(bearer(c.memberToken));
    expect(memberComments.status).toBe(200);
    expect(memberComments.body.count).toBe(1);

    // Đường 2b — tag.
    const set = await http(app).post('/api/v1/tags/items').set(bearer(c.memberToken))
      .send({ component: 'core_blog', itemType: 'post', itemId: c.postId, contextId: c.authorCtx, tags: ['cmgatekept'] });
    expect(set.status).toBe(201);
    const deniedTags = await http(app).get('/api/v1/tags/items')
      .query({ component: 'core_blog', itemType: 'post', itemId: c.postId })
      .set(bearer(c.outsiderToken));
    expect(deniedTags.status).toBe(404);
    const teacherTags = await http(app).get('/api/v1/tags/items')
      .query({ component: 'core_blog', itemType: 'post', itemId: c.postId })
      .set(bearer(c.teacherToken));
    expect(teacherTags.status).toBe(200);

    // Đường 2c — rating.
    const rated = await http(app).post('/api/v1/ratings').set(bearer(c.memberToken))
      .send({ contextId: c.authorCtx, component: 'core_blog', ratingArea: 'post', itemId: c.postId, scaleId: -5, rating: 4 });
    expect(rated.status).toBe(201);
    const deniedRate = await http(app).post('/api/v1/ratings').set(bearer(c.outsiderToken))
      .send({ contextId: c.authorCtx, component: 'core_blog', ratingArea: 'post', itemId: c.postId, scaleId: -5, rating: 1 });
    expect(deniedRate.status).toBe(404);
    const deniedAggregate = await http(app).get('/api/v1/ratings/aggregate')
      .query({ contextId: c.authorCtx, component: 'core_blog', ratingArea: 'post', itemId: c.postId })
      .set(bearer(c.outsiderToken));
    expect(deniedAggregate.status).toBe(404);
    const aggregate = await http(app).get('/api/v1/ratings/aggregate')
      .query({ contextId: c.authorCtx, component: 'core_blog', ratingArea: 'post', itemId: c.postId })
      .set(bearer(c.teacherToken));
    expect(aggregate.status).toBe(200);
    expect(aggregate.body).toMatchObject({ count: 1, average: 4 });

    // Đường 3 — global search: người ngoài không tìm thấy, thành viên/giáo viên tìm thấy.
    const idx = await http(app).post('/api/v1/search/index').set(bearer(admin)).send({ area: 'blog', itemId: c.postId });
    expect(idx.body.indexed).toBe(true);
    const token = c.secretSubject.split(' ').pop()!;
    const outsiderRes = await http(app).get(`/api/v1/search?q=${encodeURIComponent(token)}`).set(bearer(c.outsiderToken));
    expect(outsiderRes.status).toBe(200);
    expect((outsiderRes.body as { itemId: string }[]).some((d) => d.itemId === c.postId)).toBe(false);
    expect(JSON.stringify(outsiderRes.body)).not.toContain(c.secretSubject);
    const memberRes = await http(app).get(`/api/v1/search?q=${encodeURIComponent(token)}`).set(bearer(c.memberToken));
    expect((memberRes.body as { itemId: string }[]).some((d) => d.itemId === c.postId)).toBe(true);
    const teacherRes = await http(app).get(`/api/v1/search?q=${encodeURIComponent(token)}`).set(bearer(c.teacherToken));
    expect((teacherRes.body as { itemId: string }[]).some((d) => d.itemId === c.postId)).toBe(true);
  });

  it('mixed associations (course A direct + coursemodule of course B): audience is the union of the linked courses', async () => {
    const c = await setupModulePost();
    // Khoá thứ hai mà "member" của khoá module KHÔNG thuộc về; một người
    // chỉ thuộc khoá thứ hai phải xem được bài qua liên kết trực tiếp,
    // người ngoài cả hai khoá vẫn bị chặn.
    const category2 = await createCategory(app, admin);
    const course2 = await createCourse(app, admin, category2.id);
    const instance2 = await createEnrolInstance(app, admin, course2.id);
    const member2 = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course2.id, instance2.id, member2.id);
    const member2Token = (await login(app, member2.username, STRONG_PASSWORD)).accessToken;

    const assoc = await http(app).post(`/api/v1/blog/posts/${c.postId}/associations`).set(bearer(c.authorToken))
      .send({ assocType: 'course', assocId: course2.id });
    expect(assoc.status).toBe(201);

    const viaCourse2 = await http(app).get(`/api/v1/blog/posts/${c.postId}`).set(bearer(member2Token));
    expect(viaCourse2.status).toBe(200);
    expect(viaCourse2.body.content).toBe(c.secretContent);
    const viaModuleCourse = await http(app).get(`/api/v1/blog/posts/${c.postId}`).set(bearer(c.memberToken));
    expect(viaModuleCourse.status).toBe(200);
    const outsider = await http(app).get(`/api/v1/blog/posts/${c.postId}`).set(bearer(c.outsiderToken));
    expect(outsider.status).toBe(404);
    expect(JSON.stringify(outsider.body)).not.toContain(c.secretContent);
  });

  it('site post without a course association stays readable and searchable by any signed-in user (no over-blocking)', async () => {
    const c = await setupCoursePost();
    const subject = `OpenPost ${uniqueName('zzopen')}`;
    const post = await http(app).post('/api/v1/blog/posts').set(bearer(c.authorToken))
      .send({ subject, content: 'open content', publishState: 'site' });
    expect(post.status).toBe(201);

    const read = await http(app).get(`/api/v1/blog/posts/${post.body.id}`).set(bearer(c.outsiderToken));
    expect(read.status).toBe(200);
    expect(read.body.content).toBe('open content');
    const comments = await http(app).get('/api/v1/comments')
      .query({ contextId: c.authorCtx, component: 'core_blog', commentArea: 'post', itemId: post.body.id })
      .set(bearer(c.outsiderToken));
    expect(comments.status).toBe(200);
    expect(comments.body.count).toBe(0);

    const idx = await http(app).post('/api/v1/search/index').set(bearer(admin)).send({ area: 'blog', itemId: post.body.id });
    expect(idx.body.indexed).toBe(true);
    const token = subject.split(' ').pop()!;
    const found = await http(app).get(`/api/v1/search?q=${encodeURIComponent(token)}`).set(bearer(c.outsiderToken));
    expect((found.body as { itemId: string }[]).some((d) => d.itemId === post.body.id)).toBe(true);
  });
});
