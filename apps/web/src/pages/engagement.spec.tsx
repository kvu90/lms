import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { PermissionsProvider } from '#lib/permissions';
import { BadgesPage } from './badges';
import { NotificationsPage } from './notifications';

/**
 * Engagement web tests (Testing Library): the two DoD-adjacent behaviours —
 * a notification preference toggle writes through to the API, and the
 * "my badges" list renders the caller's issued assertions.
 */
const PROFILE = {
  id: '01900000-0000-7000-8000-000000000007',
  username: 'learner7',
  firstName: 'Learner',
  lastName: 'Seven',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  customFields: [],
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

describe('Notifications page', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Hình dạng thật của GET /messages/preferences: một dòng cho mỗi
  // (provider × channel × state) kèm `enabled` của chính dòng đó.
  const PREF_ROWS = [
    { provider: 'badge_awarded', component: 'core_badges', channel: 'popup', state: 'loggedin', enabled: true },
    { provider: 'badge_awarded', component: 'core_badges', channel: 'popup', state: 'loggedoff', enabled: true },
    { provider: 'badge_awarded', component: 'core_badges', channel: 'email', state: 'loggedin', enabled: true },
    { provider: 'badge_awarded', component: 'core_badges', channel: 'email', state: 'loggedoff', enabled: false },
  ];
  // Hình dạng thật của GET /notifications ở trung tâm v2 (issue #51):
  // phong bì { items: [dòng GỘP], nextCursor } thay cho mảng phẳng cũ.
  const NOTIFICATION_PAGE = {
    items: [
      {
        eventType: 'badge_awarded',
        component: 'core_badges',
        group: 'people',
        contextUrl: null,
        day: '2026-10-22',
        count: 1,
        unreadCount: 1,
        latest: {
          id: '01900000-0000-7000-8000-000000000001',
          subject: 'Badge awarded',
          smallMessage: 'You earned Finisher',
          contextUrlName: null,
          createdAt: '2026-10-22T00:00:00.000Z',
          timeRead: null,
        },
      },
    ],
    nextCursor: null,
  };

  // Trang v2 dùng useNavigate (deep-link theo contextUrl) nên render
  // qua memory router như test Badges ở dưới.
  function renderNotificationsPage() {
    const router = createMemoryRouter([{ path: '/notifications', element: <NotificationsPage /> }], { initialEntries: ['/notifications'] });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
    return router;
  }

  it('renders each state row from the API and PUTs exactly the toggled logged-in row', async () => {
    const puts: unknown[] = [];
    stubFetch((url, init) => {
      if (url.startsWith('/api/v1/notifications?')) return NOTIFICATION_PAGE;
      if (url === '/api/v1/messages/preferences' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { provider: string; channel: string; state: string; enabled: boolean };
        puts.push(body);
        // API thật trả lại đúng một mục vừa đặt.
        return body;
      }
      if (url === '/api/v1/messages/preferences') return PREF_ROWS;
      return undefined;
    });
    renderNotificationsPage();
    await waitFor(() => expect(screen.getByText('Badge awarded')).toBeInTheDocument());
    const toggle = screen.getByLabelText('badge_awarded popup đã đăng nhập');
    expect(toggle).toBeChecked();
    expect(screen.getByLabelText('badge_awarded email chưa đăng nhập')).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ provider: 'badge_awarded', channel: 'popup', state: 'loggedin', enabled: false });
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it('toggling the logged-off row PUTs that state only', async () => {
    const puts: unknown[] = [];
    stubFetch((url, init) => {
      if (url.startsWith('/api/v1/notifications?')) return NOTIFICATION_PAGE;
      if (url === '/api/v1/messages/preferences' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { provider: string; channel: string; state: string; enabled: boolean };
        puts.push(body);
        return body;
      }
      if (url === '/api/v1/messages/preferences') return PREF_ROWS;
      return undefined;
    });
    renderNotificationsPage();
    const toggle = await screen.findByLabelText('badge_awarded email chưa đăng nhập');
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ provider: 'badge_awarded', channel: 'email', state: 'loggedoff', enabled: true });
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('reverts the toggle and reports an error when the PUT fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith('/api/v1/notifications?'))
          return new Response(JSON.stringify(NOTIFICATION_PAGE), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url === '/api/v1/messages/preferences' && init?.method === 'PUT')
          return new Response(
            JSON.stringify({ type: 'about:blank', title: 'Bad Request', status: 400, code: 'messaging.unknown_provider' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        if (url === '/api/v1/messages/preferences')
          return new Response(JSON.stringify(PREF_ROWS), { status: 200, headers: { 'Content-Type': 'application/json' } });
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    renderNotificationsPage();
    const toggle = await screen.findByLabelText('badge_awarded popup đã đăng nhập');
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('Không lưu được tuỳ chọn thông báo');
    expect(toggle).toBeChecked();
    expect(toggle).not.toBeDisabled();
  });
});

describe('Notifications centre v2 (issue #51)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const GRADE_GROUP_PAGE = {
    items: [
      {
        eventType: 'grade_updated',
        component: 'core_grades',
        group: 'learning',
        contextUrl: '/courses/course-a/grades',
        day: '2026-10-22',
        count: 2,
        unreadCount: 2,
        latest: {
          id: '01900000-0000-7000-8000-000000000102',
          subject: 'Điểm mới 2',
          smallMessage: 'Có điểm mới trong khoá A',
          contextUrlName: null,
          createdAt: '2026-10-22T01:00:00.000Z',
          timeRead: null,
        },
      },
    ],
    nextCursor: null,
  };
  const GRADE_ITEMS_PAGE = {
    items: [
      {
        id: '01900000-0000-7000-8000-000000000102', subject: 'Điểm mới 2', fullMessage: 'Nội dung điểm 2', smallMessage: '',
        eventType: 'grade_updated', contextUrl: '/courses/course-a/grades', contextUrlName: null, timeRead: null,
        createdAt: '2026-10-22T01:00:00.000Z',
      },
      {
        id: '01900000-0000-7000-8000-000000000101', subject: 'Điểm mới 1', fullMessage: 'Nội dung điểm 1', smallMessage: '',
        eventType: 'grade_updated', contextUrl: '/courses/course-a/grades', contextUrlName: null, timeRead: null,
        createdAt: '2026-10-22T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  };

  function renderNotificationsPage() {
    const router = createMemoryRouter([{ path: '/notifications', element: <NotificationsPage /> }], { initialEntries: ['/notifications'] });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
    return router;
  }

  it('renders one grouped row with its count, expands to the items, and deletes an item at its row', async () => {
    const calls: { url: string; method: string }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.startsWith('/api/v1/notifications/items')) return GRADE_ITEMS_PAGE;
      if (url.startsWith('/api/v1/notifications?')) return GRADE_GROUP_PAGE;
      if (url === '/api/v1/messages/preferences') return [];
      return undefined;
    });
    renderNotificationsPage();

    // Một dòng gộp duy nhất cho cả hai thông báo điểm, kèm số lượng.
    const subject = await screen.findByText('Điểm mới 2');
    expect(subject).toBeInTheDocument();
    expect(screen.getByText(/2 thông báo/)).toBeInTheDocument();
    expect(screen.queryByText('Điểm mới 1')).not.toBeInTheDocument();

    // Mở rộng tại chỗ (§9): chi tiết từng mục tải qua /notifications/items.
    await userEvent.click(screen.getByRole('button', { name: 'Mở rộng: Điểm mới 2' }));
    expect(await screen.findByText('Nội dung điểm 1')).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith('/api/v1/notifications/items') && c.url.includes('eventType=grade_updated'))).toBe(true);

    // Xoá ngay tại dòng của mục: DELETE đúng id và mục biến mất.
    await userEvent.click(screen.getByRole('button', { name: 'Xoá thông báo: Điểm mới 2' }));
    await waitFor(() => expect(screen.queryByText('Nội dung điểm 2')).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/notifications/01900000-0000-7000-8000-000000000102')).toBe(true);
  });

  it('filters the grouped list by the learning group tab', async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      if (url.startsWith('/api/v1/notifications?')) return { items: [], nextCursor: null };
      if (url === '/api/v1/messages/preferences') return [];
      return undefined;
    });
    renderNotificationsPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Học tập' }));
    await waitFor(() => expect(urls.some((u) => u.includes('group=learning'))).toBe(true));
  });

  it('clicking a single-item group marks it read and deep-links to its contextUrl', async () => {
    const calls: { url: string; method: string }[] = [];
    const singlePage = {
      items: [
        {
          eventType: 'grade_updated', component: 'core_grades', group: 'learning',
          contextUrl: '/courses/course-a/grades', day: '2026-10-22', count: 1, unreadCount: 1,
          latest: {
            id: '01900000-0000-7000-8000-000000000201', subject: 'Điểm mới duy nhất', smallMessage: '',
            contextUrlName: null, createdAt: '2026-10-22T01:00:00.000Z', timeRead: null,
          },
        },
      ],
      nextCursor: null,
    };
    stubFetch((url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.startsWith('/api/v1/notifications?')) return singlePage;
      if (url === '/api/v1/messages/preferences') return [];
      return {};
    });
    const router = createMemoryRouter(
      [
        { path: '/notifications', element: <NotificationsPage /> },
        { path: '/courses/:id/grades', element: <div>Trang điểm khoá</div> },
      ],
      { initialEntries: ['/notifications'] },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    await userEvent.click(await screen.findByText('Điểm mới duy nhất'));
    // Đã gọi đánh dấu đọc cho đúng mục, và router đã sang trang điểm.
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/notifications/01900000-0000-7000-8000-000000000201/read')).toBe(true));
    expect(await screen.findByText('Trang điểm khoá')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/courses/course-a/grades');
  });
});

describe('Badges page', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders my issued badges with their assertion hashes, including revoked ones', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    stubFetch((url) => {
      if (url === '/api/v1/users/me') return PROFILE;
      // Điểm dò quyền của PermissionsProvider: học viên thường bị từ chối
      // (404 → probe null) nên panel quản trị phải ẩn, phần của tôi vẫn hiện.
      if (url === '/api/v1/courses') return [];
      if (url === '/api/v1/badges')
        return [
          {
            id: '01900000-0000-7000-8000-000000000002',
            name: 'Finisher',
            description: '',
            type: 1,
            courseId: null,
            status: 1,
          },
          {
            id: '01900000-0000-7000-8000-000000000003',
            name: 'Old honour',
            description: '',
            type: 1,
            courseId: null,
            status: 3,
          },
        ];
      // Shape thật của GET /badges/mine: IssuedRow kèm badge lồng bên trong.
      if (url === '/api/v1/badges/mine')
        return [
          {
            id: '01900000-0000-7000-8000-000000000011',
            badgeId: '01900000-0000-7000-8000-000000000002',
            userId: PROFILE.id,
            uniqueHash: 'abcdef0123456789',
            dateIssued: '2026-10-20T00:00:00.000Z',
            dateExpire: null,
            revoked: false,
            badge: {
              id: '01900000-0000-7000-8000-000000000002',
              name: 'Finisher',
              description: '',
              type: 1,
              courseId: null,
              status: 1,
            },
          },
          {
            id: '01900000-0000-7000-8000-000000000012',
            badgeId: '01900000-0000-7000-8000-000000000003',
            userId: PROFILE.id,
            uniqueHash: '0011223344556677',
            dateIssued: '2026-09-01T00:00:00.000Z',
            dateExpire: null,
            revoked: true,
            badge: {
              id: '01900000-0000-7000-8000-000000000003',
              name: 'Old honour',
              description: '',
              type: 1,
              courseId: null,
              status: 3,
            },
          },
        ];
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/badges', element: <BadgesPage /> }], { initialEntries: ['/badges'] });
    render(
      <TestProviders>
        <PermissionsProvider>
          <RouterProvider router={router} />
        </PermissionsProvider>
      </TestProviders>,
    );
    // Wait for the issued list itself (it loads after the auth profile resolves).
    expect(await screen.findByText(/Old honour \(đã thu hồi\)/)).toBeInTheDocument();
    expect(screen.getByText(/bản ghi abcdef012345/)).toBeInTheDocument();
    expect(screen.queryByText('Quản trị huy hiệu')).not.toBeInTheDocument();
  });
});
