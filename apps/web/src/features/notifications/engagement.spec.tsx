import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { NotificationsPage } from './routes/notifications';

/**
 * Test web cho trung tâm thông báo (Testing Library): nhóm theo ngữ
 * cảnh, lọc theo nhóm học, mở một thông báo thì đánh dấu đã đọc và
 * đi sâu vào ngữ cảnh. Tuỳ chọn thông báo của khu Cài đặt được kiểm
 * ở settings-notifications.spec.tsx.
 *
 * File này là nửa notifications của `pages/engagement.spec.tsx`
 * cũ, tách theo miền khi tổ chức lại apps/web theo mô hình
 * features/ (issue #500); nửa badges nằm ở feature badges.
 */
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

describe('Trung tâm thông báo v2 (issue #51)', () => {
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

  it('render một dòng nhóm kèm số lượng, mở rộng ra các mục, và xoá một mục ngay tại dòng của nó', async () => {
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

  it('lọc danh sách nhóm theo tab nhóm học tập', async () => {
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

  it('bấm nhóm một mục đánh dấu đã đọc và deep-link tới contextUrl của nó', async () => {
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
