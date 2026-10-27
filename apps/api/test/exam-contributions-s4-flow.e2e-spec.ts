import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';
import { ExamDossiersService } from '../src/modules/exams/exam-dossiers.service';
import { tenantAls } from '../src/modules/tenants/tenant-als';

/**
 * Lát S4 của issue #228 — đường đóng góp DUY NHẤT của đề nâng lên
 * khuôn QB-4 đầy đủ, đối chiếu các tiêu chí đã chốt trong issue:
 *  - mode 'update': đề xuất bản mới cho một đề đã có trong bank
 *    đích — thiếu targetExamId → 400 exam.contribution_target_required;
 *    đích không nằm trong bank đích → 400
 *    exam.contribution_target_not_in_bank; nguồn không phải bản sao
 *    suy từ đích → 400 exam.contribution_not_derived; hợp lệ →
 *    duyệt tạo VERSION MỚI trên chính danh tính đề đích
 *    (result_exam_id = đề đích), mốc duyệt ghi vào sổ mốc duyệt.
 *  - bộ hồ sơ đính kèm (withDossier): đề không gắn ma trận → 400
 *    exam.contribution_dossier_requires_matrix; có bộ hồ sơ +
 *    tenant/bank đích bật cấu hình cấp duyệt 2 → duyệt cấp 1 chỉ
 *    sang pending_board (đề chưa vào bank), cổng cấp 2 chặn người
 *    không có exam:moderate tại context hệ thống (403
 *    exam.contribution_board_forbidden), ban giám hiệu duyệt mới
 *    chốt — bản vào bank là PHIÊN BẢN ĐÃ GHIM ở trạng thái ready;
 *    từ chối cấp 2 giữ vết cả hai cấp; cấu hình tắt → một cấp chốt.
 *  - chống trùng cho ma trận: đề xuất ghi content_hash và
 *    near_duplicate_of khi bank đích có ma trận trùng nội dung;
 *    duyệt đóng góp mà bank đích đã có bản copy suy từ chính ma
 *    trận nguồn → 409 quiz.matrix_duplicate_in_bank.
 *  - chuyển đổi hồ sơ treo (ExamDossiersService.convertLegacyDossiers):
 *    pending/pending_board → đóng góp mang bộ hồ sơ + lịch sử mốc
 *    duyệt (idempotent theo source_dossier_id); draft → đóng băng
 *    (không sinh đóng góp); approved/rejected → giữ lịch sử.
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface BankBody { id: string; scope: string; bankKind: string; ownerId: string | null; defaultCategoryId: string | null }
interface PaperBody {
  paper: { id: string; bankId: string; status: string; latestVersion: number; derivedFromExamId: string | null; createdBy: string };
  version: { id: string; version: number; name: string; matrixId: string | null };
  slots: { position: number; questionId: string }[];
}
interface ContributionBody {
  id: string; examId: string; status: string; mode: string; targetExamId: string | null;
  resultExamId: string | null; rejectReason: string | null;
  dossierExamVersionId: string | null; dossierMatrixId: string | null;
  reviews?: { level: number; reviewerId: string; decision: string; reason: string | null }[];
}

describe('Exam contributions S4 (issue #228): QB-4 đầy đủ cho đề + chống trùng ma trận + chuyển đổi hồ sơ', () => {
  let app: INestApplication;
  let admin: string;
  let adminId: string;
  let pg: Client;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const me = await http(app).get('/api/v1/users/me').set(bearer(admin));
    adminId = me.body.id as string;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    // Công tắc cấp 2 mặc định TẮT khi bắt đầu (site-config là toàn cục).
    await http(app).delete('/api/v1/site-config/exam/requireboardapproval').set(bearer(admin));
  }, 120_000);
  afterAll(async () => {
    await http(app).delete('/api/v1/site-config/exam/requireboardapproval').set(bearer(admin));
    await pg.end();
    await app.close();
  });

  async function mkStaffUser(): Promise<{ id: string; token: string }> {
    const u = await createUserViaApi(app, admin);
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, token: session.accessToken };
  }

  async function bankOfKind(token: string, kind: 'question' | 'exam' | 'matrix', scope: string, ownerId?: string): Promise<BankBody> {
    const res = await http(app).get(`/api/v1/question-banks?kind=${kind}`).set(bearer(token));
    expect(res.status).toBe(200);
    const bank = (res.body as BankBody[]).find(
      (b) => b.scope === scope && b.bankKind === kind && (scope !== 'personal' || b.ownerId === ownerId),
    );
    expect(bank).toBeTruthy();
    return bank!;
  }

  async function createQuestion(token: string, categoryId: string, name: string): Promise<string> {
    const res = await http(app).post('/api/v1/questions').set(bearer(token)).send({
      categoryId, qtype: 'multichoice', questionText: `Thân câu ${name}?`,
      answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return (res.body as { question: { id: string } }).question.id;
  }

  async function createPaper(token: string, bankId: string, name: string, slots: { questionId: string }[]): Promise<PaperBody> {
    const res = await http(app).post(`/api/v1/exams/banks/${bankId}/exams`).set(bearer(token))
      .send({ name, examKind: 'regular', slots });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as PaperBody;
  }

  async function setPaperStatus(token: string, paperId: string, status: string): Promise<void> {
    const res = await http(app).post(`/api/v1/exams/${paperId}/status`).set(bearer(token)).send({ status });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  async function mkSchoolBank(kind: 'exam' | 'matrix'): Promise<BankBody> {
    const res = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: uniqueName(`Ngân hàng ${kind} trường S4`), scope: 'school', bankKind: kind });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body as BankBody;
  }

  it('TC-S4-1: mode update — đủ ba cổng lỗi riêng, duyệt tạo version mới trên chính đề đích, vết mốc duyệt đầy đủ', async () => {
    const owner = await mkStaffUser();
    const qBank = await bankOfKind(owner.token, 'question', 'personal', owner.id);
    const eBank = await bankOfKind(owner.token, 'exam', 'personal', owner.id);
    const schoolBank = await mkSchoolBank('exam');
    const q1 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'S4-1 câu 1');
    const q2 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'S4-1 câu 2');

    // Đề gốc vào bank trường qua mode 'new' như thường lệ.
    const paper = await createPaper(owner.token, eBank.id, 'Đề gốc S4-1', [{ questionId: q1 }]);
    await setPaperStatus(owner.token, paper.paper.id, 'ready');
    const proposeNew = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
      .send({ examId: paper.paper.id });
    expect(proposeNew.status, JSON.stringify(proposeNew.body)).toBe(201);
    const approveNew = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${(proposeNew.body as ContributionBody).id}/approve`)
      .set(bearer(admin)).send({});
    expect(approveNew.status, JSON.stringify(approveNew.body)).toBe(201);
    const targetId = (approveNew.body as ContributionBody).resultExamId!;
    expect(targetId).toBeTruthy();
    // Bản copy duyệt đóng góp hạ cánh ready ngay tại bank đích (quy
    // tắc hoàn thiện: duyệt đóng góp đạt là đường vào bank ở dạng đã
    // hoàn thiện) — dùng thẳng làm đề đích cho bản đề xuất cập nhật.
    const targetView = await http(app).get(`/api/v1/exams/${targetId}`).set(bearer(admin));
    expect((targetView.body as PaperBody).paper.status).toBe('ready');

    // Giáo viên copy đề đích về bank cá nhân → bản sao suy từ đích, sửa nội dung (thêm câu 2).
    const copy = await http(app).post(`/api/v1/exams/${targetId}/copy`).set(bearer(owner.token)).send({});
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    const working = copy.body as PaperBody;
    expect(working.paper.derivedFromExamId).toBe(targetId);
    await setPaperStatus(owner.token, working.paper.id, 'ready');
    const edited = await http(app).put(`/api/v1/exams/${working.paper.id}/slots`).set(bearer(owner.token))
      .send({ slots: [{ questionId: q1 }, { questionId: q2 }] });
    expect(edited.status, JSON.stringify(edited.body)).toBeLessThan(300);

    // Cổng 1: mode update thiếu targetExamId.
    const noTarget = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
      .send({ examId: working.paper.id, mode: 'update' });
    expect(noTarget.status).toBe(400);
    expect((noTarget.body as { code?: string }).code).toBe('exam.contribution_target_required');

    // Cổng 2: targetExamId không nằm trong bank đích (đề gốc ở bank cá nhân).
    const wrongBank = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
      .send({ examId: working.paper.id, mode: 'update', targetExamId: paper.paper.id });
    expect(wrongBank.status).toBe(400);
    expect((wrongBank.body as { code?: string }).code).toBe('exam.contribution_target_not_in_bank');

    // Cổng 3: nguồn không phải bản sao suy từ đề đích.
    const stray = await createPaper(owner.token, eBank.id, 'Đề lạc S4-1', [{ questionId: q1 }]);
    await setPaperStatus(owner.token, stray.paper.id, 'ready');
    const notDerived = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
      .send({ examId: stray.paper.id, mode: 'update', targetExamId: targetId });
    expect(notDerived.status).toBe(400);
    expect((notDerived.body as { code?: string }).code).toBe('exam.contribution_not_derived');

    // Hợp lệ → pending; gửi trùng khi đang chờ → 409.
    const propose = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
      .send({ examId: working.paper.id, mode: 'update', targetExamId: targetId, note: 'Bản cập nhật thêm câu 2' });
    expect(propose.status, JSON.stringify(propose.body)).toBe(201);
    const contribution = propose.body as ContributionBody;
    expect(contribution.mode).toBe('update');
    expect(contribution.targetExamId).toBe(targetId);
    const dup = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
      .send({ examId: working.paper.id, mode: 'update', targetExamId: targetId });
    expect(dup.status).toBe(409);
    expect((dup.body as { code?: string }).code).toBe('exam.contribution_duplicate_pending');

    // Duyệt → version MỚI trên chính danh tính đề đích (không sinh đề mới trong bank).
    const approve = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${contribution.id}/approve`)
      .set(bearer(admin)).send({});
    expect(approve.status, JSON.stringify(approve.body)).toBe(201);
    const approved = approve.body as ContributionBody;
    expect(approved.status).toBe('approved');
    expect(approved.resultExamId).toBe(targetId);
    const targetAfter = await http(app).get(`/api/v1/exams/${targetId}`).set(bearer(admin));
    const targetBody = targetAfter.body as PaperBody;
    expect(targetBody.paper.latestVersion).toBe(2);
    expect(targetBody.version.version).toBe(2);
    expect(targetBody.slots.map((s) => s.questionId)).toEqual([q1, q2]);

    // Vết mốc duyệt: hàng chờ của người duyệt mang mốc cấp 1 của lần duyệt này.
    const queue = await http(app).get(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(admin));
    const queued = (queue.body as ContributionBody[]).find((c) => c.id === contribution.id)!;
    expect(queued.reviews).toHaveLength(1);
    expect(queued.reviews![0]).toMatchObject({ level: 1, reviewerId: adminId, decision: 'approved' });
  }, 120_000);

  it('TC-S4-2: bộ hồ sơ đính kèm + cấp duyệt 2 có điều kiện — pending_board, cổng board, chốt ở bản ghim ready; tắt cấu hình thì một cấp', async () => {
    const owner = await mkStaffUser();
    const qBank = await bankOfKind(owner.token, 'question', 'personal', owner.id);
    const eBank = await bankOfKind(owner.token, 'exam', 'personal', owner.id);
    const schoolBank = await mkSchoolBank('exam');
    const q1 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'S4-2 câu 1');

    // Ma trận (qua API của admin): môn + chương trình + cây ĐVK tối thiểu để dựng bản đặc tả.
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const subj = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtx.id, name: uniqueName('Môn S4'), slug: uniqueName('mon-s4') });
    const curr = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin)).send({ subjectId: subj.body.id, grade: 10 });
    const topic = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId: curr.body.id, title: 'Chủ đề S4', kind: 'topic' });
    await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId: curr.body.id, parentId: topic.body.id, title: 'Bài S4', kind: 'lesson' });
    const matrixRes = await http(app).post('/api/v1/exam-matrices').set(bearer(admin))
      .send({ name: 'Ma trận S4', subjectId: subj.body.id, curriculumId: curr.body.id, totalScore: 10 });
    expect(matrixRes.status, JSON.stringify(matrixRes.body)).toBeLessThan(300);
    const matrixId = (matrixRes.body as { id: string }).id;

    // Đề KHÔNG gắn ma trận: withDossier bị chặn riêng.
    const plain = await createPaper(owner.token, eBank.id, 'Đề thường S4-2', [{ questionId: q1 }]);
    await setPaperStatus(owner.token, plain.paper.id, 'ready');
    const noMatrix = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
      .send({ examId: plain.paper.id, withDossier: true });
    expect(noMatrix.status).toBe(400);
    expect((noMatrix.body as { code?: string }).code).toBe('exam.contribution_dossier_requires_matrix');

    // Đề gắn ma trận (tạo với matrixId — version mang matrixId như đề sinh từ ma trận).
    async function mkMatrixPaper(name: string): Promise<PaperBody> {
      const res = await http(app).post(`/api/v1/exams/banks/${eBank.id}/exams`).set(bearer(owner.token))
        .send({ name, examKind: 'midterm', matrixId, slots: [{ questionId: q1 }] });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const body = res.body as PaperBody;
      expect(body.version.matrixId).toBe(matrixId);
      await setPaperStatus(owner.token, body.paper.id, 'ready');
      return body;
    }

    const on = await http(app).put('/api/v1/site-config/exam/requireboardapproval').set(bearer(admin)).send({ value: true });
    expect([200, 201]).toContain(on.status);
    try {
      // Đóng góp kèm bộ hồ sơ: bộ ba ghim ngay tại lúc đề xuất.
      const official = await mkMatrixPaper('Đề giữa kỳ S4-2');
      const propose = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
        .send({ examId: official.paper.id, withDossier: true, note: 'Hồ sơ giữa kỳ' });
      expect(propose.status, JSON.stringify(propose.body)).toBe(201);
      const contribution = propose.body as ContributionBody;
      expect(contribution.dossierExamVersionId).toBe(official.version.id);
      expect(contribution.dossierMatrixId).toBe(matrixId);

      // Cấp 1 duyệt → chỉ sang pending_board, đề CHƯA vào bank đích.
      const level1 = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${contribution.id}/approve`)
        .set(bearer(admin)).send({});
      expect(level1.status, JSON.stringify(level1.body)).toBe(201);
      const pendingBoard = level1.body as ContributionBody;
      expect(pendingBoard.status).toBe('pending_board');
      expect(pendingBoard.resultExamId).toBeNull();
      const inBankBefore = await http(app).get(`/api/v1/exams/banks/${schoolBank.id}/exams`).set(bearer(admin));
      expect((inBankBefore.body as { derivedFromExamId: string | null }[]).some((p) => p.derivedFromExamId === official.paper.id)).toBe(false);

      // Người không có exam:moderate tại context hệ thống không qua được cổng cấp 2 — đường alias cũ giữ nguyên mã lỗi này.
      const ownerBoard = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${contribution.id}/board-approve`)
        .set(bearer(owner.token)).send({});
      expect(ownerBoard.status).toBe(403);
      expect((ownerBoard.body as { code?: string }).code).toBe('exam.contribution_board_forbidden');

      // Ban giám hiệu (site admin) duyệt cấp 2 qua đường canonical hợp nhất `approve` → chốt: bản ghim vào bank ở ready.
      const board = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${contribution.id}/approve`)
        .set(bearer(admin)).send({});
      expect(board.status, JSON.stringify(board.body)).toBe(201);
      expect(board.headers['deprecation']).toBeUndefined();
      const done = board.body as ContributionBody;
      expect(done.status).toBe('approved');
      expect(done.resultExamId).toBeTruthy();
      const landed = await http(app).get(`/api/v1/exams/${done.resultExamId}`).set(bearer(admin));
      expect((landed.body as PaperBody).paper.status).toBe('ready');
      expect((landed.body as PaperBody).paper.derivedFromExamId).toBe(official.paper.id);
      // Vết hai cấp độc lập trong hàng chờ.
      const queue = await http(app).get(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(admin));
      const queued = (queue.body as ContributionBody[]).find((c) => c.id === contribution.id)!;
      expect(queued.reviews!.map((r) => [r.level, r.decision])).toEqual([[1, 'approved'], [2, 'approved']]);

      // Từ chối ở cấp 2: lý do bắt buộc, vết cấp 1 giữ nguyên.
      const official2 = await mkMatrixPaper('Đề giữa kỳ S4-2 (bộ 2)');
      const propose2 = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
        .send({ examId: official2.paper.id, withDossier: true });
      const c2 = (propose2.body as ContributionBody).id;
      await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${c2}/approve`).set(bearer(admin)).send({});
      const noReason = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${c2}/reject`)
        .set(bearer(admin)).send({});
      expect(noReason.status).toBe(400);
      const boardRejected = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${c2}/reject`)
        .set(bearer(admin)).send({ reason: 'Chưa đúng kế hoạch kiểm tra' });
      expect(boardRejected.status, JSON.stringify(boardRejected.body)).toBe(201);
      const rejectedBody = boardRejected.body as ContributionBody;
      expect(rejectedBody.status).toBe('rejected');
      expect(rejectedBody.rejectReason).toContain('kế hoạch kiểm tra');
      const queue2 = await http(app).get(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(admin));
      const queued2 = (queue2.body as ContributionBody[]).find((c) => c.id === c2)!;
      expect(queued2.reviews!.map((r) => [r.level, r.decision])).toEqual([[1, 'approved'], [2, 'rejected']]);
      expect(queued2.reviews![1]!.reason).toContain('kế hoạch kiểm tra');

      // Đường alias cũ `board-approve` vẫn duyệt cấp 2 như trước, kèm header sắp bỏ (issue #345, giai đoạn 2).
      const official3 = await mkMatrixPaper('Đề giữa kỳ S4-2 (bộ 3)');
      const propose3 = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
        .send({ examId: official3.paper.id, withDossier: true });
      const c3 = (propose3.body as ContributionBody).id;
      await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${c3}/approve`).set(bearer(admin)).send({});
      const aliasBoard = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${c3}/board-approve`)
        .set(bearer(admin)).send({});
      expect(aliasBoard.status, JSON.stringify(aliasBoard.body)).toBe(201);
      expect((aliasBoard.body as ContributionBody).status).toBe('approved');
      expect((aliasBoard.body as ContributionBody).resultExamId).toBeTruthy();
      expect(aliasBoard.headers['deprecation']).toBe('true');
      expect(aliasBoard.headers['sunset']).toContain('2027');
    } finally {
      await http(app).delete('/api/v1/site-config/exam/requireboardapproval').set(bearer(admin));
    }

    // Cấu hình TẮT: đóng góp kèm bộ hồ sơ vẫn duyệt MỘT cấp như QB-4.
    const official3 = await mkMatrixPaper('Đề giữa kỳ S4-2 (bộ 3)');
    const propose3 = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
      .send({ examId: official3.paper.id, withDossier: true });
    const c3 = (propose3.body as ContributionBody).id;
    const approve3 = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${c3}/approve`)
      .set(bearer(admin)).send({});
    expect(approve3.status, JSON.stringify(approve3.body)).toBe(201);
    expect((approve3.body as ContributionBody).status).toBe('approved');
  }, 120_000);

  it('TC-S4-3: chống trùng ma trận — content_hash + near_duplicate_of khi đề xuất, 409 khi duyệt trùng suy từ cùng nguồn', async () => {
    const owner = await mkStaffUser();
    const matrixBank = await bankOfKind(owner.token, 'matrix', 'personal', owner.id);
    const schoolMatrixBank = await mkSchoolBank('matrix');

    // Môn/chương trình/ĐVK tối thiểu + ma trận có một ô.
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const subj = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtx.id, name: uniqueName('Môn S4-3'), slug: uniqueName('mon-s4-3') });
    const curr = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin)).send({ subjectId: subj.body.id, grade: 10 });
    const topic = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId: curr.body.id, title: 'Chủ đề S4-3', kind: 'topic' });
    const lesson = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId: curr.body.id, parentId: topic.body.id, title: 'Bài S4-3', kind: 'lesson' });
    const matrixRes = await http(app).post('/api/v1/exam-matrices').set(bearer(owner.token))
      .send({ name: 'Ma trận S4-3', subjectId: subj.body.id, curriculumId: curr.body.id, bankId: matrixBank.id, totalScore: 10 });
    expect(matrixRes.status, JSON.stringify(matrixRes.body)).toBeLessThan(300);
    const matrixId = (matrixRes.body as { id: string }).id;
    const cell = await http(app).post(`/api/v1/exam-matrices/${matrixId}/cells`).set(bearer(owner.token))
      .send({ curriculumNodeId: lesson.body.id, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 2, cellScore: 2 });
    expect(cell.status, JSON.stringify(cell.body)).toBeLessThan(300);
    const ready = await http(app).patch(`/api/v1/exam-matrices/${matrixId}`).set(bearer(owner.token)).send({ status: 'ready' });
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);

    // Đề xuất lần 1: bank đích chưa có ma trận trùng → near_duplicate_of trống, hash đã ghi.
    const propose1 = await http(app).post(`/api/v1/exam-matrices/${matrixId}/contributions`).set(bearer(owner.token))
      .send({ targetBankId: schoolMatrixBank.id });
    expect(propose1.status, JSON.stringify(propose1.body)).toBe(201);
    const p1 = propose1.body as { id: string; contentHash: string; nearDuplicateOf: string | null };
    expect(p1.contentHash).toBeTruthy();
    expect(p1.nearDuplicateOf).toBeNull();
    const approve1 = await http(app).post(`/api/v1/question-banks/${schoolMatrixBank.id}/matrix-contributions/${p1.id}/approve`)
      .set(bearer(admin)).send({});
    expect(approve1.status, JSON.stringify(approve1.body)).toBe(201);
    const landedId = (approve1.body as { resultMatrixId: string }).resultMatrixId;

    // Đề xuất lần 2 (sau khi lần 1 đã chốt): bank đích nay có bản
    // copy CÙNG NỘI DUNG → near_duplicate_of trỏ đúng bản đã vào
    // bank; duyệt lần 2 bị chặn 409 vì bản đó suy từ chính nguồn.
    const propose2 = await http(app).post(`/api/v1/exam-matrices/${matrixId}/contributions`).set(bearer(owner.token))
      .send({ targetBankId: schoolMatrixBank.id });
    expect(propose2.status, JSON.stringify(propose2.body)).toBe(201);
    const p2 = propose2.body as { id: string; contentHash: string; nearDuplicateOf: string | null };
    expect(p2.contentHash).toBe(p1.contentHash);
    expect(p2.nearDuplicateOf).toBe(landedId);
    const approve2 = await http(app).post(`/api/v1/question-banks/${schoolMatrixBank.id}/matrix-contributions/${p2.id}/approve`)
      .set(bearer(admin)).send({});
    expect(approve2.status).toBe(409);
    expect((approve2.body as { code?: string }).code).toBe('quiz.matrix_duplicate_in_bank');
  }, 120_000);

  it('TC-S4-4: chuyển đổi hồ sơ treo — pending/pending_board thành đóng góp kèm lịch sử duyệt, draft đóng băng, chạy lại không nhân đôi', async () => {
    const owner = await mkStaffUser();
    const qBank = await bankOfKind(owner.token, 'question', 'personal', owner.id);
    const eBank = await bankOfKind(owner.token, 'exam', 'personal', owner.id);
    const schoolBank = await mkSchoolBank('exam');
    const q1 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'S4-4 câu 1');
    const paper = await createPaper(owner.token, eBank.id, 'Đề hồ sơ treo S4-4', [{ questionId: q1 }]);
    await setPaperStatus(owner.token, paper.paper.id, 'ready');
    const draftPaper = await createPaper(owner.token, eBank.id, 'Đề nháp hồ sơ S4-4', [{ questionId: q1 }]);

    // Gieo hồ sơ ở bốn trạng thái đúng hình thái dữ liệu trước khi cắt đường.
    async function insertDossier(examId: string, status: string, pinned: boolean): Promise<string> {
      const idRes = await pg.query('select uuidv7() as id');
      const dossierId = (idRes.rows[0] as { id: string }).id;
      await pg.query(
        `insert into exam_dossiers (id, exam_id, target_bank_id, proposer_id, note, status, exam_version_id, exam_version_number)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [dossierId, examId, schoolBank.id, owner.id, 'Hồ sơ treo S4-4', status,
          pinned ? paper.version.id : null, pinned ? paper.version.version : null],
      );
      return dossierId;
    }
    const dPending = await insertDossier(paper.paper.id, 'pending', true);
    const dBoard = await insertDossier(paper.paper.id, 'pending_board', true);
    await pg.query(
      'insert into exam_dossier_reviews (dossier_id, level, reviewer_id, decision, reason) values ($1, 1, $2, $3, null)',
      [dBoard, adminId, 'approved'],
    );
    const dDraft = await insertDossier(draftPaper.paper.id, 'draft', false);
    const dApproved = await insertDossier(paper.paper.id, 'approved', true);

    const runConversion = () => tenantAls.run({ platform: true }, async () => {
      const service = app.get(ExamDossiersService, { strict: false });
      return service.convertLegacyDossiers();
    });
    const report = await runConversion();
    expect(report.converted).toBeGreaterThanOrEqual(2);
    expect(report.draftsFrozen).toBeGreaterThanOrEqual(1);

    // Hai đóng góp sinh ra đúng trạng thái + bộ hồ sơ đã ghim + neo về hồ sơ gốc.
    const cPending = await pg.query(
      'select id, status, mode, dossier_exam_version_id, content_hash from exam_contributions where source_dossier_id = $1', [dPending]);
    expect(cPending.rows).toHaveLength(1);
    expect(cPending.rows[0]).toMatchObject({ status: 'pending', mode: 'new', dossier_exam_version_id: paper.version.id });
    expect((cPending.rows[0] as { content_hash: string }).content_hash).toBeTruthy();
    const cBoard = await pg.query(
      'select id, status from exam_contributions where source_dossier_id = $1', [dBoard]);
    expect(cBoard.rows).toHaveLength(1);
    expect((cBoard.rows[0] as { status: string }).status).toBe('pending_board');
    // Lịch sử mốc duyệt của hồ sơ pending_board đã sang sổ mốc duyệt của đóng góp.
    const copiedReviews = await pg.query(
      'select level, reviewer_id, decision from exam_contribution_reviews where contribution_id = $1',
      [(cBoard.rows[0] as { id: string }).id],
    );
    expect(copiedReviews.rows).toHaveLength(1);
    expect(copiedReviews.rows[0]).toMatchObject({ level: 1, reviewer_id: adminId, decision: 'approved' });
    // Draft và approved không sinh đóng góp.
    for (const d of [dDraft, dApproved]) {
      const none = await pg.query('select count(*)::int as n from exam_contributions where source_dossier_id = $1', [d]);
      expect((none.rows[0] as { n: number }).n).toBe(0);
    }
    // Hàng chờ của bank đích thấy cả hai đóng góp đã chuyển đổi.
    const queue = await http(app).get(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(admin));
    const queuedIds = (queue.body as ContributionBody[]).map((c) => c.id);
    expect(queuedIds).toContain((cPending.rows[0] as { id: string }).id);
    expect(queuedIds).toContain((cBoard.rows[0] as { id: string }).id);
    const queuedSourceIds = await pg.query(
      'select source_dossier_id from exam_contributions where target_bank_id = $1 and source_dossier_id is not null', [schoolBank.id]);
    expect((queuedSourceIds.rows as { source_dossier_id: string }[]).map((r) => r.source_dossier_id))
      .toEqual(expect.arrayContaining([dPending, dBoard]));

    // Chạy lại: không nhân đôi đóng góp lẫn mốc duyệt.
    const report2 = await runConversion();
    expect(report2.alreadyConverted).toBeGreaterThanOrEqual(2);
    const again = await pg.query(
      'select count(*)::int as n from exam_contributions where source_dossier_id in ($1, $2)', [dPending, dBoard]);
    expect((again.rows[0] as { n: number }).n).toBe(2);
    const reviewsAgain = await pg.query(
      'select count(*)::int as n from exam_contribution_reviews where contribution_id = $1',
      [(cBoard.rows[0] as { id: string }).id],
    );
    expect((reviewsAgain.rows[0] as { n: number }).n).toBe(1);
  }, 120_000);
});
