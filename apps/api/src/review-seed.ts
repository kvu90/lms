import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';

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
 */
const ADMIN = { username: process.env['ADMIN_USERNAME'] ?? 'admin', password: process.env['ADMIN_PASSWORD'] ?? 'Admin123!' };
const TEACHER_PASSWORD = ['Teacher', '123', '!'].join('');
const STUDENT_PASSWORD = ['Student', '123', '!'].join('');
const TEACHER = { username: 'teacher1', password: TEACHER_PASSWORD, firstname: 'Lan Anh', lastname: 'Nguyễn', email: 'teacher1@example.com' };
const STUDENTS = [
  { username: 'student1', password: STUDENT_PASSWORD, firstname: 'Minh Quân', lastname: 'Trần', email: 'student1@example.com' },
  { username: 'student2', password: STUDENT_PASSWORD, firstname: 'Thu Hằng', lastname: 'Phạm', email: 'student2@example.com' },
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
    const admin = (login as { accessToken: string }).accessToken;
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

    const categories = must(await call('GET', '/courses/categories', admin), 'list categories') as { id: string; name: string }[];
    let category = categories.find((c) => c.name === 'Danh mục mẫu');
    if (!category) {
      category = must(await call('POST', '/courses/categories', admin, { name: 'Danh mục mẫu' }), 'create category') as { id: string; name: string };
      console.log(`[seed] category created (#${category.id})`);
    }
    const courses = must(await call('GET', '/courses', admin), 'list courses') as { items?: { id: string; shortname: string }[] } | { id: string; shortname: string }[];
    const courseItems = Array.isArray(courses) ? courses : (courses.items ?? []);
    let course = courseItems.find((c) => c.shortname === COURSE_SHORTNAME);
    if (!course) {
      course = must(await call('POST', '/courses', admin, {
        fullname: 'Khoá học mẫu: Làm quen với LMS', shortname: COURSE_SHORTNAME, category: category.id,
        summary: 'Khoá học mẫu phục vụ buổi review: có section, module, điểm, huy hiệu và sự kiện lịch.',
      }), 'create course') as { id: string; shortname: string };
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
    const enrolments = must(await call('GET', `/courses/${courseId}/enrolments`, admin), 'list enrolments') as { userid: string; status: number }[];
    for (const sid of studentIds) {
      if (enrolments.some((e) => e.userid === sid && e.status !== 2)) { console.log(`[seed] student #${sid} already enrolled`); continue; }
      must(await call('POST', `/courses/${courseId}/enrol/instances/${manual.id}/enrol`, admin, { userid: sid }), `enrol student ${sid}`);
      console.log(`[seed] student #${sid} enrolled`);
    }
    // Giáo viên: gán role editingteacher tại context khoá học.
    const roles = must(await call('GET', '/access/roles', admin), 'list roles') as { id: string; shortname: string }[];
    const teacherRole = roles.find((r) => r.shortname === 'editingteacher');
    if (teacherRole) {
      const assignments = must(await call('GET', `/access/assignments?userid=${teacherId}&contextid=${content.contextId}`, admin), 'list assignments') as { roleid: string }[];
      if (!assignments.some((a) => a.roleid === teacherRole.id)) {
        must(await call('POST', '/access/assignments', admin, { userid: teacherId, roleid: teacherRole.id, contextid: content.contextId }), 'assign teacher role');
        console.log('[seed] teacher1 assigned editingteacher at the course');
      } else console.log('[seed] teacher role assignment exists');
    }

    const items = must(await call('GET', `/courses/${courseId}/grades/items`, admin), 'list grade items') as { id: string; itemname: string }[];
    let item = items.find((i) => i.itemname === 'Bài kiểm tra 1');
    if (!item) {
      item = must(await call('POST', `/courses/${courseId}/grades/items`, admin, { itemname: 'Bài kiểm tra 1', grademax: 10 }), 'create grade item') as { id: string; itemname: string };
      console.log(`[seed] grade item created (#${item.id})`);
    }
    const sampleGrades: [string, number][] = [[studentIds[0]!, 8.5], [studentIds[1]!, 6.5]];
    for (const [uid, grade] of sampleGrades) {
      must(await call('POST', `/courses/grades/items/${item.id}/grades`, admin, { userid: uid, rawgrade: grade }), `set grade for ${uid}`);
    }
    console.log('[seed] sample grades set (student1=8.5, student2=6.5 / 10)');

    const badges = must(await call('GET', '/badges', admin), 'list badges') as { id: string; name: string; status: number }[];
    let badge = badges.find((b) => b.name === 'Huy hiệu khởi đầu');
    if (!badge) {
      badge = must(await call('POST', '/badges', admin, { name: 'Huy hiệu khởi đầu', type: 1, issuername: 'LMS Review', description: 'Cấp thủ công cho student1 để xem ngay trong buổi review.' }), 'create badge') as { id: string; name: string; status: number };
      must(await call('PUT', `/badges/${badge.id}/criteria`, admin, { method: 1, criteria: [{ criteriatype: 'manual', params: {} }] }), 'set badge criteria');
      must(await call('POST', `/badges/${badge.id}/status`, admin, { status: 1 }), 'activate badge');
      console.log(`[seed] badge created + activated (#${badge.id})`);
    }
    const issued = must(await call('GET', `/badges/${badge.id}/issued`, admin), 'list issued') as { userid: string }[];
    if (!issued.some((i) => i.userid === studentIds[0])) {
      must(await call('POST', `/badges/${badge.id}/award`, admin, { userId: studentIds[0] }), 'award badge');
      console.log('[seed] badge awarded to student1');
    } else console.log('[seed] badge already awarded to student1');

    const events = must(await call('GET', '/calendar/events', admin), 'list events') as { id: string; name: string }[];
    if (!events.some((e) => e.name === 'Buổi học trực tuyến đầu tiên')) {
      const tomorrow = new Date(Date.now() + 24 * 3600_000);
      tomorrow.setHours(9, 0, 0, 0);
      must(await call('POST', '/calendar/events', admin, {
        name: 'Buổi học trực tuyến đầu tiên', eventtype: 'course', courseid: courseId, timestart: tomorrow.toISOString(),
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
