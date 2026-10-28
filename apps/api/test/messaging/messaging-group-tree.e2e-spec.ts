import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD,
} from '../support/identity-access-helpers';
import { createCategory, createClass, createCourse, createEnrolInstance, enrolUser, grantActiveTeacherPlan } from '../support/course-enrolment-helpers';
import { addGroupMember, contextIdByLevelInstance, createGroupViaApi } from '../support/engagement-helpers';

/**
 * MSG-T1 (issue #33 — thiết kế cấu trúc nhắn tin chốt 11:36 ngày
 * 26/10/2026): cây nhóm theo VAI dựng ở server (GET
 * /messages/group-tree) + phân loại conversation trên danh sách.
 *
 * Luồng nghiệp vụ được kiểm:
 *  (1) GV là chủ 2 lớp, mỗi lớp có khoá: cây của GV có đúng 2 nút lớp
 *      vai "đang dạy" (teaching), khoá nằm TRONG lớp theo quan hệ
 *      lớp–khoá, chat chưa ensure thì conversationId null + unread 0.
 *  (2) Sau khi chat khoá được ensure và có tin chưa đọc, nút khoá
 *      mang đúng conversationId + unread; nút lớp mang tổng chưa đọc
 *      của các nút con.
 *  (3) HS thuộc roster của lớp 1: cây chỉ có lớp 1 vai "đang học"
 *      (learning); HS đồng thời ghi danh vào một khoá thuộc lớp khác
 *      (không thuộc roster lớp đó): khoá hiện ở mục ngoài-lớp-trực-
 *      tiếp, KHÔNG kéo theo nút lớp lạ, lớp 2 của GV không xuất hiện.
 *  (4) Người ngoài hoàn toàn: cây rỗng cả ba mục.
 *  (5) Nhóm con trong khoá: thành viên thấy nút nhóm con dưới khoá
 *      (chưa ensure → null), ensure xong thì mang conversationId;
 *      nhóm tự do GV tạo hiện ở mục freeGroups với vai staff của
 *      người tạo, thành viên thường vai learning.
 *  (6) Phân loại trên GET /messages/conversations: chat khoá mang
 *      itemType 'course' + itemId đúng; nhóm con 'groups'; nhóm tự
 *      do cả ba trường null.
 */

interface Person { id: string; username: string; token: string }

interface TreeLeaf { name: string; myRole: string; conversationId: string | null; unread: number }
interface TreeGroup extends TreeLeaf { groupId: string }
interface TreeCourse extends TreeLeaf { courseId: string; groups: TreeGroup[] }
interface TreeClass extends TreeLeaf { classId: string; courses: TreeCourse[] }
interface TreeBody {
  classes: TreeClass[];
  coursesOutsideClasses: TreeCourse[];
  freeGroups: (TreeLeaf & { conversationId: string })[];
}

/**
 * Ghi thẳng một dòng gán vai vào DB cho fixture. Các fixture của bộ
 * spec nhắn tin dựng persona giáo viên vừa ghi danh trong khoá vừa
 * giữ vai giảng dạy tại context khoá (giáo viên hiện diện trong khoá
 * như một thành viên và giữ vai trò kiểm duyệt). Từ issue #425,
 * trạng thái lẫn vai cùng khoá này không còn tạo được qua API — cả
 * hai chiều ghi danh/gán vai đều bị chốt tách vai chặn — và chỉ còn
 * tồn tại như dữ kiện có sẵn; các ca của bộ spec này kiểm hành vi
 * nhắn tin trên đúng dữ kiện đó, nên dòng gán vai được ghi thẳng
 * vào DB trong lúc phần ghi danh vẫn đi qua API như cũ.
 */
async function insertAssignmentRow(roleId: string, userId: string, contextId: string): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `insert into role_assignments (role_id, user_id, context_id, component) values ($1, $2, $3, '')`,
      [roleId, userId, contextId],
    );
  } finally {
    await client.end();
  }
}

/**
 * Dựng thẳng vào DB một ghi danh học viên đang hoạt động cho
 * fixture: bản ghi user_enrolments + dòng gán vai do ghi danh cấp
 * (component 'enrol', item_id là instance) + tư cách thành viên
 * tenant của khoá — đúng các dòng EnrolService.enrolUserInternal
 * vẫn ghi. Chỉ dùng cho persona giáo viên chủ lớp ở khoá 1 của spec
 * này: từ issue #425, ghi danh một chủ lớp vào khoá thuộc lớp mình
 * chủ nhiệm bị chốt funnel 1 chặn qua API (chủ lớp đã có cấp quyền
 * giảng dạy bao phủ khoá qua context lớp), nên ghi danh "theo thông
 * lệ seed" của fixture chỉ còn dựng được như dữ kiện có sẵn.
 */
async function insertLegacyEnrolment(instanceId: string, userId: string, courseId: string, contextId: string): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `insert into user_enrolments (enrol_id, user_id, status) values ($1, $2, 0)`,
      [instanceId, userId],
    );
    await client.query(
      `insert into role_assignments (role_id, user_id, context_id, component, item_id)
         select role_id, $2, $3, 'enrol', id from enrol where id = $1 and role_id is not null`,
      [instanceId, userId, contextId],
    );
    await client.query(
      `insert into tenant_memberships (tenant_id, user_id, status)
         select tenant_id, $2, 'active' from course
          where id = $1 and not exists (
            select 1 from tenant_memberships tm where tm.tenant_id = course.tenant_id and tm.user_id = $2
          )`,
      [courseId, userId],
    );
  } finally {
    await client.end();
  }
}

describe('Messaging — cây nhóm theo vai (MSG-T1, issue #33)', () => {
  let app: INestApplication;
  let admin: string;
  let teacher: Person;
  let student: Person;
  let outsider: Person;
  let class1: string;
  let class2: string;
  let classX: string;
  let course1: string;
  let course2: string;
  let courseX: string;
  let group1: string;
  let convCourse1: string;
  let groupConv: string;
  let freeGroupId: string;

  async function person(): Promise<Person> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  async function tree(token: string): Promise<TreeBody> {
    const res = await http(app).get('/api/v1/messages/group-tree').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as TreeBody;
  }

  async function send(token: string, conversationId: string, text: string) {
    return http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`).send({ text });
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    teacher = await person();
    student = await person();
    outsider = await person();

    // GV của spec làm chủ 2 lớp/khoá ở tenant platform: theo đặc tả
    // slot đã duyệt của issue #189, giáo viên không có gói chỉ làm
    // chủ được mức nền 1 khoá — cấp quyền lợi gói giáo viên đang
    // hoạt động làm tiền đề fixture (xem grantActiveTeacherPlan).
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      await grantActiveTeacherPlan(pg, teacher.id);
    } finally {
      await pg.end();
    }

    // Admin tạo 2 lớp với chủ lớp là GV (đường tạo hộ bằng
    // tenant:manage đã có ở API của module classes) — GV là chủ lớp
    // nên vai tại cây phải là "đang dạy".
    class1 = (await createClass(app, admin, { ownerId: teacher.id })).id;
    class2 = (await createClass(app, admin, { ownerId: teacher.id })).id;
    classX = (await createClass(app, admin)).id;

    const category = await createCategory(app, admin);
    course1 = (await createCourse(app, admin, category.id, { classId: class1 })).id;
    course2 = (await createCourse(app, admin, category.id, { classId: class2 })).id;
    courseX = (await createCourse(app, admin, category.id, { classId: classX })).id;

    // GV phụ trách dạy cả 3 khoá (editingteacher tại context khoá).
    const editingTeacher = await roleIdByShortname(app, admin, 'editingteacher');
    for (const courseId of [course1, course2, courseX]) {
      const ctx = await contextIdByLevelInstance(app, admin, 50, courseId);
      await assignRole(app, admin, teacher.id, editingTeacher, ctx);
    }

    // HS thuộc roster lớp 1 (vật chất hoá xuống khoá 1).
    const roster = await http(app).post(`/api/v1/classes/${class1}/roster`)
      .set('Authorization', `Bearer ${admin}`).send({ userId: student.id });
    expect(roster.status).toBe(201);

    // HS ghi danh TRỰC TIẾP vào khoá X (không thuộc roster lớp X).
    const instanceX = await createEnrolInstance(app, admin, courseX);
    await enrolUser(app, admin, courseX, instanceX.id, student.id);

    // GV cũng ghi danh ở khoá 1 (thông lệ seed như test chat cấp
    // khoá): cổng thêm thành viên nhóm con đòi ghi danh hiệu lực.
    // Từ issue #425, ghi danh này không còn đi qua API được — chốt
    // funnel 1 chặn vì GV là chủ lớp 1, đã có cấp quyền giảng dạy
    // bao phủ khoá 1 qua context lớp — nên ghi danh được dựng thẳng
    // vào DB như dữ kiện có sẵn (xem insertLegacyEnrolment).
    const instance1 = await createEnrolInstance(app, admin, course1);
    const course1Ctx = await contextIdByLevelInstance(app, admin, 50, course1);
    await insertLegacyEnrolment(instance1.id, teacher.id, course1, course1Ctx);

    // Nhóm con trong khoá 1, HS là thành viên.
    const group = await createGroupViaApi(app, admin, course1, 'Tổ 1');
    group1 = group.id;
    await addGroupMember(app, admin, course1, group1, student.id);
    await addGroupMember(app, admin, course1, group1, teacher.id);

    // Nhóm tự do do GV tạo, HS là thành viên.
    const free = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${teacher.token}`)
      .send({ type: 2, memberIds: [student.id], name: 'Nhóm ôn thi' });
    expect(free.status).toBe(201);
    freeGroupId = free.body.id as string;
  });
  afterAll(async () => { await app.close(); });

  it('1. cây của GV: đúng 2 lớp vai teaching, khoá nằm trong lớp, chat chưa ensure thì conversationId null + unread 0', async () => {
    const t = await tree(teacher.token);
    const byId = new Map(t.classes.map((c) => [c.classId, c]));
    expect([...byId.keys()].sort()).toEqual([class1, class2].sort());
    // Khoá X: GV có gán vai dạy tại khoá nhưng KHÔNG có quan hệ với
    // lớp X — khoá hiện ở mục ngoài-lớp-trực-tiếp, vai teaching.
    expect(t.coursesOutsideClasses.map((c) => c.courseId)).toEqual([courseX]);
    expect(t.coursesOutsideClasses[0]!.myRole).toBe('teaching');

    const c1 = byId.get(class1)!;
    expect(c1.myRole).toBe('teaching');
    expect(c1.conversationId).toBeNull(); // chat cấp lớp có từ MSG-T2
    expect(c1.unread).toBe(0);
    expect(c1.courses.map((c) => c.courseId)).toEqual([course1]);
    const courseNode = c1.courses[0]!;
    expect(courseNode.myRole).toBe('teaching');
    expect(courseNode.conversationId).toBeNull();
    expect(courseNode.unread).toBe(0);
    // Nhóm con: chỉ "Tổ 1" — nhóm cấu trúc "Cả lớp" của lớp không
    // phải nhóm con, không hiện ở mức này.
    expect(courseNode.groups.map((g) => g.groupId)).toEqual([group1]);
    expect(courseNode.groups[0]!.conversationId).toBeNull();

    const c2 = byId.get(class2)!;
    expect(c2.courses.map((c) => c.courseId)).toEqual([course2]);
    // Lớp X không phải của GV theo quan hệ lớp — GV chỉ dạy khoá trong
    // đó qua gán vai khoá, lớp X không thành nút lớp của GV.
    expect(byId.has(classX)).toBe(false);
  });

  it('2. ensure chat khoá + tin chưa đọc: nút khoá mang conversationId + unread đúng, nút lớp mang tổng con', async () => {
    const ensured = await http(app).get(`/api/v1/messages/courses/${course1}/conversation`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(ensured.status).toBe(200);
    convCourse1 = ensured.body.id as string;
    const sent = await send(teacher.token, convCourse1, 'Thông báo cho cả lớp');
    expect(sent.status).toBe(201);

    const teacherTree = await tree(teacher.token);
    const teacherCourse = teacherTree.classes.find((c) => c.classId === class1)!.courses[0]!;
    expect(teacherCourse.conversationId).toBe(convCourse1);
    expect(teacherCourse.unread).toBe(0); // tin của chính GV không tính chưa đọc của GV

    const studentTree = await tree(student.token);
    const studentCourse = studentTree.classes.find((c) => c.classId === class1)!.courses[0]!;
    expect(studentCourse.conversationId).toBe(convCourse1);
    expect(studentCourse.unread).toBe(1);
    const studentClass = studentTree.classes.find((c) => c.classId === class1)!;
    expect(studentClass.unread).toBe(1); // tổng các nút con

    await http(app).post(`/api/v1/messages/conversations/${convCourse1}/read`)
      .set('Authorization', `Bearer ${student.token}`).send({});
    const afterRead = await tree(student.token);
    expect(afterRead.classes.find((c) => c.classId === class1)!.courses[0]!.unread).toBe(0);
  });

  it('3. cây của HS: lớp 1 vai learning; khoá X hiện ở mục ngoài lớp trực tiếp, không kéo nút lớp lạ', async () => {
    const t = await tree(student.token);
    expect(t.classes.map((c) => c.classId)).toEqual([class1]);
    expect(t.classes[0]!.myRole).toBe('learning');
    expect(t.classes[0]!.courses.map((c) => c.courseId)).toEqual([course1]);
    expect(t.classes[0]!.courses[0]!.myRole).toBe('learning');
    expect(t.coursesOutsideClasses.map((c) => c.courseId)).toEqual([courseX]);
    expect(t.coursesOutsideClasses[0]!.myRole).toBe('learning');
    // Lớp 2 (của GV, HS không liên quan) không xuất hiện ở bất kỳ đâu.
    expect(JSON.stringify(t)).not.toContain(class2);
  });

  it('4. người ngoài hoàn toàn: cây rỗng cả ba mục', async () => {
    const t = await tree(outsider.token);
    expect(t.classes).toEqual([]);
    expect(t.coursesOutsideClasses).toEqual([]);
    expect(t.freeGroups).toEqual([]);
  });

  it('5. nhóm con ensure xong mang conversationId; nhóm tự do ở freeGroups đúng vai', async () => {
    const created = await http(app).post('/api/v1/messages/conversations/group')
      .set('Authorization', `Bearer ${student.token}`).send({ groupId: group1 });
    expect(created.status).toBe(201);
    groupConv = created.body.id as string;

    const t = await tree(student.token);
    const groupNode = t.classes.find((c) => c.classId === class1)!.courses[0]!.groups
      .find((g) => g.groupId === group1)!;
    expect(groupNode.conversationId).toBe(groupConv);
    expect(t.freeGroups.map((g) => g.conversationId)).toEqual([freeGroupId]);
    expect(t.freeGroups[0]!.myRole).toBe('learning');

    const teacherTree = await tree(teacher.token);
    expect(teacherTree.freeGroups.map((g) => g.conversationId)).toEqual([freeGroupId]);
    expect(teacherTree.freeGroups[0]!.myRole).toBe('staff'); // người tạo nhóm tự do
    expect(teacherTree.freeGroups[0]!.name).toBe('Nhóm ôn thi');
  });

  it('6. phân loại trên danh sách conversation: itemType/itemId đúng từng loại, nhóm tự do thì null', async () => {
    const list = await http(app).get('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${student.token}`);
    expect(list.status).toBe(200);
    const rows = list.body as { id: string; component: string | null; itemType: string | null; itemId: string | null }[];
    const courseRow = rows.find((r) => r.id === convCourse1);
    expect(courseRow).toMatchObject({ component: 'core_course', itemType: 'course', itemId: course1 });
    const groupRow = rows.find((r) => r.id === groupConv);
    expect(groupRow).toMatchObject({ component: 'core_group', itemType: 'groups', itemId: group1 });
    const freeRow = rows.find((r) => r.id === freeGroupId);
    expect(freeRow).toMatchObject({ component: null, itemType: null, itemId: null });
  });
});
