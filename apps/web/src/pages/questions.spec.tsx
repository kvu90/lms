import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
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
            question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: 'truefalse', name: 'Sky' },
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
    localStorage.setItem('lms.accessToken', 'test-token');
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

    await userEvent.click(await screen.findByRole('checkbox', { name: /Chọn câu hỏi Sky/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Bắt đầu làm bài' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/question-usages' && c.method === 'POST')).toBe(true),
    );
    const createCall = calls.find((c) => c.url === '/api/v1/question-usages' && c.method === 'POST');
    expect(createCall?.body).toEqual({ component: 'mod_quiz', slots: [{ questionId: QUESTION_ID }] });
    expect(await screen.findByText(/Trạng thái lượt làm:/)).toBeInTheDocument();
  });

  it('submits an answer via POST submit and only shows the fraction after POST finish', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
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
    localStorage.setItem('lms.accessToken', 'test-token');
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
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
 * trang chỉ render khu vực của nó, collapse của khu mở sẵn; nút Thêm
 * mới trong khu riêng dùng được (không disabled oan) cho CẢ admin
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

  async function expectFullBankSurface() {
    localStorage.setItem('lms.accessToken', 'test-token');
    // Câu hỏi của tôi (/questions): chỉ có collapse riêng và mở sẵn;
    // hai khu riêng còn lại KHÔNG nằm chung trang nữa (chuẩn #221).
    renderArea('my-questions');
    expect(await screen.findByRole('button', { name: /Ngân hàng riêng của tôi/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.queryByRole('button', { name: /Ma trận của tôi/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ngân hàng hệ thống/ })).toBeNull();
    // Nút Thêm mới trong khu riêng dùng được (bank cá nhân có category
    // mặc định) — không disabled oan theo vai.
    const addButtons = await screen.findAllByRole('button', { name: 'Thêm mới' });
    expect(addButtons.length).toBeGreaterThanOrEqual(1);
    for (const b of addButtons) expect(b).not.toBeDisabled();
    cleanup();
    // Ma trận của tôi (/matrices): collapse ma trận mở sẵn ở trang
    // riêng, Thêm mới cũng dùng được.
    renderArea('my-matrices');
    expect(await screen.findByRole('button', { name: /Ma trận của tôi/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: /Ngân hàng riêng của tôi/ })).toBeNull();
    const matrixAdd = await screen.findAllByRole('button', { name: 'Thêm mới' });
    expect(matrixAdd.length).toBeGreaterThanOrEqual(1);
    for (const b of matrixAdd) expect(b).not.toBeDisabled();
    cleanup();
    // Đề của tôi (/exams): collapse đề mở sẵn ở trang riêng.
    renderArea('my-exams');
    expect(await screen.findByRole('button', { name: /Đề của tôi/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: /Ngân hàng riêng của tôi/ })).toBeNull();
    cleanup();
    // Ngân hàng hệ thống (/system-bank/questions): collapse hệ thống
    // mở sẵn và chỉ render đúng phần câu hỏi của khu.
    renderArea('system-questions');
    expect(await screen.findByRole('button', { name: /Ngân hàng hệ thống/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(document.getElementById('system-questions')).not.toBeNull();
    expect(document.getElementById('system-papers')).toBeNull();
    expect(document.getElementById('system-matrices')).toBeNull();
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
 * path riêng và trang chỉ render đúng khu vực của path đó, collapse
 * của khu mở sẵn ngay từ lần dựng đầu (aria-expanded=true), các khu
 * khác KHÔNG có trong trang. Ba phần của Ngân hàng hệ thống giữ neo
 * #system-questions / #system-papers / #system-matrices trên từng
 * trang con; thẻ Ngữ liệu giữ neo #stimuli ở /questions/stimuli.
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
  const AREA_CASES: Array<{ area: BankArea; path: string; toggle: RegExp | null }> = [
    { area: 'my-questions', path: '/questions', toggle: /Ngân hàng riêng của tôi/ },
    { area: 'stimuli', path: '/questions/stimuli', toggle: null },
    { area: 'my-exams', path: '/exams', toggle: /Đề của tôi/ },
    { area: 'my-matrices', path: '/matrices', toggle: /Ma trận của tôi/ },
    { area: 'system-questions', path: '/system-bank/questions', toggle: /Ngân hàng hệ thống/ },
    { area: 'system-exams', path: '/system-bank/exams', toggle: /Ngân hàng hệ thống/ },
    { area: 'system-matrices', path: '/system-bank/matrices', toggle: /Ngân hàng hệ thống/ },
  ];
  const ALL_TOGGLES = [/Ngân hàng riêng của tôi/, /Ma trận của tôi/, /Đề của tôi/, /Ngân hàng hệ thống/];

  for (const areaCase of AREA_CASES) {
    it(`${areaCase.path} chỉ render khu vực ${areaCase.area}, collapse của khu mở sẵn`, async () => {
      localStorage.setItem('lms.accessToken', 'test-token');
      stubAreaFetch();
      const router = createMemoryRouter([{ path: areaCase.path, element: <QuestionsPage area={areaCase.area} /> }], {
        initialEntries: [areaCase.path],
      });
      render(
        <TestProviders>
          <RouterProvider router={router} />
        </TestProviders>,
      );

      if (areaCase.toggle) {
        expect(await screen.findByRole('button', { name: areaCase.toggle })).toHaveAttribute('aria-expanded', 'true');
      } else {
        // Trang Ngữ liệu không có thẻ ngân hàng nào — chờ §9 render.
        expect(await screen.findByText('General')).toBeInTheDocument();
      }
      // Các collapse của khu KHÁC không có mặt trong trang này.
      for (const other of ALL_TOGGLES) {
        if (areaCase.toggle && other.source === areaCase.toggle.source) continue;
        expect(screen.queryByRole('button', { name: other })).toBeNull();
      }
    });
  }

  it('/questions/stimuli render thẻ Ngữ liệu với neo #stimuli', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
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
    localStorage.setItem('lms.accessToken', 'test-token');
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
      expect(await screen.findByRole('button', { name: /Ngân hàng hệ thống/ })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      for (const other of parts) {
        if (other.id === part.id) expect(document.getElementById(other.id)).not.toBeNull();
        else expect(document.getElementById(other.id)).toBeNull();
      }
      cleanup();
    }
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
      localStorage.setItem('lms.accessToken', 'test-token');
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
