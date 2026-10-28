import { Logger, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, uniqueName } from '../support/identity-access-helpers';
import { createCategory, createCm, createCourse, createSection } from '../support/course-enrolment-helpers';

/**
 * Lưới an toàn cho việc áp danh sách hành động đóng toàn hệ (issue
 * #345: giai đoạn 1 các bề mặt ngoài module exams + giai đoạn 2 phần
 * `board-*` của module exams).
 *
 * Ba khẳng định chính:
 * - Bảng route của các bề mặt đổi tên chụp qua tài liệu OpenAPI phải
 *   bằng đúng 16 cặp (method, path): 8 route canonical mang segment
 *   chuẩn (`copy`, `reactivate`, `exports`, `reports`) cộng 8 route
 *   alias mang segment cũ (`duplicate`, `unsuspend`, `export.ics`,
 *   `report.csv`) — thêm/bớt/đổi bất kỳ route nào trong các bề mặt này
 *   đều làm spec đỏ, kể cả khi các flow nghiệp vụ vẫn chạy.
 * - Riêng giai đoạn 2, bảng route của hai bề mặt duyệt đóng góp/bộ hồ
 *   sơ phải bằng đúng 16 cặp: 4 route canonical `/exams` mang
 *   `approve`/`reject`, 4 route alias `/exams` mang `board-*`, và 8
 *   route gương `/exam-papers` của cụm alias #343 (đủ cả `approve`/
 *   `reject` lẫn `board-*`). Hành vi alias của giai đoạn 2 (đường cũ
 *   vẫn duyệt cấp 2, kèm header sắp bỏ) do flow S4 của đóng góp khoá
 *   riêng, không dựng lại ở spec này.
 * - Hành vi alias: path cũ vẫn tới được đúng handler (kết quả như
 *   canonical), response qua alias mang header Deprecation/Sunset và
 *   mỗi lượt gọi alias sinh log có cấu trúc `deprecated_route_alias`;
 *   path canonical không mang header đó. Log alias là căn cứ của điều
 *   kiện gỡ alias (0 lượt gọi trong 14 ngày), nên spec kiểm cả nội
 *   dung bản ghi log, không chỉ kiểm header.
 * - Hai đích xuất file: định dạng là dữ liệu yêu cầu (`format` qua
 *   tham số truy vấn) tại path đích không còn hậu tố file; định dạng
 *   không hỗ trợ bị từ chối 400 với mã lỗi ổn định; nội dung file xuất
 *   qua canonical và qua alias là một.
 */
describe('Action path standard (issue #345)', () => {
  let app: INestApplication;
  let admin: string;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('LMS API').setDescription('action path standard probe').setVersion('1.0').build(),
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('documents exactly the 8 canonical and 8 alias routes of the renamed surfaces', () => {
    // Tập kỳ vọng viết literal: 8 canonical + 8 alias, dạng path OpenAPI.
    const expected = [
      // Canonical: động từ chuẩn theo danh sách hành động đóng.
      'POST /badges/{id}/copy',
      'POST /competencies/frameworks/{id}/copy',
      'POST /courses/{id}/copy',
      'POST /courses/{id}/sections/{sectionId}/copy',
      'POST /courses/{id}/modules/{cmId}/copy',
      'POST /users/{id}/reactivate',
      'GET /calendar/exports',
      'GET /courses/{courseId}/progress/reports',
      // Alias: segment cũ giữ song song kèm Deprecation/Sunset + log.
      'POST /badges/{id}/duplicate',
      'POST /competencies/frameworks/{id}/duplicate',
      'POST /courses/{id}/duplicate',
      'POST /courses/{id}/sections/{sectionId}/duplicate',
      'POST /courses/{id}/modules/{cmId}/duplicate',
      'POST /users/{id}/unsuspend',
      'GET /calendar/export.ics',
      'GET /courses/{courseId}/progress/report.csv',
    ];

    // Chỉ chọn đúng các bề mặt đổi tên của issue này: các path có
    // segment hành động thuộc tập đang đổi (canonical hoặc alias).
    const surfacePatterns = [
      /^\/badges\/\{[^}]+\}\/(copy|duplicate)$/,
      /^\/competencies\/frameworks\/\{[^}]+\}\/(copy|duplicate)$/,
      /^\/courses\/\{[^}]+\}\/(copy|duplicate)$/,
      /^\/courses\/\{[^}]+\}\/sections\/\{[^}]+\}\/(copy|duplicate)$/,
      /^\/courses\/\{[^}]+\}\/modules\/\{[^}]+\}\/(copy|duplicate)$/,
      /^\/users\/\{[^}]+\}\/(reactivate|unsuspend)$/,
      /^\/calendar\/(exports|export\.ics)$/,
      /^\/courses\/\{[^}]+\}\/progress\/(reports|report\.csv)$/,
    ];
    const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
    const actual: string[] = [];
    for (const [rawPath, pathItem] of Object.entries(document.paths ?? {})) {
      // Chuẩn hoá: bỏ tiền tố /api/v1 nếu tài liệu mang tiền tố đó.
      const path = rawPath.startsWith('/api/v1/') ? rawPath.slice('/api/v1'.length) : rawPath;
      if (!surfacePatterns.some((pattern) => pattern.test(path))) continue;
      for (const method of Object.keys(pathItem ?? {})) {
        if (httpMethods.has(method)) actual.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(actual.sort()).toEqual([...expected].sort());
  });

  it('serves legacy aliases with deprecation headers and structured logs while canonical routes stay unmarked', async () => {
    // Dựng dữ liệu hoàn toàn bằng path canonical / bề mặt không đổi tên.
    const badgeRes = await http(app).post('/api/v1/badges').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Alias probe badge', type: 1 });
    expect(badgeRes.status).toBe(201);
    const badgeId = badgeRes.body.id as string;

    const fwRes = await http(app).post('/api/v1/competencies/frameworks').set('Authorization', `Bearer ${admin}`)
      .send({ shortName: `FW alias ${uniqueName('fw')}`, scale: { values: ['Not competent', 'Competent'], proficient: [1] } });
    expect(fwRes.status).toBe(201);
    const frameworkId = fwRes.body.id as string;

    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const section = await createSection(app, admin, course.id, { name: 'Alias section' });
    const cm = await createCm(app, admin, course.id, section.id, { name: 'Alias module' });

    const user = await createUserViaApi(app, admin);
    const suspended = await http(app).post(`/api/v1/users/${user.id}/suspend`).set('Authorization', `Bearer ${admin}`);
    expect(suspended.status).toBeLessThan(300);

    // Bắt đầu theo dõi log cảnh báo sau khi dựng xong, để các bản ghi
    // bắt được chỉ đến từ các lượt gọi alias dưới đây.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // Alias nhân bản badge: vẫn tạo bản sao như canonical, kèm header sắp bỏ.
    const aliasBadge = await http(app).post(`/api/v1/badges/${badgeId}/duplicate`).set('Authorization', `Bearer ${admin}`).send({});
    expect(aliasBadge.status).toBe(201);
    expect(aliasBadge.body.id).not.toBe(badgeId);
    expect(aliasBadge.headers['deprecation']).toBe('true');
    expect(aliasBadge.headers['sunset']).toContain('2027');

    // Canonical nhân bản badge: 201 và tuyệt đối không có header sắp bỏ.
    const canonicalBadge = await http(app).post(`/api/v1/badges/${badgeId}/copy`).set('Authorization', `Bearer ${admin}`).send({});
    expect(canonicalBadge.status).toBe(201);
    expect(canonicalBadge.headers['deprecation']).toBeUndefined();

    // Alias nhân bản framework: id mới toàn bộ, kèm header sắp bỏ.
    const aliasFramework = await http(app).post(`/api/v1/competencies/frameworks/${frameworkId}/duplicate`).set('Authorization', `Bearer ${admin}`).send({});
    expect(aliasFramework.status).toBe(201);
    expect(aliasFramework.body.id).not.toBe(frameworkId);
    expect(aliasFramework.headers['deprecation']).toBe('true');

    // Alias nhân bản khoá / section / module: cùng handler với canonical.
    const aliasCourse = await http(app).post(`/api/v1/courses/${course.id}/duplicate`).set('Authorization', `Bearer ${admin}`)
      .send({ fullName: 'Alias course copy', shortName: uniqueName('alias') });
    expect(aliasCourse.status).toBe(201);
    expect(aliasCourse.headers['deprecation']).toBe('true');

    const canonicalCourse = await http(app).post(`/api/v1/courses/${course.id}/copy`).set('Authorization', `Bearer ${admin}`)
      .send({ fullName: 'Canonical course copy', shortName: uniqueName('canon') });
    expect(canonicalCourse.status).toBe(201);
    expect(canonicalCourse.headers['deprecation']).toBeUndefined();

    const aliasSection = await http(app).post(`/api/v1/courses/${course.id}/sections/${section.id}/duplicate`).set('Authorization', `Bearer ${admin}`).send({});
    expect(aliasSection.status).toBe(201);
    expect(aliasSection.headers['deprecation']).toBe('true');

    const aliasCm = await http(app).post(`/api/v1/courses/${course.id}/modules/${cm.id}/duplicate`).set('Authorization', `Bearer ${admin}`).send({});
    expect(aliasCm.status).toBe(201);
    expect(aliasCm.headers['deprecation']).toBe('true');

    // Alias khôi phục tài khoản: tài khoản hết đình chỉ như canonical.
    const aliasUnsuspend = await http(app).post(`/api/v1/users/${user.id}/unsuspend`).set('Authorization', `Bearer ${admin}`);
    expect(aliasUnsuspend.status).toBeLessThan(300);
    expect(aliasUnsuspend.body.suspended).toBe(false);
    expect(aliasUnsuspend.headers['deprecation']).toBe('true');

    // Canonical khôi phục: đình chỉ lại rồi khôi phục qua reactivate, không header.
    await http(app).post(`/api/v1/users/${user.id}/suspend`).set('Authorization', `Bearer ${admin}`);
    const canonicalReactivate = await http(app).post(`/api/v1/users/${user.id}/reactivate`).set('Authorization', `Bearer ${admin}`);
    expect(canonicalReactivate.status).toBeLessThan(300);
    expect(canonicalReactivate.body.suspended).toBe(false);
    expect(canonicalReactivate.headers['deprecation']).toBeUndefined();

    // Trong các log cảnh báo đã ghi phải có bản ghi JSON của sự kiện
    // deprecated_route_alias cho từng alias đã gọi, trỏ đúng canonical.
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
    const loggedPairs = new Set(aliasLogs.map((entry) => `${entry.alias} -> ${entry.canonical}`));
    expect(loggedPairs).toContain('badges/:id/duplicate -> badges/:id/copy');
    expect(loggedPairs).toContain('competencies/frameworks/:id/duplicate -> competencies/frameworks/:id/copy');
    expect(loggedPairs).toContain('courses/:id/duplicate -> courses/:id/copy');
    expect(loggedPairs).toContain('courses/:id/sections/:sectionId/duplicate -> courses/:id/sections/:sectionId/copy');
    expect(loggedPairs).toContain('courses/:id/modules/:cmId/duplicate -> courses/:id/modules/:cmId/copy');
    expect(loggedPairs).toContain('users/:id/unsuspend -> users/:id/reactivate');
  });

  it('serves the file-export destinations with format as request data and identical content on alias and canonical', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);

    // Bắt đầu theo dõi log sau khi dựng dữ liệu (không có lượt alias nào trước điểm này).
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // Alias xuất lịch: nội dung ICS như canonical, kèm header sắp bỏ.
    const aliasIcs = await http(app).get('/api/v1/calendar/export.ics').set('Authorization', `Bearer ${admin}`);
    expect(aliasIcs.status).toBe(200);
    expect(aliasIcs.headers['content-type']).toContain('text/calendar');
    expect(aliasIcs.headers['deprecation']).toBe('true');
    expect(aliasIcs.headers['sunset']).toContain('2027');

    // Canonical xuất lịch: định dạng qua tham số truy vấn, không header sắp bỏ.
    const canonicalIcs = await http(app).get('/api/v1/calendar/exports?format=ics').set('Authorization', `Bearer ${admin}`);
    expect(canonicalIcs.status).toBe(200);
    expect(canonicalIcs.headers['content-type']).toContain('text/calendar');
    expect(canonicalIcs.headers['deprecation']).toBeUndefined();
    expect(canonicalIcs.text).toContain('BEGIN:VCALENDAR');

    // Định dạng không hỗ trợ tại đích xuất lịch: 400 với mã lỗi ổn định.
    const badFormat = await http(app).get('/api/v1/calendar/exports?format=pdf').set('Authorization', `Bearer ${admin}`);
    expect(badFormat.status).toBe(400);
    expect((badFormat.body as { code?: string }).code).toBe('calendar.export_format_unsupported');

    // Báo cáo tiến độ: alias và canonical cho cùng một kết quả (nội
    // dung file xuất không đổi), chỉ khác header sắp bỏ ở alias.
    const aliasCsv = await http(app).get(`/api/v1/courses/${course.id}/progress/report.csv`).set('Authorization', `Bearer ${admin}`);
    const canonicalCsv = await http(app).get(`/api/v1/courses/${course.id}/progress/reports?format=csv`).set('Authorization', `Bearer ${admin}`);
    expect(aliasCsv.status).toBe(canonicalCsv.status);
    expect(aliasCsv.text).toBe(canonicalCsv.text);
    expect(aliasCsv.headers['deprecation']).toBe('true');
    expect(canonicalCsv.headers['deprecation']).toBeUndefined();

    // Định dạng không hỗ trợ tại đích báo cáo tiến độ: 400 với mã lỗi ổn định.
    const badReportFormat = await http(app).get(`/api/v1/courses/${course.id}/progress/reports?format=xlsx`).set('Authorization', `Bearer ${admin}`);
    expect(badReportFormat.status).toBe(400);
    expect((badReportFormat.body as { code?: string }).code).toBe('content.progress_report_format_unsupported');

    // Log alias có đủ hai cặp của hai đích xuất file.
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
    const loggedPairs = new Set(aliasLogs.map((entry) => `${entry.alias} -> ${entry.canonical}`));
    expect(loggedPairs).toContain('calendar/export.ics -> calendar/exports?format=ics');
    expect(loggedPairs).toContain('courses/:courseId/progress/report.csv -> courses/:courseId/progress/reports?format=csv');
  });

  it('documents exactly the exams canonical, board-* alias and exam-papers mirror routes of phase 2', () => {
    // Tập kỳ vọng viết literal: 4 canonical `/exams` + 4 alias
    // `/exams` mang `board-*` + 8 route gương `/exam-papers`.
    const expected = [
      // Canonical `/exams`: một động từ duyệt duy nhất cho cả hai cấp.
      'POST /exams/banks/{bankId}/contributions/{contributionId}/approve',
      'POST /exams/banks/{bankId}/contributions/{contributionId}/reject',
      'POST /exams/dossiers/{dossierId}/approve',
      'POST /exams/dossiers/{dossierId}/reject',
      // Alias `/exams`: segment cũ giữ song song kèm Deprecation/Sunset + log.
      'POST /exams/banks/{bankId}/contributions/{contributionId}/board-approve',
      'POST /exams/banks/{bankId}/contributions/{contributionId}/board-reject',
      'POST /exams/dossiers/{dossierId}/board-approve',
      'POST /exams/dossiers/{dossierId}/board-reject',
      // Gương `/exam-papers` của cụm alias #343: giữ đủ cả hai dạng.
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/approve',
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/reject',
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/board-approve',
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/board-reject',
      'POST /exam-papers/dossiers/{dossierId}/approve',
      'POST /exam-papers/dossiers/{dossierId}/reject',
      'POST /exam-papers/dossiers/{dossierId}/board-approve',
      'POST /exam-papers/dossiers/{dossierId}/board-reject',
    ];

    // Chỉ chọn đúng hai bề mặt duyệt của giai đoạn 2: đóng góp và bộ
    // hồ sơ, với động từ thuộc tập đang hợp nhất.
    const surfacePatterns = [
      /^\/(exams|exam-papers)\/banks\/\{[^}]+\}\/contributions\/\{[^}]+\}\/(approve|reject|board-approve|board-reject)$/,
      /^\/(exams|exam-papers)\/dossiers\/\{[^}]+\}\/(approve|reject|board-approve|board-reject)$/,
    ];
    const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
    const actual: string[] = [];
    for (const [rawPath, pathItem] of Object.entries(document.paths ?? {})) {
      const path = rawPath.startsWith('/api/v1/') ? rawPath.slice('/api/v1'.length) : rawPath;
      if (!surfacePatterns.some((pattern) => pattern.test(path))) continue;
      for (const method of Object.keys(pathItem ?? {})) {
        if (httpMethods.has(method)) actual.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(actual.sort()).toEqual([...expected].sort());
  });
});
