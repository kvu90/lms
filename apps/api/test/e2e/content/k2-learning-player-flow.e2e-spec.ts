import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, createSection, enrolUser, getFirstSectionId } from '../../support/course-enrolment-helpers';

/**
 * K2 — Học liệu thật + Player + tiến độ học (issue #85), gồm phần hấp
 * thụ nghiên cứu học liệu số VN (K2-B1→B6):
 *  - B1: mặc định hoàn thành theo loại nội dung (trang đọc/tài liệu =
 *    manual: mở xem + tự xác nhận; video = progress ≥ 90%; tệp khác/
 *    liên kết ngoài = none: chỉ ghi truy cập, ngoài % hoàn thành).
 *  - B2: sự kiện học lưu bền + bản ghi hồ sơ chụp tên mục khi hoàn
 *    thành (Điều 8 TT 09/2021).
 *  - B4: báo cáo tiến độ GV (ma trận lớp × mục + CSV + lọc nhóm).
 *  - B5: mẫu cấu trúc bài học theo khung CV 5512.
 * % tiến độ luôn đối chiếu với dữ liệu completion qua API completion.
 */
describe('Nội dung học tập, trình phát và tiến độ K2', () => {
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
    docRes: { id: string; cmId: string };
    videoRes: { id: string; cmId: string };
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
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    const courseCtx = String(content.body.contextId);
    async function upload(fileName: string, contentType: string, data: string): Promise<string> {
      const res = await http(app).post('/api/v1/files').set('Authorization', `Bearer ${admin}`)
        .field('contextId', courseCtx).field('component', 'mod_resource').field('fileArea', 'content')
        .attach('file', Buffer.from(data), { filename: fileName, contentType });
      if (res.status !== 201) throw new Error(`upload ${fileName} failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.id as string;
    }
    // Trang đọc ở section 1 (mặc định manual theo B1).
    const pageRes = await http(app).post(`/api/v1/courses/${course.id}/pages`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId, name: 'Bài đọc 1', content: '<p>Nội dung bài đọc</p>' });
    if (pageRes.status !== 201) throw new Error(`create page failed: ${pageRes.status} ${JSON.stringify(pageRes.body)}`);
    // Tài liệu văn bản ở section 1 (mặc định manual theo B1).
    const docFileId = await upload('phieu-bai-tap.txt', 'text/plain', 'tai-lieu-hoc-tap');
    const docRes = await http(app).post(`/api/v1/courses/${course.id}/resources`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId, name: 'Phiếu bài tập', kind: 'file', fileId: docFileId });
    if (docRes.status !== 201) throw new Error(`create doc resource failed: ${docRes.status} ${JSON.stringify(docRes.body)}`);
    // Video ở section 2 (mặc định progress theo B1) kèm transcript.
    const videoFileId = await upload('bai-giang.mp4', 'video/mp4', 'fake-video-bytes');
    const videoRes = await http(app).post(`/api/v1/courses/${course.id}/resources`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: section2.id, name: 'Video bài giảng', kind: 'file', fileId: videoFileId, transcript: 'Bản chữ của bài giảng.' });
    if (videoRes.status !== 201) throw new Error(`create video resource failed: ${videoRes.status} ${JSON.stringify(videoRes.body)}`);
    // Liên kết ngoài ở section 2 (mặc định none theo B1).
    const urlRes = await http(app).post(`/api/v1/courses/${course.id}/resources`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: section2.id, name: 'Video ngoài', kind: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    if (urlRes.status !== 201) throw new Error(`create url resource failed: ${urlRes.status} ${JSON.stringify(urlRes.body)}`);
    return {
      course, sectionId, section2Id: section2.id, students, tokens,
      page: { id: pageRes.body.id, cmId: pageRes.body.cmId },
      docRes: { id: docRes.body.id, cmId: docRes.body.cmId },
      videoRes: { id: videoRes.body.id, cmId: videoRes.body.cmId },
      urlRes: { id: urlRes.body.id, cmId: urlRes.body.cmId },
    };
  }

  async function markManual(f: Fixture, token: string, studentId: string, cmId: string) {
    const res = await http(app).post(`/api/v1/courses/${f.course.id}/modules/${cmId}/completion/manual`)
      .set('Authorization', `Bearer ${token}`).send({ userId: studentId, complete: true });
    expect(res.status).toBeLessThan(300);
  }

  it('B1 — mặc định hoàn thành theo loại: trang/tài liệu = manual, video = progress, liên kết = none (ngoài %)', async () => {
    const f = await setup();
    const me = f.tokens[0]!;
    const pageRead = await http(app).get(`/api/v1/pages/${f.page.id}`).set('Authorization', `Bearer ${me}`);
    expect(pageRead.status).toBe(200);
    expect(pageRead.body.completionMode).toBe('manual');
    const docRead = await http(app).get(`/api/v1/resources/${f.docRes.id}`).set('Authorization', `Bearer ${me}`);
    expect(docRead.body.resource.completionMode).toBe('manual');
    expect(docRead.body.file.fileName).toBe('phieu-bai-tap.txt');
    expect(docRead.body.file.signedUrl).toContain('/download?sig=');
    const videoRead = await http(app).get(`/api/v1/resources/${f.videoRes.id}`).set('Authorization', `Bearer ${me}`);
    expect(videoRead.body.resource.completionMode).toBe('progress');
    expect(videoRead.body.resource.transcript).toBe('Bản chữ của bài giảng.');
    const urlRead = await http(app).get(`/api/v1/resources/${f.urlRes.id}`).set('Authorization', `Bearer ${me}`);
    expect(urlRead.body.resource.completionMode).toBe('none');
    expect(urlRead.body.embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    // Mẫu số tiến độ chỉ gồm 3 mục được theo dõi (liên kết ngoài %).
    const progress = await http(app).get(`/api/v1/courses/${f.course.id}/progress/me`).set('Authorization', `Bearer ${me}`);
    expect(progress.body.total).toBe(3);
    // Người ngoài khoá không đọc được học liệu.
    const outsider = await createUserViaApi(app, admin);
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    expect((await http(app).get(`/api/v1/pages/${f.page.id}`).set('Authorization', `Bearer ${outsiderToken}`)).status).toBe(403);
  });

  it('player + tiến độ: xem trang chỉ ghi nhận đã xem (manual chưa xong), tự xác nhận mới hoàn thành; % khớp API completion', async () => {
    const f = await setup();
    const me = f.tokens[0]!;
    const studentId = f.students[0]!.id;

    const player = await http(app).get(`/api/v1/courses/${f.course.id}/player/${f.page.cmId}`).set('Authorization', `Bearer ${me}`);
    expect(player.status).toBe(200);
    expect(player.body.content.type).toBe('page');
    expect(player.body.content.page.content).toContain('Nội dung bài đọc');
    expect(player.body.prevCmId).toBeNull();
    expect(player.body.nextCmId).toBe(f.docRes.cmId);
    expect(player.body.progress.lastAccess.cmId).toBe(f.page.cmId);

    const viewed = await http(app).post(`/api/v1/courses/${f.course.id}/modules/${f.page.cmId}/view`).set('Authorization', `Bearer ${me}`);
    expect(viewed.status).toBeLessThan(300);
    // Đã xem ≠ đã hoàn thành với mục manual.
    const completionMe = await http(app).get(`/api/v1/courses/${f.course.id}/completion/me`).set('Authorization', `Bearer ${me}`);
    const pageActivity = (completionMe.body.activities as { cmId: string; state: number; viewed: boolean }[]).find((a) => a.cmId === f.page.cmId);
    expect(pageActivity?.viewed).toBe(true);
    expect(pageActivity?.state).toBe(0);
    let progress = await http(app).get(`/api/v1/courses/${f.course.id}/progress/me`).set('Authorization', `Bearer ${me}`);
    expect(progress.body.completed).toBe(0);

    await markManual(f, me, studentId, f.page.cmId);
    progress = await http(app).get(`/api/v1/courses/${f.course.id}/progress/me`).set('Authorization', `Bearer ${me}`);
    const doneCount = (completionMe.body.activities as { state: number }[]).filter((a) => a.state !== 0).length;
    const completionMe2 = await http(app).get(`/api/v1/courses/${f.course.id}/completion/me`).set('Authorization', `Bearer ${me}`);
    const doneCount2 = (completionMe2.body.activities as { state: number }[]).filter((a) => a.state !== 0).length;
    expect(doneCount).toBe(0);
    expect(progress.body.completed).toBe(doneCount2);
    expect(progress.body.completed).toBe(1);
    expect(progress.body.percent).toBe(33);
    const s1 = (progress.body.sections as { sectionId: string; percent: number | null }[]).find((s) => s.sectionId === f.sectionId);
    expect(s1?.percent).toBe(50);
    // Học tiếp: mục theo dõi đầu tiên chưa xong = phiếu bài tập.
    expect(progress.body.resume.cmId).toBe(f.docRes.cmId);
  });

  it('B1/B2 — video: báo tiến độ 50% chưa xong, 95% thì hoàn thành và % không thụt lùi khi báo lại thấp hơn (ôn lại an toàn)', async () => {
    const f = await setup();
    const me = f.tokens[0]!;
    const post = (percent: number, positionSeconds: number) => http(app)
      .post(`/api/v1/courses/${f.course.id}/modules/${f.videoRes.cmId}/progress`)
      .set('Authorization', `Bearer ${me}`).send({ percent, positionSeconds });
    const half = await post(50, 120);
    expect(half.status).toBeLessThan(300);
    expect(half.body.state).toBe(0);
    expect(half.body.percent).toBe(50);
    // Vị trí dở được player trả lại để học tiếp đúng chỗ.
    const player = await http(app).get(`/api/v1/courses/${f.course.id}/player/${f.videoRes.cmId}`).set('Authorization', `Bearer ${me}`);
    expect(player.body.itemProgress).toEqual({ percent: 50, positionSeconds: 120, page: null });
    const done = await post(95, 570);
    expect(done.body.state).toBe(1);
    const progress = await http(app).get(`/api/v1/courses/${f.course.id}/progress/me`).set('Authorization', `Bearer ${me}`);
    expect(progress.body.completed).toBe(1);
    // Ôn lại: báo lại 10% không làm mất hoàn thành, % giữ mức cao nhất.
    const again = await post(10, 60);
    expect(again.body.percent).toBe(95);
    expect(again.body.state).toBe(1);
  });

  it('resume theo last-access: mở dở một mục chưa xong rồi quay lại thì Học tiếp trỏ đúng mục đó', async () => {
    const f = await setup();
    const me = f.tokens[0]!;
    const player = await http(app).get(`/api/v1/courses/${f.course.id}/player/${f.urlRes.cmId}`).set('Authorization', `Bearer ${me}`);
    expect(player.status).toBe(200);
    expect(player.body.content.type).toBe('resource');
    const progress = await http(app).get(`/api/v1/courses/${f.course.id}/progress/me`).set('Authorization', `Bearer ${me}`);
    expect(progress.body.lastAccess.cmId).toBe(f.urlRes.cmId);
    expect(progress.body.resume).toEqual({ cmId: f.urlRes.cmId, reason: 'last_access' });
  });

  it('mốc lớp: cả lớp xác nhận xong trang đọc → mốc dừng ở trang đọc; % lớp khớp dữ liệu completion', async () => {
    const f = await setup();
    const group = await http(app).post(`/api/v1/courses/${f.course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Lớp A' });
    expect(group.status).toBeLessThan(300);
    for (const s of f.students) {
      const add = await http(app).post(`/api/v1/courses/${f.course.id}/groups/${group.body.id}/members`)
        .set('Authorization', `Bearer ${admin}`).send({ userId: s.id });
      expect(add.status).toBeLessThan(300);
    }
    for (let i = 0; i < f.students.length; i += 1) {
      await markManual(f, f.tokens[i]!, f.students[i]!.id, f.page.cmId);
    }
    const markers = await http(app).get(`/api/v1/courses/${f.course.id}/progress/class-markers`).set('Authorization', `Bearer ${admin}`);
    expect(markers.status).toBe(200);
    expect(markers.body.trackedTotal).toBe(3);
    const marker = (markers.body.markers as {
      groupId: string; markerCmId: string; markerIndex: number; percent: number; memberCount: number;
    }[]).find((m) => m.groupId === group.body.id);
    if (!marker) throw new Error('class marker for the group is missing');
    expect(marker.markerCmId).toBe(f.page.cmId);
    expect(marker.markerIndex).toBe(0);
    expect(marker.memberCount).toBe(2);
    expect(marker.percent).toBe(33);
  });

  it('B4/B2 — báo cáo GV: ma trận lớp × mục + tổng theo mục/HS + hồ sơ chụp tên mục; CSV tải được; HS không xem được báo cáo', async () => {
    const f = await setup();
    await markManual(f, f.tokens[0]!, f.students[0]!.id, f.page.cmId);
    await markManual(f, f.tokens[1]!, f.students[1]!.id, f.page.cmId);
    await markManual(f, f.tokens[0]!, f.students[0]!.id, f.docRes.cmId);

    const report = await http(app).get(`/api/v1/courses/${f.course.id}/progress/report`).set('Authorization', `Bearer ${admin}`);
    expect(report.status).toBe(200);
    expect(report.body.items).toHaveLength(3);
    const pageItem = (report.body.items as { cmId: string; completedCount: number; percent: number }[]).find((i) => i.cmId === f.page.cmId);
    expect(pageItem?.completedCount).toBe(2);
    expect(pageItem?.percent).toBe(100);
    const docItem = (report.body.items as { cmId: string; completedCount: number; percent: number }[]).find((i) => i.cmId === f.docRes.cmId);
    expect(docItem?.completedCount).toBe(1);
    expect(docItem?.percent).toBe(50);
    const s1 = (report.body.students as { userId: string; percent: number; records: { cmId: string; cmName: string }[] }[])
      .find((s) => s.userId === f.students[0]!.id);
    expect(s1?.percent).toBe(67);
    // Hồ sơ hoàn thành chụp đúng tên mục tại thời điểm hoàn thành.
    expect(s1?.records.map((r) => r.cmName).sort()).toEqual(['Bài đọc 1', 'Phiếu bài tập']);
    // Lọc theo nhóm: tạo nhóm chỉ gồm học sinh 2 → báo cáo chỉ còn 1 HS.
    const group = await http(app).post(`/api/v1/courses/${f.course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Tổ 1' });
    await http(app).post(`/api/v1/courses/${f.course.id}/groups/${group.body.id}/members`)
      .set('Authorization', `Bearer ${admin}`).send({ userId: f.students[1]!.id });
    const filtered = await http(app).get(`/api/v1/courses/${f.course.id}/progress/report?groupId=${group.body.id}`).set('Authorization', `Bearer ${admin}`);
    expect(filtered.body.students).toHaveLength(1);
    expect(filtered.body.students[0].userId).toBe(f.students[1]!.id);
    // CSV.
    const csv = await http(app).get(`/api/v1/courses/${f.course.id}/progress/reports?format=csv`).set('Authorization', `Bearer ${admin}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toContain('Bài đọc 1');
    expect(csv.text).toContain('x');
    // Học sinh không có quyền quản completion → 403.
    const denied = await http(app).get(`/api/v1/courses/${f.course.id}/progress/report`).set('Authorization', `Bearer ${f.tokens[0]}`);
    expect(denied.status).toBe(403);
  });

  it('B5 — mẫu bài học CV 5512: tạo đủ 5 section theo khung với tiền tố tên bài', async () => {
    const f = await setup(1);
    const res = await http(app).post(`/api/v1/courses/${f.course.id}/lesson-template`)
      .set('Authorization', `Bearer ${admin}`).send({ title: 'Bài 1: Số tự nhiên' });
    expect(res.status).toBeLessThan(300);
    const names = (res.body as { name: string }[]).map((s) => s.name);
    expect(names).toEqual([
      'Bài 1: Số tự nhiên — Mở đầu',
      'Bài 1: Số tự nhiên — Hình thành kiến thức mới',
      'Bài 1: Số tự nhiên — Luyện tập',
      'Bài 1: Số tự nhiên — Vận dụng',
      'Bài 1: Số tự nhiên — Kiểm tra nhanh & tổng kết',
    ]);
  });

  it('sửa/xoá học liệu: đổi nội dung trang và xoá tài nguyên thì cm biến mất khỏi outline của học sinh', async () => {
    const f = await setup();
    const patch = await http(app).patch(`/api/v1/pages/${f.page.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ content: '<p>Nội dung đã sửa</p>' });
    expect(patch.status).toBe(200);
    const read = await http(app).get(`/api/v1/pages/${f.page.id}`).set('Authorization', `Bearer ${f.tokens[0]}`);
    expect(read.body.content).toContain('Nội dung đã sửa');

    const del = await http(app).delete(`/api/v1/resources/${f.docRes.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(200);
    const progress = await http(app).get(`/api/v1/courses/${f.course.id}/progress/me`).set('Authorization', `Bearer ${f.tokens[0]}`);
    expect(progress.body.total).toBe(2);
    const gone = await http(app).get(`/api/v1/resources/${f.docRes.id}`).set('Authorization', `Bearer ${f.tokens[0]}`);
    expect(gone.status).toBe(404);
  });
});
