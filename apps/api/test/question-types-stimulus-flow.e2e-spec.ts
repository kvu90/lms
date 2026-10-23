import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';

/**
 * Dạng câu hỏi chuẩn + ngữ liệu (stimulus) — flow nghiệp vụ.
 * Oracle:
 *  - Cấu trúc lưu trữ + chấm: mã nguồn Moodle (bản main, đọc 23/10/2026):
 *    public/question/type/multichoice/question.php (grade_response single:
 *    fraction của đáp án đã chọn; multiple: tổng fraction kẹp [0, 1]),
 *    public/question/type/multichoice/tests/question_multi_test.php +
 *    helper test_question_maker (fixture A 0.5 / B -1 / C 0.5 / D -1),
 *    public/question/type/truefalse/question.php,
 *    public/question/type/shortanswer/question.php +
 *    tests/question_test.php (compare_string_with_wildcard) và chiến lược
 *    khớp đầu tiên question_first_matching_answer_grading_strategy,
 *    public/question/type/essay/question.php (không tự chấm → needsgrading),
 *    public/question/engine/states.php (graded_state_for_fraction).
 *  - Stimulus + chùm câu quanh ngữ liệu: mô hình của repo giaokhoa của
 *    Lão gia (stimulus độc lập, bất biến khi đã được tham chiếu, snapshot
 *    khi vào đề) — bên LMS diễn đạt chùm true_false bằng 1 stimulus + nhiều
 *    câu truefalse đơn cùng tham chiếu, và tính bất biến do chuỗi pin
 *    attempt → version → stimulus bảo đảm (không cần snapshot riêng).
 *  - Điểm tuyệt đối gắn lúc ra đề: public/question/engine/
 *    questionattempt.php (maxmark của slot, fallback defaultmark).
 */

interface DocLike { content: { content?: { text?: string }[] }[] }
const docText = (doc: DocLike) => (doc.content ?? []).map((p) => (p.content ?? []).map((t) => t.text ?? '').join('')).join('\n');

describe('Question types & stimulus', () => {
  let app: INestApplication;
  let admin: string;
  let studentToken: string;
  let systemCtxId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const student = await createUserViaApi(app, admin);
    studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const ctxRes = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    systemCtxId = (ctxRes.body as { id: string; contextlevel: number }[]).find((c) => c.contextlevel === 10)!.id;
  });
  afterAll(async () => { await app.close(); });

  async function createCategory(name: string): Promise<string> {
    const res = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name, contextid: systemCtxId });
    expect(res.status).toBeLessThan(300);
    return res.body.id as string;
  }

  async function createQuestion(body: Record<string, unknown>): Promise<{ status: number; body: never }> {
    const res = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`).send(body);
    return res as never;
  }

  /** Chạy trọn một lượt làm cho một câu: usage 1 slot → start → submit → finish; trả attempt đã chốt. */
  async function runAttempt(questionId: string, response: string | null, maxmark?: number): Promise<Record<string, never>> {
    const usageRes = await http(app).post('/api/v1/question-usages').set('Authorization', `Bearer ${admin}`)
      .send({ component: 'mod_quiz', slots: [{ questionId, ...(maxmark !== undefined ? { maxmark } : {}) }] });
    expect(usageRes.status).toBeLessThan(300);
    const usageId = usageRes.body.usage.id as string;
    const attemptId = usageRes.body.attempts[0].id as string;
    await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/start`).set('Authorization', `Bearer ${studentToken}`);
    if (response !== null) {
      const submit = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/submit`)
        .set('Authorization', `Bearer ${studentToken}`).send({ response });
      expect(submit.status).toBeLessThan(300);
    }
    const finished = await http(app).post(`/api/v1/question-usages/${usageId}/finish`).set('Authorization', `Bearer ${studentToken}`);
    expect(finished.status).toBeLessThan(300);
    expect(finished.body.state).toBe('finished');
    return finished.body.attempts[0];
  }

  it('stimulus lifecycle: create → attach → immutable once referenced; free stimulus stays editable and deletable', async () => {
    const categoryId = await createCategory('Stimulus cat');
    const stimRes = await http(app).post('/api/v1/stimuli').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId, content: 'Đọc đoạn văn sau và trả lời các câu hỏi.' });
    expect(stimRes.status).toBeLessThan(300);
    const stimulusId = stimRes.body.id as string;
    // Nội dung chuỗi thuần được chuẩn hoá thành tài liệu Tiptap khi lưu.
    expect(docText(stimRes.body.content)).toBe('Đọc đoạn văn sau và trả lời các câu hỏi.');
    expect(stimRes.body.categoryid).toBe(categoryId);

    const q = await createQuestion({
      categoryId, qtype: 'truefalse', name: 'Câu gắn ngữ liệu', questiontext: 'Đoạn văn nói trời đang mưa.',
      stimulusId, answer: { correct: true },
    });
    expect(q.status).toBeLessThan(300);
    expect((q.body as { stimulus: { id: string } }).stimulus.id).toBe(stimulusId);
    expect((q.body as { latestVersion: { stimulusid: string } }).latestVersion.stimulusid).toBe(stimulusId);

    // Đã có version tham chiếu: sửa và xoá đều bị cấm.
    const patch = await http(app).patch(`/api/v1/stimuli/${stimulusId}`).set('Authorization', `Bearer ${admin}`)
      .send({ content: 'Nội dung khác.' });
    expect(patch.status).toBe(400);
    expect(patch.body.code).toBe('stimulus_in_use');
    const del = await http(app).delete(`/api/v1/stimuli/${stimulusId}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(400);
    expect(del.body.code).toBe('stimulus_in_use');

    // Stimulus chưa được tham chiếu: sửa và xoá tự do.
    const freeRes = await http(app).post('/api/v1/stimuli').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId, content: 'Ngữ liệu nháp.' });
    const freeId = freeRes.body.id as string;
    const freePatch = await http(app).patch(`/api/v1/stimuli/${freeId}`).set('Authorization', `Bearer ${admin}`)
      .send({ content: 'Ngữ liệu nháp đã sửa.' });
    expect(freePatch.status).toBe(200);
    expect(docText(freePatch.body.content)).toBe('Ngữ liệu nháp đã sửa.');
    const freeDel = await http(app).delete(`/api/v1/stimuli/${freeId}`).set('Authorization', `Bearer ${admin}`);
    expect(freeDel.status).toBe(200);
    const gone = await http(app).get(`/api/v1/stimuli/${freeId}`).set('Authorization', `Bearer ${admin}`);
    expect(gone.status).toBe(404);
  });

  it('stimulus sharing is scoped to its category: attaching across categories is refused', async () => {
    const catA = await createCategory('Stimulus scope A');
    const catB = await createCategory('Stimulus scope B');
    const stim = await http(app).post('/api/v1/stimuli').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: catA, content: 'Ngữ liệu của A.' });
    const res = await createQuestion({
      categoryId: catB, qtype: 'truefalse', name: 'Gắn chéo', questiontext: 'X?',
      stimulusId: stim.body.id, answer: { correct: false },
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('question.stimulus_category_mismatch');
    // Học viên không có quyền tạo ngữ liệu/câu hỏi ở category hệ thống.
    const forbidden = await http(app).post('/api/v1/stimuli').set('Authorization', `Bearer ${studentToken}`)
      .send({ categoryId: catA, content: 'Lách quyền.' });
    expect(forbidden.status).toBe(403);
  });

  it('a stimulus cluster: several single truefalse questions share one stimulus and grade independently', async () => {
    const categoryId = await createCategory('Cluster cat');
    const stim = await http(app).post('/api/v1/stimuli').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId, content: 'Trời mưa to. Đường phố ngập nước. Mọi người ở trong nhà.' });
    const stimulusId = stim.body.id as string;
    const mk = (name: string, text: string, correct: boolean) => createQuestion({
      categoryId, qtype: 'truefalse', name, questiontext: text, stimulusId, answer: { correct },
    });
    const q1 = await mk('Mệnh đề 1', 'Trời đang mưa.', true);
    const q2 = await mk('Mệnh đề 2', 'Đường phố khô ráo.', false);
    const q3 = await mk('Mệnh đề 3', 'Mọi người ra đường đông đúc.', false);
    for (const q of [q1, q2, q3]) expect(q.status).toBeLessThan(300);
    const ids = [q1, q2, q3].map((q) => (q.body as { question: { id: string } }).question.id);

    const usageRes = await http(app).post('/api/v1/question-usages').set('Authorization', `Bearer ${admin}`)
      .send({ component: 'mod_quiz', slots: ids.map((questionId) => ({ questionId })) });
    const usageId = usageRes.body.usage.id as string;
    await http(app).post(`/api/v1/question-usages/${usageId}/start`).set('Authorization', `Bearer ${studentToken}`);
    const answers: Record<string, string> = { [ids[0]!]: 'true', [ids[1]!]: 'false', [ids[2]!]: 'true' };
    for (const attempt of usageRes.body.attempts as { id: string; questionid: string }[]) {
      await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attempt.id}/submit`)
        .set('Authorization', `Bearer ${studentToken}`).send({ response: answers[attempt.questionid] });
    }
    const finished = await http(app).post(`/api/v1/question-usages/${usageId}/finish`).set('Authorization', `Bearer ${studentToken}`);
    expect(finished.body.state).toBe('finished');
    const byQuestion = new Map((finished.body.attempts as { questionid: string; state: string; fraction: number }[])
      .map((a) => [a.questionid, a]));
    expect(byQuestion.get(ids[0]!)?.state).toBe('gradedright');
    expect(byQuestion.get(ids[1]!)?.state).toBe('gradedright');
    expect(byQuestion.get(ids[2]!)?.state).toBe('gradedwrong');
  });

  it('multichoice single: grading takes the chosen answer fraction; slot maxmark carries the absolute mark', async () => {
    const categoryId = await createCategory('MC single cat');
    const q = await createQuestion({
      categoryId, qtype: 'multichoice', name: 'Thủ đô', questiontext: 'Thủ đô của Pháp là?',
      answers: [
        { text: 'Paris', fraction: 1 },
        { text: 'London', fraction: 0 },
        { text: 'Berlin', fraction: 0 },
      ],
      options: { single: true },
    });
    expect(q.status).toBeLessThan(300);
    const answers = (q.body as { answers: { id: string; answer: DocLike; fraction: number }[] }).answers;
    expect(answers).toHaveLength(3);
    const paris = answers.find((a) => docText(a.answer) === 'Paris')!;
    const london = answers.find((a) => docText(a.answer) === 'London')!;
    const right = await runAttempt((q.body as { question: { id: string } }).question.id, paris.id, 5);
    expect(right.state).toBe('gradedright');
    expect(right.fraction).toBe(1);
    // Điểm tuyệt đối gắn lúc ra đề: slot ghi maxmark 5 (mặc định của câu là 1).
    expect(right.maxmark).toBe(5);
    const wrong = await runAttempt((q.body as { question: { id: string } }).question.id, london.id);
    expect(wrong.state).toBe('gradedwrong');
    expect(wrong.fraction).toBe(0);
    expect(wrong.maxmark).toBe(1); // fallback defaultmark khi slot không ghi maxmark
  });

  it('multichoice validation: fewer than two choices or positive fractions not adding to 1 are refused', async () => {
    const categoryId = await createCategory('MC validation cat');
    const one = await createQuestion({
      categoryId, qtype: 'multichoice', name: 'Một lựa chọn', questiontext: '?',
      answers: [{ text: 'A', fraction: 1 }],
    });
    expect(one.status).toBe(400);
    expect((one.body as { code: string }).code).toBe('question.bad_answer_data');
    const badSum = await createQuestion({
      categoryId, qtype: 'multichoice', name: 'Tổng sai', questiontext: '?',
      answers: [{ text: 'A', fraction: 0.6 }, { text: 'B', fraction: 0 }],
    });
    expect(badSum.status).toBe(400);
    expect((badSum.body as { code: string }).code).toBe('question.bad_answer_data');
  });

  it('multichoice multiple: fractions sum with clamping, following the Moodle multi fixture', async () => {
    const categoryId = await createCategory('MC multi cat');
    const q = await createQuestion({
      categoryId, qtype: 'multichoice', name: 'Chọn A và C', questiontext: 'The answer is A and C.',
      answers: [
        { text: 'A', fraction: 0.5 },
        { text: 'B', fraction: -1 },
        { text: 'C', fraction: 0.5 },
        { text: 'D', fraction: -1 },
      ],
      options: { single: false },
    });
    expect(q.status).toBeLessThan(300);
    const qid = (q.body as { question: { id: string } }).question.id;
    const byText = new Map((q.body as { answers: { id: string; answer: DocLike }[] }).answers.map((a) => [docText(a.answer), a.id]));
    const ac = await runAttempt(qid, `${byText.get('A')},${byText.get('C')}`);
    expect(ac).toMatchObject({ state: 'gradedright', fraction: 1 });
    const abc = await runAttempt(qid, `${byText.get('A')},${byText.get('B')},${byText.get('C')}`);
    expect(abc).toMatchObject({ state: 'gradedwrong', fraction: 0 });
    const aOnly = await runAttempt(qid, `${byText.get('A')}`);
    expect(aOnly).toMatchObject({ state: 'gradedpartial', fraction: 0.5 });
  });

  it('shortanswer: first matching answer wins and wildcards match (Moodle shortanswer semantics)', async () => {
    const categoryId = await createCategory('Shortanswer cat');
    const q = await createQuestion({
      categoryId, qtype: 'shortanswer', name: 'Con ếch tiếng Anh', questiontext: 'Con ếch tiếng Anh là gì?',
      answers: [
        { text: 'frog', fraction: 0.5 },
        { text: 'frog', fraction: 1 },
        { text: 'F*og', fraction: 1 },
      ],
      options: { usecase: false },
    });
    expect(q.status).toBeLessThan(300);
    const qid = (q.body as { question: { id: string } }).question.id;
    // Khớp đầu tiên theo thứ tự lưu: 'frog' fraction 0.5 thắng, dù đáp án sau cho 1.
    const first = await runAttempt(qid, 'FROG');
    expect(first).toMatchObject({ state: 'gradedpartial', fraction: 0.5 });
    // Wildcard: 'Fat dog' khớp mẫu 'F*og'.
    const wild = await runAttempt(qid, 'Fat dog');
    expect(wild).toMatchObject({ state: 'gradedright', fraction: 1 });
    const none = await runAttempt(qid, 'toad');
    expect(none).toMatchObject({ state: 'gradedwrong', fraction: 0 });
  });

  it('shortanswer usecase: case-sensitive grading; the legacy payload still maps onto answers/options', async () => {
    const categoryId = await createCategory('Shortanswer case cat');
    const legacy = await createQuestion({
      categoryId, qtype: 'shortanswer', name: 'Thủ đô (legacy)', questiontext: 'Thủ đô của Pháp?',
      answer: { answers: ['Paris'], casesensitive: true },
    });
    expect(legacy.status).toBeLessThan(300);
    expect((legacy.body as { options: { usecase: boolean } }).options.usecase).toBe(true);
    expect((legacy.body as { answers: { fraction: number }[] }).answers[0]?.fraction).toBe(1);
    const qid = (legacy.body as { question: { id: string } }).question.id;
    expect(await runAttempt(qid, 'paris')).toMatchObject({ state: 'gradedwrong', fraction: 0 });
    expect(await runAttempt(qid, 'Paris')).toMatchObject({ state: 'gradedright', fraction: 1 });
  });

  it('essay: options carry grader info and response template; attempts land in needsgrading with no auto fraction', async () => {
    const categoryId = await createCategory('Essay cat');
    const q = await createQuestion({
      categoryId, qtype: 'essay', name: 'Tự luận môi trường', questiontext: 'Phân tích nguyên nhân ô nhiễm không khí đô thị.',
      guidance: 'Đọc kỹ yêu cầu trước khi viết.',
      options: {
        responseformat: 'editor', responsefieldlines: 20, minwordlimit: 10, maxwordlimit: 500,
        graderinfo: 'Chấm theo 3 ý chính: giao thông, công nghiệp, xây dựng.',
        responsetemplate: 'Mở bài: ... Thân bài: ... Kết luận: ...',
      },
    });
    expect(q.status).toBeLessThan(300);
    const body = q.body as { options: { graderinfo: DocLike; responsetemplate: DocLike; minwordlimit: number }; latestVersion: { guidance: DocLike } };
    expect(docText(body.options.graderinfo)).toContain('3 ý chính');
    expect(docText(body.options.responsetemplate)).toContain('Thân bài');
    expect(body.options.minwordlimit).toBe(10);
    expect(docText(body.latestVersion.guidance)).toBe('Đọc kỹ yêu cầu trước khi viết.');
    const attempt = await runAttempt((q.body as { question: { id: string } }).question.id,
      'Ô nhiễm không khí đô thị xuất phát từ khí thải giao thông, hoạt động công nghiệp và bụi xây dựng chưa được kiểm soát tốt.');
    expect(attempt.state).toBe('needsgrading');
    expect(attempt.fraction).toBeNull();
  });

  it('essay validation: answers are refused and inverted word limits are refused', async () => {
    const categoryId = await createCategory('Essay validation cat');
    const withAnswers = await createQuestion({
      categoryId, qtype: 'essay', name: 'Sai cấu trúc', questiontext: '?',
      answers: [{ text: 'Đáp án mẫu', fraction: 1 }],
    });
    expect(withAnswers.status).toBe(400);
    const inverted = await createQuestion({
      categoryId, qtype: 'essay', name: 'Giới hạn ngược', questiontext: '?',
      options: { minwordlimit: 100, maxwordlimit: 10 },
    });
    expect(inverted.status).toBe(400);
  });

  it('rich text questiontext: a Tiptap document round-trips; documents outside the text slice are refused', async () => {
    const categoryId = await createCategory('Rich text cat');
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Chọn đáp án ', }, { type: 'text', text: 'đúng nhất', marks: [{ type: 'bold' }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Câu hỏi có hai đoạn.' }] },
      ],
    };
    const q = await createQuestion({
      categoryId, qtype: 'multichoice', name: 'Rich', questiontext: doc,
      answers: [{ text: 'Đúng', fraction: 1 }, { text: 'Sai', fraction: 0 }],
    });
    expect(q.status).toBeLessThan(300);
    expect(docText((q.body as { latestVersion: { questiontext: DocLike } }).latestVersion.questiontext)).toBe('Chọn đáp án đúng nhất\nCâu hỏi có hai đoạn.');
    const withImage = await createQuestion({
      categoryId, qtype: 'multichoice', name: 'Có ảnh', questiontext: { type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] },
      answers: [{ text: 'A', fraction: 1 }, { text: 'B', fraction: 0 }],
    });
    expect(withImage.status).toBe(400); // lát đầu chưa có node image — hợp đồng tài liệu từ chối
  });

  it('editing without answers clones the previous version content into the new version with fresh rows', async () => {
    const categoryId = await createCategory('Clone cat');
    const q = await createQuestion({
      categoryId, qtype: 'multichoice', name: 'Clone', questiontext: 'Phiên bản 1',
      answers: [{ text: 'Đúng', fraction: 1 }, { text: 'Sai', fraction: 0 }],
      options: { single: true, shuffleanswers: true },
    });
    const qid = (q.body as { question: { id: string } }).question.id;
    const v1AnswerIds = (q.body as { answers: { id: string }[] }).answers.map((a) => a.id);
    const edit = await http(app).patch(`/api/v1/questions/${qid}`).set('Authorization', `Bearer ${admin}`)
      .send({ questiontext: 'Phiên bản 2' });
    expect(edit.status).toBe(200);
    expect(edit.body.entry.latestversion).toBe(2);
    const v2Answers = edit.body.answers as { id: string; fraction: number; answer: DocLike }[];
    expect(v2Answers).toHaveLength(2);
    expect(v2Answers.map((a) => a.fraction)).toEqual([1, 0]);
    for (const a of v2Answers) expect(v1AnswerIds).not.toContain(a.id); // hàng mới, id mới
    expect(edit.body.options.shuffleanswers).toBe(true);
    // Lượt làm trên v2 dùng id đáp án của v2 và chấm đúng.
    const rightId = v2Answers.find((a) => docText(a.answer) === 'Đúng')!.id;
    expect(await runAttempt(qid, rightId)).toMatchObject({ state: 'gradedright', fraction: 1 });
  });
});
