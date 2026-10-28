import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from '../support/identity-access-helpers';

/**
 * Cân bằng trải nghiệm ngân hàng cho ADMIN (việc nối tiếp feat #70,
 * đính chính 25/10/2026): CHỈ MỘT quy tắc — admin có khu riêng ĐÚNG
 * NHƯ giáo viên trên bề mặt ngân hàng, không ẩn theo vai, không đặc
 * cách. Spec này khoá parity admin ↔ giáo viên (vai teacher tại hệ
 * thống — nhóm archetype staff) ở tầng API, đúng các đường web dùng:
 *  - GET /question-banks (kind=question): bank cá nhân tự tạo lười,
 *    đủ capabilities, có category mặc định, tạo được câu trong bank
 *    của chính mình.
 *  - GET /question-banks?kind=matrix: bank ma trận cá nhân tự tạo
 *    lười, đủ matrix capabilities, tạo được ma trận trong bank mình.
 *  - GET /question-banks?kind=exam (tầng bank của EB-1): bank đề cá
 *    nhân tự tạo lười cho cả hai.
 *  - Đối chứng âm: người dùng thường (không archetype staff, không
 *    phải site admin) vẫn KHÔNG có bank cá nhân — cổng staff của
 *    điểm chặn 3 (PR #83) giữ nguyên, parity không có nghĩa là mở
 *    cho tất cả.
 */

function bearer(token: string): { Authorization: string } {
  return { Authorization: 'Bearer '.concat(token) };
}

interface BankBody {
  id: string; name: string; scope: string; bankKind: string; ownerId: string | null;
  contextId: string; defaultCategoryId: string | null; categoryIds: string[];
  capabilities: {
    use: boolean; add: boolean; edit: boolean; manageCategory: boolean;
    copy: boolean; share: boolean; moderate: boolean;
    matrixView?: boolean; matrixManage?: boolean; matrixCopy?: boolean;
    matrixShare?: boolean; matrixModerate?: boolean;
  };
}

describe('Bank admin parity (feat #70 follow-up)', () => {
  let app: INestApplication;
  let admin: string;
  let adminId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const me = await http(app).get('/api/v1/users/me').set(bearer(admin));
    expect(me.status).toBe(200);
    adminId = (me.body as { id: string }).id;
  });
  afterAll(async () => { await app.close(); });

  async function mkUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  /** Giáo viên: vai teacher (archetype staff) tại context hệ thống. */
  async function mkTeacher(): Promise<{ id: string; username: string; token: string }> {
    const u = await mkUser();
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    return u;
  }

  async function personalBank(token: string, kind: string, ownerId: string): Promise<BankBody | undefined> {
    const res = await http(app).get(`/api/v1/question-banks?kind=${kind}`).set(bearer(token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Lọc theo CHỦ SỞ HỮU: danh sách của staff hiện còn lẫn bank cá
    // nhân của người khác (kế thừa question:useall qua cây context) —
    // đó là phạm vi của issue #123 đang thi công riêng, không thuộc
    // parity này. Parity khẳng định trên bank CỦA CHÍNH actor.
    return (res.body as BankBody[]).find((b) => b.scope === 'personal' && b.ownerId === ownerId);
  }

  async function createQuestion(token: string, categoryId: string, name: string): Promise<void> {
    const res = await http(app).post('/api/v1/questions').set(bearer(token)).send({
      categoryId, qtype: 'multichoice', questionText: 'Thân câu hỏi parity?',
      answers: [{ text: 'Đáp án đúng', correct: true }, { text: 'Đáp án sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  it('bank câu hỏi cá nhân: admin bằng giáo viên (tự tạo lười, đủ quyền, tạo được câu)', async () => {
    const teacher = await mkTeacher();
    for (const actor of [{ id: adminId, token: admin }, teacher]) {
      const bank = await personalBank(actor.token, 'question', actor.id);
      expect(bank, 'phải có bank cá nhân câu hỏi').toBeTruthy();
      expect(bank!.ownerId).toBe(actor.id);
      expect(bank!.capabilities.use).toBe(true);
      expect(bank!.capabilities.add).toBe(true);
      expect(bank!.capabilities.edit).toBe(true);
      expect(bank!.capabilities.manageCategory).toBe(true);
      expect(bank!.capabilities.copy).toBe(true);
      expect(bank!.defaultCategoryId).toBeTruthy();
      await createQuestion(actor.token, bank!.defaultCategoryId!, uniqueName('Câu parity'));
    }
  });

  it('bank ma trận cá nhân: admin bằng giáo viên (tự tạo lười, đủ matrix caps, tạo được ma trận)', async () => {
    const teacher = await mkTeacher();
    // Chương trình tối thiểu cho ma trận (admin dựng một lần, cả hai cùng tham chiếu).
    const systemCtxId = await systemContextId(app, admin);
    const subjRes = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtxId, name: uniqueName('Toán parity'), slug: `toan-parity-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    expect(subjRes.status, JSON.stringify(subjRes.body)).toBe(201);
    const subjectId = (subjRes.body as { id: string }).id;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin)).send({ subjectId, grade: 9 });
    expect(currRes.status, JSON.stringify(currRes.body)).toBe(201);
    const curriculumId = (currRes.body as { id: string }).id;

    for (const actor of [{ id: adminId, token: admin }, teacher]) {
      const bank = await personalBank(actor.token, 'matrix', actor.id);
      expect(bank, 'phải có bank ma trận cá nhân').toBeTruthy();
      expect(bank!.ownerId).toBe(actor.id);
      expect(bank!.capabilities.matrixView).toBe(true);
      expect(bank!.capabilities.matrixManage).toBe(true);
      expect(bank!.capabilities.matrixCopy).toBe(true);
      expect(bank!.capabilities.matrixShare).toBe(true);
      expect(bank!.capabilities.matrixModerate).toBe(true);
      const listRes = await http(app).get(`/api/v1/question-banks/${bank!.id}/matrices`).set(bearer(actor.token));
      expect(listRes.status, JSON.stringify(listRes.body)).toBe(200);
      const createRes = await http(app).post('/api/v1/exam-matrices').set(bearer(actor.token)).send({
        name: uniqueName('Ma trận parity'), subjectId, curriculumId, bankId: bank!.id, status: 'draft',
      });
      expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
      expect((createRes.body as { bankId: string }).bankId).toBe(bank!.id);
    }
  });

  it('bank đề cá nhân ở tầng bank (kind=exam, nền EB-1): admin bằng giáo viên', async () => {
    const teacher = await mkTeacher();
    for (const actor of [{ id: adminId, token: admin }, teacher]) {
      const bank = await personalBank(actor.token, 'exam', actor.id);
      expect(bank, 'phải có bank đề cá nhân ở tầng bank').toBeTruthy();
      expect(bank!.ownerId).toBe(actor.id);
      expect(bank!.capabilities.use).toBe(true);
      expect(bank!.capabilities.add).toBe(true);
    }
  });

  it('đối chứng âm: người dùng thường vẫn không có bank cá nhân (cổng staff giữ nguyên)', async () => {
    const plain = await mkUser();
    for (const kind of ['question', 'matrix', 'exam']) {
      const bank = await personalBank(plain.token, kind, plain.id);
      expect(bank, `người thường không được có bank cá nhân kind=${kind}`).toBeUndefined();
    }
  });
});
