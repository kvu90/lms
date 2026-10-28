import { Logger, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http } from '../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../support/course-enrolment-helpers';
import { createGradeItem, setGrade } from '../support/assessment-helpers';

/**
 * Lưới an toàn cho việc áp chuẩn đường dẫn module điểm (issue #342).
 *
 * Hai khẳng định chính:
 * - Bảng route của bề mặt điểm chụp qua tài liệu OpenAPI phải bằng
 *   đúng 25 cặp (method, path): 13 route canonical mới cộng 12 route
 *   alias cũ — thêm/bớt/đổi bất kỳ route nào của bề mặt điểm đều làm
 *   spec này đỏ, kể cả khi các flow nghiệp vụ vẫn chạy.
 * - Hành vi alias: path cũ vẫn tới được đúng handler (trả kết quả như
 *   canonical), response qua alias mang header Deprecation/Sunset và
 *   mỗi lượt gọi alias sinh log có cấu trúc `deprecated_route_alias`;
 *   path canonical không mang header đó. Log alias là căn cứ của điều
 *   kiện gỡ alias (0 lượt gọi trong 14 ngày), nên spec kiểm cả nội
 *   dung bản ghi log, không chỉ kiểm header.
 */
describe('Grades path standard (issue #342)', () => {
  let app: INestApplication;
  let admin: string;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('LMS API').setDescription('grades path standard probe').setVersion('1.0').build(),
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('documents exactly the 13 canonical and 12 alias grade routes', () => {
    // Tập kỳ vọng viết literal: 13 canonical + 12 alias, dạng path OpenAPI.
    const expected = [
      // Canonical thuộc khoá học.
      'POST /courses/{courseId}/grade-items',
      'GET /courses/{courseId}/grade-items',
      'GET /courses/{courseId}/gradebook',
      'GET /courses/{courseId}/gradebook/report',
      'POST /courses/{courseId}/grade-exports',
      // Canonical gắn với grade item.
      'PATCH /grade-items/{itemId}',
      'DELETE /grade-items/{itemId}',
      'POST /grade-items/{itemId}/grades',
      'PUT /grade-items/{itemId}/posting-policy',
      'POST /grade-items/{itemId}/publish',
      'POST /grade-items/{itemId}/unpublish',
      'GET /grade-items/{itemId}/users/{userId}/history',
      // Canonical gắn với bản ghi điểm.
      'PATCH /grades/{gradeId}',
      // Alias thuộc khoá học.
      'POST /courses/{courseId}/grades/items',
      'GET /courses/{courseId}/grades/items',
      'GET /courses/{courseId}/grades/report',
      'POST /courses/{courseId}/grades/export/vnedu',
      // Alias "phantom" dưới tiền tố courses/grades.
      'PATCH /courses/grades/items/{itemId}',
      'DELETE /courses/grades/items/{itemId}',
      'POST /courses/grades/items/{itemId}/grades',
      'PATCH /courses/grades/grades/{gradeId}',
      'PUT /courses/grades/items/{itemId}/posting-policy',
      'POST /courses/grades/items/{itemId}/publish',
      'POST /courses/grades/items/{itemId}/unpublish',
      'GET /courses/grades/items/{itemId}/users/{userId}/history',
    ];

    const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
    const actual: string[] = [];
    for (const [rawPath, pathItem] of Object.entries(document.paths ?? {})) {
      // Chuẩn hoá: bỏ tiền tố /api/v1 nếu tài liệu mang tiền tố đó.
      const path = rawPath.startsWith('/api/v1/') ? rawPath.slice('/api/v1'.length) : rawPath;
      const segments = path.split('/').filter(Boolean);
      // Chỉ lấy bề mặt điểm của module điểm: các path bắt đầu bằng
      // /courses/, /grade-items/ hoặc /grades/ và có segment điểm —
      // loại các bề mặt khác cũng nhắc tới điểm (ví dụ gradebook của
      // phụ huynh dưới /guardian/).
      const isGradesSurface = (path.startsWith('/courses/') || path.startsWith('/grade-items/') || path.startsWith('/grades/'))
        && (segments.some((segment) => ['grade-items', 'gradebook', 'grade-exports', 'grades'].includes(segment)) || path.includes('/grades/'));
      if (!isGradesSurface) continue;
      for (const method of Object.keys(pathItem ?? {})) {
        if (httpMethods.has(method)) actual.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(actual.sort()).toEqual([...expected].sort());
  });

  it('serves legacy aliases with deprecation headers and structured logs while canonical routes stay unmarked', async () => {
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
