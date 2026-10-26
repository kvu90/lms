import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { PermissionsProvider } from '#lib/permissions';
import { GradebookPage } from './grades';
import { QuestionsPage, QuestionUsagePage } from './questions';
import { QuestionEditPage } from './question-editor';

const COURSE_ID = '01900000-0000-7000-8000-000000000010';
const STUDENT_ID = '01900000-0000-7000-8000-000000000007';
const ITEM = {
  id: '01900000-0000-7000-8000-000000000005',
  courseId: COURSE_ID,
  itemName: 'Quiz 1',
  itemType: 'manual',
  itemModule: null,
  itemInstance: null,
  gradeMax: 100,
  gradeMin: 0,
  gradePass: 50,
  multiplicator: 1,
  plusFactor: 0,
  hidden: false,
  locked: false,
  sortOrder: 0,
  postingPolicy: 'auto',
};
const GRADE = {
  id: '01900000-0000-7000-8000-000000000002',
  itemId: ITEM.id,
  userId: STUDENT_ID,
  rawGrade: 85,
  finalGrade: 85,
  hidden: false,
  locked: false,
  overridden: false,
  excluded: false,
  frozen: false,
  feedback: 'Làm tốt',
  aggregationWeight: null,
};
const BOOK = {
  courseId: COURSE_ID,
  userId: STUDENT_ID,
  activities: [
    { item: ITEM, grade: GRADE, publication: { policy: 'auto', published: true } },
    {
      item: { ...ITEM, id: '01900000-0000-7000-8000-000000000006', itemName: 'Kiểm tra miệng', postingPolicy: 'manual' },
      grade: null,
      publication: { policy: 'manual', published: false },
    },
  ],
};
const REPORT = {
  courseId: COURSE_ID,
  items: [ITEM],
  publications: { [ITEM.id]: { policy: 'auto', published: true } },
  rows: [
    { userId: STUDENT_ID, displayName: 'Trần Minh Quân', grades: { [ITEM.id]: 85 } },
    { userId: '01900000-0000-7000-8000-000000000008', displayName: 'Bạn Học Khác', grades: { [ITEM.id]: null } },
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
 * Render trang điểm theo bài trong đúng khung provider của ứng dụng
 * thật: trang đọc `usePermissions()` để chỉ hiện khu quản trị cho
 * staff của khoá. Test học viên không đặt token đăng nhập:
 * PermissionsProvider kết luận không phải staff mà không gọi thêm
 * endpoint nào — khu quản trị không xuất hiện.
 */
function renderGradebook() {
  const router = createMemoryRouter([{ path: '/courses/:id/grades', element: <GradebookPage /> }], {
    initialEntries: [`/courses/${COURSE_ID}/grades`],
  });
  render(
    <TestProviders>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </TestProviders>,
  );
}

describe('Gradebook page — điểm theo bài của học sinh (issue #224)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders each activity grade with its publication state, and no course total', async () => {
    stubFetch((url) => {
      if (url === `/api/v1/courses/${COURSE_ID}/gradebook`) return BOOK;
      if (url === `/api/v1/courses/${COURSE_ID}/grades/report`) return REPORT;
      return undefined;
    });
    renderGradebook();
    expect(await screen.findByText('Điểm của tôi')).toBeInTheDocument();
    expect(screen.getByText('Quiz 1')).toBeInTheDocument();
    expect(screen.getByText('85 / 100')).toBeInTheDocument();
    expect(screen.getByText('Làm tốt')).toBeInTheDocument();
    expect(screen.getByText('Đã công bố')).toBeInTheDocument();
    // Bài manual chưa công bố: điểm bị che, chỉ hiện trạng thái.
    expect(screen.getByText('Kiểm tra miệng')).toBeInTheDocument();
    expect(screen.getByText('Chưa công bố')).toBeInTheDocument();
    // Không còn điểm tổng khoá ở bất kỳ dạng nào.
    expect(screen.queryByText(/Tổng điểm/)).not.toBeInTheDocument();
    // Không phải staff: khu quản trị không được render.
    expect(screen.queryByText('Quản trị sổ điểm')).not.toBeInTheDocument();
    expect(screen.queryByText('Bảng điểm lớp theo bài')).not.toBeInTheDocument();
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

describe('Gradebook administration — giáo viên của khoá (issue #224)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const TEACHER_ID = '01900000-0000-7000-8000-0000000000a2';
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
   * Stub fetch cho giáo viên của khoá: ảnh chụp quyền khai gán
   * editingteacher tại context khoá kèm grade:viewall nên trang kết
   * luận là staff. Mọi lời gọi được ghi lại để khẳng định URL/method/
   * body đúng controller phía API. `items`/`publications` tuỳ biến
   * lưới lớp cho từng ca (xuất vnEdu cần nhiều bài đã công bố).
   */
  function stubTeacherFetch(
    calls: RecordedCall[],
    opts?: { reportItems?: unknown[]; publications?: Record<string, unknown> },
  ) {
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
              { contextId: '01900000-0000-7000-8000-0000000000e1', contextLevel: 10, contextPath: '/1', capabilities: [] },
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
        if (url === `/api/v1/courses/${COURSE_ID}/grades/report`)
          return respond({
            ...REPORT,
            items: opts?.reportItems ?? REPORT.items,
            publications: opts?.publications ?? REPORT.publications,
          });
        if (url === `/api/v1/courses/${COURSE_ID}/gradebook`) return respond(BOOK);
        if (url === `/api/v1/courses/${COURSE_ID}/grades/items` && method === 'POST')
          return respond({ ...ITEM, id: '01900000-0000-7000-8000-000000000033', itemName: 'Midterm' });
        if (url === `/api/v1/courses/grades/items/${ITEM.id}/publish` && method === 'POST')
          return respond({ itemId: ITEM.id, scope: 'item', policy: 'manual', published: true });
        if (url === `/api/v1/courses/${COURSE_ID}/grades/export/vnedu` && method === 'POST') {
          return new Response(new Blob(['fake-xlsx-bytes']), {
            status: 200,
            headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
          });
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

  function renderAsTeacher() {
    renderGradebook();
  }

  it('renders the read-only class grid with student names and per-activity grades', async () => {
    const calls: RecordedCall[] = [];
    stubTeacherFetch(calls);
    renderAsTeacher();
    expect(await screen.findByText('Bảng điểm lớp theo bài')).toBeInTheDocument();
    expect(screen.getByText('Trần Minh Quân')).toBeInTheDocument();
    expect(screen.getByText('Bạn Học Khác')).toBeInTheDocument();
    expect(screen.getByText('85')).toBeInTheDocument();
  });

  it('creates a grade item via POST /courses/:courseId/grades/items with the contracts body', async () => {
    const calls: RecordedCall[] = [];
    stubTeacherFetch(calls);
    renderAsTeacher();

    // Form tạo mục có id tường minh (nhiều ô cùng nhãn "Tên mục điểm"/"Điểm tối đa" ở các dòng sửa).
    const nameInput = await waitFor(() => {
      const el = document.getElementById('grade-item-name');
      if (!el) throw new Error('form tạo mục chưa render');
      return el;
    });
    await userEvent.type(nameInput, 'Midterm');
    const maxInput = document.getElementById('grade-item-max')!;
    await userEvent.clear(maxInput);
    await userEvent.type(maxInput, '100');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo mục điểm' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/items` && c.method === 'POST')).toBe(true),
    );
    const createCall = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/items` && c.method === 'POST');
    // Đúng createGradeItemSchema của mô hình mới: chỉ itemName + gradeMax, không còn categoryId.
    expect(createCall?.body).toEqual({ itemName: 'Midterm', gradeMax: 100 });
  });

  it('publishes an activity via POST /courses/grades/items/:itemId/publish', async () => {
    const calls: RecordedCall[] = [];
    stubTeacherFetch(calls, {
      publications: { [ITEM.id]: { policy: 'manual', published: false } },
    });
    renderAsTeacher();

    await userEvent.click(await screen.findByRole('button', { name: 'Công bố' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/grades/items/${ITEM.id}/publish` && c.method === 'POST')).toBe(true),
    );
  });

  it('loads a student grade history from GET /courses/grades/items/:itemId/users/:userId/history', async () => {
    const calls: RecordedCall[] = [];
    stubTeacherFetch(calls);
    renderAsTeacher();

    // Hai form (nhập điểm + lịch sử) dùng chung nhãn select: chọn ở form lịch sử qua nút của nó.
    const itemTriggers = await screen.findAllByLabelText('Mục điểm');
    await userEvent.click(itemTriggers[itemTriggers.length - 1]!);
    await userEvent.click(await screen.findByRole('option', { name: 'Quiz 1' }));
    const studentTriggers = screen.getAllByLabelText('Học sinh');
    await userEvent.click(studentTriggers[studentTriggers.length - 1]!);
    await userEvent.click(await screen.findByRole('option', { name: 'Trần Minh Quân' }));
    await userEvent.click(screen.getByRole('button', { name: 'Xem lịch sử' }));

    await waitFor(() => expect(calls.some((c) => c.url === HISTORY_URL && c.method === 'GET')).toBe(true));
    expect(await screen.findByText(/85 · manual/)).toBeInTheDocument();
  });

  it('exports the vnEdu Excel sheet from published activities with the teacher-confirmed mapping', async () => {
    const calls: RecordedCall[] = [];
    const regular = { ...ITEM, id: '01900000-0000-7000-8000-000000000061', itemName: 'Kiểm tra 15 phút' };
    const midterm = { ...ITEM, id: '01900000-0000-7000-8000-000000000062', itemName: 'Kiểm tra giữa kỳ' };
    const finalItem = { ...ITEM, id: '01900000-0000-7000-8000-000000000063', itemName: 'Kiểm tra cuối kỳ' };
    const publications = Object.fromEntries(
      [regular, midterm, finalItem].map((i) => [i.id, { policy: 'auto', published: true }]),
    );
    stubTeacherFetch(calls, { reportItems: [regular, midterm, finalItem], publications });
    const createObjectURL = vi.fn(() => 'blob:vnedu');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAsTeacher();

    // Gợi ý mặc định theo tên bài: 15 phút → thường xuyên, giữa kỳ → giữa kỳ, cuối kỳ → cuối kỳ.
    await screen.findByRole('button', { name: 'Tải Excel vnEdu' });
    await userEvent.click(screen.getByRole('button', { name: 'Tải Excel vnEdu' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/export/vnedu` && c.method === 'POST')).toBe(true),
    );
    const call = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/grades/export/vnedu`);
    expect(call?.body).toMatchObject({
      regularItemIds: [regular.id],
      midtermItemId: midterm.id,
      finalItemId: finalItem.id,
      semester: 1,
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalled();
    expect(await screen.findByText('Đã tải tệp điểm Excel vnEdu.')).toBeInTheDocument();
    anchorClick.mockRestore();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('blocks the vnEdu export at the UI when an activity is not published yet', async () => {
    const calls: RecordedCall[] = [];
    const regular = { ...ITEM, id: '01900000-0000-7000-8000-000000000061', itemName: 'Kiểm tra 15 phút' };
    const midterm = { ...ITEM, id: '01900000-0000-7000-8000-000000000062', itemName: 'Kiểm tra giữa kỳ' };
    const finalItem = { ...ITEM, id: '01900000-0000-7000-8000-000000000063', itemName: 'Kiểm tra cuối kỳ' };
    const publications = {
      [regular.id]: { policy: 'auto', published: true },
      [midterm.id]: { policy: 'manual', published: false },
      [finalItem.id]: { policy: 'auto', published: true },
    };
    stubTeacherFetch(calls, { reportItems: [regular, midterm, finalItem], publications });
    renderAsTeacher();

    await screen.findByRole('button', { name: 'Tải Excel vnEdu' });
    await userEvent.click(screen.getByRole('button', { name: 'Tải Excel vnEdu' }));

    // Bài giữa kỳ chưa công bố bị loại khỏi ánh xạ → thiếu đúng 1 mục giữa kỳ → chặn tại UI, không gọi API.
    expect(await screen.findByText(/Cần ít nhất 1 mục thường xuyên/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('export/vnedu'))).toBe(false);
  });
});
