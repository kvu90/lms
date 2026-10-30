import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { NotificationBell } from './notification-bell';

/**
 * Spec lát NB-3 (issue #174) cho chuông thông báo ở header:
 * - Huy hiệu lấy số từ GET /notifications/unread-count (cùng khoá
 *   `notificationUnreadCount` với sidebar): có số > 0 thì hiện, đọc
 *   xong thì số khớp lại giá trị server trả ở lần làm mới kế tiếp.
 * - Dropdown liệt kê các dòng GỘP mới nhất theo đúng thứ tự API trả
 *   (API list nhóm đã sắp theo hoạt động mới nhất), tối đa 8 dòng.
 * - Bấm dòng đơn chưa đọc → POST /notifications/:id/read rồi đi tới
 *   contextUrl; bấm dòng gộp còn chưa đọc → POST /notifications/
 *   read-group với đúng khoá gộp rồi đi tới contextUrl; dòng đã đọc
 *   thì đi thẳng, không gọi API đọc.
 * - Chân dropdown đi tới /notifications; không có thông báo thì
 *   hiện trạng thái rỗng.
 * Chuông nằm trong một layout vỏ dùng chung mọi route (như
 * SiteHeader thật) để khẳng định được cả điều hướng lẫn số huy hiệu
 * sau điều hướng.
 */

const SINGLE_ID = '01900000-0000-7000-8000-0000000000b1';
const GROUP_LATEST_ID = '01900000-0000-7000-8000-0000000000b2';
const READ_ID = '01900000-0000-7000-8000-0000000000b3';

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

interface StubState {
  unread: number;
  groups: unknown[];
}

function groupRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    eventType: 'assignment_assigned',
    component: 'core',
    group: 'learning',
    contextUrl: '/courses/demo',
    day: localDay(new Date()),
    count: 1,
    unreadCount: 1,
    latest: {
      id: SINGLE_ID,
      subject: 'Bài tập mới được giao',
      smallMessage: 'Bài tập 1 vừa mở',
      contextUrlName: 'Khoá demo',
      createdAt: new Date().toISOString(),
      timeRead: null,
    },
    ...overrides,
  };
}

function stubFetch(calls: RecordedCall[], state: StubState) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/notifications/unread-count') return respond({ unread: state.unread });
      if (url.startsWith('/api/v1/notifications?')) return respond({ items: state.groups, nextCursor: null });
      if (url === `/api/v1/notifications/${SINGLE_ID}/read` && method === 'POST') {
        state.unread = 2;
        return respond({});
      }
      if (url === '/api/v1/notifications/read-group' && method === 'POST') {
        state.unread = 1;
        return respond({});
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function Shell() {
  return (
    <>
      <NotificationBell />
      <Outlet />
    </>
  );
}

function renderBell() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Shell />,
        children: [
          { index: true, element: <p>Trang chủ</p> },
          { path: 'notifications', element: <p>Trang thông báo đầy đủ</p> },
          { path: 'courses/demo', element: <p>Trang khoá demo</p> },
          { path: 'courses/demo/quiz', element: <p>Trang quiz demo</p> },
          { path: 'grades', element: <p>Trang điểm</p> },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
  return router;
}

function defaultGroups(): unknown[] {
  return [
    groupRow({}),
    groupRow({
      eventType: 'assignment_submitted',
      contextUrl: '/courses/demo/quiz',
      count: 3,
      unreadCount: 2,
      latest: {
        id: GROUP_LATEST_ID,
        subject: 'Học sinh nộp bài',
        smallMessage: 'Có bài nộp mới',
        contextUrlName: 'Khoá demo',
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        timeRead: null,
      },
    }),
    groupRow({
      eventType: 'grade_updated',
      contextUrl: '/grades',
      count: 1,
      unreadCount: 0,
      latest: {
        id: READ_ID,
        subject: 'Điểm đã cập nhật',
        smallMessage: '',
        contextUrlName: 'Sổ điểm',
        createdAt: new Date(Date.now() - 7_200_000).toISOString(),
        timeRead: new Date().toISOString(),
      },
    }),
  ];
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Khối NotificationBell (NB-3)', () => {
  it('hiện huy hiệu đúng số chưa đọc của API và liệt kê dropdown theo thứ tự mới nhất', async () => {
    const calls: RecordedCall[] = [];
    const state: StubState = { unread: 3, groups: defaultGroups() };
    stubFetch(calls, state);
    renderBell();
    const user = userEvent.setup();

    const bell = await screen.findByRole('button', { name: 'Thông báo' });
    expect(await screen.findByText('3')).toBeInTheDocument();

    await user.click(bell);
    const items = await screen.findAllByRole('menuitem');
    // 3 dòng thông báo + 1 chân dropdown "Xem tất cả thông báo".
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Bài tập mới được giao');
    expect(items[1]).toHaveTextContent('Học sinh nộp bài');
    expect(items[1]).toHaveTextContent('3 thông báo');
    expect(items[1]).toHaveTextContent('2 chưa đọc');
    expect(items[2]).toHaveTextContent('Điểm đã cập nhật');
    expect(items[3]).toHaveTextContent('Xem tất cả thông báo');
  });

  it('bấm dòng đơn chưa đọc: gọi POST read đúng id, đi tới ngữ cảnh và huy hiệu về số mới', async () => {
    const calls: RecordedCall[] = [];
    const state: StubState = { unread: 3, groups: defaultGroups() };
    stubFetch(calls, state);
    renderBell();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Thông báo' }));
    await user.click(await screen.findByRole('menuitem', { name: /Bài tập mới được giao/ }));

    await waitFor(() => expect(screen.getByText('Trang khoá demo')).toBeInTheDocument());
    expect(calls).toContainEqual({
      url: `/api/v1/notifications/${SINGLE_ID}/read`,
      method: 'POST',
      body: {},
    });
    // Mutation làm mới khoá unread-count → huy hiệu khớp số server mới (2).
    expect(await screen.findByText('2')).toBeInTheDocument();
  });

  it('bấm dòng gộp còn chưa đọc: gọi read-group đúng khoá gộp rồi đi tới ngữ cảnh', async () => {
    const calls: RecordedCall[] = [];
    const state: StubState = { unread: 3, groups: defaultGroups() };
    stubFetch(calls, state);
    renderBell();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Thông báo' }));
    await user.click(await screen.findByRole('menuitem', { name: /Học sinh nộp bài/ }));

    await waitFor(() => expect(screen.getByText('Trang quiz demo')).toBeInTheDocument());
    expect(calls).toContainEqual({
      url: '/api/v1/notifications/read-group',
      method: 'POST',
      body: { eventType: 'assignment_submitted', contextUrl: '/courses/demo/quiz', day: localDay(new Date()) },
    });
  });

  it('bấm dòng đã đọc: đi thẳng tới ngữ cảnh, không gọi API đọc', async () => {
    const calls: RecordedCall[] = [];
    const state: StubState = { unread: 3, groups: defaultGroups() };
    stubFetch(calls, state);
    renderBell();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Thông báo' }));
    await user.click(await screen.findByRole('menuitem', { name: /Điểm đã cập nhật/ }));

    await waitFor(() => expect(screen.getByText('Trang điểm')).toBeInTheDocument());
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('chân dropdown mở trang thông báo đầy đủ', async () => {
    const calls: RecordedCall[] = [];
    const state: StubState = { unread: 3, groups: defaultGroups() };
    stubFetch(calls, state);
    renderBell();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Thông báo' }));
    await user.click(await screen.findByRole('menuitem', { name: /Xem tất cả thông báo/ }));
    await waitFor(() => expect(screen.getByText('Trang thông báo đầy đủ')).toBeInTheDocument());
  });

  it('không có thông báo: không huy hiệu và dropdown hiện trạng thái rỗng', async () => {
    const calls: RecordedCall[] = [];
    const state: StubState = { unread: 0, groups: [] };
    stubFetch(calls, state);
    renderBell();
    const user = userEvent.setup();

    const bell = await screen.findByRole('button', { name: 'Thông báo' });
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/notifications/unread-count')).toBe(true),
    );
    expect(screen.queryByText('0')).not.toBeInTheDocument();

    await user.click(bell);
    expect(await screen.findByText('Chưa có thông báo nào.')).toBeInTheDocument();
  });
});
