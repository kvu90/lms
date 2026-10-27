import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';

/**
 * Ngân hàng ma trận MB-1 (issue #111) — phủ 4 tiêu chí nghiệm thu ở
 * tầng API (tiêu chí 5 kiểm chứng trình duyệt đổi vai do đội trình
 * duyệt riêng chạy trên bản live):
 *  1. Tổ trưởng đưa mẫu lên bank tổ; thành viên thấy mẫu, copy về bank
 *     cá nhân (deep copy ô + derived_from), sửa ô trên bản copy và xem
 *     availability đúng theo pool câu gắn YCCĐ.
 *  2. GV ngoài tổ KHÔNG thấy bank tổ — cả ở danh sách bank lẫn API
 *     danh sách ma trận trực tiếp (403), dù có vai giáo viên ở hệ thống.
 *  3. Bất biến version: sửa ô trên mẫu ready → version của MẪU tăng;
 *     bản copy đã lấy trước đó không đổi (nội dung + version).
 *  4. Đóng góp → duyệt vào bank tổ có truy vết (proposer trên hàng
 *     chờ, derived_from trên bản vào bank, bản vào bank tổ là mẫu);
 *     từ chối có lý do hiện lại cho người gửi; người không có quyền
 *     duyệt thì duyệt → 403.
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface BankBody {
  id: string; name: string; scope: string; bankKind: string; ownerId: string | null; scopeRefId: string | null;
  contextId: string;
  capabilities: {
    use: boolean; copy: boolean; share: boolean; moderate: boolean;
    matrixView?: boolean; matrixManage?: boolean; matrixCopy?: boolean; matrixShare?: boolean; matrixModerate?: boolean;
  };
}
interface MatrixBody {
  id: string; name: string; bankId: string | null; status: string; isTemplate: boolean;
  derivedFromMatrixId: string | null; version: number;
  cells: { id: string; curriculumNodeId: string; cognitiveLevel: string; qtype: string; questionCount: number; cellScore: number }[];
}
interface ContributionBody {
  id: string; matrixId: string; matrixName: string | null; targetBankId: string;
  proposerId: string; proposerName: string | null; note: string; status: string;
  rejectReason: string | null; reviewerId: string | null; resultMatrixId: string | null;
}

describe('Matrix bank MB-1 (issue #111)', () => {
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

  async function mkUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  /** Giáo viên: vai teacher tại context hệ thống (nhóm archetype staff — được cấp bank cá nhân). */
  async function mkStaffUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await mkUser();
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    return u;
  }

  /** Môn Toán → chương trình lớp 9 → chủ đề → bài → 2 YCCĐ (Biết/Hiểu). */
  async function setupCurriculum(): Promise<{ subjectId: string; curriculumId: string; lessonId: string; outcomeBiet: string; outcomeHieu: string }> {
    const systemCtxId = await systemContextId(app, admin);
    const subjRes = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtxId, name: uniqueName('Toán MB1'), slug: `toan-mb1-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    expect(subjRes.status, JSON.stringify(subjRes.body)).toBe(201);
    const subjectId = (subjRes.body as { id: string }).id;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin)).send({ subjectId, grade: 9 });
    expect(currRes.status, JSON.stringify(currRes.body)).toBe(201);
    const curriculumId = (currRes.body as { id: string }).id;
    const topicRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, title: 'Số học', kind: 'topic' });
    expect(topicRes.status, JSON.stringify(topicRes.body)).toBe(201);
    const lessonRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, parentId: (topicRes.body as { id: string }).id, title: 'Căn bậc hai', kind: 'lesson' });
    expect(lessonRes.status, JSON.stringify(lessonRes.body)).toBe(201);
    const lessonId = (lessonRes.body as { id: string }).id;
    const mkOutcome = async (content: string) => {
      const r = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin)).send({ nodeId: lessonId, content });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return (r.body as { id: string }).id;
    };
    return {
      subjectId, curriculumId, lessonId,
      outcomeBiet: await mkOutcome('Nhận biết được khái niệm căn bậc hai.'),
      outcomeHieu: await mkOutcome('Hiểu và vận dụng được tính chất căn bậc hai.'),
    };
  }

  /** Một tổ (cohort) với tổ trưởng + thành viên + bank ma trận của tổ; kèm một GV ngoài tổ. */
  async function mkTeam() {
    const leader = await mkStaffUser();
    const member = await mkStaffUser();
    const outsider = await mkStaffUser();
    const cohortRes = await http(app).post('/api/v1/cohorts').set(bearer(admin)).send({ name: uniqueName('Tổ Toán MB1') });
    expect(cohortRes.status, JSON.stringify(cohortRes.body)).toBe(201);
    const cohortId = (cohortRes.body as { id: string }).id;
    for (const u of [leader, member]) {
      const add = await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set(bearer(admin)).send({ userId: u.id });
      expect(add.status, JSON.stringify(add.body)).toBe(201);
    }
    const bankRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: uniqueName('Ngân hàng ma trận tổ Toán'), scope: 'team', bankKind: 'matrix', scopeRefId: cohortId, leaderId: leader.id });
    expect(bankRes.status, JSON.stringify(bankRes.body)).toBe(201);
    const teamBank = bankRes.body as BankBody;
    expect(teamBank.bankKind).toBe('matrix');
    return { leader, member, outsider, cohortId, teamBank };
  }

  async function personalMatrixBank(token: string): Promise<BankBody> {
    const res = await http(app).get('/api/v1/question-banks?kind=matrix').set(bearer(token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bank = (res.body as BankBody[]).find((b) => b.scope === 'personal');
    expect(bank).toBeTruthy();
    return bank!;
  }

  async function createMatrix(token: string, body: Record<string, unknown>): Promise<MatrixBody> {
    const res = await http(app).post('/api/v1/exam-matrices').set(bearer(token)).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as MatrixBody;
  }

  async function addCell(token: string, matrixId: string, body: Record<string, unknown>): Promise<MatrixBody> {
    const res = await http(app).post(`/api/v1/exam-matrices/${matrixId}/cells`).set(bearer(token)).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as MatrixBody;
  }

  /** Mẫu Toán 9 của tổ: draft → 2 ô → chốt ready (vẫn version 1). */
  async function mkTeamTemplate(team: Awaited<ReturnType<typeof mkTeam>>, cur: Awaited<ReturnType<typeof setupCurriculum>>): Promise<MatrixBody> {
    const tpl = await createMatrix(team.leader.token, {
      name: 'Mẫu giữa kỳ Toán 9', subjectId: cur.subjectId, curriculumId: cur.curriculumId,
      bankId: team.teamBank.id, isTemplate: true, status: 'draft',
    });
    await addCell(team.leader.token, tpl.id, {
      curriculumNodeId: cur.lessonId, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 2, cellScore: 2,
    });
    const withCells = await addCell(team.leader.token, tpl.id, {
      curriculumNodeId: cur.lessonId, cognitiveLevel: 'hieu', qtype: 'multichoice', questionCount: 1, cellScore: 1,
    });
    expect(withCells.cells).toHaveLength(2);
    const readyRes = await http(app).patch(`/api/v1/exam-matrices/${tpl.id}`).set(bearer(team.leader.token)).send({ status: 'ready' });
    expect(readyRes.status, JSON.stringify(readyRes.body)).toBe(200);
    const ready = readyRes.body as MatrixBody;
    expect(ready.status).toBe('ready');
    expect(ready.version).toBe(1);
    return ready;
  }

  it('TC1: thành viên thấy mẫu trong bank tổ, copy về bank cá nhân (deep copy + derived_from), sửa ô và availability đúng', async () => {
    const cur = await setupCurriculum();
    const team = await mkTeam();
    const tpl = await mkTeamTemplate(team, cur);

    // Pool câu cho availability: 3 câu Biết + 1 câu Hiểu, category ở context hệ thống (admin tạo).
    const systemCtxId = await systemContextId(app, admin);
    const catRes = await http(app).post('/api/v1/questions/categories').set(bearer(admin))
      .send({ name: uniqueName('Pool MB1'), contextId: systemCtxId });
    expect(catRes.status, JSON.stringify(catRes.body)).toBe(201);
    const catId = (catRes.body as { id: string }).id;
    const mkQ = async (name: string, outcomeId: string, level: string) => {
      const r = await http(app).post('/api/v1/questions').set(bearer(admin)).send({
        categoryId: catId, qtype: 'multichoice', questionText: `${name}?`,
        answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const qid = (r.body as { question: { id: string } }).question.id;
      const tag = await http(app).post(`/api/v1/questions/${qid}/outcomes`).set(bearer(admin)).send({ outcomeId, cognitiveLevel: level });
      expect(tag.status, JSON.stringify(tag.body)).toBe(201);
    };
    await mkQ('MB1-B1', cur.outcomeBiet, 'biet');
    await mkQ('MB1-B2', cur.outcomeBiet, 'biet');
    await mkQ('MB1-B3', cur.outcomeBiet, 'biet');
    await mkQ('MB1-H1', cur.outcomeHieu, 'hieu');

    // Thành viên thấy mẫu trong bank tổ.
    const listRes = await http(app).get(`/api/v1/question-banks/${team.teamBank.id}/matrices`).set(bearer(team.member.token));
    expect(listRes.status, JSON.stringify(listRes.body)).toBe(200);
    const listed = (listRes.body as MatrixBody[]).find((m) => m.id === tpl.id);
    expect(listed).toBeTruthy();
    expect(listed!.isTemplate).toBe(true);

    // Copy về bank cá nhân (đích mặc định): danh tính mới, derived_from = mẫu, draft, không phải mẫu, đủ 2 ô.
    const copyRes = await http(app).post(`/api/v1/exam-matrices/${tpl.id}/copy`).set(bearer(team.member.token)).send({});
    expect(copyRes.status, JSON.stringify(copyRes.body)).toBe(201);
    const copy = copyRes.body as MatrixBody;
    const myBank = await personalMatrixBank(team.member.token);
    expect(copy.id).not.toBe(tpl.id);
    expect(copy.bankId).toBe(myBank.id);
    expect(copy.derivedFromMatrixId).toBe(tpl.id);
    expect(copy.status).toBe('draft');
    expect(copy.isTemplate).toBe(false);
    expect(copy.version).toBe(1);
    expect(copy.cells).toHaveLength(2);

    // Sửa ô trên bản copy: ô Biết 2 → 3 câu.
    const bietCell = copy.cells.find((c) => c.cognitiveLevel === 'biet')!;
    const patchRes = await http(app).patch(`/api/v1/exam-matrices/${copy.id}/cells/${bietCell.id}`)
      .set(bearer(team.member.token)).send({ questionCount: 3 });
    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);

    // Availability của bản copy cho thành viên: Biết cần 3 có 3; Hiểu cần 1 có 1 → đủ.
    const avRes = await http(app).get(`/api/v1/exam-matrices/${copy.id}/availability`).set(bearer(team.member.token));
    expect(avRes.status, JSON.stringify(avRes.body)).toBe(200);
    const av = avRes.body as { sufficient: boolean; cells: { cellId: string; required: number; available: number; deficit: number }[] };
    expect(av.sufficient).toBe(true);
    const avBiet = av.cells.find((c) => c.cellId === bietCell.id)!;
    expect(avBiet.required).toBe(3);
    expect(avBiet.available).toBe(3);
    expect(avBiet.deficit).toBe(0);
  });

  it('TC2: GV ngoài tổ không thấy bank tổ — danh sách bank, danh sách ma trận trực tiếp, copy, đọc ma trận đều bị chặn', async () => {
    const cur = await setupCurriculum();
    const team = await mkTeam();
    const tpl = await mkTeamTemplate(team, cur);

    // Danh sách bank ma trận của người ngoài không có bank tổ.
    const banksRes = await http(app).get('/api/v1/question-banks?kind=matrix').set(bearer(team.outsider.token));
    expect(banksRes.status).toBe(200);
    expect((banksRes.body as BankBody[]).some((b) => b.id === team.teamBank.id)).toBe(false);

    // API danh sách ma trận của bank tổ trực tiếp → 403.
    const listRes = await http(app).get(`/api/v1/question-banks/${team.teamBank.id}/matrices`).set(bearer(team.outsider.token));
    expect(listRes.status).toBe(403);

    // Chi tiết bank trực tiếp → 403.
    const bankRes = await http(app).get(`/api/v1/question-banks/${team.teamBank.id}`).set(bearer(team.outsider.token));
    expect(bankRes.status).toBe(403);

    // Đọc thẳng ma trận mẫu → 403; copy mẫu → 403.
    const getRes = await http(app).get(`/api/v1/exam-matrices/${tpl.id}`).set(bearer(team.outsider.token));
    expect(getRes.status).toBe(403);
    const copyRes = await http(app).post(`/api/v1/exam-matrices/${tpl.id}/copy`).set(bearer(team.outsider.token)).send({});
    expect(copyRes.status).toBe(403);

    // Thành viên tổ vẫn thấy bình thường (đối chứng cổng không chặn nhầm).
    const memberList = await http(app).get(`/api/v1/question-banks/${team.teamBank.id}/matrices`).set(bearer(team.member.token));
    expect(memberList.status).toBe(200);
    // Khả năng theo bank-local trên view bank: thành viên copy được, không duyệt được; tổ trưởng duyệt được.
    const memberBanks = await http(app).get('/api/v1/question-banks?kind=matrix').set(bearer(team.member.token));
    const memberTeamBank = (memberBanks.body as BankBody[]).find((b) => b.id === team.teamBank.id)!;
    expect(memberTeamBank.capabilities.matrixCopy).toBe(true);
    expect(memberTeamBank.capabilities.matrixModerate).toBe(false);
    const leaderBanks = await http(app).get('/api/v1/question-banks?kind=matrix').set(bearer(team.leader.token));
    const leaderTeamBank = (leaderBanks.body as BankBody[]).find((b) => b.id === team.teamBank.id)!;
    expect(leaderTeamBank.capabilities.matrixModerate).toBe(true);
    expect(leaderTeamBank.capabilities.matrixManage).toBe(true);
  });

  it('TC3: sửa ô trên mẫu ready làm tăng version của mẫu; bản copy đã lấy trước đó giữ nguyên', async () => {
    const cur = await setupCurriculum();
    const team = await mkTeam();
    const tpl = await mkTeamTemplate(team, cur);

    // Thành viên copy mẫu (version 1, ô Biết 2 câu).
    const copyRes = await http(app).post(`/api/v1/exam-matrices/${tpl.id}/copy`).set(bearer(team.member.token)).send({});
    expect(copyRes.status, JSON.stringify(copyRes.body)).toBe(201);
    const copy = copyRes.body as MatrixBody;
    expect(copy.version).toBe(1);

    // Tổ trưởng sửa ô Biết của MẪU (đang ready): 2 → 5 câu → version mẫu tăng lên 2.
    const tplCell = tpl.cells.find((c) => c.cognitiveLevel === 'biet')!;
    const patchRes = await http(app).patch(`/api/v1/exam-matrices/${tpl.id}/cells/${tplCell.id}`)
      .set(bearer(team.leader.token)).send({ questionCount: 5 });
    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
    const tplAfter = patchRes.body as MatrixBody;
    expect(tplAfter.version).toBe(2);
    expect(tplAfter.cells.find((c) => c.cognitiveLevel === 'biet')!.questionCount).toBe(5);

    // Bản copy của thành viên không đổi: vẫn version 1, ô Biết vẫn 2 câu.
    const copyAfterRes = await http(app).get(`/api/v1/exam-matrices/${copy.id}`).set(bearer(team.member.token));
    expect(copyAfterRes.status, JSON.stringify(copyAfterRes.body)).toBe(200);
    const copyAfter = copyAfterRes.body as MatrixBody;
    expect(copyAfter.version).toBe(1);
    expect(copyAfter.cells.find((c) => c.cognitiveLevel === 'biet')!.questionCount).toBe(2);
  });

  it('TC4: đóng góp → từ chối có lý do → gửi lại → duyệt vào bank tổ thành mẫu, truy vết đủ; người không có quyền duyệt bị chặn', async () => {
    const cur = await setupCurriculum();
    const team = await mkTeam();
    await mkTeamTemplate(team, cur);

    // Thành viên tạo ma trận ready trong bank cá nhân của mình.
    const myBank = await personalMatrixBank(team.member.token);
    const own = await createMatrix(team.member.token, {
      name: 'Ma trận ôn tập của thành viên', subjectId: cur.subjectId, curriculumId: cur.curriculumId,
      bankId: myBank.id, status: 'ready',
    });
    await addCell(team.member.token, own.id, {
      curriculumNodeId: cur.lessonId, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 4, cellScore: 4,
    });

    // Đề xuất đóng góp vào bank tổ.
    const proposeRes = await http(app).post(`/api/v1/exam-matrices/${own.id}/contributions`)
      .set(bearer(team.member.token)).send({ targetBankId: team.teamBank.id, note: 'Ma trận ôn tập dùng chung cho tổ' });
    expect(proposeRes.status, JSON.stringify(proposeRes.body)).toBe(201);
    const proposal = proposeRes.body as ContributionBody;
    expect(proposal.status).toBe('pending');
    expect(proposal.proposerId).toBe(team.member.id);
    expect(proposal.proposerName).toBeTruthy();

    // Gửi trùng khi đang chờ → 409.
    const dupRes = await http(app).post(`/api/v1/exam-matrices/${own.id}/contributions`)
      .set(bearer(team.member.token)).send({ targetBankId: team.teamBank.id });
    expect(dupRes.status).toBe(409);

    // Thành viên (không có quyền duyệt) tự duyệt → 403.
    const selfApprove = await http(app).post(`/api/v1/question-banks/${team.teamBank.id}/matrix-contributions/${proposal.id}/approve`)
      .set(bearer(team.member.token)).send({});
    expect(selfApprove.status).toBe(403);

    // Tổ trưởng thấy hàng chờ và từ chối kèm lý do.
    const queueRes = await http(app).get(`/api/v1/question-banks/${team.teamBank.id}/matrix-contributions?status=pending`)
      .set(bearer(team.leader.token));
    expect(queueRes.status, JSON.stringify(queueRes.body)).toBe(200);
    expect((queueRes.body as ContributionBody[]).some((c) => c.id === proposal.id)).toBe(true);
    const rejectRes = await http(app).post(`/api/v1/question-banks/${team.teamBank.id}/matrix-contributions/${proposal.id}/reject`)
      .set(bearer(team.leader.token)).send({ reason: 'Thiếu ô mức Vận dụng, bổ sung rồi gửi lại' });
    expect(rejectRes.status, JSON.stringify(rejectRes.body)).toBe(201);
    expect((rejectRes.body as ContributionBody).status).toBe('rejected');

    // Lý do từ chối hiện lại cho người gửi ở danh sách đóng góp của mình.
    const mineRes = await http(app).get('/api/v1/question-banks/matrix-contributions/mine').set(bearer(team.member.token));
    expect(mineRes.status, JSON.stringify(mineRes.body)).toBe(200);
    const mine = (mineRes.body as ContributionBody[]).find((c) => c.id === proposal.id)!;
    expect(mine.status).toBe('rejected');
    expect(mine.rejectReason).toBe('Thiếu ô mức Vận dụng, bổ sung rồi gửi lại');
    expect(mine.reviewerId).toBe(team.leader.id);

    // Gửi lại (đề xuất mới) → tổ trưởng duyệt → ma trận vào bank tổ.
    const propose2Res = await http(app).post(`/api/v1/exam-matrices/${own.id}/contributions`)
      .set(bearer(team.member.token)).send({ targetBankId: team.teamBank.id, note: 'Đã bổ sung theo góp ý' });
    expect(propose2Res.status, JSON.stringify(propose2Res.body)).toBe(201);
    const proposal2 = propose2Res.body as ContributionBody;
    const approveRes = await http(app).post(`/api/v1/question-banks/${team.teamBank.id}/matrix-contributions/${proposal2.id}/approve`)
      .set(bearer(team.leader.token)).send({});
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(201);
    const approved = approveRes.body as ContributionBody;
    expect(approved.status).toBe('approved');
    expect(approved.resultMatrixId).toBeTruthy();

    // Bản vào bank tổ: thuộc bank tổ, là MẪU, ready, derived_from trỏ về ma trận của thành viên, ô được copy đủ.
    const inBankRes = await http(app).get(`/api/v1/question-banks/${team.teamBank.id}/matrices`).set(bearer(team.leader.token));
    expect(inBankRes.status).toBe(200);
    const landed = (inBankRes.body as MatrixBody[]).find((m) => m.id === approved.resultMatrixId)!;
    expect(landed).toBeTruthy();
    expect(landed.bankId).toBe(team.teamBank.id);
    expect(landed.isTemplate).toBe(true);
    expect(landed.status).toBe('ready');
    expect(landed.derivedFromMatrixId).toBe(own.id);
    expect(landed.cells).toHaveLength(1);
    expect(landed.cells[0]!.questionCount).toBe(4);
  });
});
