import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { ProgramImportService } from './modules/curriculum/program-import.service';
import { tenantAls } from './modules/tenants/tenant-als';

/**
 * Seed dữ liệu mẫu cho buổi review (chạy bằng `pnpm seed` ở thư mục gốc).
 *
 * Script khởi động API trên một cổng tạm, đăng nhập bằng tài khoản admin
 * (gieo lúc bootstrap từ biến môi trường ADMIN_*) rồi tạo dữ liệu mẫu qua
 * chính HTTP API công khai — cùng đường mà giao diện dùng. Mọi bước đều
 * find-or-create nên chạy lại nhiều lần không tạo trùng (idempotent).
 *
 * Dữ liệu tạo ra: teacher1, student1, student2; một khoá học mẫu có
 * sections + module, ghi danh, điểm mẫu, một huy hiệu đã cấp cho student1
 * và một sự kiện lịch của khoá học. Mật khẩu xem tại README, mục Review —
 * CHỈ dùng cho môi trường dev/review.
 *
 * Riêng chương trình GDPT 2018 không đi qua HTTP: seed gọi thẳng lõi
 * ProgramImportService (entry nội bộ) cho mọi dataset trong manifest —
 * xem khối "[seed] program ..." trong main().
 */
const ADMIN = { username: process.env['ADMIN_USERNAME'] ?? 'admin', password: process.env['ADMIN_PASSWORD'] ?? 'Admin123!' };
const TEACHER_PASSWORD = ['Teacher', '123', '!'].join('');
const STUDENT_PASSWORD = ['Student', '123', '!'].join('');
const TEACHER = { username: 'teacher1', password: TEACHER_PASSWORD, firstName: 'Lan Anh', lastName: 'Nguyễn', email: 'teacher1@example.com' };
const STUDENTS = [
  { username: 'student1', password: STUDENT_PASSWORD, firstName: 'Minh Quân', lastName: 'Trần', email: 'student1@example.com' },
  { username: 'student2', password: STUDENT_PASSWORD, firstName: 'Thu Hằng', lastName: 'Phạm', email: 'student2@example.com' },
];
const COURSE_SHORTNAME = 'DEMO101';

interface Api {
  call: (method: string, path: string, token?: string, body?: unknown) => Promise<{ status: number; body: never }>;
}

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  // Cùng cấu hình bootstrap với main.ts (prefix + versioning + filter lỗi).
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.listen(0);
  const { port } = app.getHttpServer().address() as { port: number };
  const base = `http://127.0.0.1:${port}/api/v1`;
  const call: Api['call'] = async (method, path, token, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as never };
  };
  const must = <T,>(res: { status: number; body: T }, what: string): T => {
    if (res.status < 200 || res.status >= 300) throw new Error(`${what} failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  try {
    const login = must(await call('POST', '/auth/token', undefined, ADMIN), 'admin login');
    let admin = (login as { accessToken: string }).accessToken;
    console.log('[seed] admin login ok');

    const findUser = async (username: string) => {
      const res = must(await call('GET', `/users?search=${username}&pageSize=50`, admin), 'list users') as { users: { id: string; username: string }[] };
      const items = res.users ?? [];
      return items.find((u) => u.username === username);
    };
    const ensureUser = async (u: typeof TEACHER) => {
      const existing = await findUser(u.username);
      if (existing) { console.log(`[seed] user ${u.username} exists (#${existing.id})`); return existing.id; }
      const created = must(await call('POST', '/users', admin, u), `create ${u.username}`) as { id: string };
      console.log(`[seed] user ${u.username} created (#${created.id})`);
      return created.id;
    };
    const teacherId = await ensureUser(TEACHER);
    const studentIds = [await ensureUser(STUDENTS[0]!), await ensureUser(STUDENTS[1]!)];

    // TENANT-0 (#168): câu chuyện mẫu sống ở tenant trường mặc định
    // (truong-mac-dinh, bootstrap seed đã tạo). Thêm giáo viên/học sinh
    // làm thành viên tường minh rồi chuyển phiên admin sang tenant đó —
    // từ đây mọi dữ liệu mẫu (danh mục, khoá DEMO101, điểm, sự kiện) đều
    // thuộc tenant-1. Ghi danh vào khoá cũng tự đảm bảo membership qua
    // móc enrol, nhưng vai giáo viên gán ở bước sau cần membership có
    // hiệu lực ngay từ đầu phiên tenant.
    const myTenants = must(await call('GET', '/auth/tenants', admin), 'list admin tenants') as { id: string; slug: string }[];
    const school = myTenants.find((t) => t.slug === 'truong-mac-dinh');
    if (!school) throw new Error('default school tenant (truong-mac-dinh) is not seeded');
    for (const uid of [teacherId, ...studentIds]) {
      must(await call('POST', `/tenants/${school.id}/members`, admin, { userId: uid }), `add tenant member ${uid}`);
    }
    const switched = must(await call('POST', `/auth/switch-tenant/${school.id}`, admin), 'switch admin to school tenant') as { accessToken: string };
    admin = switched.accessToken;
    console.log('[seed] admin session switched to tenant truong-mac-dinh; demo users are members');

    const categories = must(await call('GET', '/courses/categories', admin), 'list categories') as { id: string; name: string }[];
    let category = categories.find((c) => c.name === 'Danh mục mẫu');
    if (!category) {
      category = must(await call('POST', '/courses/categories', admin, { name: 'Danh mục mẫu' }), 'create category') as { id: string; name: string };
      console.log(`[seed] category created (#${category.id})`);
    }
    const courses = must(await call('GET', '/courses', admin), 'list courses') as { items?: { id: string; shortName: string }[] } | { id: string; shortName: string }[];
    const courseItems = Array.isArray(courses) ? courses : (courses.items ?? []);
    let course = courseItems.find((c) => c.shortName === COURSE_SHORTNAME);
    if (!course) {
      course = must(await call('POST', '/courses', admin, {
        fullName: 'Khoá học mẫu: Làm quen với LMS', shortName: COURSE_SHORTNAME, category: category.id,
        summary: 'Khoá học mẫu phục vụ buổi review: có section, module, điểm, huy hiệu và sự kiện lịch.',
      }), 'create course') as { id: string; shortName: string };
      console.log(`[seed] course created (#${course.id})`);
    }
    const courseId = course.id;

    const content = must(await call('GET', `/courses/${courseId}/content`, admin), 'course content') as {
      contextId: string; sections: { id: string; name: string | null; modules: { id: string; name: string }[] }[];
    };
    const ensureSection = async (name: string) => {
      const found = content.sections.find((s) => s.name === name);
      if (found) return found.id;
      const created = must(await call('POST', `/courses/${courseId}/sections`, admin, { name }), `create section ${name}`) as { id: string };
      console.log(`[seed] section "${name}" created (#${created.id})`);
      return created.id;
    };
    const week1 = await ensureSection('Tuần 1: Bắt đầu');
    const week2 = await ensureSection('Tuần 2: Luyện tập');
    const allModules = content.sections.flatMap((s) => s.modules.map((m) => ({ ...m, sectionId: s.id })));
    const ensureCm = async (sectionId: string, component: string, name: string) => {
      if (allModules.some((m) => m.name === name)) return;
      must(await call('POST', `/courses/${courseId}/modules`, admin, { sectionId, component, name }), `create cm ${name}`);
      console.log(`[seed] module "${name}" created`);
    };
    await ensureCm(week1, 'mod_page', 'Trang chào mừng');
    await ensureCm(week1, 'mod_resource', 'Tài liệu hướng dẫn học tập');
    await ensureCm(week2, 'mod_quiz', 'Bài kiểm tra thử');

    const instances = must(await call('GET', `/courses/${courseId}/enrol/instances`, admin), 'list enrol instances') as { id: string; enrol: string }[];
    let manual = instances.find((i) => i.enrol === 'manual');
    if (!manual) {
      manual = must(await call('POST', `/courses/${courseId}/enrol/instances`, admin, { method: 'manual' }), 'create manual instance') as { id: string; enrol: string };
      console.log(`[seed] manual enrol instance created (#${manual.id})`);
    }
    const enrolments = must(await call('GET', `/courses/${courseId}/enrolments`, admin), 'list enrolments') as { userId: string; status: number }[];
    for (const sid of studentIds) {
      if (enrolments.some((e) => e.userId === sid && e.status !== 2)) { console.log(`[seed] student #${sid} already enrolled`); continue; }
      must(await call('POST', `/courses/${courseId}/enrol/instances/${manual.id}/enrol`, admin, { userId: sid }), `enrol student ${sid}`);
      console.log(`[seed] student #${sid} enrolled`);
    }
    // Giáo viên: gán role editingteacher tại context khoá học.
    const roles = must(await call('GET', '/access/roles', admin), 'list roles') as { id: string; shortName: string }[];
    const teacherRole = roles.find((r) => r.shortName === 'editingteacher');
    if (teacherRole) {
      const assignments = must(await call('GET', `/access/assignments?userId=${teacherId}&contextId=${content.contextId}`, admin), 'list assignments') as { roleId: string }[];
      if (!assignments.some((a) => a.roleId === teacherRole.id)) {
        must(await call('POST', '/access/assignments', admin, { userId: teacherId, roleId: teacherRole.id, contextId: content.contextId }), 'assign teacher role');
        console.log('[seed] teacher1 assigned editingteacher at the course');
      } else console.log('[seed] teacher role assignment exists');
    }

    // Bài tập mẫu mod_assign (ĐX-1, issue #179): một hoạt động Bài tập
    // nộp tệp/ảnh ở Tuần 2 kèm bảng tiêu chí, để nghiệm thu trình duyệt
    // đi trọn vòng nộp → chấm → trả. Tạo bằng chính tài khoản teacher1
    // (đã có editingteacher tại khoá) — đúng đường giáo viên thật dùng.
    // Idempotent: đã có bài cùng tên thì giữ nguyên, rubric chỉ dựng khi
    // bài chưa có bảng tiêu chí.
    const teacherLogin = must(await call('POST', '/auth/token', undefined, { username: TEACHER.username, password: TEACHER_PASSWORD }), 'teacher login');
    const teacherToken = (teacherLogin as { accessToken: string }).accessToken;
    const SAMPLE_ASSIGNMENT_NAME = 'Bài tập mẫu: Chụp ảnh bài làm và nộp';
    const existingAssignments = must(await call('GET', `/courses/${courseId}/assignments`, teacherToken), 'list assignments') as { id: string; name: string }[];
    let sampleAssignment = existingAssignments.find((a) => a.name === SAMPLE_ASSIGNMENT_NAME);
    if (!sampleAssignment) {
      const due = new Date(Date.now() + 3 * 24 * 3600_000);
      sampleAssignment = must(await call('POST', `/courses/${courseId}/assignments`, teacherToken, {
        sectionId: week2,
        name: SAMPLE_ASSIGNMENT_NAME,
        intro: 'Chụp ảnh bài làm trên giấy (hoặc nộp tệp bất kỳ) rồi bấm Chốt nộp bài. Nộp sau hạn vẫn được nhận nhưng bị đánh dấu trễ.',
        dueDate: due.toISOString(),
        maxFiles: 5,
        acceptedFileTypes: null,
        grade: 10,
        resultMode: 'score_feedback',
      }), 'create sample assignment') as { id: string; name: string };
      console.log(`[seed] sample assignment created (#${sampleAssignment.id})`);
    } else console.log('[seed] sample assignment exists');
    const rubricRes = await call('GET', `/assignments/${sampleAssignment.id}/rubric`, teacherToken);
    const existingRubric = (rubricRes.body as unknown as { rubric: unknown } | undefined)?.rubric;
    if (!existingRubric) {
      must(await call('PUT', `/assignments/${sampleAssignment.id}/rubric`, teacherToken, {
        title: 'Tiêu chí chấm bài tập mẫu',
        criteria: [
          {
            name: 'Đúng nội dung',
            descriptionForStudent: 'Bài làm đúng yêu cầu, đủ các ý chính.',
            mode: 'levels',
            levels: [
              { label: 'Tốt', score: 6 },
              { label: 'Khá', score: 4 },
              { label: 'Cần cố gắng', score: 2 },
            ],
          },
          {
            name: 'Trình bày',
            descriptionForStudent: 'Ảnh chụp rõ nét, trình bày sạch sẽ, dễ đọc.',
            mode: 'score',
            maxScore: 4,
          },
        ],
      }), 'create sample rubric');
      console.log('[seed] sample assignment rubric created');
    } else console.log('[seed] sample assignment rubric exists');

    // Chương trình GDPT 2018 (GDPT-SEED, issue #161): nạp MỌI dataset
    // trong manifest bằng chính lõi ProgramImportService mà trang quản
    // trị dùng (entry nội bộ — không HTTP, không qua evaluator; tiến
    // trình seed chạy với danh nghĩa hệ thống). Nhờ vậy DB dựng từ
    // baseline + seed là có đủ chương trình ngay, admin không phải bấm
    // Nạp tay sau mỗi lần reset. Lượt nạp idempotent theo sổ đăng ký +
    // hash nội dung và cấp id xác định UUIDv5 theo khoá tự nhiên
    // (ADR-017): chạy seed lần hai là no-op (created=0, updated=0) và
    // tập id khớp giữa mọi môi trường.
    const programImport = app.get(ProgramImportService, { strict: false });
    const programStartedAt = Date.now();
    // TENANT-1 (#196): đường nạp trực tiếp (không qua HTTP) chạy với
    // danh nghĩa hệ thống — bọc ngữ cảnh platform tường minh để RLS
    // fail-closed cho thấy/ghi được dữ liệu dùng chung của platform.
    const programResults = await tenantAls.run({ platform: true }, () => programImport.importAllDatasetsInternal());
    for (const r of programResults) {
      console.log(`[seed] program ${r.datasetKey}: created=${r.created} updated=${r.updated} skipped=${r.skipped} orphanedNodes=${r.orphanedNodes} orphanedOutcomes=${r.orphanedOutcomes}`);
    }
    const programRecords = programResults.reduce((a, r) => a + r.totalRecords, 0);
    const programCreatedTotal = programResults.reduce((a, r) => a + r.created, 0);
    console.log(`[seed] program GDPT done: ${programResults.length} datasets, ${programRecords} records, created=${programCreatedTotal}, ${((Date.now() - programStartedAt) / 1000).toFixed(1)}s`);

    const items = must(await call('GET', `/courses/${courseId}/grades/items`, admin), 'list grade items') as { id: string; itemName: string }[];
    let item = items.find((i) => i.itemName === 'Bài kiểm tra 1');
    if (!item) {
      item = must(await call('POST', `/courses/${courseId}/grades/items`, admin, { itemName: 'Bài kiểm tra 1', gradeMax: 10 }), 'create grade item') as { id: string; itemName: string };
      console.log(`[seed] grade item created (#${item.id})`);
    }
    const sampleGrades: [string, number][] = [[studentIds[0]!, 8.5], [studentIds[1]!, 6.5]];
    for (const [uid, grade] of sampleGrades) {
      must(await call('POST', `/courses/grades/items/${item.id}/grades`, admin, { userId: uid, rawGrade: grade }), `set grade for ${uid}`);
    }
    console.log('[seed] sample grades set (student1=8.5, student2=6.5 / 10)');

    const badges = must(await call('GET', '/badges', admin), 'list badges') as { id: string; name: string; status: number }[];
    let badge = badges.find((b) => b.name === 'Huy hiệu khởi đầu');
    if (!badge) {
      badge = must(await call('POST', '/badges', admin, { name: 'Huy hiệu khởi đầu', type: 1, issuerName: 'LMS Review', description: 'Cấp thủ công cho student1 để xem ngay trong buổi review.' }), 'create badge') as { id: string; name: string; status: number };
      must(await call('PUT', `/badges/${badge.id}/criteria`, admin, { method: 1, criteria: [{ criteriaType: 'manual', params: {} }] }), 'set badge criteria');
      must(await call('POST', `/badges/${badge.id}/status`, admin, { status: 1 }), 'activate badge');
      console.log(`[seed] badge created + activated (#${badge.id})`);
    }
    const issued = must(await call('GET', `/badges/${badge.id}/issued`, admin), 'list issued') as { userId: string }[];
    if (!issued.some((i) => i.userId === studentIds[0])) {
      must(await call('POST', `/badges/${badge.id}/award`, admin, { userId: studentIds[0] }), 'award badge');
      console.log('[seed] badge awarded to student1');
    } else console.log('[seed] badge already awarded to student1');

    const events = must(await call('GET', '/calendar/events', admin), 'list events') as { id: string; name: string }[];
    if (!events.some((e) => e.name === 'Buổi học trực tuyến đầu tiên')) {
      const tomorrow = new Date(Date.now() + 24 * 3600_000);
      tomorrow.setHours(9, 0, 0, 0);
      must(await call('POST', '/calendar/events', admin, {
        name: 'Buổi học trực tuyến đầu tiên', eventType: 'course', courseId: courseId, timeStart: tomorrow.toISOString(),
      }), 'create calendar event');
      console.log('[seed] calendar event created (tomorrow 09:00)');
    } else console.log('[seed] calendar event exists');

    console.log('[seed] DONE — sample data ready. Accounts: see README "Review" section.');
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error('[seed] FAILED', err);
  process.exit(1);
});
