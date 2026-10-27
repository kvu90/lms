import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';
import { RolesService } from '../src/modules/access/roles.service';

/**
 * Khuôn capability chung của ba thực thể ngân hàng (issue #228, lát
 * S3) — đối chiếu tiêu chí nghiệm thu của issue: "đủ bộ capability
 * theo quy ước <area>:<name> cho cả ba thực thể
 * (use/add/edit/copy/share/moderate và các capability quản trị tương
 * ứng); bỏ việc neo quyền xem/sửa ma trận vào area quiz:*; chuẩn hoá
 * tên capability của đề về cùng khuôn".
 *
 * Luật được khoá ở đây:
 *  - Registry chỉ còn matrix:use/add/edit/copy/share/moderate cho ma
 *    trận và exam:use/add/edit/copy/share/moderate/deploy cho đề;
 *    quiz:viewmatrix, quiz:managematrix và exam:view không còn tồn
 *    tại ở bất kỳ tầng nào (định nghĩa lẫn override đã seed).
 *  - Cổng TẠO dùng capability add ở cả ba đường tạo: tạo ma trận tại
 *    context môn (matrix:add), tạo đề trong bank (exam:add) — thành
 *    viên bank (chỉ có use + copy) tạo đề trong bank tổ bị 403, phụ
 *    trách bank (đủ bộ) tạo được.
 *  - Bề mặt capabilities của bank ma trận phản ánh đúng bộ mới:
 *    phụ trách có add + edit, thành viên chỉ có use (+ copy).
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface BankBody {
  id: string; name: string; scope: string; bankKind: string; ownerId: string | null;
  capabilities: {
    use: boolean; add: boolean; edit: boolean; copy: boolean; share: boolean; moderate: boolean;
    matrixView?: boolean; matrixManage?: boolean;
  };
}

describe('Bank capability mold (issue #228 S3)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  async function mkStaffUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await createUserViaApi(app, admin);
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  /** Một tổ (cohort) với tổ trưởng + thành viên; trả cohort id để lập bank tổ theo kind. */
  async function mkTeam() {
    const leader = await mkStaffUser();
    const member = await mkStaffUser();
    const cohortRes = await http(app).post('/api/v1/cohorts').set(bearer(admin)).send({ name: uniqueName('Tổ S3') });
    expect(cohortRes.status, JSON.stringify(cohortRes.body)).toBe(201);
    const cohortId = (cohortRes.body as { id: string }).id;
    for (const u of [leader, member]) {
      const add = await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set(bearer(admin)).send({ userId: u.id });
      expect(add.status, JSON.stringify(add.body)).toBe(201);
    }
    return { leader, member, cohortId };
  }

  async function mkTeamBank(cohortId: string, leaderId: string, kind: 'matrix' | 'exam'): Promise<BankBody> {
    const res = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: uniqueName(`Ngân hàng ${kind} tổ S3`), scope: 'team', bankKind: kind, scopeRefId: cohortId, leaderId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as BankBody;
  }

  async function bankDetail(token: string, bankId: string): Promise<BankBody> {
    const res = await http(app).get(`/api/v1/question-banks/${bankId}`).set(bearer(token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as BankBody;
  }

  it('registry chỉ còn bộ matrix:*/exam:* theo khuôn — tên neo quiz:* và exam:view đã biến mất ở mọi tầng', async () => {
    await app.get(RolesService).seedDefaults();
    const names = await pg.query<{ name: string }>(
      `select name from capabilities where name like 'matrix:%' or name like 'exam:%' or name in ('quiz:viewmatrix', 'quiz:managematrix') order by name`,
    );
    expect(names.rows.map((r) => r.name)).toEqual([
      'exam:add', 'exam:copy', 'exam:deploy', 'exam:edit', 'exam:moderate', 'exam:share', 'exam:use',
      'matrix:add', 'matrix:copy', 'matrix:edit', 'matrix:moderate', 'matrix:share', 'matrix:use',
    ]);
    const staleOverrides = await pg.query<{ n: string }>(
      `select count(*) as n from role_capabilities where capability in ('quiz:viewmatrix', 'quiz:managematrix', 'exam:view')`,
    );
    expect(Number(staleOverrides.rows[0].n)).toBe(0);
  });

  it('tạo ma trận tại context môn đi qua cổng matrix:add: giáo viên staff tạo được, học sinh bị 403', async () => {
    const systemCtxId = await systemContextId(app, admin);
    const subjRes = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtxId, name: uniqueName('Toán S3'), slug: `toan-s3-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    expect(subjRes.status, JSON.stringify(subjRes.body)).toBe(201);
    const subjectId = (subjRes.body as { id: string }).id;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin)).send({ subjectId, grade: 10 });
    expect(currRes.status, JSON.stringify(currRes.body)).toBe(201);
    const curriculumId = (currRes.body as { id: string }).id;

    const teacher = await mkStaffUser();
    const okRes = await http(app).post('/api/v1/exam-matrices').set(bearer(teacher.token))
      .send({ name: 'Ma trận của giáo viên S3', subjectId, curriculumId, totalScore: 10 });
    expect(okRes.status, JSON.stringify(okRes.body)).toBe(201);

    const plain = await createUserViaApi(app, admin);
    const plainToken = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;
    const denied = await http(app).post('/api/v1/exam-matrices').set(bearer(plainToken))
      .send({ name: 'Ma trận của người không có quyền S3', subjectId, curriculumId, totalScore: 10 });
    expect(denied.status).toBe(403);
    expect((denied.body as { code?: string }).code).toBe('access.capability_denied');
  });

  it('bank ma trận tổ: phụ trách có add + edit, thành viên chỉ có use + copy trên bề mặt capabilities', async () => {
    const team = await mkTeam();
    const bank = await mkTeamBank(team.cohortId, team.leader.id, 'matrix');

    const leadView = await bankDetail(team.leader.token, bank.id);
    expect(leadView.capabilities).toMatchObject({ use: true, add: true, edit: true, copy: true, share: true, moderate: true });

    const memberView = await bankDetail(team.member.token, bank.id);
    expect(memberView.capabilities).toMatchObject({ use: true, add: false, edit: false, copy: true, share: false, moderate: false });
  });

  it('tạo đề trong bank tổ đi qua cổng exam:add: thành viên bị 403, phụ trách tạo được', async () => {
    const team = await mkTeam();
    const bank = await mkTeamBank(team.cohortId, team.leader.id, 'exam');

    const denied = await http(app).post(`/api/v1/exams/banks/${bank.id}/exams`).set(bearer(team.member.token))
      .send({ name: 'Đề thành viên tự tạo S3', examKind: 'regular', slots: [] });
    expect(denied.status).toBe(403);
    expect((denied.body as { code?: string }).code).toBe('access.capability_denied');

    const okRes = await http(app).post(`/api/v1/exams/banks/${bank.id}/exams`).set(bearer(team.leader.token))
      .send({ name: 'Đề của phụ trách S3', examKind: 'regular', slots: [] });
    expect(okRes.status, JSON.stringify(okRes.body)).toBe(201);
    const view = okRes.body as { capabilities: { view: boolean; add: boolean; edit: boolean } };
    expect(view.capabilities).toMatchObject({ view: true, add: true, edit: true });
  });
});
