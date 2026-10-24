import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, uniqueName,
} from './identity-access-helpers';
import { createCategory, createCm, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { contextIdByLevelInstance, courseContextId } from './engagement-helpers';

/**
 * Issue #87 (BL1) — mô hình space/status/loại bài của blog:
 *  1. State machine xuất bản validate ở create VÀ update (chuyển trạng
 *     thái sai, đổi space/kind sau publish, question_state lệch kind,
 *     xuất bản bài còn lịch tương lai đều bị chặn).
 *  2. Cổng space: space khoá chỉ cho thành viên khoá tạo/đọc; space
 *     trường chỉ staff đăng thẳng; xoá là xoá MỀM.
 *  3. Feed theo space: phân trang con trỏ không trùng/sót, lọc
 *     kind/tag/status, audience lọc theo từng viewer, kèm tác giả.
 *  4. Di trú dữ liệu cũ KHÔNG mở rộng audience: hàng legacy (chỉ có
 *     publish_state + association, các cột mới ở default fail-closed)
 *     sau backfill giữ nguyên hoặc THU HẸP phạm vi xem — ca khoá phụ
 *     (hợp khoá cũ) bị thu về khoá chính là bằng chứng thu hẹp; module
 *     không phân giải được giữ fail-closed.
 */
describe('Blog space model (issue #87, BL1)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function makeUser(): Promise<{ id: string; username: string; token: string }> {
    const user = await createUserViaApi(app, admin);
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    return { id: user.id, username: user.username, token };
  }

  async function makeCourseWithMember(): Promise<{
    courseId: string; author: { id: string; username: string; token: string };
    member: { id: string; username: string; token: string };
    outsider: { id: string; username: string; token: string };
  }> {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const author = await makeUser();
    await enrolUser(app, admin, course.id, instance.id, author.id);
    const member = await makeUser();
    await enrolUser(app, admin, course.id, instance.id, member.id);
    const outsider = await makeUser();
    return { courseId: course.id, author, member, outsider };
  }

  it('state machine: create/update validate trạng thái, space, kind và lịch xuất bản', async () => {
    const author = await makeUser();

    // Tạo mặc định: nháp cá nhân, audience private.
    const draft = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
      .send({ subject: 'Nháp BL1', content: 'nội dung' });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({
      status: 'draft', spaceType: 'user', spaceId: author.id,
      audience: 'private', kind: 'article', questionState: null, publishState: 'draft',
    });
    expect(draft.body.publishedAt).toBeNull();

    // Xuất bản qua PATCH: publishedAt được đóng mốc, projection cũ thành 'site'.
    const published = await http(app).patch(`/api/v1/blog/posts/${draft.body.id}`).set(bearer(author.token))
      .send({ status: 'published' });
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('published');
    expect(published.body.audience).toBe('school');
    expect(published.body.publishState).toBe('site');
    expect(published.body.publishedAt).not.toBeNull();

    // Chuyển ngược vòng đời bị chặn: published -> pending_review.
    const badTransition = await http(app).patch(`/api/v1/blog/posts/${draft.body.id}`).set(bearer(author.token))
      .send({ status: 'pending_review' });
    expect(badTransition.status).toBe(400);
    expect(badTransition.body.code).toBe('blog.bad_transition');

    // Đổi space sau publish bị cấm.
    const spaceLocked = await http(app).patch(`/api/v1/blog/posts/${draft.body.id}`).set(bearer(author.token))
      .send({ spaceType: 'school' });
    expect(spaceLocked.status).toBe(400);
    expect(spaceLocked.body.code).toBe('blog.space_locked');

    // archived hợp lệ; archived -> draft bị chặn.
    const archived = await http(app).patch(`/api/v1/blog/posts/${draft.body.id}`).set(bearer(author.token))
      .send({ status: 'archived' });
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');
    const badFromArchived = await http(app).patch(`/api/v1/blog/posts/${draft.body.id}`).set(bearer(author.token))
      .send({ status: 'draft' });
    expect(badFromArchived.status).toBe(400);
    expect(badFromArchived.body.code).toBe('blog.bad_transition');

    // Tạo thẳng ở trạng thái ngoài vòng đời mở đầu bị chặn (contract).
    const badCreate = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
      .send({ subject: 'X', content: 'y', status: 'hidden' });
    expect(badCreate.status).toBe(400);

    // questionState chỉ dành cho kind='question'.
    const badKindState = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
      .send({ subject: 'X', content: 'y', kind: 'article', questionState: 'open' });
    expect(badKindState.status).toBe(400);
    expect(badKindState.body.code).toBe('blog.question_state_kind');

    // Bài question mở ở questionState 'open' và chuyển được resolved.
    const question = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
      .send({ subject: 'Hỏi BL1', content: 'chưa hiểu', kind: 'question', status: 'published' });
    expect(question.status).toBe(201);
    expect(question.body.questionState).toBe('open');
    const resolved = await http(app).patch(`/api/v1/blog/posts/${question.body.id}`).set(bearer(author.token))
      .send({ questionState: 'resolved' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.questionState).toBe('resolved');

    // Lịch tương lai: tạo nháp được, xuất bản ngay bị chặn.
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const scheduled = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
      .send({ subject: 'Hẹn giờ', content: 'sau này', scheduledAt: future });
    expect(scheduled.status).toBe(201);
    const earlyPublish = await http(app).patch(`/api/v1/blog/posts/${scheduled.body.id}`).set(bearer(author.token))
      .send({ status: 'published' });
    expect(earlyPublish.status).toBe(400);
    expect(earlyPublish.body.code).toBe('blog.scheduled_in_future');
    const directScheduled = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
      .send({ subject: 'Hẹn giờ 2', content: 'sau này', status: 'published', scheduledAt: future });
    expect(directScheduled.status).toBe(400);
    expect(directScheduled.body.code).toBe('blog.scheduled_in_future');

    // Alias tương thích ngược: publishState 'site' vẫn xuất bản được.
    const legacy = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
      .send({ subject: 'Legacy tạo', content: 'cũ', publishState: 'site' });
    expect(legacy.status).toBe(201);
    expect(legacy.body.status).toBe('published');
  });

  it('cổng space: khoá chỉ cho thành viên, trường chỉ staff, xoá mềm giữ dấu vết cho tác giả', async () => {
    const { courseId, author, member, outsider } = await makeCourseWithMember();

    // Người ngoài khoá không tạo được bài trong space khoá.
    const deniedCreate = await http(app).post('/api/v1/blog/posts').set(bearer(outsider.token))
      .send({ subject: 'Lẻn vào', content: 'x', spaceType: 'course', spaceId: courseId, status: 'published' });
    expect(deniedCreate.status).toBe(403);

    // Thành viên tạo bài khoá; người ngoài đọc 404, thành viên đọc được.
    const post = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
      .send({ subject: 'Bài trong khoá', content: 'cho lớp', spaceType: 'course', spaceId: courseId, status: 'published' });
    expect(post.status).toBe(201);
    expect(post.body).toMatchObject({ spaceType: 'course', spaceId: courseId, audience: 'course' });
    const outsiderRead = await http(app).get(`/api/v1/blog/posts/${post.body.id}`).set(bearer(outsider.token));
    expect(outsiderRead.status).toBe(404);
    const memberRead = await http(app).get(`/api/v1/blog/posts/${post.body.id}`).set(bearer(member.token));
    expect(memberRead.status).toBe(200);

    // Học sinh thường không đăng thẳng lên space trường.
    const schoolDenied = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
      .send({ subject: 'Lên trường', content: 'x', spaceType: 'school', status: 'published' });
    expect(schoolDenied.status).toBe(403);
    expect(schoolDenied.body.code).toBe('blog.school_space_forbidden');
    // Người có vai manager tại context hệ thống thì được.
    const staff = await makeUser();
    const managerRole = await roleIdByShortname(app, admin, 'manager');
    const systemCtx = await contextIdByLevelInstance(app, admin, 10, null);
    await assignRole(app, admin, staff.id, managerRole, systemCtx);
    const schoolPost = await http(app).post('/api/v1/blog/posts').set(bearer(staff.token))
      .send({ subject: 'Bài thư viện', content: 'cho trường', spaceType: 'school', status: 'published' });
    expect(schoolPost.status).toBe(201);
    expect(schoolPost.body.spaceId).toBeNull();
    const schoolRead = await http(app).get(`/api/v1/blog/posts/${schoolPost.body.id}`).set(bearer(outsider.token));
    expect(schoolRead.status).toBe(200);

    // Xoá mềm: tác giả vẫn thấy tombstone của mình, người khác 404,
    // sửa bài đã xoá bị chặn, feed mặc định không còn bài.
    const del = await http(app).delete(`/api/v1/blog/posts/${post.body.id}`).set(bearer(author.token));
    expect(del.status).toBe(200);
    const ownAfter = await http(app).get(`/api/v1/blog/posts/${post.body.id}`).set(bearer(author.token));
    expect(ownAfter.status).toBe(200);
    expect(ownAfter.body.status).toBe('deleted');
    expect(ownAfter.body.deletedAt).not.toBeNull();
    const memberAfter = await http(app).get(`/api/v1/blog/posts/${post.body.id}`).set(bearer(member.token));
    expect(memberAfter.status).toBe(404);
    const editDeleted = await http(app).patch(`/api/v1/blog/posts/${post.body.id}`).set(bearer(author.token))
      .send({ subject: 'Sửa bài đã xoá' });
    expect(editDeleted.status).toBe(403);
    expect(editDeleted.body.code).toBe('blog.deleted');
  });

  it('feed theo space: phân trang con trỏ đủ và không trùng, lọc kind/tag/status, audience theo viewer', async () => {
    const { courseId, author, member, outsider } = await makeCourseWithMember();
    const marker = uniqueName('bl1feed');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
        .send({ subject: `${marker} article ${i}`, content: 'nội dung', spaceType: 'course', spaceId: courseId, status: 'published' });
      expect(res.status).toBe(201);
      ids.push(res.body.id as string);
    }
    const questionIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
        .send({ subject: `${marker} question ${i}`, content: 'hỏi', kind: 'question', spaceType: 'course', spaceId: courseId, status: 'published' });
      expect(res.status).toBe(201);
      questionIds.push(res.body.id as string);
    }
    const draft = await http(app).post('/api/v1/blog/posts').set(bearer(author.token))
      .send({ subject: `${marker} draft`, content: 'nháp', spaceType: 'course', spaceId: courseId });
    expect(draft.status).toBe(201);

    // Gắn tag cho 2 bài article qua lớp tag (context user của tác giả).
    const authorCtx = await contextIdByLevelInstance(app, admin, 30, author.id);
    for (const id of ids.slice(0, 2)) {
      const tagged = await http(app).post('/api/v1/tags/items').set(bearer(author.token))
        .send({ component: 'core_blog', itemType: 'post', itemId: id, contextId: authorCtx, tags: ['bl1-tag'] });
      expect(tagged.status).toBe(201);
    }

    const feedPage = async (token: string, query: Record<string, string>) =>
      http(app).get('/api/v1/blog/feed').query(query).set(bearer(token));

    // Phân trang: 3 + 3 + 1 = 7 bài published của khoá, không trùng.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const res = await feedPage(member.token, {
        spaceType: 'course', spaceId: courseId, limit: '3',
        ...(cursor ? { cursor } : {}),
      });
      expect(res.status).toBe(200);
      const pageIds = (res.body.items as { id: string }[]).map((p) => p.id);
      seen.push(...pageIds);
      cursor = res.body.nextCursor ?? undefined;
      if (page < 2) expect(res.body.nextCursor).not.toBeNull();
    }
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(7);
    expect(seen.sort()).toEqual([...ids, ...questionIds].sort());

    // Kèm tác giả tối thiểu.
    const first = await feedPage(member.token, { spaceType: 'course', spaceId: courseId, limit: '1' });
    expect(first.body.items[0].author.id).toBe(author.id);
    expect(first.body.items[0].author.username).toBe(author.username);
    expect(first.body.items[0].author.displayName.length).toBeGreaterThan(0);

    // Lọc kind.
    const questions = await feedPage(member.token, { spaceType: 'course', spaceId: courseId, kind: 'question' });
    expect((questions.body.items as { id: string }[]).map((p) => p.id).sort()).toEqual(questionIds.sort());

    // Lọc tag.
    const taggedFeed = await feedPage(member.token, { spaceType: 'course', spaceId: courseId, tag: 'BL1-Tag' });
    expect((taggedFeed.body.items as { id: string }[]).map((p) => p.id).sort()).toEqual(ids.slice(0, 2).sort());
    expect(taggedFeed.body.items[0].tags).toContain('bl1-tag');

    // Lọc status=draft: chỉ tác giả thấy nháp của mình.
    const ownDrafts = await feedPage(author.token, { spaceType: 'course', spaceId: courseId, status: 'draft', authorId: author.id });
    expect((ownDrafts.body.items as { id: string }[]).map((p) => p.id)).toEqual([draft.body.id]);
    const memberDrafts = await feedPage(member.token, { spaceType: 'course', spaceId: courseId, status: 'draft' });
    expect(memberDrafts.body.items).toHaveLength(0);

    // Người ngoài khoá: feed khoá rỗng hoàn toàn.
    const outsiderFeed = await feedPage(outsider.token, { spaceType: 'course', spaceId: courseId });
    expect(outsiderFeed.body.items).toHaveLength(0);

    // Con trỏ hỏng bị từ chối.
    const badCursor = await feedPage(member.token, { spaceType: 'course', spaceId: courseId, cursor: 'không-phải-cursor' });
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.code).toBe('blog.bad_cursor');
  });

  it('di trú: dữ liệu cũ giữ nguyên hoặc thu hẹp audience, không bài nào rộng ra', async () => {
    const category = await createCategory(app, admin);
    const courseX = await createCourse(app, admin, category.id);
    const courseY = await createCourse(app, admin, category.id);
    const instX = await createEnrolInstance(app, admin, courseX.id);
    const instY = await createEnrolInstance(app, admin, courseY.id);
    const author = await makeUser();
    await enrolUser(app, admin, courseX.id, instX.id, author.id);
    await enrolUser(app, admin, courseY.id, instY.id, author.id);
    const memberX = await makeUser();
    await enrolUser(app, admin, courseX.id, instX.id, memberX.id);
    const memberY = await makeUser();
    await enrolUser(app, admin, courseY.id, instY.id, memberY.id);
    const outsider = await makeUser();
    const ctxX = await courseContextId(app, admin, courseX.id);
    const ctxY = await courseContextId(app, admin, courseY.id);
    const sectionId = await getFirstSectionId(app, admin, courseX.id);
    const cm = await createCm(app, admin, courseX.id, sectionId);

    const marker = uniqueName('bl1mig');
    async function legacyPost(publishState: 'draft' | 'site'): Promise<string> {
      const res = await pg.query(
        `insert into blog_posts (user_id, subject, content, publish_state) values ($1, $2, $3, $4) returning id`,
        [author.id, `${marker} ${publishState}`, 'nội dung cũ', publishState],
      );
      return res.rows[0].id as string;
    }
    async function legacyAssoc(blogId: string, contextId: string, assocType: string, assocId: string): Promise<void> {
      await pg.query(
        `insert into blog_association (blog_id, context_id, assoc_type, assoc_id) values ($1, $2, $3, $4)`,
        [blogId, contextId, assocType, assocId],
      );
    }

    const legacyDraft = await legacyPost('draft');
    const legacySchool = await legacyPost('site');
    const legacyTwoCourses = await legacyPost('site');
    await legacyAssoc(legacyTwoCourses, ctxX, 'course', courseX.id);
    await legacyAssoc(legacyTwoCourses, ctxY, 'course', courseY.id);
    const legacyModule = await legacyPost('site');
    await legacyAssoc(legacyModule, ctxX, 'coursemodule', cm.id);
    const legacyGhost = await legacyPost('site');
    await legacyAssoc(legacyGhost, ctxX, 'coursemodule', uuidv7());

    // Trước backfill, hàng legacy ở default fail-closed: chỉ tác giả đọc được.
    const preRead = await http(app).get(`/api/v1/blog/posts/${legacySchool}`).set(bearer(outsider.token));
    expect(preRead.status).toBe(404);

    // Chỉ site admin chạy được backfill.
    const deniedRun = await http(app).post('/api/v1/blog/migrations/space-model').set(bearer(author.token));
    expect(deniedRun.status).toBe(403);
    const run = await http(app).post('/api/v1/blog/migrations/space-model').set(bearer(admin));
    expect(run.status).toBe(201);
    expect(run.body.migrated).toBeGreaterThanOrEqual(5);
    expect(run.body.failClosed).toBeGreaterThanOrEqual(1);
    // Idempotent: chạy lại không còn ứng viên nào của đợt này.
    const rerun = await http(app).post('/api/v1/blog/migrations/space-model').set(bearer(admin));
    expect(rerun.body.migrated).toBe(0);

    const get = (id: string, token: string) => http(app).get(`/api/v1/blog/posts/${id}`).set(bearer(token));

    // Draft cũ → cá nhân/private: người khác 404, tác giả 200.
    expect((await get(legacyDraft, memberX.token)).status).toBe(404);
    expect((await get(legacyDraft, author.token)).status).toBe(200);

    // Site không association → trường: giữ nguyên tầm nhìn (mọi user đọc được).
    expect((await get(legacySchool, outsider.token)).status).toBe(200);
    const schoolRow = await pg.query(`select space_type, status from blog_posts where id = $1`, [legacySchool]);
    expect(schoolRow.rows[0]).toMatchObject({ space_type: 'school', status: 'published' });

    // Site gắn 2 khoá: space chính = khoá đầu (X). Thành viên X giữ
    // quyền; thành viên Y (trước đây xem được theo hợp khoá) bị THU
    // HẸP còn 404; placement ghi lại khoá Y.
    expect((await get(legacyTwoCourses, memberX.token)).status).toBe(200);
    expect((await get(legacyTwoCourses, memberY.token)).status).toBe(404);
    expect((await get(legacyTwoCourses, outsider.token)).status).toBe(404);
    const placement = await pg.query(
      `select status from blog_post_placements where post_id = $1 and space_type = 'course' and space_id = $2`,
      [legacyTwoCourses, courseY.id],
    );
    expect(placement.rows).toHaveLength(1);
    expect(placement.rows[0].status).toBe('approved');

    // Site gắn qua module → space là khoá chứa module; lớp phụ trợ
    // (comment) cũng theo audience mới.
    expect((await get(legacyModule, memberX.token)).status).toBe(200);
    expect((await get(legacyModule, outsider.token)).status).toBe(404);
    const authorCtx = await contextIdByLevelInstance(app, admin, 30, author.id);
    const comments = await http(app).get('/api/v1/comments')
      .query({ contextId: authorCtx, component: 'core_blog', commentArea: 'post', itemId: legacyModule })
      .set(bearer(outsider.token));
    expect(comments.status).toBe(404);

    // Module không phân giải được → fail-closed: space course không id,
    // chỉ tác giả/admin đọc được.
    expect((await get(legacyGhost, memberX.token)).status).toBe(404);
    expect((await get(legacyGhost, outsider.token)).status).toBe(404);
    expect((await get(legacyGhost, author.token)).status).toBe(200);
    const ghostRow = await pg.query(`select space_type, space_id from blog_posts where id = $1`, [legacyGhost]);
    expect(ghostRow.rows[0].space_type).toBe('course');
    expect(ghostRow.rows[0].space_id).toBeNull();
  });
});

