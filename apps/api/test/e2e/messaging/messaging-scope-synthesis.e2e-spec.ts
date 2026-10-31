import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, roleIdByShortname,
  STRONG_PASSWORD, systemContextId,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';

/**
 * Người có phạm vi quản trị nhưng CHƯA TỪNG MỞ vẫn thấy hàng
 * lớp/khoá tổng hợp với số chưa đọc 0, và liệt kê không được ghi
 * dòng thành viên cho họ (issue #592, điểm B1 của vòng sửa).
 *
 * Vì sao ca này ở file riêng, không chung file liệt kê của quản trị
 * viên: vòng lặp liệt kê đồng bộ lại toàn bộ tập thành viên đích
 * của từng conversation đã liệt kê (syncCourse/ClassConversation
 * Members trên mỗi hàng tóm tắt), nên một staff được gán SAU khi
 * conversation đã ensure sẽ bị vật chất hoá membership ngay ở lần
 * liệt kê đầu tiên của bất kỳ thành viên nào sau đó. Vì vậy người
 * xem chưa-từng-mở chỉ giữ đúng trạng thái "có phạm vi, chưa có
 * dòng thành viên" khi không có thành viên nào liệt kê các
 * conversation đã dàn dựng trong khoảng giữa lúc gán và lúc khẳng
 * định — file này không liệt kê dưới vai trò nào khác ngoài người
 * xem, và bản thân đường liệt kê của người xem cũng không kích
 * hoạt đồng bộ cho họ (họ không thuộc định nghĩa thành viên theo
 * khoá/lớp: không ghi danh, không gán tại context khoá/lớp).
 *
 * Vì sao người xem KHÔNG phải tài khoản quản trị hệ thống dùng
 * chung: quản trị hệ thống mang vai Manager tại context hệ thống
 * nên đã nằm trong tập staff của mọi khoá/lớp và luôn được vật
 * chất hoá membership ngay khi conversation được tạo/đồng bộ.
 * Người xem đúng là user được gán Manager tại context hệ thống
 * SAU khi conversation đã ensure: có phạm vi qua kế thừa
 * capability (`course:managegroups`, `class` staff theo đường dẫn
 * context) nhưng chưa có dòng thành viên.
 *
 * Dàn dựng: một khoá (giáo viên + học viên ghi danh, chỉ giáo viên
 * ensure) và một lớp (giáo viên là chủ lớp, học viên vào roster,
 * chỉ giáo viên ensure); giáo viên gửi một tin vào mỗi conversation
 * TRƯỚC khi gán phạm vi cho người xem — để lần liệt kê đầu tiên
 * của người xem chứng minh được liệt kê không ghi membership (nếu
 * liệt kê vật chất hoá người xem thì hàng đã đếm tin có sẵn).
 * Không ensure/liệt kê dưới vai trò nào khác sau khi gán.
 * Kỳ vọng: danh sách của người xem có cả hai hàng tổng hợp với số
 * chưa đọc 0 và huy hiệu 0 (chứng tỏ liệt kê không ghi dòng thành
 * viên); người xem mở khoá lần đầu (ensure) thì hàng khoá chuyển
 * thành hàng thật và bắt đầu đếm (1), hàng lớp vẫn tổng hợp 0.
 *
 * Lưu ý về cơ chế đồng bộ lười (không thuộc phạm vi vòng sửa):
 * gửi tin vào conversation cũng đối chiếu lại toàn bộ tập thành
 * viên đích, nên người có phạm vi được gán TRƯỚC một lần gửi tin
 * sẽ bị vật chất hoá bởi chính lần gửi đó — ca này vì vậy dàn
 * dựng tin trước khi gán, để phần chứng minh "liệt kê không ghi"
 * không bị lần gửi tin làm nhiễu.
 */
interface Person { id: string; username: string; token: string }
interface ListRow { id: string; unread: number; component: string | null; itemType: string | null }

describe('Messaging — người có phạm vi nhưng chưa từng mở vẫn thấy hàng tổng hợp (issue #592)', () => {
  let app: INestApplication;
  let admin: string;
  let teacher: Person;
  let student: Person;
  let scopeViewer: Person;
  let courseId: string;
  let courseConvId: string;
  let classConvId: string;

  async function person(firstName: string, lastName: string): Promise<Person> {
    const u = await createUserViaApi(app, admin, { firstName, lastName });
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  async function scopeList(): Promise<ListRow[]> {
    const res = await http(app).get('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${scopeViewer.token}`);
    expect(res.status).toBe(200);
    return res.body as ListRow[];
  }

  async function scopeBadge(): Promise<number> {
    const res = await http(app).get('/api/v1/messages/unread-count')
      .set('Authorization', `Bearer ${scopeViewer.token}`);
    expect(res.status).toBe(200);
    return (res.body as { conversations: number }).conversations;
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    teacher = await person('Giang', 'DayTongHop');
    student = await person('Hanh', 'HocTongHop');
    scopeViewer = await person('Pham', 'CoPhamVi');

    // Mọi user là thành viên tenant hiệu lực (cổng membership của
    // evaluator — cùng tiền lệ spec chat lớp).
    const current = await http(app).get('/api/v1/tenants/current').set('Authorization', `Bearer ${admin}`);
    const tenantId = (current.body as { id: string }).id;
    for (const p of [teacher, student, scopeViewer]) {
      await http(app).post(`/api/v1/tenants/${tenantId}/members`)
        .set('Authorization', `Bearer ${admin}`).send({ userId: p.id });
    }

    // Chân khoá: giáo viên + học viên ghi danh, CHỈ giáo viên
    // ensure (tạo conversation). Không gửi tin, không liệt kê.
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    courseId = course.id;
    const instance = await createEnrolInstance(app, admin, course.id);
    for (const p of [teacher, student]) await enrolUser(app, admin, course.id, instance.id, p.id);
    const courseEnsured = await http(app).get(`/api/v1/messages/courses/${course.id}/conversation`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(courseEnsured.status).toBe(200);
    courseConvId = (courseEnsured.body as { id: string }).id;

    // Chân lớp: giáo viên là chủ lớp, học viên vào roster; CHỈ
    // giáo viên ensure. Không liệt kê dưới vai trò nào khác.
    const created = await http(app).post('/api/v1/classes')
      .set('Authorization', `Bearer ${admin}`).send({ name: 'Lớp chat chưa mở tổng hợp', ownerId: teacher.id });
    expect(created.status).toBe(201);
    const classId = (created.body as { id: string }).id;
    const added = await http(app).post(`/api/v1/classes/${classId}/roster`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ userId: student.id });
    expect(added.status).toBe(201);
    const classEnsured = await http(app).get(`/api/v1/messages/classes/${classId}/conversation`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(classEnsured.status).toBe(200);
    classConvId = (classEnsured.body as { id: string }).id;

    // Giáo viên gửi một tin vào mỗi conversation TRƯỚC khi gán
    // phạm vi: tin có sẵn để lần liệt kê đầu tiên của người xem
    // chứng minh được liệt kê không vật chất hoá họ (nếu có thì
    // hàng đã đếm 1 thay vì 0).
    expect((await http(app).post(`/api/v1/messages/conversations/${courseConvId}/messages`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ text: 'tin khoá chưa mở' })).status).toBe(201);
    expect((await http(app).post(`/api/v1/messages/conversations/${classConvId}/messages`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ text: 'tin lớp chưa mở' })).status).toBe(201);

    // Gán Manager tại hệ thống SAU khi cả hai conversation đã
    // ensure và đã có tin: người xem có phạm vi nhưng chưa có dòng
    // thành viên.
    const managerRoleId = await roleIdByShortname(app, admin, 'manager');
    const sysCtxId = await systemContextId(app, admin);
    const assigned = await http(app).post('/api/v1/access/assignments')
      .set('Authorization', `Bearer ${admin}`)
      .send({ userId: scopeViewer.id, roleId: managerRoleId, contextId: sysCtxId });
    expect(assigned.status).toBe(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('người có phạm vi nhưng chưa từng mở vẫn thấy hàng lớp/khoá với số chưa đọc 0, và mở lần đầu thì hàng chuyển thành thật và bắt đầu đếm', async () => {
    // Tin đã có sẵn trước khi liệt kê: hàng tổng hợp 0 + huy hiệu 0
    // chứng tỏ lần liệt kê này không ghi dòng thành viên (nếu ghi
    // thì hàng đã đếm tin có sẵn).
    expect(await scopeBadge()).toBe(0);
    const rows = await scopeList();
    const courseRow = rows.find((row) => row.id === courseConvId);
    const classRow = rows.find((row) => row.id === classConvId);
    expect(courseRow).toBeDefined();
    expect(courseRow!.component).toBe('core_course');
    expect(courseRow!.itemType).toBe('course');
    expect(courseRow!.unread).toBe(0);
    expect(classRow).toBeDefined();
    expect(classRow!.component).toBe('core_class');
    expect(classRow!.itemType).toBe('class');
    expect(classRow!.unread).toBe(0);

    // Mở khoá lần đầu (ensure theo phạm vi): hàng khoá thành hàng
    // thật và bắt đầu đếm tin có sẵn; hàng lớp chưa mở vẫn tổng hợp 0.
    const opened = await http(app).get(`/api/v1/messages/courses/${courseId}/conversation`)
      .set('Authorization', `Bearer ${scopeViewer.token}`);
    expect(opened.status).toBe(200);
    const rowsAfter = await scopeList();
    expect(rowsAfter.find((row) => row.id === courseConvId)?.unread).toBe(1);
    expect(rowsAfter.find((row) => row.id === classConvId)?.unread).toBe(0);
    expect(await scopeBadge()).toBe(1);
  });
});
