import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '@/test/providers';
import { PermissionsProvider } from '@/lib/permissions';
import { CoursePage } from './course';
import { CoursesPage } from './courses';

const TREE = [
  {
    id: '01900000-0000-7000-8000-000000000001',
    name: 'Science',
    idnumber: null,
    description: '',
    parent: null,
    sortorder: 0,
    path: '/1',
    depth: 1,
    visible: true,
    children: [
      {
        id: '01900000-0000-7000-8000-000000000002',
        name: 'Physics',
        idnumber: null,
        description: '',
        parent: '01900000-0000-7000-8000-000000000001',
        sortorder: 0,
        path: '/1/2',
        depth: 2,
        visible: true,
        children: [],
      },
    ],
  },
];
const COURSES = [
  {
    id: '01900000-0000-7000-8000-000000000010',
    category: '01900000-0000-7000-8000-000000000002',
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
  },
];
const CONTENT = {
  course: COURSES[0],
  contextId: '01900000-0000-7000-8000-000000000055',
  customFields: [],
  sections: [
    {
      id: '01900000-0000-7000-8000-000000000100',
      course: '01900000-0000-7000-8000-000000000010',
      section: 0,
      name: 'General',
      summary: '',
      visible: true,
      availability: null,
      availabilityResult: { available: true, visible: true, failedDescriptions: [] },
      modules: [
        {
          id: '01900000-0000-7000-8000-000000001000',
          course: '01900000-0000-7000-8000-000000000010',
          section: '01900000-0000-7000-8000-000000000100',
          component: 'mod_page',
          instanceid: '01900000-0000-7000-8000-000000000001',
          name: 'Welcome page',
          visible: true,
          groupmode: 0,
          availability: null,
          completion: 0,
          completionview: false,
          availabilityResult: { available: true, visible: true, failedDescriptions: [] },
        },
        {
          id: '01900000-0000-7000-8000-000000001001',
          course: '01900000-0000-7000-8000-000000000010',
          section: '01900000-0000-7000-8000-000000000100',
          component: 'mod_quiz',
          instanceid: '01900000-0000-7000-8000-000000000002',
          name: 'Locked quiz',
          visible: true,
          groupmode: 0,
          availability: { op: '&', show: true, showc: [true], c: [{ type: 'date', d: '>=', t: 4102444800 }] },
          completion: 2,
          completionview: true,
          availabilityResult: { available: false, visible: true, failedDescriptions: ['Available >= 2100-01-01'] },
        },
      ],
    },
  ],
};

function stubFetch(handler: (url: string) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = handler(url);
      if (body === undefined)
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/**
 * Render trang trong đúng khung provider của ứng dụng thật: trang danh
 * mục nay đọc `usePermissions()` để chỉ hiện khu quản trị cho
 * `canAdminister`, nên test phải bọc AuthProvider + PermissionsProvider
 * như main.tsx. Khi không có token đăng nhập, PermissionsProvider kết
 * luận không có quyền quản trị mà không gọi thêm endpoint nào.
 */
function renderWithProviders(router: ReturnType<typeof createMemoryRouter>) {
  render(
    <TestProviders>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </TestProviders>,
  );
}

describe('Courses pages', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders the category tree with its courses nested under the right category', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/courses/categories/tree') return TREE;
      if (url === '/api/v1/courses') return COURSES;
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/courses', element: <CoursesPage /> }], {
      initialEntries: ['/courses'],
    });
    renderWithProviders(router);
    await waitFor(() => expect(screen.getAllByText('Science').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Physics').length).toBeGreaterThan(0);
    const courseLink = screen.getByRole('link', { name: /Physics 101/ });
    expect(courseLink).toHaveAttribute('href', '/courses/01900000-0000-7000-8000-000000000010');
  });

  it('renders a locked module as shown-but-unavailable (show=true) with its restriction text, and an available module as available', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/courses/01900000-0000-7000-8000-000000000010/content') return CONTENT;
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/courses/:id', element: <CoursePage /> }], {
      initialEntries: ['/courses/01900000-0000-7000-8000-000000000010'],
    });
    renderWithProviders(router);
    await waitFor(() => expect(screen.getByText('Welcome page')).toBeInTheDocument());
    const locked = screen.getByTestId('cm-01900000-0000-7000-8000-000000001001');
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).toHaveTextContent(/Đã khoá:/);
    expect(locked).toHaveTextContent(/2100-01-01/);
    const open = screen.getByTestId('cm-01900000-0000-7000-8000-000000001000');
    expect(open).not.toHaveAttribute('aria-disabled');
    expect(open).toHaveTextContent(/Có thể truy cập/);
  });
});

describe('Courses page — category administration (admin)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /**
   * Tạo danh mục từ trang khoá học khi là admin: khu quản trị chỉ hiện vì
   * điểm dò quyền cấp hệ thống (GET /users) gọi được — stub dưới đây mô
   * phỏng đúng bề mặt API đó, và lời gọi tạo phải là POST
   * /api/v1/courses/categories với body đúng `createCourseCategorySchema`
   * (chỉ `name` khi tạo ở cấp cao nhất, không gửi `parent`).
   */
  it('creates a category via POST /courses/categories with the contracts body when admin', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const profile = {
      id: '01900000-0000-7000-8000-0000000000a1',
      username: 'admin',
      firstname: 'Quản',
      lastname: 'Trị',
      email: 'admin@example.com',
      suspended: false,
      deleted: false,
      isGuest: false,
      forcePasswordChange: false,
      lastlogin: null,
      timecreated: '2026-01-01T00:00:00.000Z',
      customFields: [],
    };
    interface RecordedCall {
      url: string;
      method: string;
      body: unknown;
    }
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url === '/api/v1/users/me') return respond(profile);
        if (url === '/api/v1/users/me/capabilities')
          return respond({ userId: profile.id, isSiteAdmin: true, assignments: [], contexts: [] });
        if (url === '/api/v1/users?pageSize=1') return respond({ users: [profile], total: 1, page: 1, pageSize: 1 });
        if (url === '/api/v1/access/roles') return respond([]);
        if (url === '/api/v1/questions/categories') return respond([]);
        if (url === '/api/v1/courses/categories/tree') return respond(TREE);
        if (url === '/api/v1/courses' && method === 'GET') return respond(COURSES);
        if (url === '/api/v1/courses/categories' && method === 'POST') {
          return respond({
            id: '01900000-0000-7000-8000-0000000000c9',
            name: 'Biology',
            idnumber: null,
            description: '',
            parent: null,
            sortorder: 0,
            path: '/3',
            depth: 1,
            visible: true,
          });
        }
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );

    const router = createMemoryRouter([{ path: '/courses', element: <CoursesPage /> }], {
      initialEntries: ['/courses'],
    });
    renderWithProviders(router);

    // Khu quản trị danh mục chỉ xuất hiện sau khi PermissionsProvider dò xong quyền admin.
    await userEvent.type(await screen.findByLabelText('Tên danh mục'), 'Biology');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo danh mục' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/courses/categories' && c.method === 'POST')).toBe(true),
    );
    const createCall = calls.find((c) => c.url === '/api/v1/courses/categories' && c.method === 'POST');
    expect(createCall?.body).toEqual({ name: 'Biology' });
  });
});
