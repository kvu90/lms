import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';
import { createCategory, createCourse, getFirstSectionId } from './course-enrolment-helpers';

/**
 * EB-3 (issue #165) — duyệt BỘ HỒ SƠ đề + đặc tả theo đề + bảo mật
 * đề định kỳ, đối chiếu hồ sơ ngân hàng đề (F.2, G.1, E-6, A.3.4):
 *  - đóng góp bộ hồ sơ (đề giữa kỳ sinh từ ma trận) vào bank tổ →
 *    tổ trưởng mở bản đặc tả ĐÃ CHỤP ngay trong hàng chờ → duyệt →
 *    đề hiện ở bank tổ ở trạng thái ready, đủ truy vết (người đóng
 *    góp, phiên bản ghim, người duyệt, vết duyệt);
 *  - từ chối không lý do → 400; có lý do → người đóng góp thấy lý do;
 *  - bật cấp duyệt 2 (BGH): duyệt cấp 1 chỉ sang pending_board, đề
 *    chưa vào bank; tổ trưởng không qua được cổng cấp 2; BGH duyệt
 *    mới hiệu lực; tắt cấp 2 → một cấp đủ;
 *  - đặc tả sinh từ examId khớp cấu trúc ma trận (pinId chỉ là
 *    tham số phụ), xuất xlsx/docx mở được;
 *  - đề định kỳ ready ở bank trường: GV khác khối bị chặn 403 ở mọi
 *    bề mặt nội dung, GV dạy đúng khối xem được, mọi lần xem thành
 *    công thuộc diện đều có audit trong outbox.
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface User { id: string; username: string; token: string }
interface BankBody { id: string; scope: string; bankKind: string; ownerId: string | null }
interface PaperBody {
  paper: { id: string; bankId: string; status: string; derivedFromExamId: string | null; createdBy: string };
  version: { id: string; version: number; matrixId: string | null; matrixVersion: number | null };
  slots: { position: number; questionId: string; matrixCellId: string | null }[];
}
interface DossierReview { level: number; reviewerId: string; decision: string; reason: string | null }
interface DossierBody {
  id: string; examId: string; targetBankId: string; proposerId: string; status: string;
  examVersionId: string | null; examVersionNumber: number | null;
  matrixId: string | null; matrixVersion: number | null;
  boardApprovalRequired: boolean; resultExamId: string | null;
  reviews: DossierReview[];
}
interface SpecCell { cognitiveLevel: string; questionCount: number; slotNumbers: number[] | null }
interface SpecBody {
  matrix: { id: string; name: string };
  topics: { nodes: { outcomes: { cells: SpecCell[] }[] }[] }[];
  totals: { totalQuestions: number; totalScore: number };
  quiz: { id: string; name: string } | null;
  paper?: { id: string; version: number };
}

/** Bung các ô ma trận của một bản đặc tả thành danh sách phẳng (theo đúng view model MatrixSpecification). */
function cellsOf(spec: SpecBody): SpecCell[] {
  const cells: SpecCell[] = [];
  for (const topic of spec.topics) {
    for (const node of topic.nodes) {
      for (const outcome of node.outcomes) cells.push(...outcome.cells);
    }
  }
  return cells;
}

describe('EB-3 dossier approval + paper specification + periodic paper security', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

  let leader: User;
  let member: User;
  let member2: User;
  let teamBank: BankBody;
  let schoolBank: BankBody;
  let matrixId: string;
  let matrixVersion: number;
  let schoolCopyId: string;
  let systemQuestionId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    // Bảo đảm công tắc cấp 2 ở mặc định TẮT khi bắt đầu (site-config là toàn cục).
    await http(app).delete('/api/v1/site-config/exam/requireboardapproval').set(bearer(admin));

    const mkUser = async (): Promise<User> => {
      const u = await createUserViaApi(app, admin);
      const session = await login(app, u.username, STRONG_PASSWORD);
      return { id: u.id, username: u.username, token: session.accessToken };
    };
    const mkStaffUser = async (): Promise<User> => {
      const u = await mkUser();
      await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
      return u;
    };
    leader = await mkStaffUser();
    member = await mkStaffUser();
    member2 = await mkStaffUser();

    // --- ma trận + kho câu (khuôn EB-2) -------------------------------------
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const subjRes = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtx.id, name: 'Toán học', slug: `toan-eb3-${Date.now()}` });
    const subjectId = subjRes.body.id as string;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin)).send({ subjectId, grade: 10 });
    const curriculumId = currRes.body.id as string;
    const topicRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, title: 'Hàm số', kind: 'topic' });
    const lessonRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, parentId: topicRes.body.id, title: 'Hàm số bậc hai', kind: 'lesson' });
    const mkOutcome = async (content: string) => {
      const r = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin)).send({ nodeId: lessonRes.body.id, content });
      return r.body.id as string;
    };
    const outcomeBiet = await mkOutcome('Nhận biết được tính đồng biến của hàm số bậc hai.');
    const outcomeHieu = await mkOutcome('Giải thích được mối liên hệ giữa đồ thị và hệ số a.');

    const bankRes = await http(app).post('/api/v1/questions/categories').set(bearer(admin))
      .send({ name: 'EB3 bank', contextId: systemCtx.id });
    const bankCatId = bankRes.body.id as string;
    const mkQuestion = async (name: string): Promise<string> => {
      const r = await http(app).post('/api/v1/questions').set(bearer(admin)).send({
        categoryId: bankCatId, qtype: 'multichoice', name, questionText: `${name}: chọn đáp án đúng.`, defaultMark: 1,
        answers: [{ text: 'Đúng', fraction: 1 }, { text: 'Sai', fraction: 0 }], options: { single: true },
      });
      if (r.status !== 201 && r.status !== 200) throw new Error(`question failed: ${r.status} ${JSON.stringify(r.body)}`);
      return (r.body as { question: { id: string } }).question.id;
    };
    const tag = async (questionId: string, outcomeId: string, level: string) => {
      const r = await http(app).post(`/api/v1/questions/${questionId}/outcomes`).set(bearer(admin)).send({ outcomeId, cognitiveLevel: level });
      if (r.status !== 201 && r.status !== 200) throw new Error(`tag failed: ${r.status} ${JSON.stringify(r.body)}`);
    };
    const poolA: string[] = [];
    for (let i = 1; i <= 6; i++) { const q = await mkQuestion(`EB3 A${i}`); await tag(q, outcomeBiet, 'biet'); poolA.push(q); }
    const poolB: string[] = [];
    for (let i = 1; i <= 2; i++) { const q = await mkQuestion(`EB3 B${i}`); await tag(q, outcomeHieu, 'hieu'); poolB.push(q); }
    systemQuestionId = poolA[0]!;

    const matrixRes = await http(app).post('/api/v1/exam-matrices').set(bearer(admin))
      .send({ name: 'Ma trận giữa kỳ EB-3', subjectId, curriculumId, totalScore: 4 });
    const matrix = matrixRes.body as { id: string; version: number };
    matrixId = matrix.id;
    matrixVersion = matrix.version;
    const cellA = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/cells`).set(bearer(admin))
      .send({ learningOutcomeId: outcomeBiet, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 3, cellScore: 3, minutes: 10 });
    if (cellA.status !== 201 && cellA.status !== 200) throw new Error(`cellA failed: ${cellA.status}`);
    const cellB = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/cells`).set(bearer(admin))
      .send({ learningOutcomeId: outcomeHieu, cognitiveLevel: 'hieu', qtype: 'multichoice', questionCount: 1, cellScore: 1, minutes: 5 });
    if (cellB.status !== 201 && cellB.status !== 200) throw new Error(`cellB failed: ${cellB.status}`);

    // Generate (admin) → đề ready gắn ma trận trong bank cá nhân admin.
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id, { grade: 10 });
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set(bearer(admin))
      .send({ courseId: course.id, sectionId, name: 'Đề giữa kỳ mẫu' });
    if (gen.status !== 201 && gen.status !== 200) throw new Error(`generate failed: ${gen.status} ${JSON.stringify(gen.body)}`);
    const generatedPaperId = (gen.body as { examId: string }).examId;

    // Bank đề trường + bản copy của đề mẫu vào bank trường (ready).
    const schoolRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: uniqueName('Ngân hàng đề trường EB3'), scope: 'school', bankKind: 'exam' });
    schoolBank = schoolRes.body as BankBody;
    const copyToSchool = await http(app).post(`/api/v1/exams/${generatedPaperId}/copy`).set(bearer(admin))
      .send({ targetBankId: schoolBank.id });
    if (copyToSchool.status !== 201 && copyToSchool.status !== 200) throw new Error(`copy to school failed: ${copyToSchool.status} ${JSON.stringify(copyToSchool.body)}`);
    schoolCopyId = (copyToSchool.body as PaperBody).paper.id;
    const readyRes = await http(app).post(`/api/v1/exams/${schoolCopyId}/status`).set(bearer(admin)).send({ status: 'ready' });
    if (readyRes.status !== 201 && readyRes.status !== 200) throw new Error(`school copy ready failed: ${readyRes.status}`);

    // Bank đề tổ: cohort (leader + 2 thành viên) + bank team với leader là tổ trưởng.
    const cohortRes = await http(app).post('/api/v1/cohorts').set(bearer(admin)).send({ name: uniqueName('Tổ Toán EB3') });
    const cohortId = (cohortRes.body as { id: string }).id;
    for (const u of [leader, member, member2]) {
      const add = await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set(bearer(admin)).send({ userId: u.id });
      if (add.status !== 201 && add.status !== 200) throw new Error(`cohort add failed: ${add.status}`);
    }
    const teamRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: uniqueName('Ngân hàng đề tổ Toán EB3'), scope: 'team', bankKind: 'exam', scopeRefId: cohortId, leaderId: leader.id });
    if (teamRes.status !== 201 && teamRes.status !== 200) throw new Error(`team bank failed: ${teamRes.status} ${JSON.stringify(teamRes.body)}`);
    teamBank = teamRes.body as BankBody;
  }, 240_000);

  afterAll(async () => {
    await http(app).delete('/api/v1/site-config/exam/requireboardapproval').set(bearer(admin));
    await pg.end();
    await app.close();
  });

  /** Bản copy cá nhân (ready, giữ matrixId + matrixCellId) của đề mẫu — "đề của tôi" để lập bộ hồ sơ. */
  async function mkMemberPaper(): Promise<PaperBody> {
    const copy = await http(app).post(`/api/v1/exams/${schoolCopyId}/copy`).set(bearer(member.token)).send({});
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    const paper = copy.body as PaperBody;
    expect(paper.version.matrixId).toBe(matrixId);
    const ready = await http(app).post(`/api/v1/exams/${paper.paper.id}/status`).set(bearer(member.token)).send({ status: 'ready' });
    expect(ready.status, JSON.stringify(ready.body)).toBe(201);
    return ready.body as PaperBody;
  }

  async function createDossier(token: string, examId: string, targetBankId: string) {
    return http(app).post(`/api/v1/exams/${examId}/dossiers`).set(bearer(token)).send({ targetBankId, note: 'Bộ hồ sơ giữa kỳ tổ Toán' });
  }

  async function outboxCount(type: string, key: string, value: string): Promise<number> {
    const res = await pg.query('select count(*)::int as n from outbox_events where type = $1 and payload->>$2 = $3', [type, key, value]);
    return (res.rows[0] as { n: number }).n;
  }

  it('TC1: bộ hồ sơ vào bank tổ — tổ trưởng mở đặc tả trong hàng chờ, duyệt đạt, đề hiện ở bank tổ đủ truy vết', async () => {
    const paper = await mkMemberPaper();
    const created = await createDossier(member.token, paper.paper.id, teamBank.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const dossier = created.body as DossierBody;
    expect(dossier.status).toBe('draft');
    expect(dossier.examVersionId).toBeNull();
    expect(dossier.boardApprovalRequired).toBe(false);

    const submitted = await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/submit`).set(bearer(member.token)).send({});
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const pending = submitted.body as DossierBody;
    expect(pending.status).toBe('pending');
    // Ghim đúng phiên bản đề + phiên bản ma trận tại lúc nộp.
    expect(pending.examVersionId).toBe(paper.version.id);
    expect(pending.examVersionNumber).toBe(paper.version.version);
    expect(pending.matrixId).toBe(matrixId);
    expect(pending.matrixVersion).toBe(matrixVersion);
    expect(await outboxCount('exam_dossier_submitted', 'dossierId', dossier.id)).toBeGreaterThanOrEqual(1);

    // Hàng chờ: tổ trưởng thấy bộ; thành viên khác của tổ chỉ thấy bộ của mình (rỗng ở đây).
    const queue = await http(app).get(`/api/v1/exams/banks/${teamBank.id}/dossiers`).set(bearer(leader.token));
    expect(queue.status).toBe(200);
    expect((queue.body as DossierBody[]).map((d) => d.id)).toContain(dossier.id);
    const queueOther = await http(app).get(`/api/v1/exams/banks/${teamBank.id}/dossiers`).set(bearer(member2.token));
    expect((queueOther.body as DossierBody[]).map((d) => d.id)).not.toContain(dossier.id);
    const directOther = await http(app).get(`/api/v1/exams/dossiers/${dossier.id}`).set(bearer(member2.token));
    expect(directOther.status).toBe(404);

    // Tổ trưởng mở bản đặc tả ĐÃ CHỤP ngay trong hàng chờ: đúng cấu trúc ma trận + vị trí câu của đề.
    const spec = await http(app).get(`/api/v1/exams/dossiers/${dossier.id}/specification`).set(bearer(leader.token));
    expect(spec.status, JSON.stringify(spec.body)).toBe(200);
    const specBody = spec.body as SpecBody;
    expect(specBody.matrix.id).toBe(matrixId);
    expect(specBody.totals.totalQuestions).toBe(4);
    const snapshotCells = cellsOf(specBody);
    expect(snapshotCells.find((c) => c.cognitiveLevel === 'biet')?.slotNumbers).toEqual([1, 2, 3]);
    expect(snapshotCells.find((c) => c.cognitiveLevel === 'hieu')?.slotNumbers).toEqual([4]);
    // Lần mở đặc tả của người duyệt có audit.
    expect(await outboxCount('exam_dossier_spec_viewed', 'dossierId', dossier.id)).toBeGreaterThanOrEqual(1);
    // Xuất bản đặc tả của bộ hồ sơ ra xlsx mở được (file zip PK).
    const exported = await http(app).get(`/api/v1/exams/dossiers/${dossier.id}/specification/export`)
      .query({ format: 'xlsx' }).set(bearer(leader.token))
      .buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(exported.status).toBe(200);
    expect((exported.body as Buffer).subarray(0, 2).toString()).toBe('PK');

    // Thành viên thường không duyệt được.
    const memberApprove = await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/approve`).set(bearer(member2.token)).send({});
    expect(memberApprove.status).toBe(403);

    // Tổ trưởng duyệt → đề hiện ở bank tổ ở trạng thái ready, truy vết đủ.
    const approved = await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/approve`).set(bearer(leader.token)).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const done = approved.body as DossierBody;
    expect(done.status).toBe('approved');
    expect(done.resultExamId).toBeTruthy();
    expect(done.reviews).toHaveLength(1);
    expect(done.reviews[0]).toMatchObject({ level: 1, reviewerId: leader.id, decision: 'approved' });
    const inBank = await http(app).get(`/api/v1/exams/banks/${teamBank.id}/exams`).set(bearer(leader.token));
    const landed = (inBank.body as { id: string; status: string; derivedFromExamId: string | null }[])
      .find((p) => p.id === done.resultExamId);
    expect(landed).toBeTruthy();
    expect(landed!.status).toBe('ready');
    expect(landed!.derivedFromExamId).toBe(paper.paper.id);
    expect(await outboxCount('exam_dossier_approved', 'dossierId', dossier.id)).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('TC2: từ chối bắt buộc lý do — không lý do 400, có lý do thì người đóng góp thấy được', async () => {
    const paper = await mkMemberPaper();
    const created = await createDossier(member.token, paper.paper.id, teamBank.id);
    const dossier = created.body as DossierBody;
    await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/submit`).set(bearer(member.token)).send({});

    const noReason = await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/reject`).set(bearer(leader.token)).send({});
    expect(noReason.status).toBe(400);
    const emptyReason = await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/reject`).set(bearer(leader.token)).send({ reason: '  ' });
    expect(emptyReason.status).toBe(400);

    const rejected = await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/reject`).set(bearer(leader.token))
      .send({ reason: 'Ô nhận biết thừa 1 câu so với ma trận đã thống nhất' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(201);
    const body = rejected.body as DossierBody;
    expect(body.status).toBe('rejected');
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0]).toMatchObject({ level: 1, reviewerId: leader.id, decision: 'rejected' });

    // Người đóng góp thấy lý do trong danh sách bộ hồ sơ của mình.
    const mine = await http(app).get('/api/v1/exams/dossiers/mine').set(bearer(member.token));
    const mineDossier = (mine.body as DossierBody[]).find((d) => d.id === dossier.id);
    expect(mineDossier?.status).toBe('rejected');
    expect(mineDossier?.reviews[0]?.reason).toContain('thừa 1 câu');
    expect(await outboxCount('exam_dossier_rejected', 'dossierId', dossier.id)).toBeGreaterThanOrEqual(1);

    // Bộ đã đóng không duyệt tiếp được.
    const again = await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/approve`).set(bearer(leader.token)).send({});
    expect(again.status).toBe(409);
  }, 120_000);

  it('TC3: bật cấp duyệt 2 (BGH) — cấp 1 chỉ là mốc trung gian, BGH duyệt mới hiệu lực; từ chối cấp 2 có lý do', async () => {
    const on = await http(app).put('/api/v1/site-config/exam/requireboardapproval').set(bearer(admin)).send({ value: true });
    expect([200, 201]).toContain(on.status);
    try {
      const paper = await mkMemberPaper();
      const created = await createDossier(member.token, paper.paper.id, teamBank.id);
      const dossier = created.body as DossierBody;
      expect(dossier.boardApprovalRequired).toBe(true);
      await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/submit`).set(bearer(member.token)).send({});

      const level1 = await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/approve`).set(bearer(leader.token)).send({});
      expect(level1.status, JSON.stringify(level1.body)).toBe(201);
      const pendingBoard = level1.body as DossierBody;
      expect(pendingBoard.status).toBe('pending_board');
      expect(pendingBoard.resultExamId).toBeNull();
      expect(pendingBoard.reviews).toHaveLength(1);
      // Chưa hiệu lực: đề chưa vào bank tổ.
      const inBankBefore = await http(app).get(`/api/v1/exams/banks/${teamBank.id}/exams`).set(bearer(leader.token));
      expect((inBankBefore.body as { derivedFromExamId: string | null }[]).some((p) => p.derivedFromExamId === paper.paper.id)).toBe(false);

      // Tổ trưởng không qua được cổng cấp 2 (không có exam:moderate tại context hệ thống).
      const leaderBoard = await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/board-approve`).set(bearer(leader.token)).send({});
      expect(leaderBoard.status).toBe(403);
      expect((leaderBoard.body as { code?: string }).code).toBe('exam.dossier_board_forbidden');

      // BGH (site admin) duyệt cấp 2 → hiệu lực, đủ hai dòng vết độc lập.
      const board = await http(app).post(`/api/v1/exams/dossiers/${dossier.id}/board-approve`).set(bearer(admin)).send({});
      expect(board.status, JSON.stringify(board.body)).toBe(201);
      const done = board.body as DossierBody;
      expect(done.status).toBe('approved');
      expect(done.resultExamId).toBeTruthy();
      expect(done.reviews.map((r) => [r.level, r.decision])).toEqual([[1, 'approved'], [2, 'approved']]);
      const inBankAfter = await http(app).get(`/api/v1/exams/banks/${teamBank.id}/exams`).set(bearer(leader.token));
      expect((inBankAfter.body as { id: string }[]).map((p) => p.id)).toContain(done.resultExamId);

      // Từ chối ở cấp 2: vẫn bắt buộc lý do, vết cấp 1 giữ nguyên.
      const paper2 = await mkMemberPaper();
      const created2 = await createDossier(member.token, paper2.paper.id, teamBank.id);
      const dossier2 = created2.body as DossierBody;
      await http(app).post(`/api/v1/exams/dossiers/${dossier2.id}/submit`).set(bearer(member.token)).send({});
      await http(app).post(`/api/v1/exams/dossiers/${dossier2.id}/approve`).set(bearer(leader.token)).send({});
      const noReason = await http(app).post(`/api/v1/exams/dossiers/${dossier2.id}/board-reject`).set(bearer(admin)).send({});
      expect(noReason.status).toBe(400);
      const boardRejected = await http(app).post(`/api/v1/exams/dossiers/${dossier2.id}/board-reject`).set(bearer(admin))
        .send({ reason: 'Chưa đúng kế hoạch kiểm tra của trường' });
      expect(boardRejected.status).toBe(201);
      const rejectedBody = boardRejected.body as DossierBody;
      expect(rejectedBody.status).toBe('rejected');
      expect(rejectedBody.reviews.map((r) => [r.level, r.decision])).toEqual([[1, 'approved'], [2, 'rejected']]);
      expect(rejectedBody.reviews[1]?.reason).toContain('kế hoạch kiểm tra');
    } finally {
      await http(app).delete('/api/v1/site-config/exam/requireboardapproval').set(bearer(admin));
    }
  }, 120_000);

  it('TC4: đặc tả sinh từ examId khớp cấu trúc ma trận; pinId chỉ là tham số phụ; xuất xlsx + docx', async () => {
    const paper = await mkMemberPaper();
    const spec = await http(app).get(`/api/v1/exams/${paper.paper.id}/specification`).set(bearer(member.token));
    expect(spec.status, JSON.stringify(spec.body)).toBe(200);
    const body = spec.body as SpecBody;
    expect(body.paper?.id).toBe(paper.paper.id);
    expect(body.paper?.version).toBe(paper.version.version);
    expect(body.matrix.id).toBe(matrixId);
    expect(body.totals.totalQuestions).toBe(4);
    const liveCells = cellsOf(body);
    expect(liveCells.find((c) => c.cognitiveLevel === 'biet')?.questionCount).toBe(3);
    expect(liveCells.find((c) => c.cognitiveLevel === 'biet')?.slotNumbers).toEqual([1, 2, 3]);
    expect(liveCells.find((c) => c.cognitiveLevel === 'hieu')?.slotNumbers).toEqual([4]);
    expect(body.quiz).toBeNull();

    // quizId của một lần triển khai KHÁC (không từ đề này) → 400.
    const otherQuizPaper = await mkMemberPaper();
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id, { grade: 10 });
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    await assignRole(app, admin, member.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const pinRes = await http(app).post(`/api/v1/courses/${course.id}/exam-pins`).set(bearer(member.token))
      .send({ sectionId, examId: otherQuizPaper.paper.id, name: 'Giữa kỳ EB-3' });
    expect(pinRes.status, JSON.stringify(pinRes.body)).toBe(201);
    const quizId = (pinRes.body as { id: string }).id;

    const mismatch = await http(app).get(`/api/v1/exams/${paper.paper.id}/specification`).query({ pinId: quizId }).set(bearer(member.token));
    expect(mismatch.status).toBe(400);
    expect((mismatch.body as { code?: string }).code).toBe('exam.spec_pin_mismatch');

    // Đúng pin của đề: đặc tả ghi nhận lần ghim, cấu trúc không đổi.
    const withQuiz = await http(app).get(`/api/v1/exams/${otherQuizPaper.paper.id}/specification`).query({ pinId: quizId }).set(bearer(member.token));
    expect(withQuiz.status).toBe(200);
    expect((withQuiz.body as SpecBody).quiz?.id).toBe(quizId);
    expect((withQuiz.body as SpecBody).totals.totalQuestions).toBe(4);

    // Xuất xlsx + docx từ examId: cả hai đều là file zip (PK) mở được.
    for (const format of ['xlsx', 'docx']) {
      const exported = await http(app).get(`/api/v1/exams/${paper.paper.id}/specification/export`)
        .query({ format }).set(bearer(member.token))
        .buffer(true).parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(exported.status).toBe(200);
      expect((exported.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      expect(String(exported.headers['content-disposition'])).toContain('ban-dac-ta-');
      expect(String(exported.headers['content-disposition'])).toContain(`.${format}`);
    }
  }, 120_000);

  it('TC5: đề định kỳ ready ở bank trường — GV khác khối bị chặn, GV đúng khối xem được và có audit', async () => {
    // Đề giữa kỳ khối 10 (admin soạn trong bank trường) + đề thường xuyên làm đối chứng.
    const mkSchoolPaper = async (examKind: string): Promise<string> => {
      const created = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/exams`).set(bearer(admin))
        .send({ name: `Đề ${examKind} EB-3`, examKind, grade: 10, slots: [{ questionId: systemQuestionId }] });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = (created.body as PaperBody).paper.id;
      const ready = await http(app).post(`/api/v1/exams/${id}/status`).set(bearer(admin)).send({ status: 'ready' });
      expect(ready.status).toBe(201);
      return id;
    };
    const periodicId = await mkSchoolPaper('midterm');
    const regularId = await mkSchoolPaper('regular');

    // GV dạy khối 10 và GV dạy khối 11 (vai editingteacher tại context khoá có grade tương ứng).
    const mkGradeTeacher = async (grade: number): Promise<User> => {
      const u = await createUserViaApi(app, admin);
      const session = await login(app, u.username, STRONG_PASSWORD);
      const teacher: User = { id: u.id, username: u.username, token: session.accessToken };
      await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
      const cat = await createCategory(app, admin);
      const course = await createCourse(app, admin, cat.id, { grade });
      const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
      const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
        .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
      await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
      return teacher;
    };
    const teacher10 = await mkGradeTeacher(10);
    const teacher11 = await mkGradeTeacher(11);
    const plainStaff = await (async () => {
      const u = await createUserViaApi(app, admin);
      const session = await login(app, u.username, STRONG_PASSWORD);
      const staff: User = { id: u.id, username: u.username, token: session.accessToken };
      await assignRole(app, admin, staff.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
      return staff;
    })();

    // Luồng vào bank thật: người dùng mở bank trước (bước này đồng bộ
    // tư cách thành viên bank trường cho staff) rồi mới mở đề.
    for (const viewer of [teacher10, teacher11, plainStaff]) {
      const list = await http(app).get(`/api/v1/exams/banks/${schoolBank.id}/exams`).set(bearer(viewer.token));
      expect(list.status).toBe(200);
    }

    // GV đúng khối xem được nội dung; lần xem có audit tra được.
    const okView = await http(app).get(`/api/v1/exams/${periodicId}`).set(bearer(teacher10.token));
    expect(okView.status, JSON.stringify(okView.body)).toBe(200);
    const audit = await pg.query(
      `select count(*)::int as n from outbox_events where type = 'exam_paper_content_viewed'
       and payload->>'examId' = $1 and payload->>'actorId' = $2 and payload->>'surface' = 'detail'`,
      [periodicId, teacher10.id],
    );
    expect((audit.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);

    // GV khác khối + GV không dạy khối nào: bị chặn ở bề mặt chi tiết.
    for (const viewer of [teacher11, plainStaff]) {
      const blocked = await http(app).get(`/api/v1/exams/${periodicId}`).set(bearer(viewer.token));
      expect(blocked.status).toBe(403);
      expect((blocked.body as { code?: string }).code).toBe('exam.periodic_view_forbidden');
    }
    // … và ở bề mặt in + đặc tả (cổng áp dụng trước mọi xử lý nội dung).
    const blockedPrint = await http(app).get(`/api/v1/exams/${periodicId}/print`)
      .query({ pinId: '00000000-0000-4000-8000-000000000000', variantCode: '001' }).set(bearer(teacher11.token));
    expect(blockedPrint.status).toBe(403);
    const blockedSpec = await http(app).get(`/api/v1/exams/${periodicId}/specification`).set(bearer(teacher11.token));
    expect(blockedSpec.status).toBe(403);
    // GV đúng khối qua được cổng đặc tả — chỉ dừng ở "đề không gắn ma trận".
    const specNoMatrix = await http(app).get(`/api/v1/exams/${periodicId}/specification`).set(bearer(teacher10.token));
    expect(specNoMatrix.status).toBe(400);
    expect((specNoMatrix.body as { code?: string }).code).toBe('exam.spec_requires_matrix');

    // Đối chứng: đề thường xuyên ready cùng bank — GV khác khối vẫn xem bình thường (cổng chỉ áp cho diện định kỳ).
    const regularView = await http(app).get(`/api/v1/exams/${regularId}`).set(bearer(teacher11.token));
    expect(regularView.status).toBe(200);
  }, 120_000);
});
