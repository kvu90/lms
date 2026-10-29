import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { QuestionsPage } from '#features/questions/components/questions';
import { QuestionUsagePage } from '#features/questions/components/usage-page';
import { QuestionEditPage, QuestionNewPage } from './routes/question-editor';

/**
 * Spec editor câu hỏi 4 qtype + ngữ liệu theo hợp đồng API của mô hình
 * port giaokhoa (lát P4 #248): câu hỏi KHÔNG có tên và đáp án KHÔNG có
 * tỉ trọng — POST /questions nhận `answers` mang cờ `correct` nhị phân
 * (multichoice đúng 4 lựa chọn + đúng 1 đúng soạn trên tài liệu thống
 * nhất rồi tách khi lưu; truefalse TF-A là MỘT tài liệu thân + 4
 * mệnh đề với đáp án từng mệnh đề ở solution;
 * shortanswer mọi mẫu đều được chấp nhận), `guidance` và `solution`
 * (lời giải mẫu của essay) đi ở phía đáp án, PATCH tạo phiên bản mới
 * với payload đầy đủ, stimulus qua POST/PATCH/DELETE /stimuli và gắn
 * bằng `stimulusId`. Trạng thái draft/ready chốt bằng
 * POST /questions/:id/status sau khi lưu.
 *
 * `@lms/editor` được thay bằng bản giả lập textarea (tài liệu ↔ văn bản
 * thuần theo paragraph; editor trắc nghiệm thống nhất giả lập bằng
 * textarea thân câu + textarea từng lựa chọn + radio đáp án đúng, vận
 * hành trên đúng hình dạng JSON tài liệu thống nhất) để spec trang
 * kiểm LUỒNG NGƯỜI DÙNG và payload — cơ chế soạn Tiptap thật thuộc
 * spec của chính package editor.
 */
vi.mock('@lms/editor', async () => {
  const React = await import('react');
  interface DocLike {
    type: 'doc';
    content?: {
      type: string;
      attrs?: { src: string; alt?: string | null };
      content?: { type: string; text?: string }[];
    }[];
  }
  // Hình dạng JSON của tài liệu thống nhất trắc nghiệm ở bản giả lập:
  // doc gồm các block thân câu + một node choiceList chứa các choice
  // (mỗi choice có attrs.id và content là các block của lựa chọn).
  interface McNodeLike {
    type: string;
    attrs?: { id?: string; src?: string; alt?: string | null };
    content?: McNodeLike[];
    text?: string;
  }
  interface McDocLike {
    type: 'doc';
    content?: McNodeLike[];
  }
  let mockChoiceSeq = 0;
  const docToText = (value: DocLike | null | undefined): string =>
    (value?.content ?? [])
      .map((node) => (node.content ?? []).map((child) => child.text ?? '').join(''))
      .join('\n');
  const textToDoc = (text: string): DocLike => ({
    type: 'doc',
    content:
      text === ''
        ? [{ type: 'paragraph' }]
        : text.split('\n').map((line) => ({
            type: 'paragraph',
            content: line ? [{ type: 'text', text: line }] : [],
          })),
  });
  return {
    RichTextEditor: ({
      value,
      onChange,
      ariaLabel,
      onRequestImage,
    }: {
      value: DocLike;
      onChange: (doc: DocLike) => void;
      ariaLabel?: string;
      onRequestImage?: (file?: File) => Promise<{ src: string; alt?: string | null } | null>;
    }) => {
      // Hai nút giả lập đúng hai cách editor thật gọi `onRequestImage`:
      // bấm nút ảnh trên toolbar (không kèm tệp) và dán ảnh (kèm tệp).
      // Editor thật tự chèn node `image` bằng định danh bề mặt chứa trả
      // về — bản giả lập nối cùng hành vi đó vào tài liệu của trường.
      const requestAndInsert = (file?: File) => {
        void (async () => {
          const pick = await onRequestImage?.(file);
          if (pick) {
            onChange({
              type: 'doc',
              content: [...(value.content ?? []), { type: 'image', attrs: { src: pick.src, alt: pick.alt ?? null } }],
            });
          }
        })();
      };
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('textarea', {
          'aria-label': ariaLabel,
          value: docToText(value),
          onChange: (event: { target: { value: string } }) => onChange(textToDoc(event.target.value)),
        }),
        onRequestImage
          ? React.createElement(
              'button',
              { type: 'button', 'aria-label': `Chèn ảnh: ${ariaLabel}`, onClick: () => requestAndInsert() },
              'Chèn ảnh',
            )
          : null,
        onRequestImage
          ? React.createElement(
              'button',
              {
                type: 'button',
                'aria-label': `Dán ảnh vào: ${ariaLabel}`,
                onClick: () =>
                  requestAndInsert(new File(['png-bytes'], 'anh-dan.png', { type: 'image/png' })),
              },
              'Dán ảnh',
            )
          : null,
      );
    },
    RichTextView: ({ value }: { value: DocLike | null }) =>
      value ? React.createElement('div', null, docToText(value)) : null,
    // --- Tài liệu thống nhất trắc nghiệm (giả lập trung thực theo
    // hình dạng JSON của module multiple-choice ở @lms/editor) ---
    splitMultipleChoiceDocument: (content: McDocLike) => {
      const nodes = content.content ?? [];
      const listIndex = nodes.findIndex((node) => node.type === 'choiceList');
      if (listIndex < 0) return { question: content, choices: [] };
      return {
        question: { ...content, content: nodes.filter((_, index) => index !== listIndex) },
        choices: (nodes[listIndex]?.content ?? []).filter((node) => node.type === 'choice'),
      };
    },
    composeMultipleChoiceDocument: (
      questionText: DocLike | null | undefined,
      answers: { id: string; answer: DocLike; sortOrder: number }[],
    ): McDocLike => {
      const sorted = [...answers].sort((a, b) => a.sortOrder - b.sortOrder);
      const choices: McNodeLike[] = sorted
        .slice(0, 4)
        .map((answer) => ({ type: 'choice', attrs: { id: answer.id }, content: answer.answer.content ?? [] }));
      while (choices.length < 4) {
        mockChoiceSeq += 1;
        choices.push({ type: 'choice', attrs: { id: `mock-choice-${mockChoiceSeq}` }, content: [{ type: 'paragraph' }] });
      }
      return {
        type: 'doc',
        content: [
          ...((questionText?.content ?? [{ type: 'paragraph' }]) as McNodeLike[]),
          { type: 'choiceList', content: choices },
        ],
      };
    },
    createEmptyMultipleChoiceDocument: (): McDocLike => ({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        {
          type: 'choiceList',
          content: [0, 1, 2, 3].map(() => {
            mockChoiceSeq += 1;
            return { type: 'choice', attrs: { id: `mock-choice-${mockChoiceSeq}` }, content: [{ type: 'paragraph' }] };
          }),
        },
      ],
    }),
    MultipleChoiceEditor: ({
      value,
      onChange,
      correctChoiceId,
      onCorrectChoiceChange,
      ariaLabel,
      onRequestImage,
    }: {
      value: McDocLike;
      onChange: (doc: McDocLike) => void;
      correctChoiceId?: string;
      onCorrectChoiceChange: (choiceId: string) => void;
      ariaLabel?: string;
      onRequestImage?: (file?: File) => Promise<{ src: string; alt?: string | null } | null>;
    }) => {
      // Tách tài liệu thống nhất tại chỗ (cùng thuật toán với bản
      // thật): textarea đầu là thân câu, mỗi choice một textarea,
      // radio "Đặt làm đáp án đúng" bám theo id của choice.
      const nodes = value.content ?? [];
      const listIndex = nodes.findIndex((node) => node.type === 'choiceList');
      const questionDoc: McDocLike = {
        type: 'doc',
        content: nodes.filter((_, index) => index !== listIndex),
      };
      const choices = (nodes[listIndex]?.content ?? []).filter((node) => node.type === 'choice');
      const rebuild = (nextQuestion: McDocLike, nextChoices: McNodeLike[]) =>
        onChange({ type: 'doc', content: [...(nextQuestion.content ?? []), { type: 'choiceList', content: nextChoices }] });
      const requestAndInsert = (file?: File) => {
        void (async () => {
          const pick = await onRequestImage?.(file);
          if (pick) {
            rebuild(
              {
                type: 'doc',
                content: [
                  ...(questionDoc.content ?? []),
                  { type: 'image', attrs: { src: pick.src, alt: pick.alt ?? null } },
                ],
              },
              choices,
            );
          }
        })();
      };
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('textarea', {
          'aria-label': ariaLabel,
          value: docToText(questionDoc as DocLike),
          onChange: (event: { target: { value: string } }) =>
            rebuild(textToDoc(event.target.value) as McDocLike, choices),
        }),
        onRequestImage
          ? React.createElement(
              'button',
              { type: 'button', 'aria-label': `Chèn ảnh: ${ariaLabel}`, onClick: () => requestAndInsert() },
              'Chèn ảnh',
            )
          : null,
        onRequestImage
          ? React.createElement(
              'button',
              {
                type: 'button',
                'aria-label': `Dán ảnh vào: ${ariaLabel}`,
                onClick: () => requestAndInsert(new File(['png-bytes'], 'anh-dan.png', { type: 'image/png' })),
              },
              'Dán ảnh',
            )
          : null,
        ...choices.flatMap((choice, index) => [
          React.createElement('textarea', {
            key: `choice-${choice.attrs?.id ?? index}`,
            'aria-label': `Lựa chọn ${index + 1}`,
            value: docToText({ type: 'doc', content: (choice.content ?? []) as DocLike['content'] }),
            onChange: (event: { target: { value: string } }) =>
              rebuild(
                questionDoc,
                choices.map((c, i) =>
                  i === index ? { ...c, content: (textToDoc(event.target.value) as McDocLike).content } : c,
                ),
              ),
          }),
          React.createElement('input', {
            key: `radio-${choice.attrs?.id ?? index}`,
            type: 'radio',
            'aria-label': 'Đặt làm đáp án đúng',
            checked: correctChoiceId === choice.attrs?.id,
            onChange: () => {
              if (choice.attrs?.id) onCorrectChoiceChange(choice.attrs.id);
            },
          }),
        ]),
      );
    },
    // --- Tài liệu thống nhất Đúng/Sai TF-A (giả lập theo hình dạng
    // JSON của module true-false ở @lms/editor): doc gồm các block
    // thân chung + một node statementList chốt đuôi chứa đúng 4
    // statement (mỗi statement có attrs.id và content là các block).
    splitTrueFalseDocument: (content: McDocLike) => {
      const nodes = content.content ?? [];
      const listIndex = nodes.findIndex((node) => node.type === 'statementList');
      if (listIndex < 0) return { stem: content, statements: [] };
      return {
        stem: { ...content, content: nodes.filter((_, index) => index !== listIndex) },
        statements: (nodes[listIndex]?.content ?? []).filter((node) => node.type === 'statement'),
      };
    },
    composeTrueFalseDocument: (questionText: DocLike | null | undefined): McDocLike => {
      const nodes = ((questionText?.content ?? [{ type: 'paragraph' }]) as McNodeLike[]).filter(
        (node) => node.type !== 'statementList',
      );
      const existing = ((questionText?.content ?? []) as McNodeLike[]).find(
        (node) => node.type === 'statementList',
      );
      const statements: McNodeLike[] = ((existing?.content ?? []) as McNodeLike[])
        .filter((node) => node.type === 'statement')
        .slice(0, 4)
        .map((s) => ({
          type: 'statement',
          attrs: { id: s.attrs?.id ?? `mock-statement-${++mockChoiceSeq}` },
          content: s.content ?? [{ type: 'paragraph' }],
        }));
      while (statements.length < 4) {
        mockChoiceSeq += 1;
        statements.push({
          type: 'statement',
          attrs: { id: `mock-statement-${mockChoiceSeq}` },
          content: [{ type: 'paragraph' }],
        });
      }
      return { type: 'doc', content: [...nodes, { type: 'statementList', content: statements }] };
    },
    createEmptyTrueFalseDocument: (): McDocLike => ({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        {
          type: 'statementList',
          content: [0, 1, 2, 3].map(() => {
            mockChoiceSeq += 1;
            return {
              type: 'statement',
              attrs: { id: `mock-statement-${mockChoiceSeq}` },
              content: [{ type: 'paragraph' }],
            };
          }),
        },
      ],
    }),
    TrueFalseEditor: ({
      value,
      onChange,
      answers,
      onAnswerChange,
      ariaLabel,
    }: {
      value: McDocLike;
      onChange: (doc: McDocLike) => void;
      answers: Record<string, boolean | undefined>;
      onAnswerChange: (statementId: string, value: boolean) => void;
      ariaLabel?: string;
    }) => {
      const nodes = value.content ?? [];
      const listIndex = nodes.findIndex((node) => node.type === 'statementList');
      const stemDoc: McDocLike = {
        type: 'doc',
        content: nodes.filter((_, index) => index !== listIndex),
      };
      const statements = (nodes[listIndex]?.content ?? []).filter((node) => node.type === 'statement');
      const rebuild = (nextStem: McDocLike, nextStatements: McNodeLike[]) =>
        onChange({
          type: 'doc',
          content: [...(nextStem.content ?? []), { type: 'statementList', content: nextStatements }],
        });
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('textarea', {
          'aria-label': ariaLabel,
          value: docToText(stemDoc as DocLike),
          onChange: (event: { target: { value: string } }) =>
            rebuild(textToDoc(event.target.value) as McDocLike, statements),
        }),
        ...statements.flatMap((statement, index) => {
          const id = statement.attrs?.id ?? `statement-${index}`;
          return [
            React.createElement('textarea', {
              key: `statement-${id}`,
              'aria-label': `Mệnh đề ${index + 1}`,
              value: docToText({ type: 'doc', content: (statement.content ?? []) as DocLike['content'] }),
              onChange: (event: { target: { value: string } }) =>
                rebuild(
                  stemDoc,
                  statements.map((s, i) =>
                    i === index ? { ...s, content: (textToDoc(event.target.value) as McDocLike).content } : s,
                  ),
                ),
            }),
            React.createElement('input', {
              key: `radio-true-${id}`,
              type: 'radio',
              'aria-label': 'Đánh dấu mệnh đề là Đúng',
              checked: answers[id] === true,
              onChange: () => onAnswerChange(id, true),
            }),
            React.createElement('input', {
              key: `radio-false-${id}`,
              type: 'radio',
              'aria-label': 'Đánh dấu mệnh đề là Sai',
              checked: answers[id] === false,
              onChange: () => onAnswerChange(id, false),
            }),
          ];
        }),
      );
    },
  };
});
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';
const QUESTION_ID = '01900000-0000-7000-8000-000000000004';
const VERSION_ID = '01900000-0000-7000-8000-000000000008';
const STIMULUS_ID = '01900000-0000-7000-8000-000000000031';
const USAGE_ID = '01900000-0000-7000-8000-000000000009';
const ATTEMPT_ID = '01900000-0000-7000-8000-000000000011';
const SYSTEM_CTX_ID = '01900000-0000-7000-8000-0000000000a1';
const FILE_ID = '01900000-0000-7000-8000-0000000000f1';

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
    question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: 'multichoice' },
    entry: {
      id: '01900000-0000-7000-8000-000000000002',
      questionCategoryId: CATEGORY_ID,
      questionId: QUESTION_ID,
      latestVersion: 1,
      status: 'ready',
    },
    latestVersion: {
      id: VERSION_ID,
      questionBankEntryId: '01900000-0000-7000-8000-000000000002',
      questionId: QUESTION_ID,
      version: 1,
      questionText: doc('Thủ đô của Việt Nam là gì?'),
      generalFeedback: null,
      defaultMark: 1,
      penalty: 0,
      stimulusId: null,
    },
    answers: [
      { id: '01900000-0000-7000-8000-000000000041', questionVersionId: VERSION_ID, answer: doc('Hà Nội'), isCorrect: true, feedback: null, sortOrder: 0 },
      { id: '01900000-0000-7000-8000-000000000042', questionVersionId: VERSION_ID, answer: doc('Huế'), isCorrect: false, feedback: null, sortOrder: 1 },
      { id: '01900000-0000-7000-8000-000000000043', questionVersionId: VERSION_ID, answer: doc('Đà Nẵng'), isCorrect: false, feedback: null, sortOrder: 2 },
      { id: '01900000-0000-7000-8000-000000000044', questionVersionId: VERSION_ID, answer: doc('Cần Thơ'), isCorrect: false, feedback: null, sortOrder: 3 },
    ],
    answerKey: { guidance: null, solution: null },
    options: { shuffleAnswers: false, answerNumbering: 'abc', showStandardInstruction: true },
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
      const rawBody = init?.body;
      const recordedBody =
        rawBody instanceof FormData
          ? Object.fromEntries(
              [...rawBody.entries()].map(([key, value]) => [key, value instanceof File ? value.name : String(value)]),
            )
          : rawBody
            ? JSON.parse(String(rawBody))
            : undefined;
      calls.push({ url, method, body: recordedBody });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities')
        return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
      if (url === '/api/v1/courses') return respond([]);
      if (url === '/api/v1/access/contexts')
        return respond([{ id: SYSTEM_CTX_ID, contextLevel: 10, instanceId: SYSTEM_CTX_ID }]);
      if (url === '/api/v1/questions/categories')
        return respond([{ id: CATEGORY_ID, name: 'General', contextId: CATEGORY_ID, info: '', parent: null }]);
      if (url === '/api/v1/files/question-image' && method === 'POST') {
        const form = init?.body as FormData;
        return respond({
          id: FILE_ID,
          src: `/api/v1/files/${FILE_ID}/content`,
          fileName: (form.get('file') as File).name,
          mimeType: 'image/png',
          fileSize: 9,
          contextId: form.get('contextId'),
          fileArea: form.get('fileArea'),
        });
      }
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
          question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: body.qtype },
        });
        state.questions = [created];
        return respond(created);
      }
      if (url === `/api/v1/questions/${QUESTION_ID}` && method === 'PATCH') {
        // PATCH tạo phiên bản mới nhưng KHÔNG đổi trạng thái bank của câu.
        const currentEntry = (state.questions[0] as { entry?: { status?: string } } | undefined)?.entry;
        const updated = multichoiceView({
          entry: {
            id: '01900000-0000-7000-8000-000000000002',
            questionCategoryId: CATEGORY_ID,
            questionId: QUESTION_ID,
            latestVersion: 2,
            status: currentEntry?.status ?? 'ready',
          },
        });
        state.questions = [updated];
        return respond(updated);
      }
      if (url === `/api/v1/questions/${QUESTION_ID}/status` && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { status: string };
        const current = (state.questions[0] ?? multichoiceView()) as ReturnType<typeof multichoiceView>;
        const updated = {
          ...current,
          entry: { ...(current.entry as Record<string, unknown>), status: body.status },
        };
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
  const router = createMemoryRouter(
    [
      { path: '/questions', element: <QuestionsPage /> },
      { path: '/questions/stimuli', element: <QuestionsPage area="stimuli" /> },
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
  return router;
}

/** §9: tạo mới là màn riêng — từ danh sách bấm "Câu hỏi mới" sang màn editor rồi chờ form hiện (form không còn trường Tên — chờ trường nội dung câu hỏi). */
async function openNewQuestionForm() {
  await userEvent.click(await screen.findByRole('link', { name: 'Câu hỏi mới' }));
  await screen.findByLabelText('Nội dung câu hỏi');
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

  it('creates a multichoice question from the unified document: split on save, four choices, one marked correct, guidance on the answer side', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    // Form không còn trường Tên (câu hỏi không có tên — quyết 11:28).
    expect(questionForm().queryByLabelText('Tên')).toBeNull();
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Thủ đô của Việt Nam là gì?');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 1'), 'Hà Nội');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 2'), 'Huế');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 3'), 'Đà Nẵng');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 4'), 'Cần Thơ');
    // Đáp án đúng chọn bằng radio tại lựa chọn trong editor thống nhất.
    await userEvent.click(questionForm().getAllByRole('radio', { name: 'Đặt làm đáp án đúng' })[0]!);
    await userEvent.type(questionForm().getByLabelText('Hướng dẫn (guidance)'), 'Nhớ lại bản đồ hành chính.');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    // Payload đã TÁCH khỏi tài liệu thống nhất: thân câu là tài liệu
    // thuần (không node lựa chọn, không guidance ở trong), answers
    // mang cờ correct nhị phân theo đúng thứ tự lựa chọn trong tài
    // liệu, guidance đi riêng ở phía đáp án. Không tên, không tỉ trọng.
    expect(createCall?.body).toEqual({
      categoryId: CATEGORY_ID,
      qtype: 'multichoice',
      questionText: doc('Thủ đô của Việt Nam là gì?'),
      guidance: doc('Nhớ lại bản đồ hành chính.'),
      answers: [
        { text: doc('Hà Nội'), correct: true },
        { text: doc('Huế'), correct: false },
        { text: doc('Đà Nẵng'), correct: false },
        { text: doc('Cần Thơ'), correct: false },
      ],
      options: {
        shuffleAnswers: true,
        answerNumbering: 'abc',
        showStandardInstruction: true,
      },
    });
    expect(JSON.stringify(createCall?.body)).not.toContain('fraction');
    expect(JSON.stringify(createCall?.body)).not.toContain('choiceList');
    // Câu mới mặc định đã ở trạng thái ready nên không gọi endpoint trạng thái.
    expect(calls.some((c) => c.url.endsWith('/status'))).toBe(false);
  });

  it('saves a new question as a draft through the status endpoint', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Câu đang soạn dở?');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 1'), 'A');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 2'), 'B');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 3'), 'C');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 4'), 'D');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/questions/${QUESTION_ID}/status` && c.method === 'POST')).toBe(true),
    );
    const statusCall = calls.find((c) => c.url === `/api/v1/questions/${QUESTION_ID}/status`);
    expect(statusCall?.body).toEqual({ status: 'draft' });
    // Tạo nội dung chạy trước, chốt trạng thái nháp chạy sau.
    const createIndex = calls.findIndex((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    const statusIndex = calls.findIndex((c) => c.url === `/api/v1/questions/${QUESTION_ID}/status`);
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThan(createIndex);
  });

  it('uploads an image pasted into the editor through onRequestImage and saves the durable file src', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Quan sát hình rồi trả lời?');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 1'), 'Hà Nội');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 2'), 'Huế');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 3'), 'Đà Nẵng');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 4'), 'Cần Thơ');
    await userEvent.click(questionForm().getAllByRole('radio', { name: 'Đặt làm đáp án đúng' })[0]!);
    // Dán ảnh vào vùng soạn: editor gọi onRequestImage kèm tệp, bề mặt
    // chứa tải ảnh qua endpoint files với context của bank đích.
    await userEvent.click(questionForm().getByRole('button', { name: 'Dán ảnh vào: Nội dung câu hỏi' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/files/question-image' && c.method === 'POST')).toBe(true),
    );
    const uploadCall = calls.find((c) => c.url === '/api/v1/files/question-image');
    expect(uploadCall?.body).toEqual({ file: 'anh-dan.png', contextId: CATEGORY_ID, fileArea: 'questiontext' });

    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    // Tài liệu lưu node image với ĐỊNH DANH BỀN của file, không phải URL ký.
    expect(createCall?.body).toMatchObject({
      questionText: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Quan sát hình rồi trả lời?' }] },
          { type: 'image', attrs: { src: `/api/v1/files/${FILE_ID}/content`, alt: 'anh-dan' } },
        ],
      },
    });
  });

  it('opens a file picker for the editor toolbar image button and uploads the chosen image', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Nhìn hình chọn đáp án?');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 1'), 'A');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 2'), 'B');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 3'), 'C');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 4'), 'D');
    await userEvent.click(questionForm().getAllByRole('radio', { name: 'Đặt làm đáp án đúng' })[0]!);
    // Bấm nút ảnh trên toolbar: editor gọi onRequestImage KHÔNG kèm tệp,
    // bề mặt chứa mở trình chọn tệp tạm gắn thẳng vào body.
    await userEvent.click(questionForm().getByRole('button', { name: 'Chèn ảnh: Nội dung câu hỏi' }));
    const pickerInput = document.body.querySelector(':scope > input[type="file"]');
    if (!(pickerInput instanceof HTMLInputElement)) throw new Error('editor image picker input not found');
    await userEvent.upload(pickerInput, new File(['png-bytes'], 'anh-chon.png', { type: 'image/png' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/files/question-image' && c.method === 'POST')).toBe(true),
    );
    const uploadCall = calls.find((c) => c.url === '/api/v1/files/question-image');
    expect(uploadCall?.body).toEqual({ file: 'anh-chon.png', contextId: CATEGORY_ID, fileArea: 'questiontext' });

    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    expect(createCall?.body).toMatchObject({
      questionText: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Nhìn hình chọn đáp án?' }] },
          { type: 'image', attrs: { src: `/api/v1/files/${FILE_ID}/content`, alt: 'anh-chon' } },
        ],
      },
    });
  });

  it('shows the real API reason when question creation fails (issue #55)', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, [], 'multichoice requires exactly one correct answer');
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Câu hỏi chưa có đáp án đúng.');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 1'), 'A');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 2'), 'B');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 3'), 'C');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 4'), 'D');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Không thể tạo câu hỏi.');
    expect(status).toHaveTextContent('multichoice requires exactly one correct answer');
  });

  it('creates ONE truefalse TF-A question: stem + 4 statements in one document, answers as solution', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await pickSelectOption(questionForm(), 'Loại câu hỏi', 'Đúng/sai (truefalse)');
    await questionForm().findByLabelText('Mệnh đề 1', {}, { timeout: 10000 });
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Xét các mệnh đề sau:');
    await userEvent.type(questionForm().getByLabelText('Mệnh đề 1'), 'Trời đang mưa.');
    await userEvent.type(questionForm().getByLabelText('Mệnh đề 2'), 'Trời đang nắng.');
    await userEvent.type(questionForm().getByLabelText('Mệnh đề 3'), 'Mặt trời mọc ở phía đông.');
    await userEvent.type(questionForm().getByLabelText('Mệnh đề 4'), 'Mặt trăng là một ngôi sao.');
    const trueRadios = questionForm().getAllByRole('radio', { name: 'Đánh dấu mệnh đề là Đúng' });
    const falseRadios = questionForm().getAllByRole('radio', { name: 'Đánh dấu mệnh đề là Sai' });
    expect(trueRadios).toHaveLength(4);
    await userEvent.click(trueRadios[0]!);
    await userEvent.click(falseRadios[1]!);
    await userEvent.click(trueRadios[2]!);
    await userEvent.click(falseRadios[3]!);
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    // TF-A là MỘT câu duy nhất — không còn tách chùm thành nhiều câu.
    const createCalls = calls.filter((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    expect(createCalls).toHaveLength(1);
    const body = createCalls[0]?.body as {
      qtype: string;
      questionText: {
        content: {
          type: string;
          content?: { attrs?: { id?: string }; content?: { content?: { text?: string }[] }[] }[];
        }[];
      };
      solution?: { answers: { statementId: string; value: boolean }[] };
      answers?: unknown;
      options?: unknown;
    };
    expect(body.qtype).toBe('truefalse');
    // Không còn dòng answers Đúng/Sai, không còn options TF.
    expect(body.answers).toBeUndefined();
    expect(body.options).toBeUndefined();
    const list = body.questionText.content[body.questionText.content.length - 1]!;
    expect(list.type).toBe('statementList');
    const statements = list.content ?? [];
    expect(statements).toHaveLength(4);
    const texts = statements.map((s) => s.content?.[0]?.content?.[0]?.text);
    expect(texts).toEqual(['Trời đang mưa.', 'Trời đang nắng.', 'Mặt trời mọc ở phía đông.', 'Mặt trăng là một ngôi sao.']);
    // solution.answers phủ đúng tập mệnh đề theo thứ tự tài liệu.
    expect(body.solution?.answers).toEqual([
      { statementId: statements[0]?.attrs?.id, value: true },
      { statementId: statements[1]?.attrs?.id, value: false },
      { statementId: statements[2]?.attrs?.id, value: true },
      { statementId: statements[3]?.attrs?.id, value: false },
    ]);
  });

  it('edits a truefalse TF-A question: statements and answers load from the stored document + answerKey', async () => {
    const calls: RecordedCall[] = [];
    const tfDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Xét các mệnh đề sau:' }] },
        {
          type: 'statementList',
          content: ['s1', 's2', 's3', 's4'].map((id, i) => ({
            type: 'statement',
            attrs: { id },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `Mệnh đề số ${i + 1}.` }] }],
          })),
        },
      ],
    };
    const view = multichoiceView({
      question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: 'truefalse' },
      latestVersion: {
        id: VERSION_ID,
        questionBankEntryId: '01900000-0000-7000-8000-000000000002',
        questionId: QUESTION_ID,
        version: 1,
        questionText: tfDoc,
        generalFeedback: null,
        defaultMark: 1,
        penalty: 0,
        stimulusId: null,
      },
      answers: [],
      answerKey: {
        guidance: null,
        solution: {
          answers: [
            { statementId: 's1', value: true },
            { statementId: 's2', value: false },
            { statementId: 's3', value: true },
            { statementId: 's4', value: false },
          ],
        },
      },
      options: {},
    });
    stubFetch(calls, [view]);
    renderBank();

    const row = await screen.findByTestId(`question-${QUESTION_ID}`);
    await userEvent.click(within(row).getByText('Sửa (phiên bản mới)'));
    // Mệnh đề nạp từ tài liệu đã lưu; đáp án nạp từ answerKey.solution.
    expect(await questionForm('Lưu thành phiên bản mới').findByLabelText('Mệnh đề 3')).toHaveValue('Mệnh đề số 3.');
    const trueRadios = questionForm('Lưu thành phiên bản mới').getAllByRole('radio', {
      name: 'Đánh dấu mệnh đề là Đúng',
    });
    expect(trueRadios[0]).toBeChecked();
    expect(trueRadios[2]).toBeChecked();
    // Đổi đáp án của mệnh đề 2 thành Đúng rồi lưu.
    await userEvent.click(trueRadios[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thành phiên bản mới' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH')).toBe(true),
    );
    const patchCall = calls.find((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH');
    const body = patchCall?.body as { solution?: { answers: { statementId: string; value: boolean }[] }; answers?: unknown };
    expect(body.answers).toBeUndefined();
    expect(body.solution?.answers).toEqual([
      { statementId: 's1', value: true },
      { statementId: 's2', value: true },
      { statementId: 's3', value: true },
      { statementId: 's4', value: false },
    ]);
  });

  it('creates a shortanswer question with accepted answers and the useCase option', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await pickSelectOption(questionForm(), 'Loại câu hỏi', 'Trả lời ngắn (shortanswer)');
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Thủ đô của Việt Nam?');
    await userEvent.type(questionForm().getByLabelText('Đáp án 1'), 'Hà Nội');
    await userEvent.click(screen.getByRole('button', { name: 'Thêm đáp án' }));
    await userEvent.type(questionForm().getByLabelText('Đáp án 2'), 'Ha Noi');
    // Form không còn ô tỉ trọng cho đáp án (quyết 12:04).
    expect(questionForm().queryByLabelText(/Tỷ trọng/)).toBeNull();
    await userEvent.click(questionForm().getByRole('checkbox', { name: 'Phân biệt hoa/thường (useCase)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    // Mọi mẫu liệt kê đều là đáp án ĐƯỢC CHẤP NHẬN (correct: true) —
    // khớp chính xác khi chấm, không có đáp án đúng một phần.
    expect(createCall?.body).toEqual({
      categoryId: CATEGORY_ID,
      qtype: 'shortanswer',
      questionText: doc('Thủ đô của Việt Nam?'),
      answers: [
        { text: 'Hà Nội', correct: true },
        { text: 'Ha Noi', correct: true },
      ],
      options: { useCase: true, numericAnswer: false },
    });
  });

  it('sends the numeric answer flags only when the numeric option is enabled', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await pickSelectOption(questionForm(), 'Loại câu hỏi', 'Trả lời ngắn (shortanswer)');
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), '3,5 + 1,5 bằng bao nhiêu?');
    await userEvent.type(questionForm().getByLabelText('Đáp án 1'), '5');
    // Cờ đáp án số mặc định TẮT: bật lên mới hiện các cờ con.
    await userEvent.click(questionForm().getByRole('checkbox', { name: 'Đáp án là số (áp dụng bộ quy tắc đáp án số)' }));
    await userEvent.type(questionForm().getByLabelText('Số ký tự tối đa'), '10');
    await userEvent.click(questionForm().getByRole('checkbox', { name: 'Cho phép phần thập phân' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    expect(createCall?.body).toMatchObject({
      qtype: 'shortanswer',
      options: {
        useCase: false,
        numericAnswer: true,
        numericMaxLength: 10,
        numericAllowSign: false,
        numericAllowDecimal: true,
      },
    });
  });

  it('creates an essay question with response options, grader info, template, guidance and a model answer on the answer side', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    await screen.findByText('General');
    await openNewQuestionForm();
    await pickSelectOption(questionForm(), 'Loại câu hỏi', 'Tự luận (essay)');
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Hãy phân tích bài thơ.');
    await pickSelectOption(questionForm(), 'Định dạng trả lời', 'Văn bản thuần (plain)');
    await userEvent.click(questionForm().getByRole('checkbox', { name: 'Bài trả lời bắt buộc' }));
    await userEvent.clear(questionForm().getByLabelText('Số dòng của trường trả lời'));
    await userEvent.type(questionForm().getByLabelText('Số dòng của trường trả lời'), '12');
    await userEvent.type(questionForm().getByLabelText('Số từ tối thiểu'), '50');
    await userEvent.type(questionForm().getByLabelText('Số từ tối đa'), '500');
    await userEvent.type(questionForm().getByLabelText('Thông tin cho người chấm (grader info)'), 'Chấm theo thang 10.');
    await userEvent.type(questionForm().getByLabelText('Khung bài làm mẫu (response template)'), 'Mở bài: ...');
    await userEvent.type(questionForm().getByLabelText('Hướng dẫn (guidance)'), 'Chú ý hình ảnh trung tâm của bài thơ.');
    await userEvent.type(questionForm().getByLabelText('Lời giải mẫu (solution)'), 'Bài làm mẫu: mở bài giới thiệu tác giả...');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo câu hỏi' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/questions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/questions' && c.method === 'POST');
    // Hướng dẫn và lời giải mẫu đi ở PHÍA ĐÁP ÁN (guidance/solution ở
    // cấp payload), không nằm trong thân câu; essay không có answers.
    expect(createCall?.body).toEqual({
      categoryId: CATEGORY_ID,
      qtype: 'essay',
      questionText: doc('Hãy phân tích bài thơ.'),
      guidance: doc('Chú ý hình ảnh trung tâm của bài thơ.'),
      solution: { answer: doc('Bài làm mẫu: mở bài giới thiệu tác giả...') },
      options: {
        responseFormat: 'plain',
        responseRequired: false,
        responseFieldLines: 12,
        minWordLimit: 50,
        maxWordLimit: 500,
        graderInfo: doc('Chấm theo thang 10.'),
        responseTemplate: doc('Mở bài: ...'),
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
    // Trạng thái đáp án đúng tải lại đúng từ isCorrect của bản ghi:
    // radio tại lựa chọn Hà Nội đang được chọn, các lựa chọn khác không.
    const radios = editForm.getAllByRole('radio', { name: 'Đặt làm đáp án đúng' });
    expect(radios).toHaveLength(4);
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
    await userEvent.clear(choice1);
    await userEvent.type(choice1, 'Hà Nội (thủ đô)');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thành phiên bản mới' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH')).toBe(true),
    );
    const patchCall = calls.find((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH');
    expect(patchCall?.body).toEqual({
      questionText: doc('Thủ đô của Việt Nam là gì?'),
      answers: [
        { text: doc('Hà Nội (thủ đô)'), correct: true },
        { text: doc('Huế'), correct: false },
        { text: doc('Đà Nẵng'), correct: false },
        { text: doc('Cần Thơ'), correct: false },
      ],
      options: {
        shuffleAnswers: false,
        answerNumbering: 'abc',
        showStandardInstruction: true,
      },
      stimulusId: null,
    });
    // §9: lưu xong quay về màn danh sách; huy hiệu phiên bản trên dòng đã lên v2.
    expect(await screen.findByTestId(`version-badge-${QUESTION_ID}`)).toHaveTextContent('v2');
  });

  it('preserves non-default multichoice options and feedback documents when editing', async () => {
    const calls: RecordedCall[] = [];
    const correctFeedback = doc('Phản hồi khi đúng');
    const incorrectFeedback = doc('Phản hồi khi sai');
    stubFetch(calls, [
      multichoiceView({
        options: {
          shuffleAnswers: true,
          answerNumbering: '123',
          showStandardInstruction: false,
          correctFeedback,
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
      questionText: doc('Thủ đô của Việt Nam là gì?'),
      answers: [
        { text: doc('Hà Nội'), correct: true },
        { text: doc('Huế'), correct: false },
        { text: doc('Đà Nẵng'), correct: false },
        { text: doc('Cần Thơ'), correct: false },
      ],
      options: {
        shuffleAnswers: true,
        answerNumbering: '123',
        showStandardInstruction: false,
        correctFeedback,
        incorrectFeedback,
      },
      stimulusId: null,
    });
  });

  it('reopens an MCP-created draft intact and publishes it as ready', async () => {
    const calls: RecordedCall[] = [];
    const generalFeedback = doc('Lời giải: Hà Nội là thủ đô.');
    const guidance = doc('Gợi ý: nhớ lại vị trí địa lý.');
    const view = multichoiceView({
      entry: {
        id: '01900000-0000-7000-8000-000000000002',
        questionCategoryId: CATEGORY_ID,
        questionId: QUESTION_ID,
        latestVersion: 1,
        status: 'draft',
      },
      answerKey: { guidance, solution: null },
    });
    (view.latestVersion as Record<string, unknown>).generalFeedback = generalFeedback;
    stubFetch(calls, [view]);
    renderBank();

    const row = await screen.findByTestId(`question-${QUESTION_ID}`);
    await userEvent.click(within(row).getByText('Sửa (phiên bản mới)'));
    await screen.findByRole('button', { name: 'Lưu thành phiên bản mới' });

    // Câu draft mở ra giữ nguyên tài liệu: thân câu, phản hồi chung và
    // hướng dẫn (nạp từ phía đáp án) còn nguyên.
    const editForm = questionForm('Lưu thành phiên bản mới');
    expect(editForm.getByLabelText('Nội dung câu hỏi')).toHaveValue('Thủ đô của Việt Nam là gì?');
    expect(editForm.getByLabelText('Phản hồi chung (general feedback)')).toHaveValue('Lời giải: Hà Nội là thủ đô.');
    expect(editForm.getByLabelText('Hướng dẫn (guidance)')).toHaveValue('Gợi ý: nhớ lại vị trí địa lý.');
    expect(await screen.findByText('Bản nháp')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Lưu thành phiên bản mới' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/questions/${QUESTION_ID}/status` && c.method === 'POST')).toBe(true),
    );
    const patchCall = calls.find((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH');
    expect(patchCall?.body).toMatchObject({ generalFeedback, guidance });
    const statusCall = calls.find((c) => c.url === `/api/v1/questions/${QUESTION_ID}/status`);
    expect(statusCall?.body).toEqual({ status: 'ready' });
  });

  it('preserves non-default essay response options and the model answer when editing', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, [
      multichoiceView({
        question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: 'essay' },
        answers: [],
        answerKey: { guidance: null, solution: { answer: doc('Lời giải mẫu đầy đủ.') } },
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
    // Lời giải mẫu nạp lại từ phía đáp án (answerKey.solution).
    expect(editForm.getByLabelText('Lời giải mẫu (solution)')).toHaveValue('Lời giải mẫu đầy đủ.');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thành phiên bản mới' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH')).toBe(true),
    );
    const patchCall = calls.find((c) => c.url === `/api/v1/questions/${QUESTION_ID}` && c.method === 'PATCH');
    expect(patchCall?.body).toEqual({
      questionText: doc('Thủ đô của Việt Nam là gì?'),
      solution: { answer: doc('Lời giải mẫu đầy đủ.') },
      options: {
        responseFormat: 'editor',
        responseRequired: false,
        responseFieldLines: 7,
        minWordLimit: 20,
        maxWordLimit: 200,
        graderInfo: doc('Chấm theo rubric.'),
        responseTemplate: doc('Mở bài mẫu.'),
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
    const router = renderBank();

    // Ngữ liệu là trang riêng /questions/stimuli (chuẩn đường dẫn
    // #221, lát R1) — tạo ngữ liệu ở đó trước.
    // Điều hướng phải bọc trong act để React flush xong render sau
    // điều hướng trước khi đọc DOM, và tín hiệu chờ phải là phần tử
    // chỉ có ở trang ngữ liệu: 'General' là tên danh mục, render ở
    // cả hai trang nên không tự chứng minh render mới đã xong, và
    // lệnh đọc nhãn đồng bộ ngay sau đó có thể đọc phải DOM cũ.
    await act(async () => {
      await router.navigate('/questions/stimuli');
    });
    await screen.findByRole('button', { name: 'Tạo ngữ liệu' });
    await userEvent.type(screen.getByLabelText('Ngữ liệu mới'), 'Đoạn văn về thủ đô Hà Nội.');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo ngữ liệu' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/stimuli' && c.method === 'POST')).toBe(true));
    const stimulusCall = calls.find((c) => c.url === '/api/v1/stimuli' && c.method === 'POST');
    expect(stimulusCall?.body).toEqual({ categoryId: CATEGORY_ID, content: 'Đoạn văn về thủ đô Hà Nội.' });
    expect(await screen.findByTestId(`stimulus-row-${STIMULUS_ID}`)).toHaveTextContent('Đoạn văn về thủ đô Hà Nội.');

    // Quay về trang câu hỏi để tạo câu hỏi gắn ngữ liệu vừa tạo.
    // Cùng mẫu rủi ro như lần điều hướng trên nên bọc trong act.
    await act(async () => {
      await router.navigate('/questions');
    });
    await openNewQuestionForm();
    await userEvent.type(questionForm().getByLabelText('Nội dung câu hỏi'), 'Theo đoạn văn, thủ đô là gì?');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 1'), 'Hà Nội');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 2'), 'Huế');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 3'), 'Đà Nẵng');
    await userEvent.type(questionForm().getByLabelText('Lựa chọn 4'), 'Cần Thơ');
    await userEvent.click(questionForm().getAllByRole('radio', { name: 'Đặt làm đáp án đúng' })[0]!);
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
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
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

