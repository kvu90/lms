import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  STRONG_PASSWORD,
  createTestApp,
  createUserViaApi,
  http,
  login,
  roleIdByShortname,
  uniqueName,
} from '../../support/identity-access-helpers';
import { createCategory, grantActiveTeacherPlan } from '../../support/course-enrolment-helpers';

/**
 * CLASS-0 (issue #184) — vòng đời ghi danh cấp lớp trên nền lớp học
 * hạng nhất:
 *  (1) tạo lớp (admin tạo hộ, owner = giáo viên) → context CLASS=45 +
 *      backing cohort; chủ lớp thấy lớp, người ngoài không;
 *  (2) tạo 2 khoá trong lớp → mỗi khoá tự có group "Cả lớp" + enrol
 *      instance cohort trỏ vào backing cohort, context khoá neo dưới
 *      context lớp;
 *  (3) thêm 2 học sinh vào roster → cả hai ACTIVE ở cả 2 khoá;
 *  (4) rời lớp → SUSPENDED ở mọi khoá; vào lại → ACTIVE lại;
 *  (5) thêm khoá mới vào lớp đang chạy → backfill ngay toàn bộ roster;
 *  (6) bền vững: chèn cohort_members + sự kiện outbox TRỰC TIẾP vào DB
 *      (bỏ qua đường in-process) → consumer vật chất hoá ghi danh —
 *      ca này đã chuyển sang tầng integration của worker cùng
 *      consumer đồng bộ cohort (issue con #528 của #519), xem
 *      `apps/worker/test/integration/enrol/cohort-sync-events-delivery.int-spec.ts`;
 *      tiến trình API không còn consumer polling cho hai loại sự kiện
 *      cohort nên ca không còn chạy được ở tầng e2e của API;
 *  (7) đình chỉ thủ công theo khoá mang vết modifierId = người thao
 *      tác (căn cứ để job đối soát tôn trọng ca "miễn môn");
 *  (8) đổi on_leave = unenrol → rời lớp thì ghi danh WITHDRAWN;
 *  (9) vai classgrader tại context lớp: xem được lớp + khoá, KHÔNG
 *      quản được roster;
 * (10) lớp lưu trữ: đóng băng roster + chặn tạo khoá; xoá lớp còn khoá
 *      → 409 class.has_courses.
 */
describe('class lifecycle (CLASS-0, #184)', () => {
  let app: INestApplication;
  let pg: Client;
  let admin = '';
  let teacher = '';
  let teacherId = '';
  let grader = '';
  let graderId = '';
  let student1 = '';
  let student1Id = '';
  let student2Id = '';
  let student3Id = '';
  let categoryId = '';
  let classId = '';
  let cohortId = '';
  let course1 = '';
  let course2 = '';
  let course3 = '';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const must = async (res: { status: number; body: unknown }, what: string) => {
    if (res.status < 200 || res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as never;
  };

  /** Trạng thái ghi danh của một user trên instance cohort của một khoá: 0 ACTIVE, 1 SUSPENDED, 2 WITHDRAWN, undefined = chưa có dòng. */
  async function cohortUeStatus(courseId: string, userId: string): Promise<number | undefined> {
    const rows = await pg.query<{ status: number }>(
      `select ue.status from user_enrolments ue join enrol e on e.id = ue.enrol_id
        where e.course_id = $1 and e.enrol = 'cohort' and ue.user_id = $2`,
      [courseId, userId],
    );
    return rows.rows[0]?.status;
  }

  async function cohortInstance(courseId: string): Promise<{ id: string; customInt1: string; customInt2: string | null; customText1: string }> {
    const rows = await pg.query<{ id: string; custom_int1: string; custom_int2: string | null; custom_text1: string }>(
      `select id, custom_int1, custom_int2, custom_text1 from enrol where course_id = $1 and enrol = 'cohort'`,
      [courseId],
    );
    if (!rows.rows[0]) throw new Error(`no cohort instance for course ${courseId}`);
    return { id: rows.rows[0].id, customInt1: rows.rows[0].custom_int1, customInt2: rows.rows[0].custom_int2, customText1: rows.rows[0].custom_text1 };
  }

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    admin = (await login(app, 'admin', 'Admin123!')).accessToken;

    const teacherUser = await createUserViaApi(app, admin);
    teacherId = teacherUser.id;
    const graderUser = await createUserViaApi(app, admin);
    graderId = graderUser.id;
    const s1 = await createUserViaApi(app, admin);
    student1Id = s1.id;
    student1 = (await login(app, s1.username, STRONG_PASSWORD)).accessToken;
    const s2 = await createUserViaApi(app, admin);
    student2Id = s2.id;
    const s3 = await createUserViaApi(app, admin);
    student3Id = s3.id;
    teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;
    grader = (await login(app, graderUser.username, STRONG_PASSWORD)).accessToken;

    // Mọi user của spec là thành viên tenant-zero (trang chính) — cổng
    // membership của PermissionEvaluator vô hiệu mọi gán vai trong cây
    // tenant khi thiếu membership hiệu lực (TENANT-0, #168).
    const current = await must(await http(app).get('/api/v1/tenants/current').set(auth(admin)), 'current tenant') as { id: string };
    for (const userId of [teacherId, graderId, student1Id, student2Id, student3Id]) {
      await http(app).post(`/api/v1/tenants/${current.id}/members`).set(auth(admin)).send({ userId });
    }
    // Giáo viên của spec làm chủ một lớp NHIỀU khoá: theo đặc tả slot
    // đã duyệt của issue #189, giáo viên ở tenant platform không có
    // gói chỉ làm chủ được mức nền 1 khoá — cấp quyền lợi gói giáo
    // viên đang hoạt động làm tiền đề fixture (xem grantActiveTeacherPlan).
    await grantActiveTeacherPlan(pg, teacherId);

    categoryId = (await createCategory(app, admin)).id;
  });

  afterAll(async () => {
    await pg.end();
    await app.close();
  });

  it('(1) tạo lớp: admin tạo hộ với owner là giáo viên; context CLASS=45 + backing cohort được dựng', async () => {
    const created = await must(
      await http(app).post('/api/v1/classes').set(auth(admin))
        .send({ name: `Lớp spec ${uniqueName('cls')}`, code: uniqueName('code').toUpperCase(), ownerId: teacherId }),
      'create class',
    ) as { id: string; cohortId: string; ownerId: string; joinCode: string | null; status: string };
    classId = created.id;
    cohortId = created.cohortId;
    expect(created.ownerId).toBe(teacherId);
    expect(created.status).toBe('active');
    expect(created.joinCode).toBeNull();

    const ctx = await pg.query<{ context_level: number; path: string }>(
      'select context_level, path from context where instance_id = $1', [classId],
    );
    expect(ctx.rows[0]?.context_level).toBe(45);

    const cohort = await pg.query<{ component: string }>('select component from cohort where id = $1', [cohortId]);
    expect(cohort.rows[0]?.component).toBe('class');

    // Chủ lớp thấy lớp trong danh sách của mình; học sinh chưa thuộc lớp thì không thấy và đọc thẳng bị 404.
    const mine = await must(await http(app).get('/api/v1/classes').set(auth(teacher)), 'list classes as owner') as { id: string }[];
    expect(mine.some((c) => c.id === classId)).toBe(true);
    const outsider = await http(app).get(`/api/v1/classes/${classId}`).set(auth(student1));
    expect(outsider.status).toBe(404);
  });

  it('(2) tạo 2 khoá trong lớp: instance cohort + group "Cả lớp" tự sinh, context khoá neo dưới context lớp', async () => {
    const mk = async (): Promise<string> => {
      const shortName = uniqueName('crs');
      const res = await must(
        await http(app).post('/api/v1/courses').set(auth(teacher))
          .send({ fullName: `Course ${shortName}`, shortName, category: categoryId, classId }),
        'create course in class',
      ) as { id: string; classId: string };
      expect(res.classId).toBe(classId);
      return res.id;
    };
    course1 = await mk();
    course2 = await mk();

    for (const courseId of [course1, course2]) {
      const instance = await cohortInstance(courseId);
      expect(instance.customInt1).toBe(cohortId);
      expect(instance.customText1).toBe('suspend');
      expect(instance.customInt2).toBeTruthy();
      const group = await pg.query<{ name: string }>('select name from course_groups where id = $1', [instance.customInt2]);
      expect(group.rows[0]?.name).toBe('Cả lớp');
      // Context khoá có context lớp trong path tổ tiên.
      const paths = await pg.query<{ path: string }>(
        `select path from context where context_level = 50 and instance_id = $1`, [courseId],
      );
      const classCtx = await pg.query<{ id: string }>(
        'select id from context where context_level = 45 and instance_id = $1', [classId],
      );
      expect(paths.rows[0]?.path.split('/')).toContain(classCtx.rows[0]?.id);
    }

    const listed = await must(await http(app).get(`/api/v1/classes/${classId}/courses`).set(auth(teacher)), 'list class courses') as { id: string }[];
    expect(listed.map((c) => c.id).sort()).toEqual([course1, course2].sort());
  });

  it('(3) thêm 2 học sinh vào roster → ACTIVE ở cả 2 khoá của lớp', async () => {
    for (const userId of [student1Id, student2Id]) {
      await must(await http(app).post(`/api/v1/classes/${classId}/roster`).set(auth(teacher)).send({ userId }), 'add to roster');
    }
    for (const courseId of [course1, course2]) {
      expect(await cohortUeStatus(courseId, student1Id)).toBe(0);
      expect(await cohortUeStatus(courseId, student2Id)).toBe(0);
    }
    const roster = await must(await http(app).get(`/api/v1/classes/${classId}/roster`).set(auth(teacher)), 'list roster') as { userId: string }[];
    expect(roster.map((m) => m.userId).sort()).toEqual([student1Id, student2Id].sort());
  });

  it('(4) rời lớp → SUSPENDED mọi khoá; vào lại → ACTIVE lại, dữ liệu ghi danh cũ được nối tiếp', async () => {
    await must(await http(app).delete(`/api/v1/classes/${classId}/roster/${student1Id}`).set(auth(teacher)), 'remove from roster');
    expect(await cohortUeStatus(course1, student1Id)).toBe(1);
    expect(await cohortUeStatus(course2, student1Id)).toBe(1);
    expect(await cohortUeStatus(course1, student2Id)).toBe(0);

    await must(await http(app).post(`/api/v1/classes/${classId}/roster`).set(auth(teacher)).send({ userId: student1Id }), 're-add to roster');
    expect(await cohortUeStatus(course1, student1Id)).toBe(0);
    expect(await cohortUeStatus(course2, student1Id)).toBe(0);
  });

  it('(5) thêm khoá mới vào lớp đang chạy → backfill ngay toàn bộ roster', async () => {
    const shortName = uniqueName('crs');
    const res = await must(
      await http(app).post('/api/v1/courses').set(auth(teacher))
        .send({ fullName: `Course ${shortName}`, shortName, category: categoryId, classId }),
      'create third course in class',
    ) as { id: string };
    course3 = res.id;
    expect(await cohortUeStatus(course3, student1Id)).toBe(0);
    expect(await cohortUeStatus(course3, student2Id)).toBe(0);
  });

  // (6) bền vững đã chuyển sang tầng integration của worker cùng
  // consumer đồng bộ cohort (issue con #528 của #519):
  // `apps/worker/test/integration/enrol/cohort-sync-events-delivery.int-spec.ts`
  // giữ nguyên khẳng định nghiệp vụ (cohort_members + outbox ghi
  // thẳng vào DB, không qua in-process → relay → hàng đợi →
  // consumer vật chất hoá ghi danh) trên đường thật của production.
  // Đường polling phía API đã gỡ nên ca này không còn chạy được ở
  // tầng e2e của API (tiến trình API không còn consumer nào quét
  // outbox cho hai loại sự kiện cohort).

  it('(7) đình chỉ thủ công theo khoá mang vết modifierId = giáo viên; kích hoạt lại xoá vết về đồng bộ', async () => {
    const instance = await cohortInstance(course1);
    await must(
      await http(app).post(`/api/v1/courses/${course1}/enrol/instances/${instance.id}/users/${student2Id}/suspend`).set(auth(teacher)),
      'manual suspend in one course',
    );
    const rows = await pg.query<{ status: number; modifier_id: string | null }>(
      'select status, modifier_id from user_enrolments where enrol_id = $1 and user_id = $2', [instance.id, student2Id],
    );
    expect(rows.rows[0]?.status).toBe(1);
    expect(rows.rows[0]?.modifier_id).toBe(teacherId);
    // Các khoá khác của lớp không bị đụng.
    expect(await cohortUeStatus(course2, student2Id)).toBe(0);

    const reactivated = await must(
      await http(app).post(`/api/v1/courses/${course1}/enrol/instances/${instance.id}/users/${student2Id}/reactivate`).set(auth(teacher)),
      'manual reactivate in one course',
    ) as { status: number };
    expect(reactivated.status).toBe(0);
    // Kích hoạt lại thủ công cũng là thao tác của người — vết modifierId
    // vẫn là giáo viên (job đối soát chỉ đọc vết trên dòng SUSPENDED).
    expect(await cohortUeStatus(course1, student2Id)).toBe(0);
  });

  it('(8) on_leave = unenrol đẩy xuống instance; rời lớp sau đó → WITHDRAWN', async () => {
    const updated = await must(
      await http(app).patch(`/api/v1/classes/${classId}`).set(auth(teacher)).send({ onLeave: 'unenrol' }),
      'update on_leave',
    ) as { onLeave: string };
    expect(updated.onLeave).toBe('unenrol');
    const instance = await cohortInstance(course2);
    expect(instance.customText1).toBe('unenrol');

    await must(await http(app).delete(`/api/v1/classes/${classId}/roster/${student2Id}`).set(auth(teacher)), 'remove student2');
    const statusC2 = await cohortUeStatus(course2, student2Id);
    // unenrolInternal: còn dữ liệu liên quan thì WITHDRAWN (2), chưa có gì thì xoá dòng (undefined) — cả hai đều là "đã rút hẳn".
    expect([2, undefined]).toContain(statusC2);
    expect(await cohortUeStatus(course1, student1Id)).toBe(0);
  });

  it('(9) vai classgrader tại context lớp: xem được lớp và khoá trong lớp, KHÔNG quản được roster', async () => {
    const classCtx = await pg.query<{ id: string }>(
      'select id from context where context_level = 45 and instance_id = $1', [classId],
    );
    const graderRoleId = await roleIdByShortname(app, admin, 'classgrader');
    await must(
      await http(app).post('/api/v1/access/assignments').set(auth(admin))
        .send({ userId: graderId, roleId: graderRoleId, contextId: classCtx.rows[0]!.id }),
      'assign classgrader',
    );
    const view = await http(app).get(`/api/v1/classes/${classId}`).set(auth(grader));
    expect(view.status).toBe(200);
    const courses = await http(app).get(`/api/v1/classes/${classId}/courses`).set(auth(grader));
    expect(courses.status).toBe(200);
    const rosterAdd = await http(app).post(`/api/v1/classes/${classId}/roster`).set(auth(grader)).send({ userId: student2Id });
    expect(rosterAdd.status).toBe(403);
  });

  it('(10) xoá lớp còn khoá → 409; lưu trữ lớp → đóng băng roster và chặn tạo khoá mới', async () => {
    const del = await http(app).delete(`/api/v1/classes/${classId}`).set(auth(teacher));
    expect(del.status).toBe(409);
    expect((del.body as { code?: string }).code).toBe('class.has_courses');

    const archived = await must(await http(app).post(`/api/v1/classes/${classId}/archive`).set(auth(teacher)), 'archive class') as { status: string };
    expect(archived.status).toBe('archived');

    const rosterAdd = await http(app).post(`/api/v1/classes/${classId}/roster`).set(auth(teacher)).send({ userId: student2Id });
    expect(rosterAdd.status).toBe(400);
    expect((rosterAdd.body as { code?: string }).code).toBe('class.archived');

    const shortName = uniqueName('crs');
    const create = await http(app).post('/api/v1/courses').set(auth(teacher))
      .send({ fullName: `Course ${shortName}`, shortName, category: categoryId, classId });
    expect(create.status).toBe(400);
    expect((create.body as { code?: string }).code).toBe('class.archived');
  });
});
