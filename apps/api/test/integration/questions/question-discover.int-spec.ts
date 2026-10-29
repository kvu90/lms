import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContextsService } from '../../../src/modules/access/contexts.service';
import { CONTEXT_LEVELS } from '../../../src/modules/access/domain/capabilities';
import { QuestionBanksService } from '../../../src/modules/questions/question-banks.service';
import {
  STRONG_PASSWORD, adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse } from '../../support/course-enrolment-helpers';
import { createReadyQuestion } from '../../support/exam-pin-helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Đặc trưng hoá DL-04 (issue #489): trang khám phá ngân hàng suy bank
 * của từng category — bank tường minh qua bank_id, bank suy từ context
 * khoá cho category cũ chưa gắn bank_id — và luật hiển thị câu chưa
 * ready (chỉ tác giả hoặc người duyệt của bank). Các khẳng định chạy
 * trên hành vi HIỆN TẠI và phải giữ nguyên khi phép suy chuyển sang
 * nạp theo tập thay cho vòng lặp cặp category × bank.
 */
describe('Questions: đặc trưng hoá khám phá ngân hàng (DL-04, issue #489)', () => {
  let app: INestApplication;
  let pg: Client;
  let banks: QuestionBanksService;
  let teacher1Id = '';
  let teacher2Id = '';
  const teacher1Questions: string[] = [];
  let draftQuestionId = '';
  let teacher2QuestionId = '';
  let legacyQuestionId = '';
  let courseBankId = '';

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    banks = app.get(QuestionBanksService, { strict: false });
    const admin = await adminToken(app);
    const adminUser = (await http(app).get('/api/v1/users/me').set(bearer(admin))).body as { id: string };

    const teacher1 = await createUserViaApi(app, admin);
    const teacher2 = await createUserViaApi(app, admin);
    teacher1Id = teacher1.id;
    teacher2Id = teacher2.id;
    const contextsRes = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const systemCtx = (contextsRes.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const teacherRoleId = await roleIdByShortname(app, admin, 'teacher');
    await assignRole(app, admin, teacher1.id, teacherRoleId, systemCtx.id);
    await assignRole(app, admin, teacher2.id, teacherRoleId, systemCtx.id);
    await banks.ensurePersonalBank(teacher1.id);
    await banks.ensurePersonalBank(teacher2.id);
    const teacher1Token = (await login(app, teacher1.username, STRONG_PASSWORD)).accessToken;
    const teacher2Token = (await login(app, teacher2.username, STRONG_PASSWORD)).accessToken;

    // Giáo viên 1: ba câu ready trong bank cá nhân; câu thứ ba bị hạ
    // xuống trạng thái draft ở tầng entry để kiểm luật hiển thị.
    for (const name of ['DL04 một', 'DL04 hai', 'DL04 ba']) {
      teacher1Questions.push(await createReadyQuestion(app, teacher1Token, name));
    }
    draftQuestionId = teacher1Questions[2]!;
    await pg.query(`update question_bank_entries set status = 'draft' where question_id = $1`, [draftQuestionId]);

    // Giáo viên 2: một câu ready trong bank cá nhân của mình.
    teacher2QuestionId = await createReadyQuestion(app, teacher2Token, 'DL04 của GV2');

    // Category cũ của khoá học: bank khoá được dựng, câu hỏi nằm trong
    // category mặc định của bank, rồi category bị tách bank_id và trỏ
    // thẳng về context khoá (dữ kiện đời cũ trước QB-1) — khám phá vẫn
    // phải gán câu về đúng bank khoá qua phép suy context.
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const courseBank = await banks.ensureCourseBank(adminUser.id, course.id);
    courseBankId = courseBank.id;
    const bankView = await banks.getBank(adminUser.id, courseBank.id);
    const legacyCategoryId = bankView.defaultCategoryId!;
    const contexts = app.get(ContextsService, { strict: false });
    const courseCtx = await contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, course.id);
    const res = await http(app).post('/api/v1/questions').set(bearer(admin)).send({
      categoryId: legacyCategoryId, qtype: 'multichoice', questionText: 'Thân câu DL04 legacy?',
      answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Khác 1', correct: false }, { text: 'Khác 2', correct: false }],
    });
    if (res.status !== 201) throw new Error(`create legacy question failed: ${res.status} ${JSON.stringify(res.body)}`);
    legacyQuestionId = (res.body as { question: { id: string } }).question.id;
    await pg.query(
      `update question_categories set bank_id = null, context_id = $2 where id = $1`,
      [legacyCategoryId, courseCtx!.id],
    );
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('tác giả thấy đủ câu của bank mình kể cả câu đang draft, kèm đúng bank sở hữu', async () => {
    const items = await banks.discover(teacher1Id, {});
    const mine = items.filter((i) => teacher1Questions.includes(i.questionId));
    expect(mine.map((i) => i.questionId).sort()).toEqual([...teacher1Questions].sort());
    for (const item of mine) {
      expect(item.bankScope).toBe('personal');
      expect(item.authorId).toBe(teacher1Id);
    }
    const draft = mine.find((i) => i.questionId === draftQuestionId)!;
    expect(draft.status).toBe('draft');
  });

  it('người ngoài bank cá nhân không thấy câu draft của người khác trong khám phá', async () => {
    const items = await banks.discover(teacher2Id, {});
    expect(items.map((i) => i.questionId)).not.toContain(draftQuestionId);
    // Câu ready của chính giáo viên 2 vẫn xuất hiện trong khám phá của mình.
    expect(items.map((i) => i.questionId)).toContain(teacher2QuestionId);
  });

  it('quản trị thấy câu legacy thuộc bank khoá khi khám phá toàn bộ hoặc lọc theo bank khoá', async () => {
    const admin = await adminToken(app);
    const me = (await http(app).get('/api/v1/users/me').set(bearer(admin))).body as { id: string };
    const all = await banks.discover(me.id, {});
    const legacy = all.find((i) => i.questionId === legacyQuestionId);
    expect(legacy).toBeDefined();
    expect(legacy!.bankId).toBe(courseBankId);
    expect(legacy!.bankScope).toBe('course');
    const filtered = await banks.discover(me.id, { bankId: courseBankId });
    expect(filtered.map((i) => i.questionId)).toEqual([legacyQuestionId]);
  });

  it('kết quả khám phá giữ thứ tự useCount giảm dần rồi copyCount giảm dần, hoà thì theo thứ tự nạp', async () => {
    const admin = await adminToken(app);
    const me = (await http(app).get('/api/v1/users/me').set(bearer(admin))).body as { id: string };
    const items = await banks.discover(me.id, {});
    for (let i = 1; i < items.length; i += 1) {
      const prev = items[i - 1]!;
      const cur = items[i]!;
      expect(prev.useCount > cur.useCount
        || (prev.useCount === cur.useCount && prev.copyCount >= cur.copyCount)).toBe(true);
    }
    // Mọi câu của spec này đều chưa dùng trong đề: useCount và copyCount bằng 0.
    const own = items.filter((i) => [...teacher1Questions, teacher2QuestionId, legacyQuestionId].includes(i.questionId));
    expect(own.every((i) => i.useCount === 0 && i.copyCount === 0)).toBe(true);
  });
});
