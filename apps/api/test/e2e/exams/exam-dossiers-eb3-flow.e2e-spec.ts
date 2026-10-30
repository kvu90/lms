import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, getFirstSectionId } from '../../support/course-enrolment-helpers';

/**
 * EB-3 (issue #165) + lát S4 của issue #228 — đường hồ sơ duyệt đề
 * và bề mặt lịch sử của nó sau khi cơ chế đóng góp được đồng bộ:
 *  - đường hồ sơ (EB-3 gốc) đã bị HẤP THỤ vào đường đóng góp duy
 *    nhất của đề: bộ hồ sơ thành phần đính kèm của một đóng góp,
 *    cấp duyệt 2 thành trạng thái pending_board của đóng góp (cơ
 *    chế mới kiểm ở spec exam-contributions-s4-flow). Mọi thao tác
 *    GHI của bề mặt hồ sơ trả 410 `exam.dossier_path_closed`.
 *  - bề mặt ĐỌC hồ sơ giữ nguyên để xem lại LỊCH SỬ: hàng chờ theo
 *    bank, chi tiết kèm vết duyệt, bản đặc tả đã chụp + xuất bản,
 *    danh sách hồ sơ của tôi — kiểm ở đây trên fixture hồ sơ gieo
 *    thẳng vào DB (đúng hình thái dữ liệu còn lại sau khi đóng
 *    đường), gồm cả cờ cấp duyệt 2 đọc qua điểm seam dùng chung.
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
  topics: { nodes: { outcomes: { content: string }[]; cells: SpecCell[] }[] }[];
  totals: { totalQuestions: number; totalScore: number };
  quiz: { id: string; name: string } | null;
  paper?: { id: string; version: number };
}

/** Bung các ô ma trận của một bản đặc tả thành danh sách phẳng (theo đúng view model MatrixSpecification — ô nằm ở cấp ĐVK, issue #249). */
function cellsOf(spec: SpecBody): SpecCell[] {
  const cells: SpecCell[] = [];
  for (const topic of spec.topics) {
    for (const node of topic.nodes) {
      cells.push(...node.cells);
    }
  }
  return cells;
}

describe('EB-3 duyệt hồ sơ + đặc tả đề + bảo mật đề định kỳ', () => {
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
    const lessonId = (lessonRes.body as { id: string }).id;
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
        categoryId: bankCatId, qtype: 'multichoice', questionText: `${name}: chọn đáp án đúng.`, defaultMark: 1,
        answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
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
      .send({ curriculumNodeId: lessonId, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 3, cellScore: 3, minutes: 10 });
    if (cellA.status !== 201 && cellA.status !== 200) throw new Error(`cellA failed: ${cellA.status}`);
    const cellB = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/cells`).set(bearer(admin))
      .send({ curriculumNodeId: lessonId, cognitiveLevel: 'hieu', qtype: 'multichoice', questionCount: 1, cellScore: 1, minutes: 5 });
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

  /**
   * Gieo một bộ hồ sơ LỊCH SỬ trực tiếp vào DB — đúng hình thái dữ
   * liệu còn lại sau khi đường hồ sơ đóng (hồ sơ được lập/nộp/duyệt
   * ở thời đường còn mở). Bản đặc tả chụp lấy từ endpoint đặc tả
   * trực tiếp của chính đề (cùng view model mà đường nộp hồ sơ từng
   * chụp tại lúc nộp).
   */
  async function insertHistoricalDossier(args: {
    paper: PaperBody; targetBankId: string; proposerId: string; status: string;
    reviews?: { level: number; reviewerId: string; decision: string; reason: string | null }[];
  }): Promise<string> {
    const specRes = await http(app).get(`/api/v1/exams/${args.paper.paper.id}/specification`).set(bearer(member.token));
    expect(specRes.status, JSON.stringify(specRes.body)).toBe(200);
    const idRes = await pg.query('select uuidv7() as id');
    const dossierId = (idRes.rows[0] as { id: string }).id;
    const mvRes = await pg.query('select id from exam_matrix_versions where matrix_id = $1 and version = $2', [matrixId, matrixVersion]);
    const matrixVersionId = (mvRes.rows[0] as { id: string } | undefined)?.id ?? null;
    await pg.query(
      `insert into exam_dossiers (id, exam_id, target_bank_id, proposer_id, note, status, exam_version_id, exam_version_number, matrix_id, matrix_version, matrix_version_id, spec_snapshot)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [dossierId, args.paper.paper.id, args.targetBankId, args.proposerId, 'Bộ hồ sơ giữa kỳ tổ Toán', args.status,
        args.paper.version.id, args.paper.version.version, matrixId, matrixVersion, matrixVersionId, JSON.stringify(specRes.body)],
    );
    for (const review of args.reviews ?? []) {
      await pg.query(
        'insert into exam_dossier_reviews (dossier_id, level, reviewer_id, decision, reason) values ($1, $2, $3, $4, $5)',
        [dossierId, review.level, review.reviewerId, review.decision, review.reason],
      );
    }
    return dossierId;
  }

  async function outboxCount(type: string, key: string, value: string): Promise<number> {
    const res = await pg.query('select count(*)::int as n from outbox_events where type = $1 and payload->>$2 = $3', [type, key, value]);
    return (res.rows[0] as { n: number }).n;
  }

  it('TC1: bề mặt ĐỌC hồ sơ xem lại lịch sử — hàng chờ, đặc tả đã chụp, xuất bản; mọi thao tác ghi trả 410', async () => {
    const paper = await mkMemberPaper();
    const dossierId = await insertHistoricalDossier({ paper, targetBankId: teamBank.id, proposerId: member.id, status: 'pending' });

    // Hàng chờ TRƯỚC: bề mặt này qua cổng bank (đồng bộ tư cách thành
    // viên bank của người gọi) — tổ trưởng thấy bộ; thành viên khác
    // của tổ chỉ thấy bộ của mình (không có bộ này) và mở trực tiếp
    // bị 404. Đặt trước chi tiết vì cổng xem chi tiết đọc tư cách đã
    // được đồng bộ, đúng thứ tự thao tác thật của người duyệt.
    const queue = await http(app).get(`/api/v1/exams/banks/${teamBank.id}/dossiers`).set(bearer(leader.token));
    expect(queue.status).toBe(200);
    expect((queue.body as DossierBody[]).map((d) => d.id)).toContain(dossierId);
    const queueOther = await http(app).get(`/api/v1/exams/banks/${teamBank.id}/dossiers`).set(bearer(member2.token));
    expect((queueOther.body as DossierBody[]).map((d) => d.id)).not.toContain(dossierId);
    const directOther = await http(app).get(`/api/v1/exams/dossiers/${dossierId}`).set(bearer(member2.token));
    expect(directOther.status).toBe(404);

    // Chi tiết: bộ ba đã ghim tại lúc nộp còn nguyên (version đề + version ma trận), cờ cấp 2 mặc định tắt.
    const detail = await http(app).get(`/api/v1/exams/dossiers/${dossierId}`).set(bearer(leader.token));
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const dossier = detail.body as DossierBody;
    expect(dossier.status).toBe('pending');
    expect(dossier.examVersionId).toBe(paper.version.id);
    expect(dossier.examVersionNumber).toBe(paper.version.version);
    expect(dossier.matrixId).toBe(matrixId);
    expect(dossier.matrixVersion).toBe(matrixVersion);
    expect(dossier.boardApprovalRequired).toBe(false);

    // Tổ trưởng mở bản đặc tả ĐÃ CHỤP: đúng cấu trúc ma trận + vị trí câu của đề; lần mở của người duyệt có audit.
    const spec = await http(app).get(`/api/v1/exams/dossiers/${dossierId}/specification`).set(bearer(leader.token));
    expect(spec.status, JSON.stringify(spec.body)).toBe(200);
    const specBody = spec.body as SpecBody;
    expect(specBody.matrix.id).toBe(matrixId);
    expect(specBody.totals.totalQuestions).toBe(4);
    const snapshotCells = cellsOf(specBody);
    expect(snapshotCells.find((c) => c.cognitiveLevel === 'biet')?.slotNumbers).toEqual([1, 2, 3]);
    expect(snapshotCells.find((c) => c.cognitiveLevel === 'hieu')?.slotNumbers).toEqual([4]);
    expect(await outboxCount('exam_dossier_spec_viewed', 'dossierId', dossierId)).toBeGreaterThanOrEqual(1);
    // Xuất bản đặc tả của bộ hồ sơ ra xlsx mở được (file zip PK).
    const exported = await http(app).get(`/api/v1/exams/dossiers/${dossierId}/specification/export`)
      .query({ format: 'xlsx' }).set(bearer(leader.token))
      .buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(exported.status).toBe(200);
    expect((exported.body as Buffer).subarray(0, 2).toString()).toBe('PK');

    // Mọi thao tác GHI của đường hồ sơ đã đóng — 410 exam.dossier_path_closed, kể cả với đúng người từng có quyền.
    const writes = [
      await http(app).post(`/api/v1/exams/${paper.paper.id}/dossiers`).set(bearer(member.token)).send({ targetBankId: teamBank.id }),
      await http(app).post(`/api/v1/exams/dossiers/${dossierId}/submit`).set(bearer(member.token)).send({}),
      await http(app).post(`/api/v1/exams/dossiers/${dossierId}/approve`).set(bearer(leader.token)).send({}),
      await http(app).post(`/api/v1/exams/dossiers/${dossierId}/reject`).set(bearer(leader.token)).send({ reason: 'Lý do bất kỳ' }),
      await http(app).post(`/api/v1/exams/dossiers/${dossierId}/board-approve`).set(bearer(admin)).send({}),
      await http(app).post(`/api/v1/exams/dossiers/${dossierId}/board-reject`).set(bearer(admin)).send({ reason: 'Lý do bất kỳ' }),
      await http(app).delete(`/api/v1/exams/dossiers/${dossierId}`).set(bearer(member.token)),
    ];
    for (const res of writes) {
      expect(res.status, JSON.stringify(res.body)).toBe(410);
      expect((res.body as { code?: string }).code).toBe('exam.dossier_path_closed');
    }
    // Bộ hồ sơ không đổi sau mọi nỗ lực ghi.
    const after = await http(app).get(`/api/v1/exams/dossiers/${dossierId}`).set(bearer(leader.token));
    expect((after.body as DossierBody).status).toBe('pending');
  }, 120_000);

  it('TC2: lịch sử từ chối còn đọc lại được nguyên vẹn — người đóng góp thấy lý do qua danh sách của mình', async () => {
    const paper = await mkMemberPaper();
    const dossierId = await insertHistoricalDossier({
      paper, targetBankId: teamBank.id, proposerId: member.id, status: 'rejected',
      reviews: [{ level: 1, reviewerId: leader.id, decision: 'rejected', reason: 'Ô nhận biết thừa 1 câu so với ma trận đã thống nhất' }],
    });

    const mine = await http(app).get('/api/v1/exams/dossiers/mine').set(bearer(member.token));
    const mineDossier = (mine.body as DossierBody[]).find((d) => d.id === dossierId);
    expect(mineDossier?.status).toBe('rejected');
    expect(mineDossier?.reviews).toHaveLength(1);
    expect(mineDossier?.reviews[0]).toMatchObject({ level: 1, reviewerId: leader.id, decision: 'rejected' });
    expect(mineDossier?.reviews[0]?.reason).toContain('thừa 1 câu');

    // Đường ghi đã đóng: duyệt lại bộ đã đóng không còn là 409 nghiệp vụ mà là 410 đóng đường.
    const again = await http(app).post(`/api/v1/exams/dossiers/${dossierId}/approve`).set(bearer(leader.token)).send({});
    expect(again.status).toBe(410);
    expect((again.body as { code?: string }).code).toBe('exam.dossier_path_closed');
  }, 120_000);

  it('TC3: cờ cấp duyệt 2 trong view hồ sơ lịch sử đọc qua điểm seam dùng chung — bật/tắt theo cấu hình platform của bank đích', async () => {
    const paper = await mkMemberPaper();
    const dossierId = await insertHistoricalDossier({ paper, targetBankId: teamBank.id, proposerId: member.id, status: 'pending' });

    // Chạm bề mặt hàng chờ trước để tư cách bank của tổ trưởng được
    // đồng bộ (như TC1) rồi mới đọc chi tiết.
    const queue = await http(app).get(`/api/v1/exams/banks/${teamBank.id}/dossiers`).set(bearer(leader.token));
    expect((queue.body as DossierBody[]).map((d) => d.id)).toContain(dossierId);
    const off = await http(app).get(`/api/v1/exams/dossiers/${dossierId}`).set(bearer(leader.token));
    expect((off.body as DossierBody).boardApprovalRequired).toBe(false);
    const on = await http(app).put('/api/v1/site-config/exam/requireboardapproval').set(bearer(admin)).send({ value: true });
    expect([200, 201]).toContain(on.status);
    try {
      const onView = await http(app).get(`/api/v1/exams/dossiers/${dossierId}`).set(bearer(leader.token));
      expect((onView.body as DossierBody).boardApprovalRequired).toBe(true);
    } finally {
      await http(app).delete('/api/v1/site-config/exam/requireboardapproval').set(bearer(admin));
    }
    const offAgain = await http(app).get(`/api/v1/exams/dossiers/${dossierId}`).set(bearer(leader.token));
    expect((offAgain.body as DossierBody).boardApprovalRequired).toBe(false);
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
