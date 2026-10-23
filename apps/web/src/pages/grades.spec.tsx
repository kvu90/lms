import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { PermissionsProvider } from '#lib/permissions';
import { GradebookPage } from './grades';
import { QuestionsPage, QuestionUsagePage } from './questions';

const ITEM = {
  id: '01900000-0000-7000-8000-000000000005',
  courseid: '01900000-0000-7000-8000-000000000010',
  categoryid: '01900000-0000-7000-8000-000000000001',
  itemname: 'Quiz 1',
  itemtype: 'manual',
  itemmodule: null,
  iteminstance: null,
  grademax: 100,
  grademin: 0,
  gradepass: 50,
  weightoverride: false,
  aggregationcoef: 0,
  extracredit: false,
  multiplicator: 1,
  plusfactor: 0,
  hidden: false,
  locked: false,
};
const GRADE = {
  id: '01900000-0000-7000-8000-000000000002',
  itemid: '01900000-0000-7000-8000-000000000005',
  userid: '01900000-0000-7000-8000-000000000007',
  rawgrade: 85,
  finalgrade: 85,
  hidden: false,
  locked: false,
  overridden: false,
  excluded: false,
  frozen: false,
  feedback: null,
  aggregationweight: 100,
  letter: 'B',
};
const BOOK = {
  courseId: '01900000-0000-7000-8000-000000000010',
  userId: '01900000-0000-7000-8000-000000000007',
  categories: [
    {
      category: {
        id: '01900000-0000-7000-8000-000000000001',
        courseid: '01900000-0000-7000-8000-000000000010',
        parent: null,
        fullname: '',
        aggregation: 'natural',
        droplow: 0,
        keephigh: 0,
        aggregateonlygraded: false,
        depth: 1,
        path: '/1',
        hidden: false,
      },
      total: {
        item: {
          ...ITEM,
          id: '01900000-0000-7000-8000-000000000009',
          itemname: 'Course total',
          itemtype: 'course',
          iteminstance: '01900000-0000-7000-8000-000000000010',
        },
        grade: {
          ...GRADE,
          id: '01900000-0000-7000-8000-000000000003',
          itemid: '01900000-0000-7000-8000-000000000009',
          finalgrade: 85,
          letter: 'B',
        },
      },
      items: [{ item: ITEM, grade: GRADE }],
      children: [
        {
          category: {
            id: '01900000-0000-7000-8000-000000000002',
            courseid: '01900000-0000-7000-8000-000000000010',
            parent: '01900000-0000-7000-8000-000000000001',
            fullname: 'Quizzes',
            aggregation: 'mean',
            droplow: 0,
            keephigh: 0,
            aggregateonlygraded: false,
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
      itemname: 'Course total',
      itemtype: 'course',
      iteminstance: '01900000-0000-7000-8000-000000000010',
    },
    grade: {
      ...GRADE,
      id: '01900000-0000-7000-8000-000000000003',
      itemid: '01900000-0000-7000-8000-000000000009',
      finalgrade: 85,
      letter: 'B',
    },
  },
};
const REPORT = {
  courseId: '01900000-0000-7000-8000-000000000010',
  rows: [
    { userId: '01900000-0000-7000-8000-000000000007', finalgrade: 85, letter: 'B' },
    { userId: '01900000-0000-7000-8000-000000000008', finalgrade: 40, letter: 'F' },
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

describe('Question bank page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the version badge, and editing bumps the badge to the new version', async () => {
    let edited = false;
    const questionView = (version: number) => ({
      question: {
        id: '01900000-0000-7000-8000-000000000004',
        category: '01900000-0000-7000-8000-000000000001',
        qtype: 'truefalse',
        name: 'Sky',
        createdby: '01900000-0000-7000-8000-000000000001',
        modifiedby: '01900000-0000-7000-8000-000000000001',
        timecreated: 'x',
        timemodified: 'x',
      },
      entry: {
        id: '01900000-0000-7000-8000-000000000002',
        questioncategoryid: '01900000-0000-7000-8000-000000000001',
        questionid: '01900000-0000-7000-8000-000000000004',
        latestversion: version,
        status: 'ready',
        timecreated: 'x',
        timemodified: 'x',
      },
      latestVersion: {
        id: '01900000-0000-7000-8000-000000000008',
        questionbankentryid: '01900000-0000-7000-8000-000000000002',
        questionid: '01900000-0000-7000-8000-000000000004',
        version,
        status: 'ready',
        questiontext: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: version === 1 ? 'The sky is blue.' : 'The sky is blue. (edited)' }],
            },
          ],
        },
        defaultmark: 1,
        timecreated: 'x',
      },
    });
    stubFetch((url, init) => {
      if (url === '/api/v1/questions/categories')
        return [
          {
            id: '01900000-0000-7000-8000-000000000001',
            name: 'General',
            contextid: '01900000-0000-7000-8000-000000000001',
            info: '',
            parent: null,
            sortorder: 0,
            stamp: 's',
            timecreated: 'x',
            timemodified: 'x',
          },
        ];
      if (url === '/api/v1/questions/categories/01900000-0000-7000-8000-000000000001/questions')
        return [questionView(edited ? 2 : 1)];
      if (url === '/api/v1/questions/01900000-0000-7000-8000-000000000004' && init?.method === 'PATCH') {
        edited = true;
        return questionView(2);
      }
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/questions', element: <QuestionsPage /> }], {
      initialEntries: ['/questions'],
    });
    render(<RouterProvider router={router} />);
    await waitFor(() =>
      expect(screen.getByTestId('version-badge-01900000-0000-7000-8000-000000000004')).toHaveTextContent('v1'),
    );
    await userEvent.click(screen.getByRole('button', { name: /Sửa \(phiên bản mới\)/ }));
    await waitFor(() =>
      expect(screen.getByTestId('version-badge-01900000-0000-7000-8000-000000000004')).toHaveTextContent('v2'),
    );
    expect(screen.getByText(/Các lượt làm đã bắt đầu vẫn giữ phiên bản đã gắn/)).toBeInTheDocument();
  });

  it('renders a usage with attempt states, steps and the pinned version', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/question-usages/01900000-0000-7000-8000-000000000009') {
        return {
          usage: {
            id: '01900000-0000-7000-8000-000000000009',
            component: 'mod_quiz',
            instanceid: '01900000-0000-7000-8000-000000000042',
            owningcontextid: null,
            preferredbehaviour: 'deferredfeedback',
            userid: '01900000-0000-7000-8000-000000000007',
            timecreated: 'x',
            timemodified: 'x',
          },
          state: 'finished',
          attempts: [
            {
              id: '01900000-0000-7000-8000-000000000011',
              questionusageid: '01900000-0000-7000-8000-000000000009',
              slot: 1,
              behaviour: 'deferredfeedback',
              questionid: '01900000-0000-7000-8000-000000000004',
              questionversionid: '01900000-0000-7000-8000-000000000008',
              variant: 1,
              maxmark: 1,
              minfraction: 0,
              maxfraction: 1,
              flagged: false,
              questionsummary: 'Q',
              responsesummary: 'true',
              rightanswer: 'True',
              state: 'gradedright',
              fraction: 1,
              userid: '01900000-0000-7000-8000-000000000007',
              timecreated: 'x',
              timemodified: 'x',
              steps: [
                {
                  id: '01900000-0000-7000-8000-000000000001',
                  sequencenumber: 0,
                  state: 'todo',
                  fraction: null,
                  data: {},
                },
                {
                  id: '01900000-0000-7000-8000-000000000002',
                  sequencenumber: 1,
                  state: 'complete',
                  fraction: null,
                  data: { answer: 'true' },
                },
                {
                  id: '01900000-0000-7000-8000-000000000003',
                  sequencenumber: 2,
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
    render(<RouterProvider router={router} />);
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
    courseid: COURSE_ID,
    parent: null,
    fullname: 'Quizzes',
    aggregation: 'mean',
    droplow: 0,
    keephigh: 0,
    aggregateonlygraded: false,
    depth: 1,
    path: '/1',
    hidden: false,
  };
  const LETTERS = [
    {
      id: '01900000-0000-7000-8000-000000000031',
      contextid: '01900000-0000-7000-8000-000000000055',
      lowerboundary: 90,
      letter: 'A',
    },
    {
      id: '01900000-0000-7000-8000-000000000032',
      contextid: '01900000-0000-7000-8000-000000000055',
      lowerboundary: 80,
      letter: 'B',
    },
  ];
  const COURSE = {
    id: COURSE_ID,
    category: '01900000-0000-7000-8000-000000000001',
    fullname: 'Physics 101',
    shortname: 'PHY101',
    idnumber: '',
    summary: '',
    format: 'topics',
    visible: true,
    startdate: null,
    enddate: null,
    groupmode: 0,
    enablecompletion: true,
  };
  const PROFILE = {
    id: TEACHER_ID,
    username: 'teacher1',
    firstname: 'Lan Anh',
    lastname: 'Nguyễn',
    email: 'teacher1@example.com',
    suspended: false,
    deleted: false,
    isGuest: false,
    forcePasswordChange: false,
    lastlogin: null,
    timecreated: '2026-01-01T00:00:00.000Z',
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
   * kèm moodle/grade:viewall nên trang kết luận là staff và mới tải thêm
   * categories/items/letters/scales. Mọi lời gọi đều được ghi lại để
   * khẳng định URL/method/body đúng controller phía API.
   */
  function stubTeacherFetch(calls: RecordedCall[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
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
                capabilities: ['moodle/grade:viewall', 'moodle/grade:edit', 'moodle/question:useall'],
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
            return respond({ ...ITEM, id: '01900000-0000-7000-8000-000000000033', itemname: 'Midterm' });
          return respond([ITEM]);
        }
        if (url === `/api/v1/courses/${COURSE_ID}/grades/letters`) {
          if (method === 'PUT') return respond(LETTERS);
          return respond(LETTERS);
        }
        if (url === `/api/v1/courses/${COURSE_ID}/grades/scales`)
          return respond([
            {
              id: '01900000-0000-7000-8000-000000000041',
              courseid: COURSE_ID,
              name: 'Pass scale',
              scale: 'Fail,Pass',
              description: '',
            },
          ]);
        if (url === `/api/v1/courses/${COURSE_ID}/grades/outcomes`) {
          if (method === 'POST')
            return respond({
              id: '01900000-0000-7000-8000-000000000043',
              courseid: COURSE_ID,
              scaleid: '01900000-0000-7000-8000-000000000041',
              name: 'Teamwork',
              description: '',
            });
          return respond([]);
        }
        if (url === HISTORY_URL) {
          return respond([
            {
              id: '01900000-0000-7000-8000-000000000051',
              action: 2,
              oldid: null,
              itemid: ITEM.id,
              userid: STUDENT_ID,
              rawgrade: 85,
              finalgrade: 85,
              overridden: false,
              excluded: false,
              frozen: false,
              source: 'manual',
              timemodified: '2026-10-20T00:00:00.000Z',
              loggeduser: TEACHER_ID,
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
    // Đúng createGradeItemSchema: itemname + grademax dạng số; không chọn hạng mục thì không gửi categoryId.
    expect(createCall?.body).toEqual({ itemname: 'Midterm', grademax: 100 });
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
    // Đúng setGradeLettersSchema: PUT nguyên bộ { letters: [{ letter, lowerboundary }] } với mốc dưới dạng số.
    expect(putCall?.body).toEqual({
      letters: [
        { letter: 'A', lowerboundary: 95 },
        { letter: 'B', lowerboundary: 80 },
      ],
    });
  });

  it('loads a student grade history from GET /courses/grades/items/:itemId/users/:userId/history', async () => {
    const calls: RecordedCall[] = [];
    stubTeacherFetch(calls);
    renderAsTeacher();

    // Chờ cả option của mục điểm xuất hiện trong ô chọn (dữ liệu quản trị nạp sau khi xác nhận staff).
    await screen.findByRole('option', { name: 'Quiz 1' });
    const itemSelect = screen.getByLabelText('Mục điểm');
    await userEvent.selectOptions(itemSelect, ITEM.id);
    await userEvent.type(fieldById('Học viên (ID người dùng)', 'history-user'), STUDENT_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Xem lịch sử' }));

    await waitFor(() => expect(calls.some((c) => c.url === HISTORY_URL && c.method === 'GET')).toBe(true));
    expect(await screen.findByText(/điểm cuối: 85/)).toBeInTheDocument();
  });
});
