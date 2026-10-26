import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuestionsService } from '../src/modules/questions/questions.service';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';

/**
 * Dạng câu hỏi chuẩn + ngữ liệu (stimulus) — flow nghiệp vụ theo MÔ
 * HÌNH GIAOKHOA (quyết 12:04 + 12:12 ngày 26/10/2026, đợt port #248):
 *  - Câu hỏi KHÔNG có tên; đáp án chỉ mang cờ đúng/sai nhị phân
 *    (`correct` ở payload, `isCorrect` ở view) — KHÔNG còn tỉ trọng
 *    fraction của đáp án; chấm tự động là nhị phân 1/0.
 *  - multichoice: đúng 4 lựa chọn, đúng MỘT đáp án đúng, chọn một đáp
 *    án; chọn nhiều đáp án bị chấm 0.
 *  - truefalse (TF-A): MỘT câu gồm thân chung + đúng 4 mệnh đề trong
 *    thân câu; đáp án Đ/S của từng mệnh đề ở `solution.answers` phía
 *    đáp án; chấm theo thang Đ–S của lần dùng.
 *  - shortanswer: khớp CHÍNH XÁC sau chuẩn hoá (hoa/thường theo
 *    useCase) — ký tự đại diện `*` đã bỏ hẳn (điểm quyết D-2).
 *  - essay: không tự chấm → needsgrading; guidance nằm ở bản ghi phía
 *    đáp án (`answerKey`) cùng lời giải mẫu, KHÔNG còn trên version.
 *  - Stimulus quanh ngữ liệu: mô hình của repo giaokhoa của Lão gia
 *    (stimulus độc lập, bất biến khi đã được tham chiếu); nhiều câu
 *    (kể cả câu TF-A) cùng tham chiếu một stimulus và chấm độc lập,
 *    tính bất biến do chuỗi pin attempt → version → stimulus bảo đảm
 *    (không cần snapshot riêng).
 *  - Điểm tuyệt đối gắn lúc ra đề: maxMark của slot, fallback
 *    defaultMark của câu.
 */

interface DocLike { content: { content?: { text?: string }[] }[] }
const docText = (doc: DocLike) => (doc.content ?? []).map((p) => (p.content ?? []).map((t) => t.text ?? '').join('')).join('\n');

describe('Question types & stimulus', () => {
  let app: INestApplication;
  let admin: string;
  let studentToken: string;
  let studentId: string;
  let systemCtxId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const student = await createUserViaApi(app, admin);
    studentId = student.id;
    studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const ctxRes = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    systemCtxId = (ctxRes.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!.id;
  });
  afterAll(async () => { await app.close(); });

  async function createCategory(name: string): Promise<string> {
    const res = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name, contextId: systemCtxId });
    expect(res.status).toBeLessThan(300);
    return res.body.id as string;
  }


  // Payload câu TF-A: thân là `stem`, 4 mệnh đề mang cùng giá trị
  // `allValue`; response đúng toàn phần là JSON map cả 4 ý theo giá trị đó.
  const tfBody = (stem: string, allValue: boolean, stimulusId?: string) => ({
    qtype: 'truefalse',
    questionText: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: stem }] },
        {
          type: 'statementList',
          content: [1, 2, 3, 4].map((i) => ({
            type: 'statement',
            attrs: { id: `s${i}` },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `${stem} — ý ${i}` }] }],
          })),
        },
      ],
    },
    solution: { answers: [1, 2, 3, 4].map((i) => ({ statementId: `s${i}`, value: allValue })) },
    ...(stimulusId ? { stimulusId } : {}),
  });
  const tfResponse = (value: boolean) => JSON.stringify({ s1: value, s2: value, s3: value, s4: value });

  async function createQuestion(body: Record<string, unknown>): Promise<{ status: number; body: never }> {
    const res = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`).send(body);
    return res as never;
  }

  /** Chạy trọn một lượt làm cho một câu: usage 1 slot → start → submit → finish; trả attempt đã chốt. */
  async function runAttempt(questionId: string, response: string | null, maxMark?: number): Promise<Record<string, never>> {
    // Mẫu dựng sau khi #60 (chủ sở hữu) + #55 (cổng tạo usage qua HTTP
    // đòi question:useall) cùng có mặt: usage của lượt làm do hoạt động
    // tạo ở tầng service với actor là chính học sinh — chủ sở hữu là học
    // sinh nên start/submit/finish qua route thô bình thường; tạo qua
    // HTTP bằng tài khoản học sinh bị cổng #55 chặn 404 (đúng chủ đích:
    // usage thô qua HTTP là đường đọc đáp án, chỉ đội ngân hàng dùng).
    const created = await app.get(QuestionsService).createUsage(studentId, {
      component: 'mod_quiz', slots: [{ questionId, ...(maxMark !== undefined ? { maxMark } : {}) }],
    });
    const usageId = created.usage.id as string;
    const attemptId = created.attempts[0].id as string;
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
    expect(stimRes.body.categoryId).toBe(categoryId);

    const q = await createQuestion({
      categoryId, ...tfBody('Đoạn văn nói trời đang mưa.', true, stimulusId),
    });
    expect(q.status).toBeLessThan(300);
    expect((q.body as { stimulus: { id: string } }).stimulus.id).toBe(stimulusId);
    expect((q.body as { latestVersion: { stimulusId: string } }).latestVersion.stimulusId).toBe(stimulusId);

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
      categoryId: catB, ...tfBody('X?', false, stim.body.id),
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('question.stimulus_category_mismatch');
    // Học viên không có quyền tạo ngữ liệu/câu hỏi ở category hệ thống.
    const forbidden = await http(app).post('/api/v1/stimuli').set('Authorization', `Bearer ${studentToken}`)
      .send({ categoryId: catA, content: 'Lách quyền.' });
    expect(forbidden.status).toBe(403);
  });

  it('a stimulus cluster: several TF-A questions share one stimulus and grade independently', async () => {
    const categoryId = await createCategory('Cluster cat');
    const stim = await http(app).post('/api/v1/stimuli').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId, content: 'Trời mưa to. Đường phố ngập nước. Mọi người ở trong nhà.' });
    const stimulusId = stim.body.id as string;
    const mk = (text: string, correct: boolean) => createQuestion({
      categoryId, ...tfBody(text, correct, stimulusId),
    });
    const q1 = await mk('Trời đang mưa.', true);
    const q2 = await mk('Đường phố khô ráo.', false);
    const q3 = await mk('Mọi người ra đường đông đúc.', false);
    for (const q of [q1, q2, q3]) expect(q.status).toBeLessThan(300);
    const ids = [q1, q2, q3].map((q) => (q.body as { question: { id: string } }).question.id);

    // Usage chùm câu: dựng ở tầng service với actor là học sinh (như runAttempt).
    const created = await app.get(QuestionsService).createUsage(studentId, {
      component: 'mod_quiz', slots: ids.map((questionId) => ({ questionId })),
    });
    const usageId = created.usage.id as string;
    await http(app).post(`/api/v1/question-usages/${usageId}/start`).set('Authorization', `Bearer ${studentToken}`);
    const answers: Record<string, string> = { [ids[0]!]: tfResponse(true), [ids[1]!]: tfResponse(false), [ids[2]!]: tfResponse(true) };
    for (const attempt of created.attempts as { id: string; questionId: string }[]) {
      await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attempt.id}/submit`)
        .set('Authorization', `Bearer ${studentToken}`).send({ response: answers[attempt.questionId] });
    }
    const finished = await http(app).post(`/api/v1/question-usages/${usageId}/finish`).set('Authorization', `Bearer ${studentToken}`);
    expect(finished.body.state).toBe('finished');
    const byQuestion = new Map((finished.body.attempts as { questionId: string; state: string; fraction: number }[])
      .map((a) => [a.questionId, a]));
    expect(byQuestion.get(ids[0]!)?.state).toBe('gradedright');
    expect(byQuestion.get(ids[1]!)?.state).toBe('gradedright');
    expect(byQuestion.get(ids[2]!)?.state).toBe('gradedwrong');
  });

  it('multichoice: chọn đúng đáp án đúng duy nhất được trọn điểm của slot; chọn đáp án sai được 0', async () => {
    const categoryId = await createCategory('MC single cat');
    const q = await createQuestion({
      categoryId, qtype: 'multichoice', questionText: 'Thủ đô của Pháp là?',
      answers: [
        { text: 'Paris', correct: true },
        { text: 'London', correct: false },
        { text: 'Berlin', correct: false },
        { text: 'Madrid', correct: false },
      ],
    });
    expect(q.status).toBeLessThan(300);
    const answers = (q.body as { answers: { id: string; answer: DocLike; isCorrect: boolean }[] }).answers;
    expect(answers).toHaveLength(4);
    // Đáp án đúng nằm ở cờ isCorrect của đúng một dòng — view không còn fraction của đáp án.
    expect(answers.filter((a) => a.isCorrect)).toHaveLength(1);
    for (const a of answers) expect(a).not.toHaveProperty('fraction');
    const paris = answers.find((a) => docText(a.answer) === 'Paris')!;
    const london = answers.find((a) => docText(a.answer) === 'London')!;
    const right = await runAttempt((q.body as { question: { id: string } }).question.id, paris.id, 5);
    expect(right.state).toBe('gradedright');
    expect(right.fraction).toBe(1);
    // Điểm tuyệt đối gắn lúc ra đề: slot ghi maxMark 5 (mặc định của câu là 1).
    expect(right.maxMark).toBe(5);
    const wrong = await runAttempt((q.body as { question: { id: string } }).question.id, london.id);
    expect(wrong.state).toBe('gradedwrong');
    expect(wrong.fraction).toBe(0);
    expect(wrong.maxMark).toBe(1); // fallback defaultMark khi slot không ghi maxMark
  });

  it('multichoice validation: không đúng 4 lựa chọn hoặc không đúng một đáp án đúng đều bị từ chối', async () => {
    const categoryId = await createCategory('MC validation cat');
    const one = await createQuestion({
      categoryId, qtype: 'multichoice', questionText: '?',
      answers: [{ text: 'A', correct: true }],
    });
    expect(one.status).toBe(400);
    const three = await createQuestion({
      categoryId, qtype: 'multichoice', questionText: '?',
      answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }, { text: 'C', correct: false }],
    });
    expect(three.status).toBe(400);
    const twoCorrect = await createQuestion({
      categoryId, qtype: 'multichoice', questionText: '?',
      answers: [
        { text: 'A', correct: true }, { text: 'B', correct: true },
        { text: 'C', correct: false }, { text: 'D', correct: false },
      ],
    });
    expect(twoCorrect.status).toBe(400);
    const noneCorrect = await createQuestion({
      categoryId, qtype: 'multichoice', questionText: '?',
      answers: [
        { text: 'A', correct: false }, { text: 'B', correct: false },
        { text: 'C', correct: false }, { text: 'D', correct: false },
      ],
    });
    expect(noneCorrect.status).toBe(400);
    // Tầng nghiệp vụ cũng giữ đúng luật này cho các đường không qua
    // HTTP (đây là cổng mà đường nạp nội bộ chạm phải): mã lỗi nghiệp
    // vụ của service là question.bad_answer_data.
    const me = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${admin}`);
    const svc = app.get(QuestionsService);
    await expect(svc.createQuestion(me.body.id as string, {
      categoryId, qtype: 'multichoice', questionText: '?',
      answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }],
    })).rejects.toMatchObject({ response: { code: 'question.bad_answer_data' } });
  });

  it('multichoice: chọn NHIỀU đáp án bị chấm 0 — mô hình chọn một đáp án, không cộng điểm từng phần', async () => {
    const categoryId = await createCategory('MC multi cat');
    const q = await createQuestion({
      categoryId, qtype: 'multichoice', questionText: 'Thủ đô của Pháp là?',
      answers: [
        { text: 'Paris', correct: true },
        { text: 'London', correct: false },
        { text: 'Berlin', correct: false },
        { text: 'Madrid', correct: false },
      ],
    });
    expect(q.status).toBeLessThan(300);
    const qid = (q.body as { question: { id: string } }).question.id;
    const byText = new Map((q.body as { answers: { id: string; answer: DocLike }[] }).answers.map((a) => [docText(a.answer), a.id]));
    // Chọn cả đáp án đúng lẫn đáp án sai trong một response → 0 điểm
    // (ca này phải đỏ nếu engine quay lại cộng tỉ trọng từng phần).
    const both = await runAttempt(qid, `${byText.get('Paris')},${byText.get('London')}`);
    expect(both).toMatchObject({ state: 'gradedwrong', fraction: 0 });
    const only = await runAttempt(qid, `${byText.get('Paris')}`);
    expect(only).toMatchObject({ state: 'gradedright', fraction: 1 });
  });

  it('shortanswer: khớp CHÍNH XÁC sau chuẩn hoá — lệch ký tự là 0 điểm, dấu * không còn là wildcard (D-2)', async () => {
    const categoryId = await createCategory('Shortanswer cat');
    const q = await createQuestion({
      categoryId, qtype: 'shortanswer', questionText: 'Con ếch tiếng Anh là gì?',
      answers: [
        { text: 'frog', correct: true },
        { text: 'toad', correct: true },
      ],
      options: { useCase: false },
    });
    expect(q.status).toBeLessThan(300);
    const qid = (q.body as { question: { id: string } }).question.id;
    // Không phân biệt hoa/thường khi useCase tắt.
    const exact = await runAttempt(qid, 'FROG');
    expect(exact).toMatchObject({ state: 'gradedright', fraction: 1 });
    // Đáp án đúng hiển thị là đáp án được chấp nhận đầu tiên theo thứ tự lưu.
    expect((exact as unknown as { rightAnswer: string }).rightAnswer).toBe('frog');
    // Mẫu 'F*og' KHÔNG còn khớp như wildcard: học sinh gõ nguyên văn
    // 'F*og' hay 'Fat dog' đều không ăn điểm.
    const wild = await runAttempt(qid, 'F*og');
    expect(wild).toMatchObject({ state: 'gradedwrong', fraction: 0 });
    const fatDog = await runAttempt(qid, 'Fat dog');
    expect(fatDog).toMatchObject({ state: 'gradedwrong', fraction: 0 });
    // Lệch một ký tự so với đáp án được chấp nhận → 0.
    const off = await runAttempt(qid, 'frogs');
    expect(off).toMatchObject({ state: 'gradedwrong', fraction: 0 });
  });

  it('shortanswer useCase: bật phân biệt hoa/thường — đáp án phải khớp đúng cả hoa/thường mới ăn điểm', async () => {
    const categoryId = await createCategory('Shortanswer case cat');
    const q = await createQuestion({
      categoryId, qtype: 'shortanswer', questionText: 'Thủ đô của Pháp?',
      answers: [{ text: 'Paris', correct: true }],
      options: { useCase: true },
    });
    expect(q.status).toBeLessThan(300);
    expect((q.body as { options: { useCase: boolean } }).options.useCase).toBe(true);
    expect((q.body as { answers: { isCorrect: boolean }[] }).answers[0]?.isCorrect).toBe(true);
    const qid = (q.body as { question: { id: string } }).question.id;
    expect(await runAttempt(qid, 'paris')).toMatchObject({ state: 'gradedwrong', fraction: 0 });
    expect(await runAttempt(qid, 'Paris')).toMatchObject({ state: 'gradedright', fraction: 1 });
  });

  it('essay: options carry grader info and response template; attempts land in needsgrading with no auto fraction', async () => {
    const categoryId = await createCategory('Essay cat');
    const q = await createQuestion({
      categoryId, qtype: 'essay', questionText: 'Phân tích nguyên nhân ô nhiễm không khí đô thị.',
      guidance: 'Đọc kỹ yêu cầu trước khi viết.',
      solution: { answer: 'Ba ý chính: khí thải giao thông, hoạt động công nghiệp, bụi xây dựng.' },
      options: {
        responseFormat: 'editor', responseFieldLines: 20, minWordLimit: 10, maxWordLimit: 500,
        graderInfo: 'Chấm theo 3 ý chính: giao thông, công nghiệp, xây dựng.',
        responseTemplate: 'Mở bài: ... Thân bài: ... Kết luận: ...',
      },
    });
    expect(q.status).toBeLessThan(300);
    const body = q.body as {
      options: { graderInfo: DocLike; responseTemplate: DocLike; minWordLimit: number };
      latestVersion: Record<string, unknown>;
      answerKey: { guidance: DocLike; solution: { answer: DocLike } };
    };
    expect(docText(body.options.graderInfo)).toContain('3 ý chính');
    expect(docText(body.options.responseTemplate)).toContain('Thân bài');
    expect(body.options.minWordLimit).toBe(10);
    // Guidance + lời giải mẫu nằm ở bản ghi phía đáp án (answerKey),
    // KHÔNG còn trên dòng version (quyết 12:12 ngày 26/10/2026).
    expect(docText(body.answerKey.guidance)).toBe('Đọc kỹ yêu cầu trước khi viết.');
    expect(docText(body.answerKey.solution.answer)).toContain('Ba ý chính');
    expect(body.latestVersion).not.toHaveProperty('guidance');
    const attempt = await runAttempt((q.body as { question: { id: string } }).question.id,
      'Ô nhiễm không khí đô thị xuất phát từ khí thải giao thông, hoạt động công nghiệp và bụi xây dựng chưa được kiểm soát tốt.');
    expect(attempt.state).toBe('needsgrading');
    expect(attempt.fraction).toBeNull();
  });

  it('essay validation: answers are refused and inverted word limits are refused', async () => {
    const categoryId = await createCategory('Essay validation cat');
    const withAnswers = await createQuestion({
      categoryId, qtype: 'essay', questionText: '?',
      answers: [{ text: 'Đáp án mẫu', correct: true }],
    });
    expect(withAnswers.status).toBe(400);
    const inverted = await createQuestion({
      categoryId, qtype: 'essay', questionText: '?',
      options: { minWordLimit: 100, maxWordLimit: 10 },
    });
    expect(inverted.status).toBe(400);
  });

  it('rich text questionText: a Tiptap document round-trips; documents outside the text slice are refused', async () => {
    const categoryId = await createCategory('Rich text cat');
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Chọn đáp án ', }, { type: 'text', text: 'đúng nhất', marks: [{ type: 'bold' }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Câu hỏi có hai đoạn.' }] },
      ],
    };
    const four = [
      { text: 'Đúng', correct: true }, { text: 'Sai', correct: false },
      { text: 'Không rõ', correct: false }, { text: 'Tuỳ', correct: false },
    ];
    const q = await createQuestion({
      categoryId, qtype: 'multichoice', questionText: doc,
      answers: four,
    });
    expect(q.status).toBeLessThan(300);
    expect(docText((q.body as { latestVersion: { questionText: DocLike } }).latestVersion.questionText)).toBe('Chọn đáp án đúng nhất\nCâu hỏi có hai đoạn.');
    // Node image ĐÃ thuộc lát hợp đồng (QE-1 + nối files ở QE-2): tài liệu có
    // ảnh hợp lệ phải được tạo và round-trip nguyên vẹn cả attrs.
    const imageDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Quan sát hình sau:' }] },
        { type: 'image', attrs: { src: '/api/v1/files/11111111-1111-7111-8111-111111111111/content', alt: 'Hình minh hoạ', title: 'Hình 1' } },
      ],
    };
    const withImage = await createQuestion({
      categoryId, qtype: 'multichoice', questionText: imageDoc,
      answers: four,
    });
    expect(withImage.status).toBeLessThan(300);
    expect((withImage.body as { latestVersion: { questionText: unknown } }).latestVersion.questionText).toEqual(imageDoc);
    // Node heading vẫn NGOÀI lát hợp đồng hiện tại (richTextDocumentSchema chỉ
    // gồm paragraph, bulletList, blockMath, image) — hợp đồng tài liệu từ chối.
    const withHeading = await createQuestion({
      categoryId, qtype: 'multichoice', questionText: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Tiêu đề' }] }] },
      answers: four,
    });
    expect(withHeading.status).toBe(400);
  });

  it('editing without answers clones the previous version content into the new version with fresh rows', async () => {
    const categoryId = await createCategory('Clone cat');
    const q = await createQuestion({
      categoryId, qtype: 'multichoice', questionText: 'Phiên bản 1',
      answers: [
        { text: 'Đúng', correct: true }, { text: 'Sai', correct: false },
        { text: 'Không rõ', correct: false }, { text: 'Tuỳ', correct: false },
      ],
      options: { shuffleAnswers: true },
    });
    const qid = (q.body as { question: { id: string } }).question.id;
    const v1AnswerIds = (q.body as { answers: { id: string }[] }).answers.map((a) => a.id);
    const edit = await http(app).patch(`/api/v1/questions/${qid}`).set('Authorization', `Bearer ${admin}`)
      .send({ questionText: 'Phiên bản 2' });
    expect(edit.status).toBe(200);
    expect(edit.body.entry.latestVersion).toBe(2);
    const v2Answers = edit.body.answers as { id: string; isCorrect: boolean; answer: DocLike }[];
    expect(v2Answers).toHaveLength(4);
    expect(v2Answers.map((a) => a.isCorrect)).toEqual([true, false, false, false]);
    for (const a of v2Answers) expect(v1AnswerIds).not.toContain(a.id); // hàng mới, id mới
    expect(edit.body.options.shuffleAnswers).toBe(true);
    // Lượt làm trên v2 dùng id đáp án của v2 và chấm đúng.
    const rightId = v2Answers.find((a) => docText(a.answer) === 'Đúng')!.id;
    expect(await runAttempt(qid, rightId)).toMatchObject({ state: 'gradedright', fraction: 1 });
  });
});
