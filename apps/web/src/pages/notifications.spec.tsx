import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { apiJson } from '#lib/api';
import { queryKeys } from '#lib/query-keys';
import { NotificationsPage } from './notifications';

/**
 * Spec F-01 cho trang thông báo: điểm hợp nhất cốt lõi là các thao tác
 * đọc ở trang này phải LÀM MỚI khoá `notificationUnreadCount` dùng chung
 * với huy hiệu chuông ở sidebar/header (trước đây trang fetch thủ công
 * không hề invalidate nên huy hiệu giữ số cũ). Probe dưới đây đóng vai
 * huy hiệu: một useQuery độc lập cùng khoá factory + cùng endpoint như
 * app-sidebar.
 */
const ITEM_ID = '01900000-0000-7000-8000-0000000000n1'.replace('n', 'a');

function localDay(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Huy hiệu chưa đọc mô phỏng sidebar: query độc lập, cùng khoá + endpoint thật. */
function UnreadBadgeProbe() {
  const query = useQuery({
    queryKey: queryKeys.notificationUnreadCount,
    queryFn: () => apiJson<{ unread: number }>('/api/v1/notifications/unread-count'),
  });
  return <span data-testid="unread-badge">{query.data ? String(query.data.unread) : '…'}</span>;
}

function stubFetch(calls: RecordedCall[], state: { unread: number; allRead: boolean; prefEnabled: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/notifications/unread-count') return respond({ unread: state.unread });
      if (url.startsWith('/api/v1/notifications?')) {
        return respond({
          items: [
            {
              eventType: 'assignment_due',
              component: 'core',
              group: 'learning',
              contextUrl: '/courses/demo',
              day: localDay(new Date()),
              count: 1,
              unreadCount: state.allRead ? 0 : 1,
              latest: {
                id: ITEM_ID,
                subject: 'Bài tập sắp đến hạn',
                smallMessage: 'Nộp trước 23:59',
                contextUrlName: 'Khoá demo',
                createdAt: new Date().toISOString(),
                timeRead: state.allRead ? new Date().toISOString() : null,
              },
            },
          ],
          nextCursor: null,
        });
      }
      if (url === '/api/v1/notifications/read-all' && method === 'POST') {
        state.allRead = true;
        state.unread = 0;
        return respond({});
      }
      if (url === '/api/v1/messages/preferences' && method === 'GET') {
        return respond([
          { provider: 'core', component: 'core', channel: 'popup', state: 'loggedin', enabled: state.prefEnabled },
          { provider: 'core', component: 'core', channel: 'popup', state: 'loggedoff', enabled: false },
        ]);
      }
      if (url === '/api/v1/messages/preferences' && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        state.prefEnabled = body.enabled;
        return respond({
          provider: 'core',
          component: 'core',
          channel: 'popup',
          state: 'loggedin',
          enabled: body.enabled,
        });
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/notifications', element: <NotificationsPage /> }], {
    initialEntries: ['/notifications'],
  });
  render(
    <TestProviders>
      <UnreadBadgeProbe />
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

describe('Notifications page — TanStack invalidation (F-01)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('mark-all-read invalidates the shared unread-count query so the badge drops to 0', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    const state = { unread: 3, allRead: false, prefEnabled: true };
    stubFetch(calls, state);
    renderPage();

    await screen.findByTestId('unread-badge');
    await waitFor(() => expect(screen.getByTestId('unread-badge')).toHaveTextContent('3'));
    expect(await screen.findByText('Bài tập sắp đến hạn')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Đánh dấu đã đọc tất cả' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/notifications/read-all' && c.method === 'POST')).toBe(true),
    );
    // Huy hiệu (query độc lập cùng khoá) chỉ về 0 được nếu mutation đã
    // invalidate đúng khoá factory — đây là hành vi F-01 thêm vào.
    await waitFor(() => expect(screen.getByTestId('unread-badge')).toHaveTextContent('0'));
    expect(
      calls.filter((c) => c.url === '/api/v1/notifications/unread-count' && c.method === 'GET').length,
    ).toBeGreaterThan(1);
  });

  it('preference toggle PUTs exactly one row and keeps the saved value', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    const state = { unread: 0, allRead: true, prefEnabled: true };
    stubFetch(calls, state);
    renderPage();

    const checkbox = await screen.findByLabelText('core popup đã đăng nhập');
    expect(checkbox).toBeChecked();
    await userEvent.click(checkbox);

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/messages/preferences' && c.method === 'PUT')).toBe(true),
    );
    const put = calls.find((c) => c.url === '/api/v1/messages/preferences' && c.method === 'PUT');
    expect(put?.body).toEqual({ provider: 'core', channel: 'popup', state: 'loggedin', enabled: false });
    await waitFor(() => expect(screen.getByLabelText('core popup đã đăng nhập')).not.toBeChecked());
  });
});
