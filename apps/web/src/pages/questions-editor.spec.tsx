import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { QuestionsPage, QuestionUsagePage } from './questions';
import { QuestionEditPage, QuestionNewPage } from './question-editor';

/**
 * Spec editor câu hỏi 4 qtype + ngữ liệu theo hợp đồng API hiện có:
 * POST /questions nhận `answers` + `options` theo qtype (truefalse dùng
 * `answer: { correct }`), PATCH tạo phiên bản mới với payload đầy đủ,
 * stimulus qua POST/PATCH/DELETE /stimuli và gắn bằng `stimulusId`.
 */
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';
const QUESTION_ID = '01900000-0000-7000-8000-000000000004';
const VERSION_ID = '01900000-0000-7000-8000-000000000008';
const STIMULUS_ID = '01900000-0000-7000-8000-000000000031';
const USAGE_ID = '01900000-0000-7000-8000-000000000009';
const ATTEMPT_ID = '01900000-0000-7000-8000-000000000011';
const SYSTEM_CTX_ID = '01900000-0000-7000-8000-0000000000a1';

const PROFILE = {
  id: '01900000-0000-7000-8000-0000000000a9',
  username: 'teacher1',
  firstName: 'Lan Anh',
  lastName: 'Nguyễn',
  email: 'teacher1@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  customFields: [],
};

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function multichoiceView(overrides: Record<string, unknown> = {}) {
  return {
    question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: 'multichoice', name: 'Thủ đô' },
    entry: {
      id: '01900000-0000-7000-8000-000000000002',
      questionCategoryId: CATEGORY_ID,
      questionId: QUESTION_ID,
      latestVersion: 1,
    },
    latestVersion: {
      id: VERSION_ID,
      questionBankEntryId: '01900000-0000-7000-8000-000000000002',
      questionId: QUESTION_ID,
      version: 1,
      questionText: doc('Thủ đô của Việt Nam là gì?'),
      generalFeedback: null,
      guidance: null,
      defaultMark: 1,
      penalty: 0,
      stimulusId: null,
    },
    answers: [
      { id: '01900000-0000-7000-8000-000000000041', questionVersionId: VERSION_ID, answer: doc('Hà Nội'), fraction: 1, feedback: null, sortOrder: 0 },
      { id: '01900000-0000-7000-8000-000000000042', questionVersionId: VERSION_ID, answer: doc('Huế'), fraction: 0, feedback: null, sortOrder: 1 },
    ],
    options: { single: true, shuffleAnswers: false, answerNumbering: 'abc', showNumCorrect: false, showStandardInstruction: true },
    stimulus: null,
    ...overrides,
  };
}

/** Stub fetch mô phỏng ngân hàng câu hỏi + ngữ liệu trong bộ nhớ. */
function stubFetch(calls: RecordedCall[], initialQuestions: unknown[] = [], failCreateDetail?: string) {
  const state = {
    questions: [...initialQuestions] as Record<string, unknown>[],
    stimuli: [] as Record<string, unknown>[],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities')
        return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
      if (url === '/api/v1/courses') return respond([]);
      if (url === '/api/v1/access/contexts')
        return respond([{ id: SYSTEM_CTX_ID, contextLevel: 10, instanceId: SYSTEM_CTX_ID }]);
      if (url === '/api/v1/questions/categories')
        return respond([{ id: CATEGORY_ID, name: 'General', contextId: CATEGORY_ID, info: '', parent: null }]);
      if (url === `/api/v1/questions/categories/${CATEGORY_ID}/questions`) return respond(state.questions);
      if (url === `/api/v1/stimuli?categoryId=${CATEGORY_ID}`) return respond(state.stimuli);
      if (url === '/api/v1/stimuli' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { content: string };
        const created = {
          id: STIMULUS_ID,
          categoryId: CATEGORY_ID,
          createdBy: null,
          content: doc(body.content),
        };
        state.stimuli = [created];
        return respond(created);
      }
      if (url === '/api/v1/questions' && method === 'POST') {
        if (failCreateDetail) {
          return new Response(
            JSON.stringify({
              type: 'about:blank',
              title: 'Bad Request',
              status: 400,
              code: 'question.bad_answer_data',
              detail: failCreateDetail,
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const created = multichoiceView({
          question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: body.qtype, name: body.name },
        });
        state.questions = [created];
        return respond(created);
      }
      if (url === `/api/v1/questions/${QUESTION_ID}` && method === 'PATCH') {
        const updated = multichoiceView({
          entry: {
            id: '01900000-0000-7000-8000-000000000002',
            questionCategoryId: CATEGORY_ID,
            questionId: QUESTION_ID,
            latestVersion: 2,
          },
        });
        state.questions = [updated];
        return respond(updated);
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return state;
}


/** Form editor câu hỏi (trang còn một form danh mục cũng có nhãn "Tên" nên phải khoanh vùng). */
function questionForm(submitName = 'Tạo câu hỏi') {
  const form = screen.getByRole('button', { name: submitName }).closest('form');
  if (!form) throw new Error('question form not found');
  return within(form);
}

function renderBank() {
  localStorage.setItem('lms.accessToken', 'test-token');
  const router = createMemoryRouter(
    [
      { path: '/questions', element: <QuestionsPage /> },
      { path: '/questions/new', element: <QuestionNewPage /> },
      { path: '/questions/:questionId/edit', element: <QuestionEditPage /> },
    ],
    { initialEntries: ['/questions'] },
  );
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

/** §9: tạo mới là màn riêng — từ danh sách bấm "Câu hỏi mới" sang màn editor rồi chờ form hiện. */
async function openNewQuestionForm() {
  await userEvent.click(await screen.findByRole('link', { name: 'Câu hỏi mới' }));
  await screen.findByLabelText('Tên');
}

/** Chọn một tuỳ chọn trong Select của @lms/ui: bấm trigger theo nhãn rồi bấm option theo chữ hiển thị. */
async function pickSelectOption(scope: ReturnType<typeof within>, label: string, optionText: string) {
  await userEvent.click(scope.getByLabelText(label));
  await userEvent.click(await screen.findByRole('option', { name: optionText }));
}

describe('Question editor — four qtypes', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('creates a multichoice question with choices, fractions and the marked correct choice', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await userEvent.type(questionForm().getByLabelText('Tên'), 'Thủ đô');
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Thủ đô của Việt Nam là gì?');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 1'), 'Hà Nội');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 2'), 'Huế');
    await userEvent.click(questionForm().getAllByLabelText('Đáp án đúng')[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    expect(createCall?.body).toEqual({
      categoryId: CATEGORY_ID,
      qtype: 'multichoice',
      name: 'Thủ đô',
      questionText: 'Thủ đô của Việt Nam là gì?',
      answers: [
        { text: 'Hà Nội', fraction: 1 },
        { text: 'Huế', fraction: 0 },
      ],
      options: { single: true },
    });
  });

  it('shows the real API reason when question creation fails (issue #55)', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, [], 'multichoice positive fractions must add up to 1 (100%)');
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await userEvent.type(questionForm().getByLabelText('Tên'), 'Câu lỗi');
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Câu hỏi sai tỷ trọng.');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 1'), 'A');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 2'), 'B');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Không thể tạo câu hỏi.');
    expect(status).toHaveTextContent('multichoice positive fractions must add up to 1 (100%)');
  });

  it('creates a truefalse question with the legacy answer payload', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await pickSelectOption(questionForm(), 'Loại câu hỏi', 'Đúng/sai (truefalse)');
    await userEvent.type(questionForm().getByLabelText('Tên'), 'Trời mưa');
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Trời đang mưa.');
    await userEvent.click(questionForm().getByLabelText('Đáp án đúng là "sai"'));
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    expect(createCall?.body).toEqual({
      categoryId: CATEGORY_ID,
      qtype: 'truefalse',
      name: 'Trời mưa',
      questionText: 'Trời đang mưa.',
      answer: { correct: false },
    });
  });

  it('creates a shortanswer question with accepted answers and the useCase option', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await pickSelectOption(questionForm(), 'Loại câu hỏi', 'Trả lời ngắn (shortanswer)');
    await userEvent.type(questionForm().getByLabelText('Tên'), 'Thủ đô ngắn');
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Thủ đô của Việt Nam?');
    await userEvent.type(questionForm().getByLabelText('Đáp án 1'), 'Hà Nội');
    await userEvent.click(screen.getByRole('button', { name: 'Thêm đáp án' }));
    await userEvent.type(questionForm().getByLabelText('Đáp án 2'), 'Ha Noi');
    await userEvent.type(questionForm().getByLabelText('Tỷ trọng (fraction) của đáp án 2'), '0.5');
    await userEvent.click(questionForm().getByRole('checkbox', { name: 'Phân biệt hoa/thường (useCase)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    expect(createCall?.body).toEqual({
      categoryId: CATEGORY_ID,
      qtype: 'shortanswer',
      name: 'Thủ đô ngắn',
      questionText: 'Thủ đô của Việt Nam?',
      answers: [
        { text: 'Hà Nội', fraction: 1 },
        { text: 'Ha Noi', fraction: 0.5 },
      ],
      options: { useCase: true },
    });
  });

  it('creates an essay question with response options, grader info and template', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await pickSelectOption(questionForm(), 'Loại câu hỏi', 'Tự luận (essay)');
    await userEvent.type(questionForm().getByLabelText('Tên'), 'Bài luận');
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Hãy phân tích bài thơ.');
    await pickSelectOption(questionForm(), 'Định dạng trả lời', 'Văn bản thuần (plain)');
    await userEvent.click(questionForm().getByRole('checkbox', { name: 'Bài trả lời bắt buộc' }));
    await userEvent.clear(questionForm().getByLabelText('Số dòng của trường trả lời'));
    await userEvent.type(questionForm().getByLabelText('Số dòng của trường trả lời'), '12');
    await userEvent.type(questionForm().getByLabelText('Số từ tối thiểu'), '50');
    await userEvent.type(questionForm().getByLabelText('Số từ tối đa'), '500');
    await userEvent.type(questionForm().getByLabelText('Thông tin cho người chấm (grader info)'), 'Chấm theo thang 10.');
    await userEvent.type(questionForm().getByLabelText('Khung bài làm mẫu (response template)'), 'Mở bài: ...');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    expect(createCall?.body).toEqual({
      categoryId: CATEGORY_ID,
      qtype: 'essay',
      name: 'Bài luận',
      questionText: 'Hãy phân tích bài thơ.',
      options: {
        responseFormat: 'plain',
        responseRequired: false,
        responseFieldLines: 12,
        minWordLimit: 50,
        maxWordLimit: 500,
        graderInfo: 'Chấm theo thang 10.',
        responseTemplate: 'Mở bài: ...',
      },
    });
  });

  it('reopens the editor for an existing multichoice question and saves a new version', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, [multichoiceView()]);
    renderBank();

    const row = await screen.findByTestId(`question-${QUESTION_ID}`);
    await userEvent.click(within(row).getByText('Sửa (phiên bản mới)'));
    await screen.findByRole('button', { name: 'Lưu thành phiên bản mới' });

    const editForm = questionForm('Lưu thành phiên bản mới');
    const choice1 = editForm.getByLabelText('Lựa chọn 1');
    expect(choice1).toHaveValue('Hà Nội');
    expect(editForm.getByLabelText('Lựa chọn 2')).toHaveValue('Huế');
    expect(editForm.getByLabelText('Loại câu hỏi')).toBeDisabled();
    await userEvent.clear(choice1);
    await userEvent.type(choice1, 'Hà Nội (thủ đô)');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thành phiên bản mới' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH')).toBe(true),
    );
    const patchCall = calls.find((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH');
    expect(patchCall?.body).toEqual({
      name: 'Thủ đô',
      questionText: 'Thủ đô của Việt Nam là gì?',
      answers: [
        { text: 'Hà Nội (thủ đô)', fraction: 1 },
        { text: 'Huế', fraction: 0 },
      ],
      options: {
        single: true,
        shuffleAnswers: false,
        answerNumbering: 'abc',
        showNumCorrect: false,
        showStandardInstruction: true,
      },
      stimulusId: null,
    });
    // §9: lưu xong quay về màn danh sách; huy hiệu phiên bản trên dòng đã lên v2.
    expect(await screen.findByTestId(`version-badge-${QUESTION_ID}`)).toHaveTextContent('v2');
  });

  it('preserves non-default multichoice options and feedback documents when editing', async () => {
    const calls: RecordedCall[] = [];
    const correctFeedback = doc('Phản hồi khi đúng hoàn toàn');
    const partiallyCorrectFeedback = doc('Phản hồi khi đúng một phần');
    const incorrectFeedback = doc('Phản hồi khi sai');
    stubFetch(calls, [
      multichoiceView({
        options: {
          single: false,
          shuffleAnswers: true,
          answerNumbering: '123',
          showNumCorrect: true,
          showStandardInstruction: false,
          correctFeedback,
          partiallyCorrectFeedback,
          incorrectFeedback,
        },
      }),
    ]);
    renderBank();

    const row = await screen.findByTestId(`question-${QUESTION_ID}`);
    await userEvent.click(within(row).getByText('Sửa (phiên bản mới)'));
    await userEvent.click(await screen.findByRole('button', { name: 'Lưu thành phiên bản mới' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH')).toBe(true),
    );
    const patchCall = calls.find((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH');
    expect(patchCall?.body).toEqual({
      name: 'Thủ đô',
      questionText: 'Thủ đô của Việt Nam là gì?',
      answers: [
        { text: 'Hà Nội', fraction: 1 },
        { text: 'Huế', fraction: 0 },
      ],
      options: {
        single: false,
        shuffleAnswers: true,
        answerNumbering: '123',
        showNumCorrect: true,
        showStandardInstruction: false,
        correctFeedback,
        partiallyCorrectFeedback,
        incorrectFeedback,
      },
      stimulusId: null,
    });
  });

  it('preserves non-default essay response options when editing', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, [
      multichoiceView({
        question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: 'essay', name: 'Bài luận' },
        answers: [],
        options: {
          responseFormat: 'editor',
          responseRequired: false,
          responseFieldLines: 7,
          minWordLimit: 20,
          maxWordLimit: 200,
          graderInfo: doc('Chấm theo rubric.'),
          responseTemplate: doc('Mở bài mẫu.'),
        },
      }),
    ]);
    renderBank();

    const row = await screen.findByTestId(`question-${QUESTION_ID}`);
    await userEvent.click(within(row).getByText('Sửa (phiên bản mới)'));
    await screen.findByRole('button', { name: 'Lưu thành phiên bản mới' });

    const editForm = questionForm('Lưu thành phiên bản mới');
    expect(editForm.getByRole('checkbox', { name: 'Bài trả lời bắt buộc' })).not.toBeChecked();
    expect(editForm.getByLabelText('Số dòng của trường trả lời')).toHaveValue(7);
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thành phiên bản mới' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH')).toBe(true),
    );
    const patchCall = calls.find((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH');
    expect(patchCall?.body).toEqual({
      name: 'Bài luận',
      questionText: 'Thủ đô của Việt Nam là gì?',
      options: {
        responseFormat: 'editor',
        responseRequired: false,
        responseFieldLines: 7,
        minWordLimit: 20,
        maxWordLimit: 200,
        graderInfo: 'Chấm theo rubric.',
        responseTemplate: 'Mở bài mẫu.',
      },
      stimulusId: null,
    });
  });
});

describe('Stimulus in the question bank UI', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('creates a stimulus and attaches it to a new question', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await userEvent.type(screen.getByLabelText('Ngữ liệu mới'), 'Đoạn văn về thủ đô Hà Nội.');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo ngữ liệu' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/stimuli' && c.method === 'POST')).toBe(true));
    const stimulusCall = calls.find((c) => c.url === '/api/v1/stimuli' && c.method === 'POST');
    expect(stimulusCall?.body).toEqual({ categoryId: CATEGORY_ID, content: 'Đoạn văn về thủ đô Hà Nội.' });
    expect(await screen.findByTestId(`stimulus-row-${STIMULUS_ID}`)).toHaveTextContent('Đoạn văn về thủ đô Hà Nội.');

    await openNewQuestionForm();
    await userEvent.type(questionForm().getByLabelText('Tên'), 'Câu kèm ngữ liệu');
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Theo đoạn văn, thủ đô là gì?');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 1'), 'Hà Nội');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 2'), 'Huế');
    await pickSelectOption(questionForm(), 'Ngữ liệu gắn kèm', 'Đoạn văn về thủ đô Hà Nội.');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    expect(createCall?.body).toMatchObject({ qtype: 'multichoice', stimulusId: STIMULUS_ID });
  });

  it('shows the attached stimulus on the usage page for the pinned version', async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url === '/api/v1/users/me') return respond(PROFILE);
        if (url === '/api/v1/users/me/capabilities')
          return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
        if (url === '/api/v1/courses') return respond([]);
        if (url === `/api/v1/question-usages/${USAGE_ID}`) {
          return respond({
            usage: { id: USAGE_ID, component: 'mod_quiz', instanceId: null, preferredBehaviour: 'deferredfeedback' },
            state: 'inprogress',
            attempts: [
              {
                id: ATTEMPT_ID,
                questionUsageId: USAGE_ID,
                slot: 1,
                behaviour: 'deferredfeedback',
                questionId: QUESTION_ID,
                questionVersionId: VERSION_ID,
                maxMark: 1,
                state: 'todo',
                fraction: null,
                steps: [],
              },
            ],
          });
        }
        if (url === `/api/v1/questions/${QUESTION_ID}/versions`) {
          return respond([
            {
              id: VERSION_ID,
              questionBankEntryId: '01900000-0000-7000-8000-000000000002',
              questionId: QUESTION_ID,
              version: 1,
              questionText: doc('Theo đoạn văn, thủ đô là gì?'),
              generalFeedback: null,
              guidance: null,
              defaultMark: 1,
              penalty: 0,
              stimulusId: STIMULUS_ID,
            },
          ]);
        }
        if (url === `/api/v1/stimuli/${STIMULUS_ID}`) {
          return respond({
            id: STIMULUS_ID,
            categoryId: CATEGORY_ID,
            createdBy: null,
            content: doc('Đoạn văn về thủ đô Hà Nội.'),
          });
        }
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    localStorage.setItem('lms.accessToken', 'test-token');
    const router = createMemoryRouter([{ path: '/question-usages/:id', element: <QuestionUsagePage /> }], {
      initialEntries: [`/question-usages/${USAGE_ID}`],
    });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    const block = await screen.findByTestId(`attempt-stimulus-${ATTEMPT_ID}`);
    expect(block).toHaveTextContent('Đoạn văn về thủ đô Hà Nội.');
    expect(screen.getByTestId(`attempt-${ATTEMPT_ID}`)).toHaveTextContent('Theo đoạn văn, thủ đô là gì?');
  });
});
