import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http } from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';
import { createGradeItem, setGrade } from '../../support/assessment-helpers';

/**
 * Lưới an toàn cho việc áp chuẩn đường dẫn module điểm (issue #342).
 *
 * Khẳng định chính còn lại ở spec này (hành vi qua HTTP):
 * - Bảng route tĩnh của bề mặt điểm (25 cặp method + path: 13 route
 *   canonical mới cộng 12 route alias cũ) nay được ghim ở spec hợp
 *   đồng bảng route tại tầng integration:
 *   `test/integration/platform/route-table-contract.int-spec.ts`.
 * - Hành vi alias: path cũ vẫn tới được đúng handler (trả kết quả như
 *   canonical), response qua alias mang header Deprecation/Sunset và
 *   mỗi lượt gọi alias sinh log có cấu trúc `deprecated_route_alias`;
 *   path canonical không mang header đó. Log alias là căn cứ của điều
 *   kiện gỡ alias (0 lượt gọi trong 14 ngày), nên spec kiểm cả nội
 *   dung bản ghi log, không chỉ kiểm header.
 */
describe('Chuẩn đường dẫn điểm (issue #342)', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });



  it('phục vụ alias cũ kèm header deprecation và log có cấu trúc trong khi route chuẩn không bị đánh dấu', async () => {
    // Dựng khoá học + học sinh + item + điểm hoàn toàn bằng path canonical.
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Path standard item', gradeMax: 10 });
    await setGrade(app, admin, item.id, student.id, 8);

    // Bắt đầu theo dõi log cảnh báo sau khi dựng xong bằng canonical,
    // để các bản ghi bắt được chỉ đến từ các lượt gọi alias dưới đây.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // GET alias danh sách item: vẫn trả 200 như canonical, kèm header sắp bỏ.
    const aliasList = await http(app).get(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`);
    expect(aliasList.status).toBe(200);
    expect(aliasList.headers['deprecation']).toBe('true');
    expect(aliasList.headers['sunset']).toContain('2027');

    // POST alias nhập điểm theo path cũ phantom: vẫn tới đúng handler nhập điểm.
    const aliasSetGrade = await http(app).post(`/api/v1/courses/grades/items/${item.id}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userId: student.id, rawGrade: 7 });
    expect(aliasSetGrade.status).toBeLessThan(300);
    expect(aliasSetGrade.headers['deprecation']).toBe('true');

    // GET canonical danh sách item: 200 và tuyệt đối không có header sắp bỏ.
    const canonicalList = await http(app).get(`/api/v1/courses/${course.id}/grade-items`).set('Authorization', `Bearer ${admin}`);
    expect(canonicalList.status).toBe(200);
    expect(canonicalList.headers['deprecation']).toBeUndefined();

    // POST alias xuất vnEdu với thân rỗng: bị kiểm chứng chặn 400
    // (chứng minh lượt gọi tới được handler/pipe của alias), và vẫn
    // mang header sắp bỏ dù bị từ chối.
    const aliasExport = await http(app).post(`/api/v1/courses/${course.id}/grades/export/vnedu`).set('Authorization', `Bearer ${admin}`)
      .send({});
    expect(aliasExport.status).toBe(400);
    expect(aliasExport.headers['deprecation']).toBe('true');

    // Trong các log cảnh báo đã ghi phải có ít nhất một bản ghi JSON
    // của sự kiện deprecated_route_alias cho alias danh sách item.
    const aliasLogs = warn.mock.calls
      .map((call) => String(call[0]))
      .flatMap((message) => {
        try {
          return [JSON.parse(message) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .filter((entry) => entry.event === 'deprecated_route_alias');
    expect(aliasLogs.length).toBeGreaterThanOrEqual(1);
    expect(aliasLogs.some((entry) => entry.alias === 'courses/:courseId/grades/items')).toBe(true);
  });
});
