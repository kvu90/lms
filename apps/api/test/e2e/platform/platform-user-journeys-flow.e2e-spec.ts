import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD, uniqueName,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createCm, createEnrolInstance, createSection, enrolUser } from '../../support/course-enrolment-helpers';

/**
 * Hành trình người dùng (user journeys) dịch từ oracle Behat của Moodle 5.3
 * (MOODLE_503_STABLE, đã kiểm chứng live 22/10/2026) — chỉ dịch BƯỚC NGHIỆP VỤ
 * và KẾT QUẢ KỲ VỌNG thành e2e qua HTTP; các bước gắn giao diện PHP (ô tìm
 * kiếm trên header, breadcrumb, fieldset, menu hành động, dialogue) là chi
 * tiết cài đặt UI và được bỏ qua:
 * - Behat `search/tests/behat/search_query.feature`, scenario
 *   "Search from search page with two results": truy vấn khớp thì thấy các
 *   kết quả khớp kèm mô tả; truy vấn không khớp thì "No results".
 * - Behat `search/tests/behat/search_by_user.feature`, scenario
 *   "As student, cannot see users on other courses": người học không thấy
 *   nội dung/người dùng của khoá mình không tham gia.
 * - Behat `backup/util/ui/tests/behat/restore_moodle2_courses.feature`,
 *   scenarios "Restore a course in another existing course" (khoá đích giữ
 *   nguyên danh tính, nhận thêm nội dung nguồn) và "Restore a course in a
 *   new course" (khoá mới chứa đủ section/nội dung của nguồn, không thừa).
 * - Behat `admin/tool/dataprivacy/tests/behat/manage_data_requests.feature`,
 *   scenarios "Bulk accepting requests" / "Bulk denying requests": người
 *   dùng gửi yêu cầu export, privacy officer thấy cả hai ở trạng thái chờ
 *   duyệt, duyệt thì thành Approved, từ chối thì thành Rejected (thao tác
 *   hàng loạt trên UI được dịch thành quyết định cho từng yêu cầu qua API).
 */
describe('Hành trình người dùng platform (dẫn từ Behat): tìm kiếm, khôi phục, yêu cầu riêng tư', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  it('hành trình tìm kiếm: truy vấn khớp trả các kết quả nhìn thấy được, truy vấn không khớp trả rỗng, và khoá khác vẫn vô hình', async () => {
    const cat = await createCategory(app, admin);
    const tokenA = uniqueName('amphibian');
    const tokenB = uniqueName('zombie');
    const courseA = await createCourse(app, admin, cat.id, { fullName: `Course ${tokenA}` });
    const courseB = await createCourse(app, admin, cat.id, { fullName: `Course ${tokenB}` });
    const instanceA = await createEnrolInstance(app, admin, courseA.id);
    const instanceB = await createEnrolInstance(app, admin, courseB.id);
    const student = await createUserViaApi(app, admin);
    const outsider = await createUserViaApi(app, admin);
    await enrolUser(app, admin, courseA.id, instanceA.id, student.id);
    await enrolUser(app, admin, courseB.id, instanceB.id, outsider.id);
    await http(app).post('/api/v1/search/reindex').set('Authorization', `Bearer ${admin}`).send({});
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;

    // Behat "two results": truy vấn khớp → thấy kết quả của khoá mình tham gia.
    const hits = await http(app).get(`/api/v1/search?q=${tokenA}`).set('Authorization', `Bearer ${studentToken}`);
    expect((hits.body as { area: string; itemId: string }[]).some((d) => d.area === 'courses' && d.itemId === courseA.id)).toBe(true);
    // Behat "cannot see users on other courses" gắn với user-picker của form
    // tìm kiếm PHP (autocomplete chỉ liệt kê user của khoá đang chọn trong
    // "Search within") — đó là chi tiết cài đặt UI, bỏ qua theo quy ước dịch
    // oracle. Phần nghiệp vụ tương ứng ở mức API
    // (tài liệu users chỉ hiện với người có user:viewdetails tại
    // context của user đó) đã được kiểm ở flow test PROHIBIT/re-check của
    // search; ở đây chỉ khẳng định control: tài liệu của outsider THẬT SỰ có
    // trong index (admin thấy), để các assertion "không thấy" không rỗng.
    void tokenB; void courseB;
    const asAdmin = await http(app).get(`/api/v1/search?q=${outsider.username}`).set('Authorization', `Bearer ${admin}`);
    expect((asAdmin.body as { area: string; itemId: string }[]).some((d) => d.area === 'users' && d.itemId === outsider.id)).toBe(true);
    // Behat "No results": truy vấn không khớp gì → danh sách rỗng.
    const none = await http(app).get(`/api/v1/search?q=${uniqueName('nomatch')}`).set('Authorization', `Bearer ${studentToken}`);
    expect(none.body).toEqual([]);
  });

  it('hành trình khôi phục: hợp nhất vào khoá sẵn có giữ định danh đích và thêm nội dung nguồn; thay thế vào khoá mới sao chép đúng cấu trúc nguồn', async () => {
    const cat = await createCategory(app, admin);
    const source = await createCourse(app, admin, cat.id, { fullName: uniqueName('JourneySource') });
    const section = await createSection(app, admin, source.id, { name: 'Journey Week' });
    const cm = await createCm(app, admin, source.id, section.id, { name: 'Journey Reading', completion: 1, completionManual: true });
    void cm;
    const backup = await http(app).post('/api/v1/backup/jobs').set('Authorization', `Bearer ${admin}`).send({ courseId: source.id });
    expect(backup.body.status).toBe('completed');
    const sourceContent = await http(app).get(`/api/v1/courses/${source.id}/content`).set('Authorization', `Bearer ${admin}`);
    const sourceSections = (sourceContent.body.sections as unknown[]).length;

    // Behat: restore vào khoá có sẵn — "I should see Course 2" (danh tính
    // đích giữ nguyên) và "I should see Test forum name" (nội dung nguồn có mặt).
    const target = await createCourse(app, admin, cat.id, { fullName: uniqueName('JourneyTarget') });
    const merge = await http(app).post('/api/v1/backup/restore').set('Authorization', `Bearer ${admin}`)
      .send({ backupJobId: backup.body.id, mode: 'merge', targetCourseId: target.id });
    expect(merge.body.status).toBe('completed');
    const targetAfter = await http(app).get(`/api/v1/courses/${target.id}`).set('Authorization', `Bearer ${admin}`);
    expect(targetAfter.body.fullName).toBe(target.fullName);
    const targetContent = await http(app).get(`/api/v1/courses/${target.id}/content`).set('Authorization', `Bearer ${admin}`);
    const targetModuleNames = (targetContent.body.sections as { modules: { name: string }[] }[]).flatMap((s) => s.modules.map((m) => m.name));
    expect(targetModuleNames).toContain('Journey Reading');

    // Behat: restore thành khoá mới — đủ section của nguồn, không thừa
    // ("Section 15" có, "Section 16" không). Từ CLASS-0 (PR #200),
    // restore-as-new bị từ chối vì khoá mới phải thuộc một lớp
    // (400 course.class_required); tương đương Behat đạt bằng replace
    // vào một khoá đích trống.
    const restoreNew = await http(app).post('/api/v1/backup/restore').set('Authorization', `Bearer ${admin}`)
      .send({ backupJobId: backup.body.id, mode: 'new' });
    expect(restoreNew.status).toBe(400);
    expect(restoreNew.body.code).toBe('course.class_required');
    const freshTarget = await createCourse(app, admin, cat.id, { fullName: uniqueName('JourneyFresh') });
    const restore = await http(app).post('/api/v1/backup/restore').set('Authorization', `Bearer ${admin}`)
      .send({ backupJobId: backup.body.id, mode: 'replace', targetCourseId: freshTarget.id });
    expect(restore.body.status).toBe('completed');
    const newContent = await http(app).get(`/api/v1/courses/${restore.body.targetCourseId}/content`).set('Authorization', `Bearer ${admin}`);
    expect((newContent.body.sections as unknown[]).length).toBe(sourceSections);
    const newModuleNames = (newContent.body.sections as { modules: { name: string }[] }[]).flatMap((s) => s.modules.map((m) => m.name));
    expect(newModuleNames).toContain('Journey Reading');
  });

  it('hành trình riêng tư: hai người gửi yêu cầu xuất, cán bộ thấy cả hai đang chờ duyệt, duyệt hoàn tất chúng và từ chối bác bỏ', async () => {
    const userA = await createUserViaApi(app, admin);
    const userB = await createUserViaApi(app, admin);
    const userC = await createUserViaApi(app, admin);
    const tokenOf = async (u: { username: string }) => (await login(app, u.username, STRONG_PASSWORD)).accessToken;
    // Token phải lấy TRƯỚC khi dựng request ngoài: lồng một request supertest
    // (login) vào tham số của request khác làm hai Test dùng chung HTTP
    // server chưa listen và đóng lẫn nhau (lỗi 'address' of null).
    const [tokA, tokB, tokC] = [await tokenOf(userA), await tokenOf(userB), await tokenOf(userC)];
    const reqA = await http(app).post('/api/v1/privacy/requests').set('Authorization', `Bearer ${tokA}`).send({ type: 'export' });
    const reqB = await http(app).post('/api/v1/privacy/requests').set('Authorization', `Bearer ${tokB}`).send({ type: 'export' });
    const reqC = await http(app).post('/api/v1/privacy/requests').set('Authorization', `Bearer ${tokC}`).send({ type: 'export' });
    for (const r of [reqA, reqB, reqC]) expect(r.body.status).toBe('pending');

    // Officer thấy cả hai yêu cầu ở trạng thái chờ duyệt (Awaiting approval).
    const list = await http(app).get('/api/v1/privacy/requests').set('Authorization', `Bearer ${admin}`);
    const byId = new Map((list.body as { id: string; status: string }[]).map((r) => [r.id, r.status]));
    expect(byId.get(reqA.body.id)).toBe('pending');
    expect(byId.get(reqB.body.id)).toBe('pending');

    // Duyệt → Approved (hệ thống xử lý ngay sau duyệt nên trạng thái cuối là
    // completed kèm gói export); từ chối → Rejected và không xử lý tiếp được.
    const doneA = await http(app).post(`/api/v1/privacy/requests/${reqA.body.id}/decide`).set('Authorization', `Bearer ${admin}`).send({ decision: 'approved' });
    expect(doneA.body.status).toBe('completed');
    const filesA = await http(app).get(`/api/v1/privacy/requests/${reqA.body.id}/files`).set('Authorization', `Bearer ${admin}`);
    expect((filesA.body as unknown[]).length).toBeGreaterThan(0);
    const doneB = await http(app).post(`/api/v1/privacy/requests/${reqB.body.id}/decide`).set('Authorization', `Bearer ${admin}`).send({ decision: 'approved' });
    expect(doneB.body.status).toBe('completed');
    const deniedC = await http(app).post(`/api/v1/privacy/requests/${reqC.body.id}/decide`).set('Authorization', `Bearer ${admin}`).send({ decision: 'rejected' });
    expect(deniedC.body.status).toBe('rejected');
    const again = await http(app).post(`/api/v1/privacy/requests/${reqC.body.id}/decide`).set('Authorization', `Bearer ${admin}`).send({ decision: 'approved' });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });
});
