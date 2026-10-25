import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { PermissionsProvider } from '#lib/permissions';
import { GradebookPage } from './grades';
import { QuestionsPage, QuestionUsagePage } from './questions';
import { QuestionEditPage } from './question-editor';

const ITEM = {
  id: '01900000-0000-7000-8000-000000000005',
  courseId: '01900000-0000-7000-8000-000000000010',
  categoryId: '01900000-0000-7000-8000-000000000001',
  itemName: 'Quiz 1',
  itemType: 'manual',
  itemModule: null,
  itemInstance: null,
  gradeMax: 100,
  gradeMin: 0,
  gradePass: 50,
  weightOverride: false,
  aggregationCoef: 0,
  extraCredit: false,
  multiplicator: 1,
  plusFactor: 0,
  hidden: false,
  locked: false,
};
const GRADE = {
  id: '01900000-0000-7000-8000-000000000002',
  itemId: '01900000-0000-7000-8000-000000000005',
  userId: '01900000-0000-7000-8000-000000000007',
  rawGrade: 85,
  finalGrade: 85,
  hidden: false,
  locked: false,
  overridden: false,
  excluded: false,
  frozen: false,
  feedback: null,
  aggregationWeight: 100,
  letter: 'B',
};
const BOOK = {
  courseId: '01900000-0000-7000-8000-000000000010',
  userId: '01900000-0000-7000-8000-000000000007',
  categories: [
    {
      category: {
        id: '01900000-0000-7000-8000-000000000001',
        courseId: '01900000-0000-7000-8000-000000000010',
        parent: null,
        fullName: '',
        aggregation: 'natural',
        dropLow: 0,
        keepHigh: 0,
        aggregateOnlyGraded: false,
        depth: 1,
        path: '/1',
        hidden: false,
      },
      total: {
        item: {
          ...ITEM,
          id: '01900000-0000-7000-8000-000000000009',
          itemName: 'Course total',
          itemType: 'course',
          itemInstance: '01900000-0000-7000-8000-000000000010',
        },
        grade: {
          ...GRADE,
          id: '01900000-0000-7000-8000-000000000003',
          itemId: '01900000-0000-7000-8000-000000000009',
          finalGrade: 85,
          letter: 'B',
        },
      },
      items: [{ item: ITEM, grade: GRADE }],
      children: [
        {
          category: {
            id: '01900000-0000-7000-8000-000000000002',
            courseId: '01900000-0000-7000-8000-000000000010',
            parent: '01900000-0000-7000-8000-000000000001',
            fullName: 'Quizzes',
            aggregation: 'mean',
            dropLow: 0,
            keepHigh: 0,
            aggregateOnlyGraded: false,
            depth: 2,
            path: '/1/2',
            hidden: false,
          },
          total: null,
          items: [],
          children: [],
        },
      ],
    },
  ],
  courseTotal: {
    item: {
      ...ITEM,
      id: '01900000-0000-7000-8000-000000000009',
      itemName: 'Course total',
      itemType: 'course',
      itemInstance: '01900000-0000-7000-8000-000000000010',
    },
    grade: {
      ...GRADE,
      id: '01900000-0000-7000-8000-000000000003',
      itemId: '01900000-0000-7000-8000-000000000009',
      finalGrade: 85,
      letter: 'B',
    },
  },
};
const REPORT = {
  courseId: '01900000-0000-7000-8000-000000000010',
  rows: [
    { userId: '01900000-0000-7000-8000-000000000007', finalGrade: 85, letter: 'B' },
    { userId: '01900000-0000-7000-8000-000000000008', finalGrade: 40, letter: 'F' },
  ],
};

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = handler(url, init);
      if (body === undefined)
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/**
 * Render trang sổ điểm trong đúng khung provider của ứng dụng thật.
 * Cập nhật có chủ đích: trang nay đọc `usePermissions()` để chỉ hiện (và
 * chỉ tải) khu quản trị cho staff của khoá, nên test phải bọc
 * AuthProvider + PermissionsProvider như main.tsx. Test học viên dưới đây
 * không đặt token đăng nhập: PermissionsProvider kết luận không phải
 * staff mà không gọi thêm endpoint nào, nên các stub cũ giữ nguyên ý đồ —
 * khu quản trị không xuất hiện và không có lời gọi categories/items nào
 * lúc nạp.
 */
function renderGradebook() {
  const router = createMemoryRouter([{ path: '/courses/:id/grades', element: <GradebookPage /> }], {
    initialEntries: ['/courses/01900000-0000-7000-8000-000000000010/grades'],
  });
  render(
    <TestProviders>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </TestProviders>,
  );
}

describe('Gradebook page', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders the category/item tree with grades, letters and the course total', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/courses/01900000-0000-7000-8000-000000000010/gradebook') return BOOK;
      if (url === '/api/v1/courses/01900000-0000-7000-8000-000000000010/grades/report') return REPORT;
      return undefined;
    });
    renderGradebook();
    await waitFor(() => expect(screen.getByText('Quiz 1')).toBeInTheDocument());
    expect(screen.getByTestId('grade-item-01900000-0000-7000-8000-000000000005')).toHaveTextContent('85');
    expect(screen.getByTestId('grade-item-01900000-0000-7000-8000-000000000005')).toHaveTextContent('B');
    expect(screen.getByText('Quizzes')).toBeInTheDocument();
    expect(screen.getByText(/Tổng điểm khoá học: 85 \(B\)/)).toBeInTheDocument();
    // Teacher report renders alongside.
    expect(screen.getByText('Báo cáo lớp')).toBeInTheDocument();
    // Không phải staff: khu quản trị sổ điểm không được render.
    expect(screen.queryByText('Quản trị sổ điểm')).not.toBeInTheDocument();
  });
});

describe('Gradebook page — kết quả VN của tôi (issue #180)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const COURSE_ID = '01900000-0000-7000-8000-000000000010';
  const MINE_URL = `/api/v1/courses/${COURSE_ID}/grades/vn-results/mine`;

  function stubMine(mine: unknown) {
    stubFetch((url) => {
      if (url === `/api/v1/courses/${COURSE_ID}/gradebook`) return BOOK;
      if (url === `/api/v1/courses/${COURSE_ID}/grades/report`) return REPORT;
      if (url === MINE_URL) return mine;
      return undefined;
    });
  }

  it('đã công bố: hiện ĐTB + nhận xét của kì đã công bố, kì chưa công bố chỉ hiện nhãn chưa công bố', async () => {
    stubMine({
      courseId: COURSE_ID,
      terms: [
        {
          bookId: '01900000-0000-7000-8000-000000000101',
          term: 'hk1',
          assessmentMode: 'score',
          published: true,
          dtbHk: 7.9,
          commentResult: null,
          comment: 'Học tập tốt',
          awaitingMakeup: false,
        },
        {
          bookId: null,
          term: 'hk2',
          assessmentMode: 'score',
          published: false,
          dtbHk: null,
          commentResult: null,
          comment: null,
          awaitingMakeup: false,
        },
      ],
      year: { published: false, dtbYear: null, comment: null },
      levels: { hk1: null, hk2: null, year: null },
    });
    renderGradebook();
    const block = await screen.findByTestId('my-vn-results');
    expect(block).toHaveTextContent('Kết quả học tập của tôi');
    expect(screen.getByTestId('my-vn-term-hk1')).toHaveTextContent('7,9');
    expect(screen.getByTestId('my-vn-term-hk1')).toHaveTextContent('Học tập tốt');
    expect(screen.getByTestId('my-vn-term-hk2')).toHaveTextContent('Chưa công bố');
    expect(screen.getByTestId('my-vn-year')).toHaveTextContent('Chưa công bố');
  });

  it('chưa công bố kỳ/năm nào: khối chỉ hiện nhãn chưa công bố, không một con điểm nào', async () => {
    stubMine({
      courseId: COURSE_ID,
      terms: [
        {
          bookId: null,
          term: 'hk1',
          assessmentMode: 'score',
          published: false,
          dtbHk: null,
          commentResult: null,
          comment: null,
          awaitingMakeup: false,
        },
      ],
      year: { published: false, dtbYear: null, comment: null },
      levels: { hk1: null, hk2: null, year: null },
    });
    renderGradebook();
    const block = await screen.findByTestId('my-vn-results');
    expect(block).toHaveTextContent('Chưa công bố');
    // Khẳng định khoá nằm ở TỪNG HÀNG kỳ/năm: chỉ nhãn "Chưa công bố",
    // không nhãn điểm/mức/nhận xét nào (mô tả của khối ở CardHeader có
    // nhắc chữ "Điểm trung bình" theo thiết kế nên không rà toàn trang).
    for (const testid of ['my-vn-term-hk1', 'my-vn-year']) {
      const row = screen.getByTestId(testid);
      expect(row).toHaveTextContent('Chưa công bố');
      expect(row.textContent).not.toMatch(/Điểm trung bình|Mức học tập|Nhận xét của giáo viên/);
    }
  });

  it('khoá chưa có sổ VN: không render khối kết quả của tôi', async () => {
    stubMine({ courseId: COURSE_ID, terms: [], year: null, levels: { hk1: null, hk2: null, year: null } });
    renderGradebook();
    await waitFor(() => expect(screen.getByText('Quiz 1')).toBeInTheDocument());
    expect(screen.queryByTestId('my-vn-results')).not.toBeInTheDocument();
  });
});

describe('Question bank page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders the version badge, and editing bumps the badge to the new version', async () => {
    // Trang ngân hàng nay đọc usePermissions() (cổng issue #55): phải bọc
    // TestProviders và stub ảnh chụp quyền có quyền ngân hàng, nếu không
    // trang ném lỗi thiếu PermissionsProvider (lỗi CI của PR #61).
    localStorage.setItem('lms.accessToken', 'test-token');
    let edited = false;
    const questionView = (version: number) => ({
      question: {
        id: '01900000-0000-7000-8000-000000000004',
        category: '01900000-0000-7000-8000-000000000001',
        qtype: 'truefalse',
        name: 'Sky',
        createdBy: '01900000-0000-7000-8000-000000000001',
        modifiedBy: '01900000-0000-7000-8000-000000000001',
        createdAt: 'x',
        updatedAt: 'x',
      },
      entry: {
        id: '01900000-0000-7000-8000-000000000002',
        questionCategoryId: '01900000-0000-7000-8000-000000000001',
        questionId: '01900000-0000-7000-8000-000000000004',
        latestVersion: version,
        status: 'ready',
        createdAt: 'x',
        updatedAt: 'x',
      },
      latestVersion: {
        id: '01900000-0000-7000-8000-000000000008',
        questionBankEntryId: '01900000-0000-7000-8000-000000000002',
        questionId: '01900000-0000-7000-8000-000000000004',
        version,
        status: 'ready',
        questionText: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: version === 1 ? 'The sky is blue.' : 'The sky is blue. (edited)' }],
            },
          ],
        },
        defaultMark: 1,
        createdAt: 'x',
      },
    });
    stubFetch((url, init) => {
      if (url === '/api/v1/users/me')
        return {
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
      if (url === '/api/v1/users/me/capabilities')
        return { userId: '01900000-0000-7000-8000-0000000000a9', isSiteAdmin: true, assignments: [], contexts: [] };
      if (url === '/api/v1/questions/categories')
        return [
          {
            id: '01900000-0000-7000-8000-000000000001',
            name: 'General',
            contextId: '01900000-0000-7000-8000-000000000001',
            info: '',
            parent: null,
            sortOrder: 0,
            stamp: 's',
            createdAt: 'x',
            updatedAt: 'x',
          },
        ];
      if (url === '/api/v1/questions/categories/01900000-0000-7000-8000-000000000001/questions')
        return [questionView(edited ? 2 : 1)];
      if (url === '/api/v1/questions/01900000-0000-7000-8000-000000000004' && init?.method === 'PATCH') {
        edited = true;
        return questionView(2);
      }
      // Các endpoint màn sửa riêng (/questions/:id/edit) mà nút Sửa điều hướng tới.
      if (url.startsWith('/api/v1/stimuli')) return [];
      if (url === '/api/v1/questions/01900000-0000-7000-8000-000000000004/versions')
        return [questionView(edited ? 2 : 1).latestVersion];
      if (url === '/api/v1/questions/01900000-0000-7000-8000-000000000004/curriculum-links')
        return { questionId: '01900000-0000-7000-8000-000000000004', subjectIds: [], outcomes: [] };
      if (url === '/api/v1/access/contexts')
        return [
          {
            id: '01900000-0000-7000-8000-000000000001',
            contextLevel: 10,
            path: '/1',
            instanceId: '01900000-0000-7000-8000-000000000001',
          },
        ];
      return undefined;
    });
    const router = createMemoryRouter(
      [
        { path: '/questions', element: <QuestionsPage /> },
        { path: '/questions/:questionId/edit', element: <QuestionEditPage /> },
      ],
      {
        initialEntries: ['/questions'],
      },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('version-badge-01900000-0000-7000-8000-000000000004')).toHaveTextContent('v1'),
    );
    await userEvent.click(screen.getByRole('link', { name: /Sửa \(phiên bản mới\)/ }));
    // Sửa mở editor theo dạng của câu hỏi; lưu trong editor mới tạo phiên bản mới.
    await userEvent.click(await screen.findByRole('button', { name: 'Lưu thành phiên bản mới' }));
    await waitFor(() =>
      expect(screen.getByTestId('version-badge-01900000-0000-7000-8000-000000000004')).toHaveTextContent('v2'),
    );
    expect(screen.getByText(/Các lượt làm đã bắt đầu vẫn giữ phiên bản đã gắn/)).toBeInTheDocument();
  });

  it('renders a usage with attempt states, steps and the pinned version', async () => {
    // Trang usage cũng đọc usePermissions() (cổng issue #55): cùng cách bọc
    // và stub quyền như test ngân hàng ở trên.
    localStorage.setItem('lms.accessToken', 'test-token');
    stubFetch((url) => {
      if (url === '/api/v1/users/me')
        return {
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
      if (url === '/api/v1/users/me/capabilities')
        return { userId: '01900000-0000-7000-8000-0000000000a9', isSiteAdmin: true, assignments: [], contexts: [] };
      if (url === '/api/v1/question-usages/01900000-0000-7000-8000-000000000009') {
        return {
          usage: {
            id: '01900000-0000-7000-8000-000000000009',
            component: 'mod_quiz',
            instanceId: '01900000-0000-7000-8000-000000000042',
            owningContextId: null,
            preferredBehaviour: 'deferredfeedback',
            userId: '01900000-0000-7000-8000-000000000007',
            createdAt: 'x',
            updatedAt: 'x',
          },
          state: 'finished',
          attempts: [
            {
              id: '01900000-0000-7000-8000-000000000011',
              questionUsageId: '01900000-0000-7000-8000-000000000009',
              slot: 1,
              behaviour: 'deferredfeedback',
              questionId: '01900000-0000-7000-8000-000000000004',
              questionVersionId: '01900000-0000-7000-8000-000000000008',
              variant: 1,
              maxMark: 1,
              minFraction: 0,
              maxFraction: 1,
              flagged: false,
              questionSummary: 'Q',
              responseSummary: 'true',
              rightAnswer: 'True',
              state: 'gradedright',
              fraction: 1,
              userId: '01900000-0000-7000-8000-000000000007',
              createdAt: 'x',
              updatedAt: 'x',
              steps: [
                {
                  id: '01900000-0000-7000-8000-000000000001',
                  sequenceNumber: 0,
                  state: 'todo',
                  fraction: null,
                  data: {},
                },
                {
                  id: '01900000-0000-7000-8000-000000000002',
                  sequenceNumber: 1,
                  state: 'complete',
                  fraction: null,
                  data: { answer: 'true' },
                },
                {
                  id: '01900000-0000-7000-8000-000000000003',
                  sequenceNumber: 2,
                  state: 'gradedright',
                  fraction: 1,
                  data: {},
                },
              ],
            },
          ],
        };
      }
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/question-usages/:id', element: <QuestionUsagePage /> }], {
      initialEntries: ['/question-usages/01900000-0000-7000-8000-000000000009'],
    });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
    await waitFor(() => expect(screen.getByTestId('attempt-01900000-0000-7000-8000-000000000011')).toBeInTheDocument());
    expect(screen.getByTestId('attempt-01900000-0000-7000-8000-000000000011')).toHaveTextContent('gradedright');
    expect(screen.getByTestId('attempt-01900000-0000-7000-8000-000000000011')).toHaveTextContent(
      'todo → complete → gradedright',
    );
    expect(screen.getByText(/Trạng thái lượt làm: finished/)).toBeInTheDocument();
  });
});

describe('Gradebook administration (teacher of the course)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const COURSE_ID = '01900000-0000-7000-8000-000000000010';
  const TEACHER_ID = '01900000-0000-7000-8000-0000000000a2';
  const STUDENT_ID = '01900000-0000-7000-8000-000000000007';
  const ADMIN_CAT = {
    id: '01900000-0000-7000-8000-000000000021',
    courseId: COURSE_ID,
    parent: null,
    fullName: 'Quizzes',
    aggregation: 'mean',
    dropLow: 0,
    keepHigh: 0,
    aggregateOnlyGraded: false,
    depth: 1,
    path: '/1',
    hidden: false,
  };
  const LETTERS = [
    {
      id: '01900000-0000-7000-8000-000000000031',
      contextId: '01900000-0000-7000-8000-000000000055',
      lowerBoundary: 90,
      letter: 'A',
    },
    {
      id: '01900000-0000-7000-8000-000000000032',
      contextId: '01900000-0000-7000-8000-000000000055',
      lowerBoundary: 80,
      letter: 'B',
    },
  ];
  const COURSE = {
    id: COURSE_ID,
    category: '01900000-0000-7000-8000-000000000001',
    fullName: 'Physics 101',
    shortName: 'PHY101',
    idNumber: '',
    summary: '',
    format: 'topics',
    visible: true,
    startDate: null,
    endDate: null,
    groupMode: 0,
    enableCompletion: true,
  };
  const PROFILE = {
    id: TEACHER_ID,
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
  const FORBIDDEN = { type: 'about:blank', title: 'Forbidden', status: 403, code: 'access.capability_denied' };
  const HISTORY_URL = `/api/v1/courses/grades/items/${ITEM.id}/users/${STUDENT_ID}/history`;

  interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
  }

  /**
   * Stub fetch cho giáo viên của khoá: ảnh chụp quyền
   * (GET /users/me/capabilities) khai gán editingteacher tại context khoá
   * kèm grade:viewall nên trang kết luận là staff và mới tải thêm
   * categories/items/letters/scales. Mọi lời gọi đều được ghi lại để
   * khẳng định URL/method/body đúng controller phía API.
   */
  function stubTeacherFetch(calls: RecordedCall[], opts?: { items?: unknown[] }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({
          url,
          method,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        });
        const respond = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (url === '/api/v1/users/me') return respond(PROFILE);
        if (url === '/api/v1/users/me/capabilities') {
          return respond({
            userId: TEACHER_ID,
            isSiteAdmin: false,
            assignments: [
              {
                id: '01900000-0000-7000-8000-0000000000f1',
                roleId: '01900000-0000-7000-8000-0000000000b9',
                roleShortname: 'editingteacher',
                roleName: 'Teacher',
                contextId: '01900000-0000-7000-8000-000000000055',
                contextLevel: 50,
                contextPath: '/1/9/10',
                instanceId: COURSE_ID,
              },
            ],
            contexts: [
              {
                contextId: '01900000-0000-7000-8000-0000000000e1',
                contextLevel: 10,
                contextPath: '/1',
                capabilities: [],
              },
              {
                contextId: '01900000-0000-7000-8000-000000000055',
                contextLevel: 50,
                contextPath: '/1/9/10',
                capabilities: ['grade:viewall', 'grade:edit', 'question:useall'],
              },
            ],
          });
        }
        if (url === '/api/v1/users?pageSize=1') return respond(FORBIDDEN, 403);
        if (url === '/api/v1/access/roles') return respond(FORBIDDEN, 403);
        if (url === '/api/v1/questions/categories') return respond([]);
        if (url === '/api/v1/courses' && method === 'GET') return respond([COURSE]);
        if (url === `/api/v1/courses/${COURSE_ID}/enrolments/me`)
          return respond({ courseId: COURSE_ID, userId: TEACHER_ID, enrolled: true, active: true });
        if (url === `/api/v1/courses/${COURSE_ID}/grades/report`) return respond(REPORT);
        if (url === `/api/v1/courses/${COURSE_ID}/gradebook`) return respond(BOOK);
        if (url === `/api/v1/courses/${COURSE_ID}/grades/categories`) {
          if (method === 'POST') return respond({ ...ADMIN_CAT, id: '01900000-0000-7000-8000-000000000022' });
          return respond([ADMIN_CAT]);
        }
        if (url === `/api/v1/courses/${COURSE_ID}/grades/items`) {
          if (method === 'POST')
            return respond({ ...ITEM, id: '01900000-0000-7000-8000-000000000033', itemName: 'Midterm' });
          return respond(opts?.items ?? [ITEM]);
        }
        if (url === `/api/v1/courses/${COURSE_ID}/grades/letters`) {
          if (method === 'PUT') return respond(LETTERS);
          return respond(LETTERS);
        }
        if (url === `/api/v1/courses/${COURSE_ID}/grades/scales`)
          return respond([
            {
              id: '01900000-0000-7000-8000-000000000041',
              courseId: COURSE_ID,
              name: 'Pass scale',
              scale: 'Fail,Pass',
              description: '',
            },
          ]);
        if (url === `/api/v1/courses/${COURSE_ID}/grades/outcomes`) {
          if (method === 'POST')
            return respond({
              id: '01900000-0000-7000-8000-000000000043',
              courseId: COURSE_ID,
              scaleId: '01900000-0000-7000-8000-000000000041',
              name: 'Teamwork',
              description: '',
            });
          return respond([]);
        }
        if (url === `/api/v1/courses/${COURSE_ID}/grades/export`) {
          return new Response('userId,username,Quiz 1\r\n', {
            status: 200,
            headers: { 'Content-Type': 'text/csv' },
          });
        }
        if (url === `/api/v1/courses/${COURSE_ID}/grades/export/vnedu` && method === 'POST') {
          return new Response(new Blob(['fake-xlsx-bytes']), {
            status: 200,
            headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
          });
        }
        if (url === `/api/v1/courses/${COURSE_ID}/grades/import` && method === 'POST') {
          return respond(
            {
              imported: 3,
              skipped: 1,
              errors: [
                {
                  row: 4,
                  column: 'username',
                  code: 'grades.import_user_not_found',
                  message: "No user with username 'ghost'",
                },
              ],
              ignoredColumns: ['Course total'],
            },
            201,
          );
        }
        if (url === HISTORY_URL) {
          return respond([
            {
              id: '01900000-0000-7000-8000-000000000051',
              action: 2,
              oldId: null,
              itemId: ITEM.id,
              userId: STUDENT_ID,
              rawGrade: 85,
              finalGrade: 85,
              overridden: false,
              excluded: false,
              frozen: false,
              source: 'manual',
              updatedAt: '2026-10-20T00:00:00.000Z',
              loggedUser: TEACHER_ID,
            },
          ]);
        }
        return respond({}, 404);
      }),
    );
  }

  /** Render trang sổ điểm với phiên đăng nhập của giáo viên. */
  function renderAsTeacher() {
    localStorage.setItem('lms.accessToken', 'test-token');
    renderGradebook();
  }

  /** Tìm một ô nhập theo nhãn hiển thị và `id` duy nhất của nó (nhiều form dùng chung một nhãn). */
  function fieldById(label: string, id: string): HTMLElement {
    const el = screen.getAllByLabelText(label).find((e) => e.id === id);
    if (!el) throw new Error(`field #${id} with label ${label} not found`);
    return el;
  }

  it('creates a grade item via POST /courses/:courseId/grades/items with the contracts body', async () => {
    const calls: RecordedCall[] = [];
    stubTeacherFetch(calls);
    renderAsTeacher();

    // Chờ khu quản trị xuất hiện (PermissionsProvider dò xong quyền staff) rồi mới nhập liệu.
    const nameInput = await waitFor(() => fieldById('Tên mục điểm', 'grade-item-name'));
    await userEvent.type(nameInput, 'Midterm');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo mục điểm' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/items` && c.method === 'POST')).toBe(
        true,
      ),
    );
    const createCall = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/items` && c.method === 'POST');
    // Đúng createGradeItemSchema: itemName + gradeMax dạng số; không chọn hạng mục thì không gửi categoryId.
    expect(createCall?.body).toEqual({ itemName: 'Midterm', gradeMax: 100 });
  });

  it('creates a course outcome via POST /courses/:courseId/grades/outcomes with name and scaleId', async () => {
    const calls: RecordedCall[] = [];
    stubTeacherFetch(calls);
    renderAsTeacher();

    await userEvent.type(await screen.findByLabelText('Tên outcome'), 'Teamwork');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo outcome' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/outcomes` && c.method === 'POST')).toBe(
        true,
      ),
    );
    const createCall = calls.find(
      (c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/outcomes` && c.method === 'POST',
    );
    expect(createCall?.body).toEqual({ name: 'Teamwork', scaleId: '01900000-0000-7000-8000-000000000041' });
  });

  it('saves the whole letter set via PUT /courses/:courseId/grades/letters', async () => {
    const calls: RecordedCall[] = [];
    stubTeacherFetch(calls);
    renderAsTeacher();

    const boundary = await waitFor(() => {
      const el = screen.getAllByLabelText('Mốc dưới')[0];
      if (!el) throw new Error('letters chưa được nạp');
      return el;
    });
    await userEvent.clear(boundary);
    await userEvent.type(boundary, '95');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thang điểm chữ' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/letters` && c.method === 'PUT')).toBe(
        true,
      ),
    );
    const putCall = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/letters` && c.method === 'PUT');
    // Đúng setGradeLettersSchema: PUT nguyên bộ { letters: [{ letter, lowerBoundary }] } với mốc dưới dạng số.
    expect(putCall?.body).toEqual({
      letters: [
        { letter: 'A', lowerBoundary: 95 },
        { letter: 'B', lowerBoundary: 80 },
      ],
    });
  });

  it('loads a student grade history from GET /courses/grades/items/:itemId/users/:userId/history', async () => {
    const calls: RecordedCall[] = [];
    stubTeacherFetch(calls);
    renderAsTeacher();

    // Select của @lms/ui: chờ trigger (nhãn "Mục điểm") xuất hiện cùng dữ liệu
    // quản trị, bấm mở popup rồi bấm tuỳ chọn "Quiz 1".
    await userEvent.click(await screen.findByLabelText('Mục điểm'));
    await userEvent.click(await screen.findByRole('option', { name: 'Quiz 1' }));
    await userEvent.type(fieldById('Học viên (ID người dùng)', 'history-user'), STUDENT_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Xem lịch sử' }));

    await waitFor(() => expect(calls.some((c) => c.url === HISTORY_URL && c.method === 'GET')).toBe(true));
    expect(await screen.findByText(/điểm cuối: 85/)).toBeInTheDocument();
  });

  it('downloads the course grades CSV via GET /courses/:courseId/grades/export', async () => {
    const calls: RecordedCall[] = [];
    stubTeacherFetch(calls);
    // jsdom không có URL.createObjectURL và click vào anchor blob sẽ đòi điều hướng — thay cả hai bằng bản ghi.
    const createObjectURL = vi.fn(() => 'blob:grades');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAsTeacher();

    await userEvent.click(await screen.findByRole('button', { name: 'Xuất điểm ra CSV' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/export` && c.method === 'GET')).toBe(true),
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalled();
    expect(await screen.findByText('Đã tải tệp điểm CSV.')).toBeInTheDocument();
    anchorClick.mockRestore();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('exports the vnEdu Excel sheet with the teacher-confirmed mapping via POST /grades/export/vnedu', async () => {
    const calls: RecordedCall[] = [];
    const regular = { ...ITEM, id: '01900000-0000-7000-8000-000000000061', itemName: 'Kiểm tra 15 phút' };
    const midterm = { ...ITEM, id: '01900000-0000-7000-8000-000000000062', itemName: 'Kiểm tra giữa kỳ' };
    const finalItem = { ...ITEM, id: '01900000-0000-7000-8000-000000000063', itemName: 'Kiểm tra cuối kỳ' };
    stubTeacherFetch(calls, { items: [regular, midterm, finalItem] });
    const createObjectURL = vi.fn(() => 'blob:vnedu');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAsTeacher();

    // Gợi ý mặc định theo tên mục: 15 phút → thường xuyên, giữa kỳ → giữa kỳ, cuối kỳ → cuối kỳ.
    await screen.findByRole('button', { name: 'Tải Excel vnEdu' });
    await userEvent.click(screen.getByLabelText('Học kỳ'));
    await userEvent.click(await screen.findByRole('option', { name: 'Học kỳ II' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tải Excel vnEdu' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/export/vnedu` && c.method === 'POST'),
      ).toBe(true),
    );
    const call = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/export/vnedu`);
    expect(call?.body).toMatchObject({
      regularItemIds: [regular.id],
      midtermItemId: midterm.id,
      finalItemId: finalItem.id,
      semester: 2,
      schoolYear: '2026-2027',
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalled();
    expect(await screen.findByText('Đã tải tệp điểm Excel vnEdu.')).toBeInTheDocument();
    anchorClick.mockRestore();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('blocks the vnEdu export at the UI when the mapping lacks a midterm item', async () => {
    const calls: RecordedCall[] = [];
    const regular = { ...ITEM, id: '01900000-0000-7000-8000-000000000061', itemName: 'Kiểm tra 15 phút' };
    const midterm = { ...ITEM, id: '01900000-0000-7000-8000-000000000062', itemName: 'Kiểm tra giữa kỳ' };
    const finalItem = { ...ITEM, id: '01900000-0000-7000-8000-000000000063', itemName: 'Kiểm tra cuối kỳ' };
    stubTeacherFetch(calls, { items: [regular, midterm, finalItem] });
    renderAsTeacher();

    await screen.findByRole('button', { name: 'Tải Excel vnEdu' });
    // Giáo viên bỏ gán mục giữa kỳ → ánh xạ không còn hợp lệ, không được gọi API.
    await userEvent.click(screen.getByLabelText('Kiểm tra giữa kỳ'));
    await userEvent.click(await screen.findByRole('option', { name: 'Không xuất' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tải Excel vnEdu' }));

    expect(await screen.findByText(/Cần ít nhất 1 mục thường xuyên/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('export/vnedu'))).toBe(false);
  });

  it('imports grades from a chosen CSV file and shows the report (counts + per-row errors)', async () => {
    const calls: RecordedCall[] = [];
    stubTeacherFetch(calls);
    renderAsTeacher();

    const fileInput = await screen.findByLabelText(/Tệp CSV điểm/);
    await userEvent.upload(fileInput, new File(['username,Quiz 1\nsv1,90\n'], 'grades.csv', { type: 'text/csv' }));
    await userEvent.click(screen.getByRole('button', { name: 'Nhập điểm từ CSV' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/import` && c.method === 'POST')).toBe(
        true,
      ),
    );
    const importCall = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/import` && c.method === 'POST');
    // Tải lên là multipart: body phải là FormData mang trường file, không phải JSON.
    expect(importCall?.body).toBeInstanceOf(FormData);
    expect((importCall?.body as FormData).get('file')).toBeInstanceOf(File);
    expect(await screen.findByText('Đã nhập 3 điểm, bỏ qua 1 ô trống, 1 lỗi, 1 cột bị bỏ qua.')).toBeInTheDocument();
    expect(await screen.findByText("Dòng 4, cột username: No user with username 'ghost'")).toBeInTheDocument();
  });
});
