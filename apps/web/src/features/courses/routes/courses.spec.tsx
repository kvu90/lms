import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { PermissionsProvider } from '#lib/permissions';
import { CoursePage } from './course';
import { CoursesPage } from './courses';

const TREE = [
  {
    id: '01900000-0000-7000-8000-000000000001',
    name: 'Science',
    idNumber: null,
    description: '',
    parent: null,
    sortOrder: 0,
    path: '/1',
    depth: 1,
    visible: true,
    children: [
      {
        id: '01900000-0000-7000-8000-000000000002',
        name: 'Physics',
        idNumber: null,
        description: '',
        parent: '01900000-0000-7000-8000-000000000001',
        sortOrder: 0,
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
          instanceId: '01900000-0000-7000-8000-000000000001',
          name: 'Welcome page',
          visible: true,
          groupMode: 0,
          availability: null,
          completion: 0,
          completionView: false,
          availabilityResult: { available: true, visible: true, failedDescriptions: [] },
        },
        {
          id: '01900000-0000-7000-8000-000000001001',
          course: '01900000-0000-7000-8000-000000000010',
          section: '01900000-0000-7000-8000-000000000100',
          component: 'mod_quiz',
          instanceId: '01900000-0000-7000-8000-000000000002',
          name: 'Locked quiz',
          visible: true,
          groupMode: 0,
          availability: { op: '&', show: true, showc: [true], c: [{ type: 'date', d: '>=', t: 4102444800 }] },
          completion: 2,
          completionView: true,
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

describe('Trang khoá học', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('render cây danh mục với các khoá học lồng đúng danh mục', async () => {
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

  it('DASH1: thẻ khoá hiện màu + biệt danh của chính chủ nhân, tên gốc giữ ở title, mở được editor tại dòng', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/courses/categories/tree') return TREE;
      if (url === '/api/v1/courses') return COURSES;
      if (url === '/api/v1/dashboard/course-cards') {
        return { prefs: [{ courseId: '01900000-0000-7000-8000-000000000010', color: 'teal', nickname: 'Vật lý của tui' }] };
      }
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/courses', element: <CoursesPage /> }], {
      initialEntries: ['/courses'],
    });
    renderWithProviders(router);
    // Biệt danh thay tên hiển thị; tên khoá gốc vẫn còn ở title của liên kết.
    const link = await screen.findByRole('link', { name: /Vật lý của tui/ });
    expect(link).toHaveAttribute('title', 'Physics 101');
    expect(screen.getByTestId('course-card-color-dot')).toBeInTheDocument();
    // Mở editor tại dòng: thấy đủ 10 lựa chọn màu + ô biệt danh có sẵn giá trị.
    await userEvent.click(screen.getByTestId('course-card-edit'));
    const editor = await screen.findByTestId('course-card-pref-editor');
    expect(editor).toBeInTheDocument();
    expect(screen.getByTestId('card-pref-nickname')).toHaveValue('Vật lý của tui');
    expect(screen.getByTestId('card-color-red')).toBeInTheDocument();
    expect(screen.getByTestId('card-color-slate')).toBeInTheDocument();
  });

  it('render module bị khoá dạng hiện-nhưng-không-khả-dụng (show=true) kèm văn bản hạn chế, và module khả dụng dạng khả dụng', async () => {
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

describe('Trang khoá học — quản trị danh mục (admin)', () => {
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
  it('tạo danh mục qua POST /courses/categories với body contracts khi là admin', async () => {
    const profile = {
      id: '01900000-0000-7000-8000-0000000000a1',
      username: 'admin',
      firstName: 'Quản',
      lastName: 'Trị',
      email: 'admin@example.com',
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
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: profile.id, username: profile.username, email: profile.email }));
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
            idNumber: null,
            description: '',
            parent: null,
            sortOrder: 0,
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
