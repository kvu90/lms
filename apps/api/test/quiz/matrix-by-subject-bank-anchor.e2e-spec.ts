import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  STRONG_PASSWORD, adminToken, assignRole, createRoleViaApi, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, setOverride, systemContextId, uniqueName,
} from '../support/identity-access-helpers';
import { createCategory, createCourse } from '../support/course-enrolment-helpers';
import { courseContextId } from '../support/engagement-helpers';

/**
 * Danh sách ma trận theo môn — phân quyền NEO TẠI BANK (issue #376).
 *
 * Luồng nghiệp vụ được kiểm: `GET /exam-matrices/by-subject/:subjectId`
 * từng gác hai cổng liên tiếp tại context của MÔN (đọc môn qua
 * `curriculum:view`, rồi đòi `matrix:use` tại context môn) nên giáo
 * viên làm việc với môn hệ thống — môn neo tại context hệ thống, nơi
 * giáo viên không giữ vai trò nào — luôn nhận 403 dù có đầy đủ quyền
 * tại bank chứa ma trận. Học thuyết neo bank (điểm neo quyền duy nhất
 * của ma trận là bank chứa nó; context môn chỉ là phạm vi dữ liệu)
 * đòi bề mặt này: đọc môn dạng tham chiếu thuần tuý, bỏ cổng tại
 * context môn, và lọc từng ma trận theo quyền của chính nó —
 * bank-local (`bankLocalMatrixCaps.view`) với ma trận có bank, quy
 * tắc legacy (`PermissionEvaluator` với `matrix:use` tại context của
 * chính ma trận) với ma trận chưa thuộc bank nào/bank đã xoá.
 *
 * Diễn viên dựng theo ĐÚNG mô hình dữ liệu mẫu (hồi quy D-3 của issue
 * #233): giáo viên giữ vai `editingteacher` tại context KHOÁ mình
 * dạy, KHÔNG có vai nào tại context hệ thống. Các khẳng định đối
 * chiếu cả danh sách id lẫn bankId của từng ma trận trả về.
 */
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface MatrixListItem { id: string; bankId: string | null }

describe('Danh sách ma trận theo môn neo quyền tại bank (issue #376)', () => {
  let app: INestApplication;
  let admin: string;
  let subjectId: string;
  let curriculumId: string;

  let teacherA: { id: string; token: string };
  let teacherB: { id: string; token: string };
  let teamLeader: { id: string; token: string };
  let teamMember: { id: string; token: string };
  let nobody: { id: string; token: string };
  let legacyViewer: { id: string; token: string };

  let bankAId: string;
  let matrixAId: string;
  let matrixBId: string;
  let matrixTeamId: string;
  let matrixLegacyId: string;

  async function listBySubject(token: string): Promise<{ status: number; body: MatrixListItem[] }> {
    const res = await http(app).get(`/api/v1/exam-matrices/by-subject/${subjectId}`).set(auth(token));
    return { status: res.status, body: res.body as MatrixListItem[] };
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const systemCtxId = await systemContextId(app, admin);

    // Môn + chương trình neo tại context HỆ THỐNG (như môn GDPT thật).
    const suffix = Date.now().toString(36);
    const subjRes = await http(app).post('/api/v1/curriculum/subjects').set(auth(admin))
      .send({ contextId: systemCtxId, name: 'Toán học 376', slug: `toan-376-${suffix}` });
    expect(subjRes.status, JSON.stringify(subjRes.body)).toBe(201);
    subjectId = (subjRes.body as { id: string }).id;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set(auth(admin))
      .send({ subjectId, grade: 10 });
    expect(currRes.status, JSON.stringify(currRes.body)).toBe(201);
    curriculumId = (currRes.body as { id: string }).id;

    // Hai khoá học để gán vai editingteacher tại context khoá (mô
    // hình seed): giáo viên KHÔNG có vai nào tại context hệ thống.
    const category = await createCategory(app, admin);
    const courseA = await createCourse(app, admin, category.id);
    const courseB = await createCourse(app, admin, category.id);
    const ctxA = await courseContextId(app, admin, courseA.id);
    const ctxB = await courseContextId(app, admin, courseB.id);
    const editingTeacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    const mkTeacher = async (username: string, ctxId: string) => {
      const u = await createUserViaApi(app, admin, { username });
      await assignRole(app, admin, u.id, editingTeacherRole, ctxId);
      const token = (await login(app, username, STRONG_PASSWORD)).accessToken;
      return { id: u.id, token };
    };
    teacherA = await mkTeacher(`gv376_a_${suffix}`, ctxA);
    teacherB = await mkTeacher(`gv376_b_${suffix}`, ctxB);
    teamLeader = await mkTeacher(`gv376_lead_${suffix}`, ctxA);
    teamMember = await mkTeacher(`gv376_mem_${suffix}`, ctxB);

    // Bank ma trận cá nhân của A và B (tạo lười qua danh sách bank).
    const personalBankOf = async (token: string): Promise<string> => {
      const res = await http(app).get('/api/v1/question-banks?kind=matrix').set(auth(token)).expect(200);
      const bank = (res.body as { id: string; scope: string }[]).find((b) => b.scope === 'personal');
      expect(bank, 'giáo viên phải có bank ma trận cá nhân').toBeTruthy();
      return bank!.id;
    };
    bankAId = await personalBankOf(teacherA.token);
    const bankBId = await personalBankOf(teacherB.token);

    const createMatrix = async (token: string, name: string, bankId?: string): Promise<string> => {
      const res = await http(app).post('/api/v1/exam-matrices').set(auth(token))
        .send({ name, subjectId, curriculumId, ...(bankId ? { bankId } : {}) });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return (res.body as { id: string }).id;
    };
    matrixAId = await createMatrix(teacherA.token, `Ma trận 376 của A ${suffix}`, bankAId);
    matrixBId = await createMatrix(teacherB.token, `Ma trận 376 của B ${suffix}`, bankBId);

    // Bank ma trận của TỔ (cohort: tổ trưởng + một thành viên; A và B
    // không thuộc tổ) và ma trận của tổ do tổ trưởng tạo.
    const cohortRes = await http(app).post('/api/v1/cohorts').set(auth(admin)).send({ name: uniqueName('Tổ 376') });
    expect(cohortRes.status, JSON.stringify(cohortRes.body)).toBe(201);
    const cohortId = (cohortRes.body as { id: string }).id;
    for (const u of [teamLeader, teamMember]) {
      const add = await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set(auth(admin)).send({ userId: u.id });
      expect(add.status, JSON.stringify(add.body)).toBe(201);
    }
    const teamBankRes = await http(app).post('/api/v1/question-banks').set(auth(admin))
      .send({ name: uniqueName('Ngân hàng ma trận tổ 376'), scope: 'team', bankKind: 'matrix', scopeRefId: cohortId, leaderId: teamLeader.id });
    expect(teamBankRes.status, JSON.stringify(teamBankRes.body)).toBe(201);
    const teamBankId = (teamBankRes.body as { id: string }).id;
    matrixTeamId = await createMatrix(teamLeader.token, `Ma trận 376 của tổ ${suffix}`, teamBankId);

    // Ma trận LEGACY: tạo tay KHÔNG gắn bank (nhánh legacy của đường
    // tạo — cổng tại context môn, admin qua được) nên bankId = null và
    // contextId của ma trận là context hệ thống của môn.
    matrixLegacyId = await createMatrix(admin, `Ma trận 376 legacy ${suffix}`);

    // Người không có quyền nào ở bất kỳ đâu.
    const nb = await createUserViaApi(app, admin, { username: `nb376_${suffix}` });
    nobody = { id: nb.id, token: (await login(app, `nb376_${suffix}`, STRONG_PASSWORD)).accessToken };

    // Người có quyền legacy: vai tuỳ biến chỉ mang `matrix:use` tại
    // context hệ thống — qua cổng legacy của ma trận chưa thuộc bank,
    // nhưng không phải thành viên của bất kỳ bank nào ở trên.
    const legacyRoleId = await createRoleViaApi(app, admin);
    await setOverride(app, admin, legacyRoleId, 'matrix:use', systemCtxId, 1);
    const lv = await createUserViaApi(app, admin, { username: `lv376_${suffix}` });
    await assignRole(app, admin, lv.id, legacyRoleId, systemCtxId);
    legacyViewer = { id: lv.id, token: (await login(app, `lv376_${suffix}`, STRONG_PASSWORD)).accessToken };
  });

  afterAll(async () => { await app.close(); });

  it('(a)+(b) giáo viên có quyền tại bank cá nhân, không quyền tại context môn/hệ thống: 200 và thấy đúng ma trận của bank mình, không thấy ma trận bank cá nhân của đồng nghiệp', async () => {
    const { status, body } = await listBySubject(teacherA.token);
    expect(status).toBe(200);
    // Đúng tập ma trận: chỉ ma trận trong bank cá nhân của A. Ma trận
    // của B (bank personal của người khác), ma trận tổ (A không phải
    // thành viên) và ma trận legacy (A không có matrix:use tại
    // context của ma trận) đều vắng mặt.
    expect(body.map((m) => m.id)).toEqual([matrixAId]);
    // Đối chiếu bank chứa: mọi ma trận trả về thuộc bank của A.
    expect(body.every((m) => m.bankId === bankAId)).toBe(true);
  });

  it('(b) giáo viên B cũng chỉ thấy ma trận của bank cá nhân mình', async () => {
    const { status, body } = await listBySubject(teacherB.token);
    expect(status).toBe(200);
    expect(body.map((m) => m.id)).toEqual([matrixBId]);
  });

  it('bank dùng chung: tổ trưởng và thành viên thấy ma trận của tổ; giáo viên ngoài tổ không thấy', async () => {
    const leaderList = await listBySubject(teamLeader.token);
    expect(leaderList.status).toBe(200);
    expect(leaderList.body.map((m) => m.id)).toEqual([matrixTeamId]);

    const memberList = await listBySubject(teamMember.token);
    expect(memberList.status).toBe(200);
    expect(memberList.body.map((m) => m.id)).toEqual([matrixTeamId]);

    const outsiderList = await listBySubject(teacherB.token);
    expect(outsiderList.body.map((m) => m.id)).not.toContain(matrixTeamId);
  });

  it('(c) người không có quyền ở bất kỳ bank liên quan nào: 200 với danh sách rỗng, không 403 vì context môn', async () => {
    const { status, body } = await listBySubject(nobody.token);
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('(d) tài khoản quản trị vẫn xem được toàn bộ ma trận của môn như trước', async () => {
    const { status, body } = await listBySubject(admin);
    expect(status).toBe(200);
    expect(body.map((m) => m.id).sort()).toEqual([matrixAId, matrixBId, matrixTeamId, matrixLegacyId].sort());
  });

  it('(e) ma trận chưa thuộc bank nào tuân quy tắc legacy: người có matrix:use tại context của ma trận thấy, người không có quyền bank vẫn không thấy ma trận trong bank', async () => {
    const { status, body } = await listBySubject(legacyViewer.token);
    expect(status).toBe(200);
    expect(body.map((m) => m.id)).toEqual([matrixLegacyId]);
    expect(body[0]!.bankId).toBeNull();
  });

  it('môn không tồn tại vẫn trả 404 như trước (đọc tham chiếu không che lỗi không tồn tại)', async () => {
    const res = await http(app).get(`/api/v1/exam-matrices/by-subject/${randomUUID()}`).set(auth(teacherA.token));
    expect(res.status).toBe(404);
    expect((res.body as { code?: string }).code).toBe('curriculum.subject_not_found');
  });
});
