import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';

/**
 * Người có phạm vi quản trị trên khoá (giáo viên của khoá, ĐÃ có
 * dòng thành viên trong hội thoại khoá) lưu trữ hội thoại khoá
 * thì hội thoại phải rời danh sách chính của chính họ và chỉ còn
 * ở tập đã lưu (vòng sửa issue #623).
 *
 * Gốc rễ của khuyết tật đã sửa: truy vấn summaries mặc định lọc
 * đúng dòng đã lưu trữ ra, nhưng khối "hàng tổng hợp cho quản trị
 * có phạm vi" ở tầng service lại nối hội thoại trở lại danh sách
 * chính với trạng thái cá nhân rỗng vì chỉ đối chiếu tập id của
 * summaries. Ca này dàn dựng đúng hình thái đã tái hiện trên bản
 * xem trước: giáo viên (staff của khoá, thành viên thật của hội
 * thoại) đặt cờ lưu trữ qua API rồi đọc lại cả hai tập.
 *
 * Kèm theo: chi tiết hội thoại phải mang trạng thái lưu trữ cá
 * nhân của chính người xem — căn cứ để menu đầu khung của hội
 * thoại đã mở hiện đúng "Bỏ lưu trữ" và thao tác bỏ lưu có hiệu
 * lực ngay, kể cả khi mở hội thoại từ tab Lưu trữ.
 */
interface Person { id: string; username: string; token: string }
interface ListRow { id: string; archivedAt: string | null }

describe('Messaging — staff lưu trữ hội thoại khoá (vòng sửa issue #623)', () => {
  let app: INestApplication;
  let admin: string;
  let teacher: Person;
  let student: Person;
  let courseConvId: string;

  async function person(firstName: string, lastName: string): Promise<Person> {
    const u = await createUserViaApi(app, admin, { firstName, lastName });
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  async function teacherList(archived = false): Promise<ListRow[]> {
    const res = await http(app).get(`/api/v1/messages/conversations${archived ? '?archived=true' : ''}`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(res.status).toBe(200);
    return res.body as ListRow[];
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    teacher = await person('Thao', 'DayLuuTru');
    student = await person('Luu', 'HocLuuTru');

    // Mọi user là thành viên tenant hiệu lực (cổng membership của
    // evaluator — cùng tiền lệ spec phạm vi tổng hợp).
    const current = await http(app).get('/api/v1/tenants/current').set('Authorization', `Bearer ${admin}`);
    const tenantId = (current.body as { id: string }).id;
    for (const p of [teacher, student]) {
      await http(app).post(`/api/v1/tenants/${tenantId}/members`)
        .set('Authorization', `Bearer ${admin}`).send({ userId: p.id });
    }

    // Khoá có giáo viên + học viên ghi danh; giáo viên ensure hội
    // thoại khoá (giáo viên thành thành viên thật của hội thoại)
    // và gửi một tin để hội thoại có hoạt động.
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    for (const p of [teacher, student]) await enrolUser(app, admin, course.id, instance.id, p.id);
    const ensured = await http(app).get(`/api/v1/messages/courses/${course.id}/conversation`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(ensured.status).toBe(200);
    courseConvId = (ensured.body as { id: string }).id;
    expect((await http(app).post(`/api/v1/messages/conversations/${courseConvId}/messages`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ text: 'tin mở đầu hội thoại khoá' })).status).toBe(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('staff lưu trữ hội thoại khoá thì hội thoại vắng khỏi danh sách chính của chính họ và chỉ hiện ở tập đã lưu', async () => {
    // Trước khi lưu: hội thoại ở danh sách chính của giáo viên với
    // trạng thái chưa lưu, tập đã lưu không có nó.
    const before = await teacherList();
    expect(before.find((row) => row.id === courseConvId)).toMatchObject({ archivedAt: null });
    expect((await teacherList(true)).map((row) => row.id)).not.toContain(courseConvId);

    // Giáo viên lưu trữ hội thoại khoá qua API trạng thái.
    const patched = await http(app).patch(`/api/v1/messages/conversations/${courseConvId}/state`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ archived: true });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ archived: true });

    // Sau khi lưu: danh sách chính KHÔNG còn hội thoại (khối hàng
    // tổng hợp không được nối nó trở lại), tập đã lưu có nó kèm
    // mốc lưu trữ thật.
    expect((await teacherList()).map((row) => row.id)).not.toContain(courseConvId);
    const storedRow = (await teacherList(true)).find((row) => row.id === courseConvId);
    expect(storedRow).toBeDefined();
    expect(typeof storedRow!.archivedAt).toBe('string');
  });

  it('mở hội thoại khoá đã lưu thì chi tiết mang trạng thái lưu trữ của chính người xem, và bỏ lưu đưa hội thoại về danh sách chính ngay', async () => {
    // Chi tiết đọc bằng token của chính giáo viên đang lưu trữ:
    // archivedAt khác null là căn cứ để menu đầu khung hiện
    // "Bỏ lưu trữ" thay vì "Lưu trữ".
    const detail = await http(app).get(`/api/v1/messages/conversations/${courseConvId}`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(detail.status).toBe(200);
    expect(typeof (detail.body as { archivedAt: string | null }).archivedAt).toBe('string');

    // Bỏ lưu trữ: hội thoại về danh sách chính, rời tập đã lưu và
    // chi tiết hết mốc lưu trữ.
    const unpatched = await http(app).patch(`/api/v1/messages/conversations/${courseConvId}/state`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ archived: false });
    expect(unpatched.status).toBe(200);
    expect(unpatched.body).toMatchObject({ archived: false, archivedAt: null });
    expect((await teacherList()).map((row) => row.id)).toContain(courseConvId);
    expect((await teacherList(true)).map((row) => row.id)).not.toContain(courseConvId);
    const detailAfter = await http(app).get(`/api/v1/messages/conversations/${courseConvId}`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect((detailAfter.body as { archivedAt: string | null }).archivedAt).toBeNull();
  });
});
