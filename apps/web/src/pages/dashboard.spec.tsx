import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { PermissionsProvider } from '@/lib/permissions';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarProvider } from '@/components/ui/sidebar';
import { DashboardPage } from './dashboard';

const ADMIN_ID = '01900000-0000-7000-8000-0000000000a1';
const TEACHER_ID = '01900000-0000-7000-8000-0000000000a2';
const STUDENT_ID = '01900000-0000-7000-8000-0000000000a3';
const COURSE_ID = '01900000-0000-7000-8000-000000000010';
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';

const COURSE = {
  id: COURSE_ID, category: CATEGORY_ID, fullname: 'Khoá học mẫu', shortname: 'DEMO101',
  idnumber: '', summary: '', format: 'topics', visible: true, startdate: null, enddate: null,
  groupmode: 0, enablecompletion: true,
};

function profile(id: string, username: string, firstname: string, lastname: string) {
  return {
    id, username, firstname, lastname, email: `${username}@example.com`,
    suspended: false, deleted: false, isGuest: false, forcePasswordChange: false,
    lastlogin: null, timecreated: '2026-10-01T00:00:00.000Z', customFields: [],
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
    item: { id: '01900000-0000-7000-8000-000000000090', grademax: 10 },
    grade: { finalgrade: 8.5, letter: 'A' },
  },
};

const REPORT = {
  courseId: COURSE_ID,
  rows: [
    { userId: STUDENT_ID, finalgrade: 8.5, letter: 'A' },
    { userId: '01900000-0000-7000-8000-0000000000a4', finalgrade: null, letter: null },
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
      userId: me.id, isSiteAdmin: true, assignments: [],
      contexts: [{ contextId: SYS_CTX_ID, contextLevel: 10, contextPath: '/1', capabilities: ['moodle/user:viewdetails', 'moodle/role:manage'] }],
    };
  }
  return {
    userId: me.id, isSiteAdmin: false,
    assignments: [{
      id: '01900000-0000-7000-8000-0000000000f1', roleId: '01900000-0000-7000-8000-0000000000b9',
      roleShortname: role === 'teacher' ? 'editingteacher' : 'student', roleName: role === 'teacher' ? 'Teacher' : 'Student',
      contextId: COURSE_CTX_ID, contextLevel: 50, contextPath: '/1/9/10', instanceId: COURSE_ID,
    }],
    contexts: [
      { contextId: SYS_CTX_ID, contextLevel: 10, contextPath: '/1', capabilities: [] },
      {
        contextId: COURSE_CTX_ID, contextLevel: 50, contextPath: '/1/9/10',
        capabilities: role === 'teacher' ? ['moodle/grade:viewall', 'moodle/course:update', 'moodle/question:useall'] : ['moodle/course:view'],
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
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const result = handler(url);
    if (!result) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
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
    <AuthProvider>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </AuthProvider>,
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
            { id: '01900000-0000-7000-8000-0000000000b1', name: 'Quản lý', shortname: 'manager', description: '', archetype: 'manager' },
            { id: '01900000-0000-7000-8000-0000000000b2', name: 'Học viên', shortname: 'student', description: '', archetype: 'student' },
          ])
        : forbidden();
    }
    if (url === '/api/v1/questions/categories') return role === 'student' ? forbidden() : ok([]);
    if (url === '/api/v1/courses') return ok([COURSE]);
    if (url === '/api/v1/courses/categories/tree') {
      return ok([
        { ...COURSE, id: CATEGORY_ID, name: 'Danh mục mẫu', idnumber: null, description: '', parent: null, sortorder: 0, path: '/1', depth: 1, visible: true, children: [] },
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
    if (url === '/api/v1/notifications') {
      return ok([
        { id: 'n1', timeread: null },
        { id: 'n2', timeread: '2026-10-20T00:00:00.000Z' },
      ]);
    }
    if (url.startsWith('/api/v1/calendar/events')) {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
      return ok([{ id: 'e1', name: 'Sự kiện mẫu', timestart: tomorrow }]);
    }
    return undefined;
  };
}

describe('Dashboard theo vai trò', () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom thiếu matchMedia/ResizeObserver mà sidebar và biểu đồ cần.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => undefined, removeListener: () => undefined,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));
    vi.stubGlobal('ResizeObserver', class {
      observe() { /* no-op cho jsdom */ }
      unobserve() { /* no-op cho jsdom */ }
      disconnect() { /* no-op cho jsdom */ }
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
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

  it('sidebar của admin có nhóm quản trị, sidebar của student thì không', async () => {
    stubFetch(baseHandler('admin'));
    renderApp(true);
    expect(await screen.findByText('Người dùng')).toBeInTheDocument();
    expect(screen.getByText('Vai trò')).toBeInTheDocument();
    // Ngân hàng câu hỏi được phép với admin.
    expect(screen.getByText('Câu hỏi')).toBeInTheDocument();
  });

  it('sidebar của student không có mục quản trị và không có ngân hàng câu hỏi', async () => {
    stubFetch(baseHandler('student'));
    renderApp(true);
    expect(await screen.findByText('Tổng quan')).toBeInTheDocument();
    expect(screen.getByText('Khoá học')).toBeInTheDocument();
    expect(screen.queryByText('Người dùng')).not.toBeInTheDocument();
    expect(screen.queryByText('Vai trò')).not.toBeInTheDocument();
    expect(screen.queryByText('Câu hỏi')).not.toBeInTheDocument();
  });
});
