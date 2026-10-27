import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { QuestionCategoryNewPage, QuestionsPage, QuestionUsagePage } from './questions';
import QuestionsRoute from '../routes/questions';
import StimuliRoute from '../routes/question-stimuli';
import ExamsRoute from '../routes/exams';
import ExamPaperNewRoute from '../routes/exam-paper-new';
import ExamPaperEditRoute from '../routes/exam-paper-edit';
import LegacyExamPapersRoute from '../routes/legacy-exam-papers';
import LegacyExamPaperNewRoute from '../routes/legacy-exam-paper-new';
import LegacyExamPaperEditRoute from '../routes/legacy-exam-paper-edit';
import MatricesRoute from '../routes/matrices';
import MatrixNewRoute from '../routes/question-matrix-new';
import MatrixEditRoute from '../routes/question-matrix-edit';
import LegacyMatrixNewRoute from '../routes/legacy-matrix-new';
import LegacyMatrixEditRoute from '../routes/legacy-matrix-edit';
import SystemBankRoute from '../routes/system-bank';
import SystemBankQuestionsRoute from '../routes/system-bank-questions';
import SystemBankExamsRoute from '../routes/system-bank-exams';
import LegacySystemBankPapersRoute from '../routes/legacy-system-bank-papers';
import SystemBankMatricesRoute from '../routes/system-bank-matrices';

/**
 * Spec flow làm bài theo endpoint thật của question engine: tạo usage từ
 * các câu hỏi đã chọn (POST /question-usages, component mod_quiz, slots chỉ
 * gồm questionId), rồi trên trang usage nộp bài qua POST .../submit và chốt
 * điểm qua POST /question-usages/:id/finish (deferredfeedback).
 */
const USAGE_ID = '01900000-0000-7000-8000-000000000009';
const ATTEMPT_ID = '01900000-0000-7000-8000-000000000011';
const QUESTION_ID = '01900000-0000-7000-8000-000000000004';
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';
const SYSTEM_CTX_ID = '01900000-0000-7000-8000-0000000000a1';
const NEW_CATEGORY_ID = '01900000-0000-7000-8000-000000000051';

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

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub fetch ghi lời gọi và mô phỏng máy trạng thái attempt ở phía server. */
function stubFetch(calls: RecordedCall[]) {
  const categories = [{ id: CATEGORY_ID, name: 'General', contextId: SYSTEM_CTX_ID, info: '', parent: null }];
  const state = {
    attempt: 'notstarted',
    fraction: null as number | null,
    steps: [] as {
      id: string;
      sequenceNumber: number;
      state: string;
      fraction: number | null;
      data: Record<string, string>;
    }[],
  };
  const usageBody = () => ({
    usage: { id: USAGE_ID, component: 'mod_quiz', instanceId: null, preferredBehaviour: 'deferredfeedback' },
    state:
      state.attempt === 'notstarted' ? 'notstarted' : state.attempt.startsWith('graded') ? 'finished' : 'inprogress',
    attempts: [
      {
        id: ATTEMPT_ID,
        questionUsageId: USAGE_ID,
        slot: 1,
        behaviour: 'deferredfeedback',
        questionId: QUESTION_ID,
        questionVersionId: state.attempt === 'notstarted' ? null : '01900000-0000-7000-8000-000000000008',
        maxMark: 1,
        state: state.attempt,
        fraction: state.fraction,
        steps: state.steps,
      },
    ],
  });
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
      if (url === '/api/v1/access/contexts')
        return respond([{ id: SYSTEM_CTX_ID, contextLevel: 10, instanceId: SYSTEM_CTX_ID }]);
      if (url === '/api/v1/questions/categories' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { name: string; contextId: string };
        const created = { id: NEW_CATEGORY_ID, name: body.name, contextId: body.contextId, info: '', parent: null };
        categories.push(created);
        return respond(created);
      }
      if (url === '/api/v1/questions/categories') return respond(categories);
      if (url === `/api/v1/questions/categories/${CATEGORY_ID}/questions`) {
        return respond([
          {
            question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: 'truefalse' },
            entry: {
              id: '01900000-0000-7000-8000-000000000002',
              questionCategoryId: CATEGORY_ID,
              questionId: QUESTION_ID,
              latestVersion: 1,
            },
            latestVersion: {
              id: '01900000-0000-7000-8000-000000000008',
              questionBankEntryId: '01900000-0000-7000-8000-000000000002',
              questionId: QUESTION_ID,
              version: 1,
              questionText: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The sky is blue.' }] }],
              },
              defaultMark: 1,
            },
          },
        ]);
      }
      if (url === '/api/v1/question-usages' && method === 'POST') return respond(usageBody());
      if (url === `/api/v1/question-usages/${USAGE_ID}`) return respond(usageBody());
      if (url === `/api/v1/question-usages/${USAGE_ID}/start` && method === 'POST') {
        state.attempt = 'todo';
        state.steps = [
          { id: '01900000-0000-7000-8000-000000000021', sequenceNumber: 0, state: 'todo', fraction: null, data: {} },
        ];
        return respond(usageBody());
      }
      if (url === `/api/v1/question-usages/${USAGE_ID}/attempts/${ATTEMPT_ID}/submit` && method === 'POST') {
        state.attempt = 'complete';
        state.steps = [
          ...state.steps,
          {
            id: '01900000-0000-7000-8000-000000000022',
            sequenceNumber: 1,
            state: 'complete',
            fraction: null,
            data: { answer: 'true' },
          },
        ];
        return respond(state.steps[state.steps.length - 1]);
      }
      if (url === `/api/v1/question-usages/${USAGE_ID}/finish` && method === 'POST') {
        state.attempt = 'gradedright';
        state.fraction = 1;
        return respond(usageBody());
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Question usage flow — real endpoints', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('creates a usage from selected questions and navigates to the usage page', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    const router = createMemoryRouter(
      [
        { path: '/questions', element: <QuestionsPage /> },
        { path: '/question-usages/:id', element: <QuestionUsagePage /> },
      ],
      { initialEntries: ['/questions'] },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    await userEvent.click(await screen.findByRole('checkbox', { name: /Chọn câu hỏi The sky is blue/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Bắt đầu làm bài' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/question-usages' && c.method === 'POST')).toBe(true),
    );
    const createCall = calls.find((c) => c.url === '/api/v1/question-usages' && c.method === 'POST');
    expect(createCall?.body).toEqual({ component: 'mod_quiz', slots: [{ questionId: QUESTION_ID }] });
    expect(await screen.findByText(/Trạng thái lượt làm:/)).toBeInTheDocument();
  });

  it('submits an answer via POST submit and only shows the fraction after POST finish', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    const router = createMemoryRouter([{ path: '/question-usages/:id', element: <QuestionUsagePage /> }], {
      initialEntries: [`/question-usages/${USAGE_ID}`],
    });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Bắt đầu lượt làm' }));
    const answer = await screen.findByLabelText('Câu trả lời cho ô 1');
    await userEvent.type(answer, 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Nộp câu trả lời' }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/submit'))).toBe(true));
    const submitCall = calls.find((c) => c.url.endsWith('/submit'));
    expect(submitCall?.method).toBe('POST');
    expect(submitCall?.url).toBe(`/api/v1/question-usages/${USAGE_ID}/attempts/${ATTEMPT_ID}/submit`);
    expect(submitCall?.body).toEqual({ response: 'true' });
    // deferredfeedback: đã nộp (complete) nhưng chưa có điểm.
    await waitFor(() => expect(screen.getByTestId(`attempt-${ATTEMPT_ID}`)).toHaveTextContent('complete'));
    expect(screen.getByTestId(`attempt-${ATTEMPT_ID}`)).not.toHaveTextContent('hệ số');

    await userEvent.click(screen.getByRole('button', { name: 'Kết thúc lượt làm' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/question-usages/${USAGE_ID}/finish` && c.method === 'POST')).toBe(
        true,
      ),
    );
    await waitFor(() => expect(screen.getByTestId(`attempt-${ATTEMPT_ID}`)).toHaveTextContent('gradedright'));
    expect(screen.getByTestId(`attempt-${ATTEMPT_ID}`)).toHaveTextContent('hệ số 1');
  });

  it('creates a category on its own screen through the context select, defaulting to the system context (issue #55, §9)', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    const router = createMemoryRouter(
      [
        { path: '/questions', element: <QuestionsPage /> },
        { path: '/questions/categories/new', element: <QuestionCategoryNewPage /> },
      ],
      { initialEntries: ['/questions'] },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    // §9: trang danh sách KHÔNG còn form tạo danh mục inline — chỉ có
    // liên kết sang màn tạo riêng.
    await screen.findByText('General');
    expect(screen.queryByRole('button', { name: 'Tạo danh mục' })).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'Danh mục mới' }));

    // Ngữ cảnh là một Select tử tế của @lms/ui (không còn ô gõ ID thô
    // điền sẵn "1"), mặc định ngữ cảnh hệ thống: trigger hiện nhãn "Hệ
    // thống" và danh sách mở ra có tuỳ chọn đó.
    const contextTrigger = await screen.findByLabelText('Ngữ cảnh');
    expect(contextTrigger).toHaveTextContent('Hệ thống');
    await userEvent.click(contextTrigger);
    await userEvent.click(await screen.findByRole('option', { name: 'Hệ thống' }));

    const createButton = screen.getByRole('button', { name: 'Tạo danh mục' });
    const form = createButton.closest('form');
    if (!form) throw new Error('category form not found');
    await userEvent.type(within(form).getByLabelText('Tên'), 'Danh mục mới của tôi');
    await userEvent.click(createButton);

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/questions/categories' && c.method === 'POST')).toBe(true),
    );
    const createCall = calls.find((c) => c.url === '/api/v1/questions/categories' && c.method === 'POST');
    expect(createCall?.body).toEqual({ name: 'Danh mục mới của tôi', contextId: SYSTEM_CTX_ID });

    // Tạo xong quay về danh sách và danh mục mới hiện ngay trong danh sách.
    expect(await screen.findByText('Danh mục mới của tôi')).toBeInTheDocument();
  });
});

describe('Question bank page — role gate (issue #55)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders no bank data and calls no bank endpoint for a role without question capabilities', async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond({ ...PROFILE, username: 'student1' });
        if (url === '/api/v1/users/me/capabilities')
          return respond({
            userId: PROFILE.id,
            isSiteAdmin: false,
            assignments: [],
            contexts: [{ contextId: SYSTEM_CTX_ID, contextLevel: 10, contextPath: '/1', capabilities: [] }],
          });
        if (url === '/api/v1/courses') return respond([]);
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    const router = createMemoryRouter([{ path: '/questions', element: <QuestionsPage /> }], {
      initialEntries: ['/questions'],
    });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    // waitFor với truy vấn tươi mỗi nhịp: chịu được việc cây React bị dựng
    // lại khi máy kiểm thử quá tải (findByText giữ phần tử của cây cũ).
    await waitFor(
      () => expect(screen.getByText('Bạn không có quyền truy cập ngân hàng câu hỏi.')).toBeInTheDocument(),
      { timeout: 15_000 },
    );
    expect(screen.queryByText('Danh mục mới')).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/api/v1/questions'))).toBe(false);
    expect(calls.some((c) => c.url.startsWith('/api/v1/stimuli'))).toBe(false);
  });
});

/**
 * Parity admin ↔ giáo viên trên bề mặt ngân hàng (việc nối tiếp feat
 * #70, đính chính 25/10/2026): admin có khu riêng ĐÚNG NHƯ giáo viên.
 * Từ lát R1 (chuẩn đường dẫn #221) mỗi khu vực là một trang theo path
 * riêng (/questions, /matrices, /exams, /system-bank/*) và
 * trang chỉ render khu vực của nó; danh sách của khu hiện THẲNG,
 * không qua thẻ thu/mở (chốt 23:43 ngày 26/10/2026, issue #228);
 * nút tạo ở PageHeader dùng được (không disabled oan) cho CẢ admin
 * (isSiteAdmin) lẫn giáo viên (capability qua context, không phải
 * site admin).
 */
describe('Question bank page — admin parity (issue #70)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const PERSONAL_BANK_ID = '01900000-0000-7000-8000-0000000000b1';
  const SCHOOL_BANK_ID = '01900000-0000-7000-8000-0000000000b2';
  const PERSONAL_MATRIX_BANK_ID = '01900000-0000-7000-8000-0000000000b3';
  const SCHOOL_MATRIX_BANK_ID = '01900000-0000-7000-8000-0000000000b4';
  const CAPS = {
    use: true, add: true, edit: true, manageCategory: true, copy: true, share: true, moderate: true,
    matrixView: true, matrixManage: true, matrixCopy: true, matrixShare: true, matrixModerate: true,
  };
  const bankRow = (id: string, scope: string, kind: string) => ({
    id, name: scope === 'personal' ? 'Ngân hàng của tôi' : 'Ngân hàng trường', scope, bankKind: kind,
    ownerId: scope === 'personal' ? PROFILE.id : null, scopeRefId: null, contextId: SYSTEM_CTX_ID,
    status: 'active', createdBy: PROFILE.id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    capabilities: CAPS, defaultCategoryId: kind === 'question' ? CATEGORY_ID : null,
    categoryIds: kind === 'question' ? [CATEGORY_ID] : [],
  });

  function stubBankFetch(username: string, capabilitiesBody: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond({ ...PROFILE, username });
        if (url === '/api/v1/users/me/capabilities') return respond(capabilitiesBody);
        if (url === '/api/v1/courses') return respond([]);
        if (url === '/api/v1/questions/categories')
          return respond([{ id: CATEGORY_ID, name: 'General', contextId: SYSTEM_CTX_ID, info: '', parent: null }]);
        if (url === `/api/v1/questions/categories/${CATEGORY_ID}/questions`) return respond([]);
        if (url === '/api/v1/question-banks')
          return respond([bankRow(PERSONAL_BANK_ID, 'personal', 'question'), bankRow(SCHOOL_BANK_ID, 'school', 'question')]);
        if (url === '/api/v1/question-banks?kind=matrix')
          return respond([
            bankRow(PERSONAL_MATRIX_BANK_ID, 'personal', 'matrix'),
            bankRow(SCHOOL_MATRIX_BANK_ID, 'school', 'matrix'),
          ]);
        if (url === `/api/v1/question-banks/${PERSONAL_MATRIX_BANK_ID}/matrices`) return respond([]);
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  }

  type BankArea = 'my-questions' | 'my-matrices' | 'my-exams' | 'system-questions';
  const AREA_PATHS: Record<BankArea, string> = {
    'my-questions': '/questions',
    'my-matrices': '/matrices',
    'my-exams': '/exams',
    'system-questions': '/system-bank/questions',
  };

  function renderArea(area: BankArea) {
    const path = AREA_PATHS[area];
    const router = createMemoryRouter([{ path, element: <QuestionsPage area={area} /> }], {
      initialEntries: [path],
    });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
  }

  const AREA_TOGGLES = [/Ngân hàng riêng của tôi/, /Ma trận của tôi/, /Đề của tôi/, /Ngân hàng hệ thống/];

  async function expectFullBankSurface() {
    // Câu hỏi của tôi (/questions): danh sách khu riêng hiện THẲNG —
    // không còn thẻ thu/mở của bất kỳ khu ngân hàng nào; nút tạo nằm
    // ở PageHeader (link Câu hỏi mới trỏ đúng đích theo category
    // đang chọn, link Danh mục mới) và KHÔNG còn nút "Thêm mới" lặp
    // trong danh sách.
    renderArea('my-questions');
    const newQuestionLink = await screen.findByRole('link', { name: 'Câu hỏi mới' });
    await waitFor(() =>
      expect(newQuestionLink).toHaveAttribute('href', `/questions/new?category=${CATEGORY_ID}`),
    );
    expect(screen.getByRole('link', { name: 'Danh mục mới' })).toHaveAttribute(
      'href',
      '/questions/categories/new',
    );
    for (const toggle of AREA_TOGGLES) expect(screen.queryByRole('button', { name: toggle })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Thêm mới' })).toBeNull();
    cleanup();
    // Ma trận của tôi (/matrices): nút Ma trận mới + Nhập từ file ở
    // PageHeader; Ma trận mới dùng được (bank cá nhân có sẵn) —
    // không disabled oan theo vai.
    renderArea('my-matrices');
    const newMatrixButton = await screen.findByRole('button', { name: 'Ma trận mới' });
    expect(newMatrixButton).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Nhập từ file' })).toBeInTheDocument();
    for (const toggle of AREA_TOGGLES) expect(screen.queryByRole('button', { name: toggle })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Thêm mới' })).toBeNull();
    cleanup();
    // Đề của tôi (/exams): nút Đề mới ở PageHeader. Stub của
    // describe này không cấp bank đề nên nút disabled đúng luật
    // (chưa có bank cá nhân thì không tạo được); trạng thái enabled
    // + đích khi CÓ bank được khẳng định ở describe đích điều hướng
    // bên dưới.
    renderArea('my-exams');
    expect(await screen.findByRole('button', { name: 'Đề mới' })).toBeDisabled();
    for (const toggle of AREA_TOGGLES) expect(screen.queryByRole('button', { name: toggle })).toBeNull();
    cleanup();
    // Ngân hàng hệ thống (/system-bank/questions): phần câu hỏi
    // hiện thẳng với neo của nó, không qua thẻ thu/mở "Ngân hàng hệ
    // thống" và đầu trang không có nút tạo nào.
    renderArea('system-questions');
    await waitFor(() => expect(document.getElementById('system-questions')).not.toBeNull());
    expect(document.getElementById('system-papers')).toBeNull();
    expect(document.getElementById('system-matrices')).toBeNull();
    for (const toggle of AREA_TOGGLES) expect(screen.queryByRole('button', { name: toggle })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Đề mới' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ma trận mới' })).toBeNull();
    cleanup();
  }

  it('site admin sees and can use the personal bank area exactly like a teacher', async () => {
    stubBankFetch('admin', { userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
    await expectFullBankSurface();
  });

  it('teacher (capabilities via context, not site admin) sees the identical surface', async () => {
    stubBankFetch('teacher1', {
      userId: PROFILE.id,
      isSiteAdmin: false,
      assignments: [],
      contexts: [
        {
          contextId: SYSTEM_CTX_ID, contextLevel: 10, contextPath: '/1',
          capabilities: ['question:useall', 'question:add', 'question:editall', 'question:managecategory'],
        },
      ],
    });
    await expectFullBankSurface();
  });
});

/**
 * Khu vực ngân hàng theo PATH (chuẩn đường dẫn #221, lát R1 — thay
 * cơ chế liên kết sâu ?bank=&section= của issue #70): mỗi khu vực có
 * path riêng và trang chỉ render đúng khu vực của path đó; danh
 * sách của khu hiện THẲNG ngay từ lần dựng đầu, không qua thẻ
 * thu/mở nào (bỏ bọc collapse — chốt 23:43 ngày 26/10/2026, issue
 * #228), các khu khác KHÔNG có trong trang. Ba phần của Ngân hàng
 * hệ thống giữ neo #system-questions / #system-papers /
 * #system-matrices trên từng trang con; thẻ Ngữ liệu giữ neo
 * #stimuli ở /questions/stimuli.
 */
describe('Question bank areas — by path (issue #221)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const PERSONAL_BANK_ID = '01900000-0000-7000-8000-0000000000b1';
  const SCHOOL_BANK_ID = '01900000-0000-7000-8000-0000000000b2';
  const CAPS = {
    use: true, add: true, edit: true, manageCategory: true, copy: true, share: true, moderate: true,
    matrixView: true, matrixManage: true, matrixCopy: true, matrixShare: true, matrixModerate: true,
  };
  const bankRow = (id: string, scope: string, kind: string) => ({
    id, name: scope === 'personal' ? 'Ngân hàng của tôi' : 'Ngân hàng trường', scope, bankKind: kind,
    ownerId: scope === 'personal' ? PROFILE.id : null, scopeRefId: null, contextId: SYSTEM_CTX_ID,
    status: 'active', createdBy: PROFILE.id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    capabilities: CAPS, defaultCategoryId: kind === 'question' ? CATEGORY_ID : null,
    categoryIds: kind === 'question' ? [CATEGORY_ID] : [],
  });

  function stubAreaFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond({ ...PROFILE, username: 'admin' });
        if (url === '/api/v1/users/me/capabilities')
          return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
        if (url === '/api/v1/courses') return respond([]);
        if (url === '/api/v1/questions/categories')
          return respond([{ id: CATEGORY_ID, name: 'General', contextId: SYSTEM_CTX_ID, info: '', parent: null }]);
        if (url === `/api/v1/questions/categories/${CATEGORY_ID}/questions`) return respond([]);
        if (url === '/api/v1/question-banks')
          return respond([bankRow(PERSONAL_BANK_ID, 'personal', 'question'), bankRow(SCHOOL_BANK_ID, 'school', 'question')]);
        if (url === '/api/v1/question-banks?kind=matrix')
          return respond([bankRow(PERSONAL_BANK_ID, 'personal', 'matrix'), bankRow(SCHOOL_BANK_ID, 'school', 'matrix')]);
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  }

  type BankArea = 'my-questions' | 'stimuli' | 'my-exams' | 'my-matrices' | 'system-questions' | 'system-exams' | 'system-matrices';
  const AREA_CASES: Array<{ area: BankArea; path: string }> = [
    { area: 'my-questions', path: '/questions' },
    { area: 'stimuli', path: '/questions/stimuli' },
    { area: 'my-exams', path: '/exams' },
    { area: 'my-matrices', path: '/matrices' },
    { area: 'system-questions', path: '/system-bank/questions' },
    { area: 'system-exams', path: '/system-bank/exams' },
    { area: 'system-matrices', path: '/system-bank/matrices' },
  ];
  const ALL_TOGGLES = [/Ngân hàng riêng của tôi/, /Ma trận của tôi/, /Đề của tôi/, /Ngân hàng hệ thống/];

  for (const areaCase of AREA_CASES) {
    it(`${areaCase.path} chỉ render khu vực ${areaCase.area}, danh sách hiện thẳng không qua thẻ thu/mở`, async () => {
      stubAreaFetch();
      const router = createMemoryRouter([{ path: areaCase.path, element: <QuestionsPage area={areaCase.area} /> }], {
        initialEntries: [areaCase.path],
      });
      render(
        <TestProviders>
          <RouterProvider router={router} />
        </TestProviders>,
      );

      // Dấu hiệu bề mặt của khu đã hiện NGAY, không cần thao tác mở
      // thẻ: nút tạo ở PageHeader (khu cá nhân) / neo phần (khu hệ
      // thống) / danh mục §9 (trang Ngữ liệu dùng chung khung).
      if (areaCase.area === 'my-questions') {
        expect(await screen.findByRole('link', { name: 'Câu hỏi mới' })).toBeInTheDocument();
      } else if (areaCase.area === 'my-exams') {
        expect(await screen.findByRole('button', { name: 'Đề mới' })).toBeInTheDocument();
      } else if (areaCase.area === 'my-matrices') {
        expect(await screen.findByRole('button', { name: 'Ma trận mới' })).toBeInTheDocument();
      } else if (areaCase.area === 'stimuli') {
        expect(await screen.findByText('General')).toBeInTheDocument();
      } else {
        const anchorId = areaCase.area === 'system-exams' ? 'system-papers' : areaCase.area;
        await waitFor(() => expect(document.getElementById(anchorId)).not.toBeNull());
      }
      // Không còn toggle thu/mở của BẤT KỲ khu ngân hàng nào, và
      // không còn nút "Thêm mới" lặp trong danh sách.
      for (const other of ALL_TOGGLES) {
        expect(screen.queryByRole('button', { name: other })).toBeNull();
      }
      expect(screen.queryByRole('button', { name: 'Thêm mới' })).toBeNull();
    });
  }

  it('/questions/stimuli render thẻ Ngữ liệu với neo #stimuli', async () => {
    stubAreaFetch();
    const router = createMemoryRouter(
      [{ path: '/questions/stimuli', element: <QuestionsPage area="stimuli" /> }],
      { initialEntries: ['/questions/stimuli'] },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    await waitFor(() => expect(document.getElementById('stimuli')).not.toBeNull());
  });

  it('mỗi trang /system-bank/* chỉ render đúng phần của nó với neo id tương ứng', async () => {
    stubAreaFetch();
    const parts: Array<{ area: BankArea; path: string; id: string }> = [
      { area: 'system-questions', path: '/system-bank/questions', id: 'system-questions' },
      { area: 'system-exams', path: '/system-bank/exams', id: 'system-papers' },
      { area: 'system-matrices', path: '/system-bank/matrices', id: 'system-matrices' },
    ];
    for (const part of parts) {
      const router = createMemoryRouter([{ path: part.path, element: <QuestionsPage area={part.area} /> }], {
        initialEntries: [part.path],
      });
      render(
        <TestProviders>
          <RouterProvider router={router} />
        </TestProviders>,
      );
      // Phần của trang hiện thẳng với neo của nó — không còn nút
      // thu/mở "Ngân hàng hệ thống" phải bấm mở trước.
      await waitFor(() => expect(document.getElementById(part.id)).not.toBeNull());
      expect(screen.queryByRole('button', { name: /Ngân hàng hệ thống/ })).toBeNull();
      for (const other of parts) {
        if (other.id === part.id) expect(document.getElementById(other.id)).not.toBeNull();
        else expect(document.getElementById(other.id)).toBeNull();
      }
      cleanup();
    }
  });
});

/**
 * Nút tạo ở PageHeader điều hướng đúng đích (bỏ bọc collapse —
 * chốt 23:43 ngày 26/10/2026, issue #228): Đề mới →
 * /exams/new?bank=<bank đề cá nhân>; Ma trận mới → /matrices/new;
 * Nhập từ file → /matrices/import. Khu Hệ thống KHÔNG có bất kỳ
 * nút tạo nào ở đầu trang.
 */
describe('Bank list pages — header create buttons (issue #228)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const PERSONAL_BANK_ID = '01900000-0000-7000-8000-0000000000b1';
  const SCHOOL_BANK_ID = '01900000-0000-7000-8000-0000000000b2';
  const CAPS = {
    use: true, add: true, edit: true, manageCategory: true, copy: true, share: true, moderate: true,
    matrixView: true, matrixManage: true, matrixCopy: true, matrixShare: true, matrixModerate: true,
  };
  const bankRow = (id: string, scope: string, kind: string) => ({
    id, name: scope === 'personal' ? 'Ngân hàng của tôi' : 'Ngân hàng trường', scope, bankKind: kind,
    ownerId: scope === 'personal' ? PROFILE.id : null, scopeRefId: null, contextId: SYSTEM_CTX_ID,
    status: 'active', createdBy: PROFILE.id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    capabilities: CAPS, defaultCategoryId: kind === 'question' ? CATEGORY_ID : null,
    categoryIds: kind === 'question' ? [CATEGORY_ID] : [],
  });

  function stubNavFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond({ ...PROFILE, username: 'admin' });
        if (url === '/api/v1/users/me/capabilities')
          return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
        if (url === '/api/v1/courses') return respond([]);
        if (url === '/api/v1/questions/categories')
          return respond([{ id: CATEGORY_ID, name: 'General', contextId: SYSTEM_CTX_ID, info: '', parent: null }]);
        if (url === '/api/v1/question-banks')
          return respond([bankRow(PERSONAL_BANK_ID, 'personal', 'question'), bankRow(SCHOOL_BANK_ID, 'school', 'question')]);
        if (url === '/api/v1/question-banks?kind=matrix')
          return respond([bankRow(PERSONAL_BANK_ID, 'personal', 'matrix'), bankRow(SCHOOL_BANK_ID, 'school', 'matrix')]);
        if (url === '/api/v1/question-banks?kind=exam')
          return respond([bankRow(PERSONAL_BANK_ID, 'personal', 'exam'), bankRow(SCHOOL_BANK_ID, 'school', 'exam')]);
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  }

  type NavArea = 'my-exams' | 'my-matrices' | 'system-exams';
  function renderNav(area: NavArea, path: string) {
    const router = createMemoryRouter(
      [
        { path, element: <QuestionsPage area={area} /> },
        { path: '/exams/new', element: <div>Màn tạo đề</div> },
        { path: '/matrices/new', element: <div>Màn tạo ma trận</div> },
        { path: '/matrices/import', element: <div>Màn nhập ma trận</div> },
      ],
      { initialEntries: [path] },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
    return router;
  }

  it('/exams: bấm Đề mới ở đầu trang sang /exams/new?bank=<bank đề cá nhân>', async () => {
    stubNavFetch();
    const router = renderNav('my-exams', '/exams');
    const button = await screen.findByRole('button', { name: 'Đề mới' });
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(await screen.findByText('Màn tạo đề')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/exams/new');
    expect(router.state.location.search).toBe(`?bank=${PERSONAL_BANK_ID}`);
  });

  it('/matrices: Ma trận mới → /matrices/new; Nhập từ file → /matrices/import', async () => {
    stubNavFetch();
    const router = renderNav('my-matrices', '/matrices');
    const newButton = await screen.findByRole('button', { name: 'Ma trận mới' });
    expect(newButton).not.toBeDisabled();
    await userEvent.click(newButton);
    expect(await screen.findByText('Màn tạo ma trận')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/matrices/new');
    cleanup();

    const router2 = renderNav('my-matrices', '/matrices');
    await userEvent.click(await screen.findByRole('button', { name: 'Nhập từ file' }));
    expect(await screen.findByText('Màn nhập ma trận')).toBeInTheDocument();
    expect(router2.state.location.pathname).toBe('/matrices/import');
  });

  it('khu Hệ thống (đề): đầu trang không có nút tạo nào', async () => {
    stubNavFetch();
    renderNav('system-exams', '/system-bank/exams');
    await waitFor(() => expect(document.getElementById('system-papers')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Đề mới' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ma trận mới' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Nhập từ file' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Câu hỏi mới' })).toBeNull();
  });
});

/**
 * Thanh tab Cá nhân | Hệ thống trên màn danh sách ngân hàng (chốt
 * trình bày của Lão gia 11:40 ngày 26/10/2026, issue #228 — thay mục
 * "Ngân hàng hệ thống" ở sidebar): cả 6 màn danh sách (câu hỏi / đề /
 * ma trận × cá nhân / hệ thống) dùng CHUNG một thanh tab ở đầu vùng
 * danh sách; tab đang đứng mang aria-current="page", bấm tab là điều
 * hướng sang route của khu vực kia (path riêng, không query định danh
 * khu vực). Vào từ sidebar luôn là tab Cá nhân.
 */
describe('Bank area tabs — Cá nhân | Hệ thống (issue #228)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const PERSONAL_BANK_ID = '01900000-0000-7000-8000-0000000000b1';
  const SCHOOL_BANK_ID = '01900000-0000-7000-8000-0000000000b2';
  const CAPS = {
    use: true, add: true, edit: true, manageCategory: true, copy: true, share: true, moderate: true,
    matrixView: true, matrixManage: true, matrixCopy: true, matrixShare: true, matrixModerate: true,
  };
  const bankRow = (id: string, scope: string, kind: string) => ({
    id, name: scope === 'personal' ? 'Ngân hàng của tôi' : 'Ngân hàng trường', scope, bankKind: kind,
    ownerId: scope === 'personal' ? PROFILE.id : null, scopeRefId: null, contextId: SYSTEM_CTX_ID,
    status: 'active', createdBy: PROFILE.id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    capabilities: CAPS, defaultCategoryId: kind === 'question' ? CATEGORY_ID : null,
    categoryIds: kind === 'question' ? [CATEGORY_ID] : [],
  });

  function stubTabFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond({ ...PROFILE, username: 'admin' });
        if (url === '/api/v1/users/me/capabilities')
          return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
        if (url === '/api/v1/courses') return respond([]);
        if (url === '/api/v1/questions/categories')
          return respond([{ id: CATEGORY_ID, name: 'General', contextId: SYSTEM_CTX_ID, info: '', parent: null }]);
        if (url === `/api/v1/questions/categories/${CATEGORY_ID}/questions`) return respond([]);
        if (url === '/api/v1/question-banks')
          return respond([bankRow(PERSONAL_BANK_ID, 'personal', 'question'), bankRow(SCHOOL_BANK_ID, 'school', 'question')]);
        if (url === '/api/v1/question-banks?kind=matrix')
          return respond([bankRow(PERSONAL_BANK_ID, 'personal', 'matrix'), bankRow(SCHOOL_BANK_ID, 'school', 'matrix')]);
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  }

  function renderBankRoutes(initialPath: string) {
    // Dùng đúng route module thật như app (mỗi route là một component
    // riêng nên điều hướng qua tab remount trang đích — trạng thái
    // collapse của khu vực đích khởi tạo đúng theo area của nó).
    const router = createMemoryRouter(
      [
        { path: '/questions', element: <QuestionsRoute /> },
        { path: '/system-bank/questions', element: <SystemBankQuestionsRoute /> },
        { path: '/exams', element: <ExamsRoute /> },
        { path: '/system-bank/exams', element: <SystemBankExamsRoute /> },
        { path: '/matrices', element: <MatricesRoute /> },
        { path: '/system-bank/matrices', element: <SystemBankMatricesRoute /> },
      ],
      { initialEntries: [initialPath] },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
    return router;
  }

  it('ở trang hệ thống (câu hỏi): tab Hệ thống active; bấm tab Cá nhân về đúng /questions', async () => {
    stubTabFetch();
    const router = renderBankRoutes('/system-bank/questions');

    const systemTab = await screen.findByRole('link', { name: 'Hệ thống' });
    expect(systemTab).toHaveAttribute('href', '/system-bank/questions');
    expect(systemTab).toHaveAttribute('aria-current', 'page');
    const personalTab = screen.getByRole('link', { name: 'Cá nhân' });
    expect(personalTab).toHaveAttribute('href', '/questions');
    expect(personalTab).not.toHaveAttribute('aria-current');

    await userEvent.click(personalTab);
    // Đã sang trang cá nhân thật: bề mặt ngân hàng riêng hiện thẳng
    // (nút Câu hỏi mới ở PageHeader) và tab Cá nhân thành tab đang
    // đứng.
    expect(
      await screen.findByRole('link', { name: 'Câu hỏi mới' }, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/questions');
    expect(screen.getByRole('link', { name: 'Cá nhân' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Hệ thống' })).not.toHaveAttribute('aria-current');
  });

  it('ở trang cá nhân (đề): tab Cá nhân active; bấm tab Hệ thống sang đúng /system-bank/exams', async () => {
    stubTabFetch();
    const router = renderBankRoutes('/exams');

    const personalTab = await screen.findByRole('link', { name: 'Cá nhân' });
    expect(personalTab).toHaveAttribute('href', '/exams');
    expect(personalTab).toHaveAttribute('aria-current', 'page');
    const systemTab = screen.getByRole('link', { name: 'Hệ thống' });
    expect(systemTab).toHaveAttribute('href', '/system-bank/exams');
    expect(systemTab).not.toHaveAttribute('aria-current');

    await userEvent.click(systemTab);
    // Đã sang trang hệ thống của đề: phần hệ thống render đúng neo.
    await waitFor(() => expect(document.getElementById('system-papers')).not.toBeNull(), { timeout: 10_000 });
    expect(router.state.location.pathname).toBe('/system-bank/exams');
    expect(screen.getByRole('link', { name: 'Hệ thống' })).toHaveAttribute('aria-current', 'page');
  });

  it('ở trang hệ thống (ma trận): tab Hệ thống active, tab Cá nhân trỏ đúng /matrices', async () => {
    stubTabFetch();
    renderBankRoutes('/system-bank/matrices');

    const systemTab = await screen.findByRole('link', { name: 'Hệ thống' });
    expect(systemTab).toHaveAttribute('href', '/system-bank/matrices');
    expect(systemTab).toHaveAttribute('aria-current', 'page');
    const personalTab = screen.getByRole('link', { name: 'Cá nhân' });
    expect(personalTab).toHaveAttribute('href', '/matrices');
    expect(personalTab).not.toHaveAttribute('aria-current');
  });
});

/**
 * Lớp tương thích đường dẫn cũ (chuẩn đường dẫn #221, mục 3.5 của
 * hồ sơ): URL cũ ?bank=...&section=... và /questions/matrices/* phải
 * CHUYỂN HƯỚNG THAY THẾ sang path mới tương ứng — kiểm bằng route
 * module thật trong memory router, khẳng định pathname cuối cùng.
 * Query thuộc diện F2 còn lại (ngoài bank/section) được giữ nguyên.
 */
describe('Legacy bank URLs — redirect to new paths (issue #221)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function stubRedirectFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond({ ...PROFILE, username: 'admin' });
        if (url === '/api/v1/users/me/capabilities')
          return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
        if (url === '/api/v1/courses') return respond([]);
        if (url === '/api/v1/questions/categories')
          return respond([{ id: CATEGORY_ID, name: 'General', contextId: SYSTEM_CTX_ID, info: '', parent: null }]);
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  }

  const MATRIX_ID = '01900000-0000-7000-8000-0000000000c9';
  const REDIRECT_CASES: Array<{ from: string; toPath: string; toSearch?: string }> = [
    { from: '/questions?bank=my-questions', toPath: '/questions', toSearch: '' },
    { from: '/questions?bank=my-questions&section=stimuli', toPath: '/questions/stimuli' },
    { from: '/questions?bank=my-papers', toPath: '/exams' },
    { from: '/questions?bank=my-matrices', toPath: '/matrices' },
    { from: '/questions?bank=system', toPath: '/system-bank/questions' },
    { from: '/questions?bank=system&section=questions', toPath: '/system-bank/questions' },
    { from: '/questions?bank=system&section=papers', toPath: '/system-bank/exams' },
    { from: '/questions?bank=system&section=matrices', toPath: '/system-bank/matrices' },
    { from: '/questions?bank=system&section=papers&x=1', toPath: '/system-bank/exams', toSearch: '?x=1' },
    { from: '/exam-papers', toPath: '/exams' },
    { from: '/exam-papers/new', toPath: '/exams/new' },
    { from: '/exam-papers/01900000-0000-7000-8000-0000000000d7/edit', toPath: '/exams/01900000-0000-7000-8000-0000000000d7/edit' },
    { from: '/system-bank/papers', toPath: '/system-bank/exams' },
    { from: '/questions/matrices/new', toPath: '/matrices/new' },
    { from: `/questions/matrices/${MATRIX_ID}/edit`, toPath: `/matrices/${MATRIX_ID}/edit` },
    { from: '/system-bank', toPath: '/system-bank/questions' },
  ];

  for (const redirectCase of REDIRECT_CASES) {
    it(`${redirectCase.from} → ${redirectCase.toPath}`, async () => {
      stubRedirectFetch();
      const router = createMemoryRouter(
        [
          { path: '/questions', element: <QuestionsRoute /> },
          { path: '/questions/stimuli', element: <StimuliRoute /> },
          { path: '/exams', element: <ExamsRoute /> },
          { path: '/exams/new', element: <ExamPaperNewRoute /> },
          { path: '/exams/:paperId/edit', element: <ExamPaperEditRoute /> },
          { path: '/exam-papers', element: <LegacyExamPapersRoute /> },
          { path: '/exam-papers/new', element: <LegacyExamPaperNewRoute /> },
          { path: '/exam-papers/:paperId/edit', element: <LegacyExamPaperEditRoute /> },
          { path: '/matrices', element: <MatricesRoute /> },
          { path: '/matrices/new', element: <MatrixNewRoute /> },
          { path: '/matrices/:matrixId/edit', element: <MatrixEditRoute /> },
          { path: '/questions/matrices/new', element: <LegacyMatrixNewRoute /> },
          { path: '/questions/matrices/:matrixId/edit', element: <LegacyMatrixEditRoute /> },
          { path: '/system-bank', element: <SystemBankRoute /> },
          { path: '/system-bank/questions', element: <SystemBankQuestionsRoute /> },
          { path: '/system-bank/exams', element: <SystemBankExamsRoute /> },
          { path: '/system-bank/papers', element: <LegacySystemBankPapersRoute /> },
          { path: '/system-bank/matrices', element: <SystemBankMatricesRoute /> },
        ],
        { initialEntries: [redirectCase.from] },
      );
      render(
        <TestProviders>
          <RouterProvider router={router} />
        </TestProviders>,
      );

      await waitFor(() => expect(router.state.location.pathname).toBe(redirectCase.toPath));
      if (redirectCase.toSearch !== undefined) {
        expect(router.state.location.search).toBe(redirectCase.toSearch);
      }
    });
  }
});

/**
 * Đường đóng góp DUY NHẤT của đề (issue #228, S4/Q4): bộ hồ sơ không
 * còn đường ghi riêng — nộp bộ hồ sơ là đề xuất đóng góp kèm đính kèm
 * (`withDossier`), duyệt hai cấp đi trên trạng thái của đóng góp
 * (pending = cấp 1, pending_board = cấp 2 ban giám hiệu), và hàng chờ
 * hồ sơ (bề mặt đọc lịch sử) thao tác duyệt qua đóng góp đã chuyển
 * đổi từ chính hồ sơ đó (sourceDossierId). Các ca dưới đây khoá đúng
 * các lời gọi API của ba thao tác đó và khẳng định KHÔNG còn lời gọi
 * ghi nào tới bề mặt hồ sơ (nơi API đã đóng, trả 410).
 */
describe('Exam dossier writes ride the single contribution path (issue #228 Q4)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const PERSONAL_EXAM_BANK_ID = '01900000-0000-7000-8000-0000000000c1';
  const SCHOOL_EXAM_BANK_ID = '01900000-0000-7000-8000-0000000000c2';
  const PAPER_ID = '01900000-0000-7000-8000-0000000000c3';
  const DOSSIER_PENDING_ID = '01900000-0000-7000-8000-0000000000c4';
  const DOSSIER_BOARD_ID = '01900000-0000-7000-8000-0000000000c5';
  const CONTRIB_FROM_PENDING_ID = '01900000-0000-7000-8000-0000000000c6';
  const CONTRIB_FROM_BOARD_ID = '01900000-0000-7000-8000-0000000000c7';
  const CONTRIB_DIRECT_BOARD_ID = '01900000-0000-7000-8000-0000000000c8';
  const PROPOSER_ID = '01900000-0000-7000-8000-0000000000c9';

  const CAPS = {
    use: true, add: true, edit: true, manageCategory: true, copy: true, share: true, moderate: true,
    matrixView: true, matrixManage: true, matrixCopy: true, matrixShare: true, matrixModerate: true,
  };
  const examBankRow = (id: string, scope: string) => ({
    id, name: scope === 'personal' ? 'Ngân hàng của tôi' : 'Ngân hàng trường', scope, bankKind: 'exam',
    ownerId: scope === 'personal' ? PROFILE.id : null, scopeRefId: null, contextId: SYSTEM_CTX_ID,
    status: 'active', createdBy: PROFILE.id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    capabilities: CAPS, defaultCategoryId: null, categoryIds: [],
  });
  const readyPaper = {
    id: PAPER_ID, bankId: PERSONAL_EXAM_BANK_ID, kind: 'exam', status: 'ready',
    name: 'Đề kiểm tra giữa kỳ', examKind: null, slotCount: 10, latestVersion: 3,
    createdBy: PROFILE.id, copyCount: 0,
    capabilities: { edit: true, copy: true, deploy: true, moderate: true },
  };
  const SPEC_SNAPSHOT = {
    totals: { totalQuestions: 10, totalScore: 10 },
    topics: [
      { nodes: [{ outcomes: [{ cells: [{ cognitiveLevel: 'biet', questionCount: 4, cellScore: 4, slotNumbers: [1, 2, 3, 4] }] }] }] },
    ],
  };
  const dossierRow = (id: string, status: string) => ({
    id, examId: PAPER_ID, examName: 'Đề kiểm tra giữa kỳ', sourceBankId: PERSONAL_EXAM_BANK_ID,
    targetBankId: SCHOOL_EXAM_BANK_ID, proposerId: PROPOSER_ID, proposerName: 'Cô Lan',
    note: '', status, examVersionId: '01900000-0000-7000-8000-0000000000ca', examVersionNumber: 3,
    matrixId: '01900000-0000-7000-8000-0000000000cb', matrixName: 'Ma trận giữa kỳ', matrixVersion: 2,
    matrixVersionId: '01900000-0000-7000-8000-0000000000cc', boardApprovalRequired: true,
    resultExamId: null, reviews: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const contributionRow = (id: string, status: string, sourceDossierId: string | null) => ({
    id, examId: PAPER_ID, targetBankId: SCHOOL_EXAM_BANK_ID, proposerId: PROPOSER_ID, note: '',
    mode: 'new', targetExamId: null, status, contentHash: 'hash', nearDuplicateOf: null,
    rejectReason: null, reviewerId: null, resultExamId: null,
    dossierExamVersionId: '01900000-0000-7000-8000-0000000000ca', dossierExamVersionNumber: 3,
    dossierMatrixId: '01900000-0000-7000-8000-0000000000cb', dossierMatrixVersion: 2,
    dossierMatrixVersionId: '01900000-0000-7000-8000-0000000000cc',
    dossierSpecSnapshot: SPEC_SNAPSHOT, sourceDossierId,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    paperName: 'Đề kiểm tra giữa kỳ', sourceBankId: PERSONAL_EXAM_BANK_ID, reviews: [],
  });

  interface DossierFixtures {
    dossiers: ReturnType<typeof dossierRow>[];
    contributions: ReturnType<typeof contributionRow>[];
  }

  function stubContributionFetch(calls: RecordedCall[], fixtures: DossierFixtures) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond({ ...PROFILE, username: 'admin' });
        if (url === '/api/v1/users/me/capabilities')
          return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
        if (url === '/api/v1/courses') return respond([]);
        if (url === '/api/v1/access/contexts')
          return respond([{ id: SYSTEM_CTX_ID, contextLevel: 10, instanceId: SYSTEM_CTX_ID }]);
        if (url === '/api/v1/questions/categories')
          return respond([{ id: CATEGORY_ID, name: 'General', contextId: SYSTEM_CTX_ID, info: '', parent: null }]);
        if (url === '/api/v1/question-banks?kind=exam')
          return respond([examBankRow(PERSONAL_EXAM_BANK_ID, 'personal'), examBankRow(SCHOOL_EXAM_BANK_ID, 'school')]);
        if (url === '/api/v1/question-banks?kind=matrix') return respond([]);
        if (url === '/api/v1/question-banks') return respond([]);
        if (url === `/api/v1/exams/banks/${PERSONAL_EXAM_BANK_ID}/exams`) return respond([readyPaper]);
        if (url === `/api/v1/exams/banks/${SCHOOL_EXAM_BANK_ID}/exams`) return respond([]);
        if (url === `/api/v1/exams/banks/${SCHOOL_EXAM_BANK_ID}/contributions` && method === 'GET')
          return respond(fixtures.contributions);
        if (url === `/api/v1/exams/banks/${SCHOOL_EXAM_BANK_ID}/contributions` && method === 'POST')
          return respond(contributionRow(CONTRIB_DIRECT_BOARD_ID, 'pending', null));
        if (url.startsWith(`/api/v1/exams/banks/${SCHOOL_EXAM_BANK_ID}/contributions/`) && method === 'POST')
          return respond({});
        if (url === `/api/v1/exams/banks/${SCHOOL_EXAM_BANK_ID}/dossiers`) return respond(fixtures.dossiers);
        if (url === '/api/v1/exams/dossiers/mine') return respond([]);
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  }

  const dossierWriteCalls = (calls: RecordedCall[]) =>
    calls.filter((c) => c.method !== 'GET' && c.url.includes('/dossiers'));

  it('nộp bộ hồ sơ = POST đóng góp kèm withDossier vào bank đích, không lập/nộp hồ sơ', async () => {
    const calls: RecordedCall[] = [];
    stubContributionFetch(calls, { dossiers: [], contributions: [] });
    const router = createMemoryRouter([{ path: '/exams', element: <QuestionsPage area="my-exams" /> }], {
      initialEntries: ['/exams'],
    });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    await userEvent.selectOptions(await screen.findByTestId('dossier-paper-select'), PAPER_ID);
    await userEvent.selectOptions(screen.getByTestId('dossier-bank-select'), SCHOOL_EXAM_BANK_ID);
    await userEvent.click(screen.getByTestId('dossier-submit-button'));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/exams/banks/${SCHOOL_EXAM_BANK_ID}/contributions` && c.method === 'POST'),
      ).toBe(true),
    );
    const proposeCall = calls.find(
      (c) => c.url === `/api/v1/exams/banks/${SCHOOL_EXAM_BANK_ID}/contributions` && c.method === 'POST',
    );
    expect(proposeCall?.body).toEqual({ examId: PAPER_ID, withDossier: true });
    expect(dossierWriteCalls(calls)).toEqual([]);
    expect(await screen.findByText('Đã nộp bộ hồ sơ chờ duyệt.')).toBeInTheDocument();
  });

  it('hàng chờ hồ sơ: duyệt cấp 1 và cấp 2 đi trên đóng góp đã chuyển đổi (sourceDossierId), không gọi ghi hồ sơ', async () => {
    const calls: RecordedCall[] = [];
    stubContributionFetch(calls, {
      dossiers: [dossierRow(DOSSIER_PENDING_ID, 'pending'), dossierRow(DOSSIER_BOARD_ID, 'pending_board')],
      contributions: [
        contributionRow(CONTRIB_FROM_PENDING_ID, 'pending', DOSSIER_PENDING_ID),
        contributionRow(CONTRIB_FROM_BOARD_ID, 'pending_board', DOSSIER_BOARD_ID),
      ],
    });
    const router = createMemoryRouter([{ path: '/system-bank/exams', element: <QuestionsPage area="system-exams" /> }], {
      initialEntries: ['/system-bank/exams'],
    });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    await userEvent.selectOptions(await screen.findByLabelText('Chọn ngân hàng'), SCHOOL_EXAM_BANK_ID);
    const rows = await screen.findAllByTestId('dossier-queue-row');
    expect(rows).toHaveLength(2);

    // Bộ đang pending: nút Duyệt gọi approve trên ĐÓNG GÓP liên kết.
    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Duyệt' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === `/api/v1/exams/banks/${SCHOOL_EXAM_BANK_ID}/contributions/${CONTRIB_FROM_PENDING_ID}/approve` &&
            c.method === 'POST',
        ),
      ).toBe(true),
    );

    // Bộ đang pending_board: nút BGH duyệt gọi approve trên ĐÓNG GÓP liên kết.
    // (Truy vấn lại hàng sau lượt duyệt cấp 1 vì danh sách được nạp lại.)
    const rowsAfter = await screen.findAllByTestId('dossier-queue-row');
    await userEvent.click(within(rowsAfter[1]!).getByRole('button', { name: 'BGH duyệt' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === `/api/v1/exams/banks/${SCHOOL_EXAM_BANK_ID}/contributions/${CONTRIB_FROM_BOARD_ID}/approve` &&
            c.method === 'POST',
        ),
      ).toBe(true),
    );
    expect(dossierWriteCalls(calls)).toEqual([]);
  });

  it('đóng góp kèm hồ sơ chờ BGH (không qua hồ sơ) hiện ngay ở hàng chờ đóng góp với nút cấp 2 và bản đặc tả đã chụp', async () => {
    const calls: RecordedCall[] = [];
    stubContributionFetch(calls, {
      dossiers: [],
      contributions: [contributionRow(CONTRIB_DIRECT_BOARD_ID, 'pending_board', null)],
    });
    vi.stubGlobal('prompt', vi.fn(() => 'Chưa đạt yêu cầu'));
    const router = createMemoryRouter([{ path: '/system-bank/exams', element: <QuestionsPage area="system-exams" /> }], {
      initialEntries: ['/system-bank/exams'],
    });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    await userEvent.selectOptions(await screen.findByLabelText('Chọn ngân hàng'), SCHOOL_EXAM_BANK_ID);
    const row = await screen.findByTestId('exam-contribution-row');
    expect(within(row).getByText('Chờ BGH duyệt')).toBeInTheDocument();
    expect(within(row).getByText(/Đề v3 · Ma trận v2/)).toBeInTheDocument();

    // Bản đặc tả đã chụp mở tại chỗ từ payload đóng góp.
    await userEvent.click(within(row).getByRole('button', { name: 'Xem đặc tả' }));
    expect(await screen.findByTestId('contribution-spec-panel')).toHaveTextContent('Tổng: 10 câu · 10 điểm');

    // BGH từ chối kèm lý do bắt buộc → reject trên chính đóng góp.
    await userEvent.click(within(row).getByRole('button', { name: 'BGH từ chối' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === `/api/v1/exams/banks/${SCHOOL_EXAM_BANK_ID}/contributions/${CONTRIB_DIRECT_BOARD_ID}/reject` &&
            c.method === 'POST',
        ),
      ).toBe(true),
    );
    const rejectCall = calls.find((c) => c.url.endsWith('/reject'));
    expect(rejectCall?.body).toEqual({ reason: 'Chưa đạt yêu cầu' });
    expect(dossierWriteCalls(calls)).toEqual([]);
  });
});
