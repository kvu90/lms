import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, createSection, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

/**
 * K2 — Học liệu thật + Player + tiến độ học (issue #85).
 * Luồng kiểm chứng: giáo viên (admin) tạo trang đọc + tài nguyên file +
 * tài nguyên liên kết trong một khoá; học sinh học qua player, tiến độ %
 * phải khớp dữ liệu completion (đối chiếu với API completion/me), Học
 * tiếp đưa về đúng mục dở dang theo last-access, và mốc lớp trên
 * outline khớp phần việc cả lớp đã hoàn thành.
 */
describe('K2 learning content, player & progress', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); }, 120_000);
  afterAll(async () => { await app.close(); });

  interface Fixture {
    course: { id: string; fullName: string; shortName: string };
    sectionId: string;
    section2Id: string;
    students: { id: string; username: string }[];
    tokens: string[];
    page: { id: string; cmId: string };
    fileRes: { id: string; cmId: string };
    urlRes: { id: string; cmId: string };
  }

  async function setup(studentCount = 2): Promise<Fixture> {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const section2 = await createSection(app, admin, course.id, { name: 'Tuần 2' });
    const instance = await createEnrolInstance(app, admin, course.id);
    const students: { id: string; username: string }[] = [];
    const tokens: string[] = [];
    for (let i = 0; i < studentCount; i += 1) {
      const s = await createUserViaApi(app, admin);
      await enrolUser(app, admin, course.id, instance.id, s.id);
      students.push(s);
      tokens.push((await login(app, s.username, STRONG_PASSWORD)).accessToken);
    }
    // Trang đọc (hoàn thành theo lượt xem) ở section 1.
    const pageRes = await http(app).post(`/api/v1/courses/${course.id}/pages`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId, name: 'Bài đọc 1', content: '<p>Nội dung bài đọc</p>' });
    if (pageRes.status !== 201) throw new Error(`create page failed: ${pageRes.status} ${JSON.stringify(pageRes.body)}`);
    // Tài nguyên file ở section 1: tệp tải lên context của khoá.
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    const upload = await http(app).post('/api/v1/files').set('Authorization', `Bearer ${admin}`)
      .field('contextId', String(content.body.contextId)).field('component', 'mod_resource').field('fileArea', 'content')
      .attach('file', Buffer.from('tai-lieu-hoc-tap'), 'phieu-bai-tap.txt');
    if (upload.status !== 201) throw new Error(`upload failed: ${upload.status} ${JSON.stringify(upload.body)}`);
    const fileResRes = await http(app).post(`/api/v1/courses/${course.id}/resources`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId, name: 'Phiếu bài tập', kind: 'file', fileId: upload.body.id });
    if (fileResRes.status !== 201) throw new Error(`create file resource failed: ${fileResRes.status} ${JSON.stringify(fileResRes.body)}`);
    // Tài nguyên liên kết (video) ở section 2: mặc định hoàn thành thủ công.
    const urlResRes = await http(app).post(`/api/v1/courses/${course.id}/resources`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: section2.id, name: 'Video bài giảng', kind: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    if (urlResRes.status !== 201) throw new Error(`create url resource failed: ${urlResRes.status} ${JSON.stringify(urlResRes.body)}`);
    return {
      course, sectionId, section2Id: section2.id, students, tokens,
      page: { id: pageRes.body.id, cmId: pageRes.body.cmId },
      fileRes: { id: fileResRes.body.id, cmId: fileResRes.body.cmId },
      urlRes: { id: urlResRes.body.id, cmId: urlResRes.body.cmId },
    };
  }

  it('tạo học liệu: page mặc định hoàn thành theo lượt xem, resource url mặc định thủ công, resource file có URL đã ký cho học sinh', async () => {
    const f = await setup();
    expect(f.page.cmId).toBeTruthy();
    const pageRead = await http(app).get(`/api/v1/pages/${f.page.id}`).set('Authorization', `Bearer ${f.tokens[0]}`);
    expect(pageRead.status).toBe(200);
    expect(pageRead.body.content).toContain('Nội dung bài đọc');
    expect(pageRead.body.completionMode).toBe('view');

    const fileRead = await http(app).get(`/api/v1/resources/${f.fileRes.id}`).set('Authorization', `Bearer ${f.tokens[0]}`);
    expect(fileRead.status).toBe(200);
    expect(fileRead.body.file.fileName).toBe('phieu-bai-tap.txt');
    expect(fileRead.body.file.signedUrl).toContain('/download?sig=');
    expect(fileRead.body.resource.completionMode).toBe('view');

    const urlRead = await http(app).get(`/api/v1/resources/${f.urlRes.id}`).set('Authorization', `Bearer ${f.tokens[0]}`);
    expect(urlRead.status).toBe(200);
    expect(urlRead.body.embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(urlRead.body.resource.completionMode).toBe('manual');

    // Người ngoài khoá không đọc được học liệu.
    const outsider = await createUserViaApi(app, admin);
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    const denied = await http(app).get(`/api/v1/pages/${f.page.id}`).set('Authorization', `Bearer ${outsiderToken}`);
    expect(denied.status).toBe(403);
  });

  it('player + tiến độ: xem trang → hoàn thành theo lượt xem; % tiến độ khớp API completion; đánh dấu đã học cho mục thủ công', async () => {
    const f = await setup();
    const me = f.tokens[0]!;
    const studentId = f.students[0]!.id;

    const before = await http(app).get(`/api/v1/courses/${f.course.id}/progress/me`).set('Authorization', `Bearer ${me}`);
    expect(before.status).toBe(200);
    expect(before.body.total).toBe(3);
    expect(before.body.completed).toBe(0);
    expect(before.body.percent).toBe(0);
    expect(before.body.resume.cmId).toBe(f.page.cmId);

    // Mở player ở trang đọc: có nội dung, có Trước/Tiếp, ghi last-access.
    const player = await http(app).get(`/api/v1/courses/${f.course.id}/player/${f.page.cmId}`).set('Authorization', `Bearer ${me}`);
    expect(player.status).toBe(200);
    expect(player.body.content.type).toBe('page');
    expect(player.body.content.page.content).toContain('Nội dung bài đọc');
    expect(player.body.prevCmId).toBeNull();
    expect(player.body.nextCmId).toBe(f.fileRes.cmId);
    expect(player.body.progress.lastAccess.cmId).toBe(f.page.cmId);

    // Tự ghi nhận đã xem qua endpoint /view sẵn có → completion theo lượt xem.
    const viewed = await http(app).post(`/api/v1/courses/${f.course.id}/modules/${f.page.cmId}/view`).set('Authorization', `Bearer ${me}`);
    expect(viewed.status).toBeLessThan(300);

    // Đối chiếu % tiến độ với dữ liệu completion thô từ API completion/me.
    const completionMe = await http(app).get(`/api/v1/courses/${f.course.id}/completion/me`).set('Authorization', `Bearer ${me}`);
    const doneCount = (completionMe.body.activities as { state: number }[]).filter((a) => a.state !== 0).length;
    const progress = await http(app).get(`/api/v1/courses/${f.course.id}/progress/me`).set('Authorization', `Bearer ${me}`);
    expect(progress.body.completed).toBe(doneCount);
    expect(progress.body.completed).toBe(1);
    expect(progress.body.percent).toBe(33);
    const s1 = (progress.body.sections as { sectionId: string; percent: number | null }[]).find((s) => s.sectionId === f.sectionId);
    const s2 = (progress.body.sections as { sectionId: string; percent: number | null }[]).find((s) => s.sectionId === f.section2Id);
    expect(s1?.percent).toBe(50);
    expect(s2?.percent).toBe(0);
    // Học tiếp: mục theo dõi đầu tiên chưa xong = tài nguyên file.
    expect(progress.body.resume.cmId).toBe(f.fileRes.cmId);

    // Mục liên kết không tự đo được: học sinh tự "Đánh dấu đã học".
    const mark = await http(app).post(`/api/v1/courses/${f.course.id}/modules/${f.urlRes.cmId}/completion/manual`)
      .set('Authorization', `Bearer ${me}`).send({ userId: studentId, complete: true });
    expect(mark.status).toBeLessThan(300);
    const after = await http(app).get(`/api/v1/courses/${f.course.id}/progress/me`).set('Authorization', `Bearer ${me}`);
    expect(after.body.completed).toBe(2);
    expect(after.body.percent).toBe(67);
    const urlItem = (after.body.sections as { items: { cmId: string; done: boolean }[] }[])
      .flatMap((s) => s.items).find((i) => i.cmId === f.urlRes.cmId);
    expect(urlItem?.done).toBe(true);
  });

  it('resume theo last-access: mở dở một mục chưa xong rồi quay lại thì Học tiếp trỏ đúng mục đó', async () => {
    const f = await setup();
    const me = f.tokens[0]!;
    // Mở player ở tài nguyên liên kết (chưa đánh dấu xong) — last-access nằm ở đó.
    const player = await http(app).get(`/api/v1/courses/${f.course.id}/player/${f.urlRes.cmId}`).set('Authorization', `Bearer ${me}`);
    expect(player.status).toBe(200);
    expect(player.body.content.type).toBe('resource');
    expect(player.body.content.embedUrl).toContain('youtube.com/embed/');
    const progress = await http(app).get(`/api/v1/courses/${f.course.id}/progress/me`).set('Authorization', `Bearer ${me}`);
    expect(progress.body.lastAccess.cmId).toBe(f.urlRes.cmId);
    expect(progress.body.resume).toEqual({ cmId: f.urlRes.cmId, reason: 'last_access' });
  });

  it('mốc lớp: cả lớp xong trang đọc, chưa ai xong phần còn lại → mốc dừng ở trang đọc; % lớp khớp completion', async () => {
    const f = await setup();
    // Tạo nhóm lớp gồm cả hai học sinh.
    const group = await http(app).post(`/api/v1/courses/${f.course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Lớp A' });
    expect(group.status).toBeLessThan(300);
    for (const s of f.students) {
      const add = await http(app).post(`/api/v1/courses/${f.course.id}/groups/${group.body.id}/members`)
        .set('Authorization', `Bearer ${admin}`).send({ userId: s.id });
      expect(add.status).toBeLessThan(300);
    }
    // Cả hai học sinh xem trang đọc (hoàn thành theo lượt xem).
    for (const token of f.tokens) {
      const v = await http(app).post(`/api/v1/courses/${f.course.id}/modules/${f.page.cmId}/view`).set('Authorization', `Bearer ${token}`);
      expect(v.status).toBeLessThan(300);
    }
    const markers = await http(app).get(`/api/v1/courses/${f.course.id}/progress/class-markers`).set('Authorization', `Bearer ${admin}`);
    expect(markers.status).toBe(200);
    expect(markers.body.trackedTotal).toBe(3);
    const marker = (markers.body.markers as { groupId: string }[]).find((m) => m.groupId === group.body.id) as {
      markerCmId: string; markerIndex: number; percent: number; memberCount: number;
    };
    expect(marker).toBeDefined();
    expect(marker.markerCmId).toBe(f.page.cmId);
    expect(marker.markerIndex).toBe(0);
    expect(marker.memberCount).toBe(2);
    // 2 học sinh × 1 mục xong / (2 × 3 mục theo dõi) = 33%.
    expect(marker.percent).toBe(33);
  });

  it('sửa/xoá học liệu: đổi nội dung trang và xoá tài nguyên thì cm biến mất khỏi outline của học sinh', async () => {
    const f = await setup();
    const patch = await http(app).patch(`/api/v1/pages/${f.page.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ content: '<p>Nội dung đã sửa</p>' });
    expect(patch.status).toBe(200);
    const read = await http(app).get(`/api/v1/pages/${f.page.id}`).set('Authorization', `Bearer ${f.tokens[0]}`);
    expect(read.body.content).toContain('Nội dung đã sửa');

    const del = await http(app).delete(`/api/v1/resources/${f.fileRes.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(200);
    const progress = await http(app).get(`/api/v1/courses/${f.course.id}/progress/me`).set('Authorization', `Bearer ${f.tokens[0]}`);
    expect(progress.body.total).toBe(2);
    const gone = await http(app).get(`/api/v1/resources/${f.fileRes.id}`).set('Authorization', `Bearer ${f.tokens[0]}`);
    expect(gone.status).toBe(404);
  });
});
