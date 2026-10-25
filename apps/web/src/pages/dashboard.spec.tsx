import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { PermissionsProvider } from '#lib/permissions';
import { AppSidebar } from '#components/app-sidebar';
import { SidebarProvider } from '@lms/ui/components/sidebar';
import { DashboardPage } from './dashboard';

const ADMIN_ID = '01900000-0000-7000-8000-0000000000a1';
const TEACHER_ID = '01900000-0000-7000-8000-0000000000a2';
const STUDENT_ID = '01900000-0000-7000-8000-0000000000a3';
const COURSE_ID = '01900000-0000-7000-8000-000000000010';
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';

const COURSE = {
  id: COURSE_ID,
  category: CATEGORY_ID,
  fullName: 'Khoá học mẫu',
  shortName: 'DEMO101',
  idNumber: '',
  summary: '',
  format: 'topics',
  visible: true,
  startDate: null,
  endDate: null,
  groupMode: 0,
  enableCompletion: true,
};

function profile(id: string, username: string, firstName: string, lastName: string) {
  return {
    id,
    username,
    firstName,
    lastName,
    email: `${username}@example.com`,
    suspended: false,
    deleted: false,
    isGuest: false,
    forcePasswordChange: false,
    lastLogin: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    customFields: [],
  };
}

const PROFILES: Record<string, ReturnType<typeof profile>> = {
  admin: profile(ADMIN_ID, 'admin', 'Quản', 'Trị'),
  teacher1: profile(TEACHER_ID, 'teacher1', 'Lan Anh', 'Nguyễn'),
  student1: profile(STUDENT_ID, 'student1', 'Minh Quân', 'Trần'),
};

const GRADEBOOK = {
  courseId: COURSE_ID,
  userId: STUDENT_ID,
  categories: [],
  courseTotal: {
    item: { id: '01900000-0000-7000-8000-000000000090', gradeMax: 10 },
    grade: { finalGrade: 8.5, letter: 'A' },
  },
};

const REPORT = {
  courseId: COURSE_ID,
  rows: [
    { userId: STUDENT_ID, finalGrade: 8.5, letter: 'A' },
    { userId: '01900000-0000-7000-8000-0000000000a4', finalGrade: null, letter: null },
  ],
};

const FORBIDDEN = { type: 'about:blank', title: 'Forbidden', status: 403, code: 'access.capability_denied' };

const SYS_CTX_ID = '01900000-0000-7000-8000-0000000000e1';
const COURSE_CTX_ID = '01900000-0000-7000-8000-0000000000e2';

/** Ảnh chụp quyền (GET /users/me/capabilities) mà API thật trả cho từng vai trò. */
function accessView(role: 'admin' | 'teacher' | 'student') {
  const me = role === 'admin' ? PROFILES.admin : role === 'teacher' ? PROFILES.teacher1 : PROFILES.student1;
  if (role === 'admin') {
    return {
      userId: me.id,
      isSiteAdmin: true,
      assignments: [],
      contexts: [
        {
          contextId: SYS_CTX_ID,
          contextLevel: 10,
          contextPath: '/1',
          capabilities: ['user:viewdetails', 'role:manage'],
        },
      ],
    };
  }
  return {
    userId: me.id,
    isSiteAdmin: false,
    assignments: [
      {
        id: '01900000-0000-7000-8000-0000000000f1',
        roleId: '01900000-0000-7000-8000-0000000000b9',
        roleShortname: role === 'teacher' ? 'editingteacher' : 'student',
        roleName: role === 'teacher' ? 'Teacher' : 'Student',
        contextId: COURSE_CTX_ID,
        contextLevel: 50,
        contextPath: '/1/9/10',
        instanceId: COURSE_ID,
      },
    ],
    contexts: [
      { contextId: SYS_CTX_ID, contextLevel: 10, contextPath: '/1', capabilities: [] },
      {
        contextId: COURSE_CTX_ID,
        contextLevel: 50,
        contextPath: '/1/9/10',
        capabilities:
          role === 'teacher'
            ? ['grade:viewall', 'course:update', 'question:useall']
            : ['course:view'],
      },
    ],
  };
}

type Handler = (url: string) => { status: number; body: unknown } | undefined;

function ok(body: unknown) {
  return { status: 200, body };
}
function forbidden() {
  return { status: 403, body: FORBIDDEN };
}

/**
 * Stub fetch theo đúng bề mặt API thật: quyền của từng vai trò được khai
 * qua GET /users/me/capabilities (đúng nguồn PermissionsProvider đọc),
 * còn các endpoint dữ liệu bị khoá quyền vẫn trả 403 như PermissionEvaluator
 * của API để test kiểm chứng cả dữ liệu hiển thị theo vai trò.
 */
function stubFetch(handler: Handler) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const result = handler(url);
      if (!result) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function renderApp(withSidebar: boolean) {
  localStorage.setItem('lms.accessToken', 'test-token');
  const router = createMemoryRouter([
    {
      path: '/',
      element: withSidebar ? (
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      ) : (
        <DashboardPage />
      ),
    },
  ]);
  render(
    <TestProviders>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </TestProviders>,
  );
}

function baseHandler(role: 'admin' | 'teacher' | 'student'): Handler {
  const me = role === 'admin' ? PROFILES.admin : role === 'teacher' ? PROFILES.teacher1 : PROFILES.student1;
  return (url) => {
    if (url === '/api/v1/users/me') return ok(me);
    if (url === '/api/v1/users/me/capabilities') return ok(accessView(role));
    if (url.startsWith('/api/v1/users?')) {
      if (role !== 'admin') return forbidden();
      return url.includes('pageSize=100')
        ? ok({ users: [PROFILES.admin, PROFILES.teacher1, PROFILES.student1], total: 3, page: 1, pageSize: 100 })
        : ok({ users: [PROFILES.admin], total: 3, page: 1, pageSize: 1 });
    }
    if (url === '/api/v1/access/roles') {
      return role === 'admin'
        ? ok([
            {
              id: '01900000-0000-7000-8000-0000000000b1',
              name: 'Quản lý',
              shortName: 'manager',
              description: '',
              archetype: 'manager',
            },
            {
              id: '01900000-0000-7000-8000-0000000000b2',
              name: 'Học viên',
              shortName: 'student',
              description: '',
              archetype: 'student',
            },
          ])
        : forbidden();
    }
    if (url === '/api/v1/questions/categories') return role === 'student' ? forbidden() : ok([]);
    if (url === '/api/v1/courses') return ok([COURSE]);
    if (url === '/api/v1/courses/categories/tree') {
      return ok([
        {
          ...COURSE,
          id: CATEGORY_ID,
          name: 'Danh mục mẫu',
          idNumber: null,
          description: '',
          parent: null,
          sortOrder: 0,
          path: '/1',
          depth: 1,
          visible: true,
          children: [],
        },
      ]);
    }
    if (url === `/api/v1/courses/${COURSE_ID}/enrolments/me`) {
      return role === 'admin'
        ? ok({ courseId: COURSE_ID, userId: me.id, enrolled: false, active: false })
        : ok({ courseId: COURSE_ID, userId: me.id, enrolled: true, active: true });
    }
    if (url === `/api/v1/courses/${COURSE_ID}/grades/report`) {
      return role === 'student' ? forbidden() : ok(REPORT);
    }
    if (url === `/api/v1/courses/${COURSE_ID}/gradebook`) {
      return role === 'admin' ? forbidden() : ok(GRADEBOOK);
    }
    if (url === '/api/v1/badges/mine') return ok([{ id: 'x' }, { id: 'y' }]);
    // DASH1 (issue #121): endpoint tổng hợp dashboard + thẻ khoá.
    if (url.startsWith('/api/v1/dashboard/overview')) {
      const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const past = new Date(Date.now() - 3_600_000).toISOString();
      return ok({
        generatedAt: new Date().toISOString(),
        previousSeenAt: null,
        dueWindowDays: 7,
        dueItems:
          role === 'student'
            ? [
                { courseId: COURSE_ID, courseName: 'Khoá học mẫu', cmId: 'cm-overdue', activityId: 'a-overdue', kind: 'assignment', name: 'Bài nộp quá hạn', dueAt: past, status: 'overdue' },
                { courseId: COURSE_ID, courseName: 'Khoá học mẫu', cmId: 'cm-quiz', activityId: 'q-soon', kind: 'quiz', name: 'Quiz sắp đến hạn', dueAt: soon, status: 'not_started' },
              ]
            : [],
        newResults:
          role === 'student'
            ? [
                { courseId: COURSE_ID, courseName: 'Khoá học mẫu', kind: 'grade_item', itemId: 'item-1', itemName: 'Điểm kiểm tra', vnScope: null, finalGrade: 9, gradeMax: 10, feedback: 'Làm tốt', changedAt: new Date().toISOString() },
              ]
            : [],
        gradingQueue:
          role === 'teacher'
            ? [{ courseId: COURSE_ID, courseName: 'Khoá học mẫu', pendingCount: 3, assignmentPending: 2, quizPending: 1, oldestPendingAt: past }]
            : [],
      });
    }
    if (url === '/api/v1/dashboard/course-cards') return ok({ prefs: [] });
    // Dashboard chỉ còn hỏi SỐ chưa đọc (trung tâm v2, issue #51).
    if (url === '/api/v1/notifications/unread-count') {
      return ok({ unread: 1 });
    }
    if (url.startsWith('/api/v1/calendar/events')) {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
      return ok([{ id: 'e1', name: 'Sự kiện mẫu', timeStart: tomorrow }]);
    }
    return undefined;
  };
}

describe('Dashboard theo vai trò', () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom thiếu matchMedia/ResizeObserver mà sidebar và biểu đồ cần.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {
          /* no-op cho jsdom */
        }
        unobserve() {
          /* no-op cho jsdom */
        }
        disconnect() {
          /* no-op cho jsdom */
        }
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('student thấy khối việc cần làm DASH1 ở đầu dashboard: quá hạn tách rõ + điểm mới', async () => {
    stubFetch(baseHandler('student'));
    renderApp(false);
    // Chờ nội dung thật (skeleton chờ tải mang cùng testid nên không chờ theo testid).
    expect(await screen.findByText('Bài nộp quá hạn')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-todo')).toBeInTheDocument();
    const items = screen.getAllByTestId('todo-due-item');
    expect(items).toHaveLength(2);
    // Quá hạn đứng đầu danh sách (API đã sắp) và mang nhãn Quá hạn.
    expect(items[0]).toHaveTextContent('Bài nộp quá hạn');
    expect(items[0]).toHaveTextContent('Quá hạn');
    expect(items[1]).toHaveTextContent('Quiz sắp đến hạn');
    // ĐX-5 (issue #179): việc cần làm trỏ thẳng tới trang hoạt động, không về trang khoá chung.
    expect(items[0].querySelector('a')?.getAttribute('href')).toBe(`/courses/${COURSE_ID}/assignments/a-overdue`);
    expect(items[1].querySelector('a')?.getAttribute('href')).toBe(`/courses/${COURSE_ID}/quizzes/q-soon`);
    // Điểm mới đã công bố hiện kèm điểm số.
    const fresh = screen.getByTestId('todo-new-result');
    expect(fresh).toHaveTextContent('Điểm kiểm tra');
    expect(fresh).toHaveTextContent('9 / 10');
  });

  it('teacher thấy hàng đợi chấm DASH1 gộp theo khoá với số chờ đúng', async () => {
    stubFetch(baseHandler('teacher'));
    renderApp(false);
    const row = await screen.findByTestId('grading-queue-row');
    expect(screen.getByTestId('dashboard-grading-queue')).toBeInTheDocument();
    expect(row).toHaveTextContent('Khoá học mẫu');
    expect(row).toHaveTextContent('3');
    // Bấm vào hàng đợi tới thẳng trang điểm của khoá (href nằm ở thẻ
    // liên kết bao quanh hàng — Button render qua Link của Base UI).
    const queueLink = row.closest('a') ?? row.querySelector('a');
    expect(queueLink?.getAttribute('href')).toBe(`/courses/${COURSE_ID}/grades`);
  });

  it('admin thấy khối quản trị hệ thống, không thấy khối giảng dạy/học tập', async () => {
    stubFetch(baseHandler('admin'));
    renderApp(false);
    expect(await screen.findByText('Quản trị hệ thống')).toBeInTheDocument();
    expect(await screen.findByText('Tổng người dùng')).toBeInTheDocument();
    // Bảng người dùng thật từ API quản trị.
    expect(await screen.findByText('teacher1')).toBeInTheDocument();
    expect(screen.queryByText('Giảng dạy')).not.toBeInTheDocument();
    expect(screen.queryByText('Học tập của tôi')).not.toBeInTheDocument();
  });

  it('student chỉ thấy khối học tập của mình với điểm thật, không thấy khối quản trị/giảng dạy', async () => {
    stubFetch(baseHandler('student'));
    renderApp(false);
    expect(await screen.findByText('Học tập của tôi')).toBeInTheDocument();
    // Điểm trung bình từ điểm tổng 8.5/10 trong sổ điểm cá nhân.
    expect(await screen.findByText('85.0%')).toBeInTheDocument();
    // Bảng khoá học của tôi có khoá đã ghi danh.
    expect(await screen.findByText('Khoá học mẫu')).toBeInTheDocument();
    expect(screen.queryByText('Quản trị hệ thống')).not.toBeInTheDocument();
    expect(screen.queryByText('Giảng dạy')).not.toBeInTheDocument();
  });

  it('teacher thấy khối giảng dạy với hàng đợi chấm thật, không thấy khối quản trị/học tập', async () => {
    stubFetch(baseHandler('teacher'));
    renderApp(false);
    expect(await screen.findByText('Giảng dạy')).toBeInTheDocument();
    // Báo cáo lớp có 2 học viên, 1 người chưa có điểm → thẻ "Chưa có điểm" = 1.
    const ungradedCard = await screen.findByTestId('stat-card-teacher-ungraded');
    await waitFor(() => expect(ungradedCard).toHaveTextContent('1'));
    expect(screen.queryByText('Quản trị hệ thống')).not.toBeInTheDocument();
    expect(screen.queryByText('Học tập của tôi')).not.toBeInTheDocument();
  });

  it('sidebar của admin có các nhóm quản trị thu/mở được, sidebar của student thì không', async () => {
    stubFetch(baseHandler('admin'));
    renderApp(true);
    // Mục quản trị nay nằm trong nhóm cha thu/mở: mở nhóm "Người dùng
    // & quyền" mới thấy Người dùng và Vai trò.
    await userEvent.click(await screen.findByRole('button', { name: 'Người dùng & quyền' }));
    expect(await screen.findByText('Người dùng')).toBeInTheDocument();
    expect(screen.getByText('Vai trò')).toBeInTheDocument();
    // Ngân hàng câu hỏi được phép với admin — nay là nút cha riêng
    // ngay sau nhóm Học tập (mở lại #70): bấm nút cha mới thấy các
    // mục con liên kết sâu của trang /questions.
    await userEvent.click(await screen.findByRole('button', { name: 'Ngân hàng câu hỏi' }));
    expect(await screen.findByText('Câu hỏi của tôi')).toBeInTheDocument();
    expect(screen.getByText('Ngân hàng hệ thống')).toBeInTheDocument();
  });

  it('sidebar của student không có mục quản trị và không có ngân hàng câu hỏi', async () => {
    stubFetch(baseHandler('student'));
    renderApp(true);
    expect(await screen.findByText('Tổng quan')).toBeInTheDocument();
    expect(screen.getByText('Khoá học')).toBeInTheDocument();
    expect(screen.queryByText('Người dùng')).not.toBeInTheDocument();
    expect(screen.queryByText('Vai trò')).not.toBeInTheDocument();
    expect(screen.queryByText('Ngân hàng câu hỏi')).not.toBeInTheDocument();
  });
});
