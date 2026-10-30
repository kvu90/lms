import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname,
  STRONG_PASSWORD, systemContextId, uniqueName,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';
import { addGroupMember, contextIdByLevelInstance, createGroupViaApi } from '../../support/engagement-helpers';

/**
 * Cổng tạo NHÓM TỰ DO (issue #563): nhóm thủ công trong hệ thống chỉ
 * do ba nhóm người tạo —
 *
 *  1. Quản trị viên hệ thống (site admin);
 *  2. Chủ trung tâm: thành viên của tenant giữ vai manager tại
 *     context của chính tenant đó (capability `tenant:manage` tại
 *     context tenant hiện hành);
 *  3. Quản trị viên nền tảng: giữ vai manager tại context HỆ THỐNG
 *     (capability `tenant:manage` tại context hệ thống) nhưng không
 *     nằm trong danh sách site admin và không phải thành viên của
 *     tenant hiện hành — qua cổng nhờ nhánh dự phòng của cùng
 *     predicate chủ trung tâm, vì gán vai ở context hệ thống không
 *     chảy vào cây tenant nên phải kiểm riêng tại context hệ thống.
 *
 * Giáo viên (gán vai giảng dạy tại context khoá), nhân viên (gán vai
 * staff tại context hệ thống) và học viên (ghi danh khoá) đều bị từ
 * chối 403 `messaging.group_creation_forbidden` tại tầng service.
 * Nhóm sinh theo cấu trúc lớp/khoá (conversation của course group)
 * không qua cổng này: thành viên group vẫn tạo/mở được như cũ. Cờ
 * `canCreateFreeGroup` trên cây nhóm (GET /messages/group-tree) phải
 * khớp đúng cổng này cho từng vai, để nút tạo nhóm phía web hiện/ẩn
 * đúng người. Hội thoại 1-1 qua cổng liên lạc không đổi.
 */

interface Person { id: string; username: string; token: string }

describe('Messaging — cổng tạo nhóm tự do chỉ dành cho quản trị viên và chủ trung tâm (issue #563)', () => {
  let app: INestApplication;
  let admin: string;
  let adminId: string;
  let teacher: Person;
  let staff: Person;
  let platformManager: Person;
  let student: Person;
  let member: Person;
  let owner: Person;
  let centreMember: Person;
  let ownerCentreToken: string;
  let courseGroupId: string;

  async function person(): Promise<Person> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  async function createFreeGroup(token: string, memberIds: string[]) {
    return http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 2, memberIds, name: 'Nhóm kiểm cổng tạo nhóm' });
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    adminId = (await login(app, 'admin', 'Admin123!')).userId;

    // Khoá nền ở tenant mặc định: giáo viên giữ vai editingteacher
    // tại context khoá (không ghi danh — đúng trạng thái tách vai
    // hiện hành), học viên ghi danh vào khoá.
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    teacher = await person();
    student = await person();
    member = await person();
    const courseCtx = await contextIdByLevelInstance(app, admin, 50, course.id);
    const editingTeacher = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, teacher.id, editingTeacher, courseCtx);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    await enrolUser(app, admin, course.id, instance.id, member.id);

    // Nhân viên: vai coursecreator tại context HỆ THỐNG — có gán vai
    // staff nhưng không dạy khoá nào và không quản lý tenant nào.
    staff = await person();
    const systemCtx = await systemContextId(app, admin);
    const courseCreator = await roleIdByShortname(app, admin, 'coursecreator');
    await assignRole(app, admin, staff.id, courseCreator, systemCtx);

    // Quản trị viên nền tảng: vai manager tại context HỆ THỐNG —
    // giữ `tenant:manage` tại context hệ thống nhưng KHÔNG nằm
    // trong danh sách site admin và không phải thành viên của tenant
    // hiện hành; persona này chỉ qua cổng bằng nhánh dự phòng quản
    // trị nền tảng của predicate chủ trung tâm.
    platformManager = await person();
    const managerRoleAtSystem = await roleIdByShortname(app, admin, 'manager');
    await assignRole(app, admin, platformManager.id, managerRoleAtSystem, systemCtx);

    // Nhóm con của khoá (cấu trúc): hai học viên ghi danh là thành
    // viên group — dùng cho ca đường cấu trúc không bị cổng này chặn
    // (thêm thành viên group đòi ghi danh hiệu lực, giáo viên tách
    // vai không ghi danh nên không thuộc group này).
    const group = await createGroupViaApi(app, admin, course.id, 'Tổ kiểm cổng');
    courseGroupId = group.id;
    await addGroupMember(app, admin, course.id, group.id, student.id);
    await addGroupMember(app, admin, course.id, group.id, member.id);

    // Trung tâm riêng: chủ trung tâm là thành viên của tenant và giữ
    // vai manager tại context của chính tenant đó.
    const slug = `gate-${uniqueName('t').toLowerCase()}`;
    const tenantRes = await http(app).post('/api/v1/tenants')
      .set('Authorization', `Bearer ${admin}`).send({ name: 'Trung tâm kiểm cổng tạo nhóm', slug, kind: 'center' });
    if (tenantRes.status !== 201) throw new Error(`create tenant failed: ${tenantRes.status} ${JSON.stringify(tenantRes.body)}`);
    const centreTenantId = (tenantRes.body as { id: string }).id;
    owner = await person();
    centreMember = await person();
    for (const p of [owner, centreMember]) {
      const add = await http(app).post(`/api/v1/tenants/${centreTenantId}/members`)
        .set('Authorization', `Bearer ${admin}`).send({ userId: p.id });
      if (add.status !== 201) throw new Error(`add tenant member failed: ${add.status} ${JSON.stringify(add.body)}`);
    }
    const centreCtx = await contextIdByLevelInstance(app, admin, 20, centreTenantId);
    const managerRole = await roleIdByShortname(app, admin, 'manager');
    await assignRole(app, admin, owner.id, managerRole, centreCtx);
    // Phiên của chủ trung tâm TRONG tenant của mình (token mang claim
    // tenant) — cổng tạo nhóm xét theo tenant hiện hành của phiên.
    const switched = await http(app).post(`/api/v1/auth/switch-tenant/${centreTenantId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    if (switched.status !== 201) throw new Error(`switch tenant failed: ${switched.status} ${JSON.stringify(switched.body)}`);
    ownerCentreToken = (switched.body as { accessToken: string }).accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('giáo viên có gán vai giảng dạy tại context khoá bị từ chối tạo nhóm tự do với mã messaging.group_creation_forbidden', async () => {
    const res = await createFreeGroup(teacher.token, [student.id, member.id]);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('messaging.group_creation_forbidden');
  });

  it('nhân viên có gán vai staff tại context hệ thống bị từ chối tạo nhóm tự do với mã messaging.group_creation_forbidden', async () => {
    const res = await createFreeGroup(staff.token, [student.id, member.id]);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('messaging.group_creation_forbidden');
  });

  it('học viên đang ghi danh khoá bị từ chối tạo nhóm tự do với mã messaging.group_creation_forbidden', async () => {
    const res = await createFreeGroup(student.token, [teacher.id, member.id]);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('messaging.group_creation_forbidden');
  });

  it('quản trị viên hệ thống tạo được nhóm tự do và thành viên đúng như khai', async () => {
    const res = await createFreeGroup(admin, [student.id, member.id]);
    expect(res.status).toBe(201);
    expect(new Set(res.body.members as string[])).toEqual(new Set([adminId, student.id, member.id]));
    expect(res.body.createdBy).toBe(adminId);
  });

  it('chủ trung tâm tạo được nhóm tự do trong tenant của mình với phiên đã chuyển vào tenant đó', async () => {
    const res = await createFreeGroup(ownerCentreToken, [centreMember.id]);
    expect(res.status).toBe(201);
    expect(new Set(res.body.members as string[])).toEqual(new Set([owner.id, centreMember.id]));
    expect(res.body.createdBy).toBe(owner.id);
  });

  it('quản trị viên nền tảng giữ tenant:manage tại context hệ thống (không phải site admin, không phải thành viên tenant) tạo được nhóm tự do', async () => {
    const res = await createFreeGroup(platformManager.token, [student.id, member.id]);
    expect(res.status).toBe(201);
    expect(new Set(res.body.members as string[])).toEqual(new Set([platformManager.id, student.id, member.id]));
    expect(res.body.createdBy).toBe(platformManager.id);
  });

  it('đường cấu trúc không bị ảnh hưởng: thành viên nhóm con của khoá vẫn tạo được conversation của nhóm', async () => {
    const res = await http(app).post('/api/v1/messages/conversations/group')
      .set('Authorization', `Bearer ${student.token}`).send({ groupId: courseGroupId });
    expect(res.status).toBe(201);
    expect(new Set(res.body.members as string[])).toEqual(new Set([student.id, member.id]));
  });

  it('cờ canCreateFreeGroup trên cây nhóm khớp cổng tạo nhóm: quản trị viên, chủ trung tâm và quản trị nền tảng true; giáo viên, nhân viên và học viên false', async () => {
    const flagOf = async (token: string) => {
      const res = await http(app).get('/api/v1/messages/group-tree').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      return (res.body as { canCreateFreeGroup: boolean }).canCreateFreeGroup;
    };
    expect(await flagOf(teacher.token)).toBe(false);
    expect(await flagOf(staff.token)).toBe(false);
    expect(await flagOf(student.token)).toBe(false);
    expect(await flagOf(admin)).toBe(true);
    expect(await flagOf(ownerCentreToken)).toBe(true);
    expect(await flagOf(platformManager.token)).toBe(true);
  });

  it('hội thoại 1-1 qua cổng liên lạc không hồi quy: kết bạn xong vẫn mở được conversation riêng', async () => {
    const a = await person();
    const b = await person();
    const req = await http(app).post(`/api/v1/messages/contacts/${b.id}`).set('Authorization', `Bearer ${a.token}`).send({});
    expect(req.status).toBe(201);
    const acc = await http(app).post(`/api/v1/messages/contacts/requests/${a.id}/accept`).set('Authorization', `Bearer ${b.token}`).send({});
    expect(acc.status).toBe(201);
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${a.token}`)
      .send({ type: 1, memberIds: [b.id] });
    expect(conv.status).toBe(201);
    expect(new Set(conv.body.members as string[])).toEqual(new Set([a.id, b.id]));
  });
});
