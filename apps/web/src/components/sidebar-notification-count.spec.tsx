import { act, cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from '../root';
import Shell from '../routes/shell';
import { queryClient } from '../lib/query-client';

/**
 * Test cho số thông báo chưa đọc ở mục Thông báo trên sidebar (thay
 * chuông thông báo ở site-header đã gỡ theo lệnh Lão gia): số ban đầu
 * lấy từ GET /notifications/unread-count — lớn hơn 0 thì hiện huy hiệu
 * số đếm cạnh nhãn mục Thông báo, bằng 0 thì không hiện; sau đó stream
 * SSE (GET /notifications/unread-count/stream) ĐẨY số mới xuống thời
 * gian thực, client KHÔNG polling nữa. Header không còn nút chuông
 * nào và vẫn không có bộ chọn ngôn ngữ. Dựng đúng cây thật
 * (App → Shell → AppSidebar + SiteHeader) như nav-user.spec, stub
 * fetch theo từng URL và EventSource bằng bản giả lập ghi lại instance.
 */

const ADMIN_ID = '01900000-0000-7000-8000-0000000000a1';

const PROFILE = {
  id: ADMIN_ID,
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

const ACCESS = { userId: ADMIN_ID, isSiteAdmin: true, assignments: [], contexts: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(unread: number, counter?: { unreadCalls: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
      if (url === '/api/v1/users/me/capabilities') return jsonResponse(ACCESS);
      if (url === '/api/v1/courses') return jsonResponse([]);
      if (url === '/api/v1/notifications/unread-count') {
        if (counter) counter.unreadCalls += 1;
        return jsonResponse({ unread });
      }
      if (url === '/api/v1/auth/refresh') return jsonResponse({}, 401);
      return jsonResponse({}, 404);
    }),
  );
}

/** EventSource giả lập: ghi lại mọi instance đã tạo, phát sự kiện theo yêu cầu của test. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState = FakeEventSource.OPEN;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Phát một sự kiện `unread-count` như server đẩy xuống stream. */
  emitUnread(unread: number): void {
    const event = new MessageEvent('unread-count', { data: JSON.stringify({ unread }) });
    for (const listener of this.listeners.get('unread-count') ?? []) listener(event);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function stubEventSource() {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  return FakeEventSource;
}

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        element: <App />,
        children: [
          {
            element: <Shell />,
            children: [
              { index: true, element: <div data-testid="home-probe" /> },
              { path: 'notifications', element: <div data-testid="notifications-probe" /> },
            ],
          },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

function seedTokens() {
  localStorage.setItem('lms.accessToken', 'access-test');
  localStorage.setItem('lms.refreshToken', 'refresh-test');
}

beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  queryClient.clear();
});

describe('số thông báo chưa đọc trên sidebar', () => {
  it('hiện huy hiệu đúng số chưa đọc cạnh mục Thông báo khi còn tin chưa đọc', async () => {
    seedTokens();
    stubFetch(3);
    renderShell();

    const item = await screen.findByRole('link', { name: /Thông báo/ });
    // Huy hiệu nằm trong chính mục điều hướng và mang đúng số từ API.
    expect(await within(item).findByText('3')).toBeInTheDocument();
  });

  it('không hiện huy hiệu khi không còn thông báo chưa đọc', async () => {
    seedTokens();
    stubFetch(0);
    renderShell();

    const item = await screen.findByRole('link', { name: 'Thông báo' });
    // Mục vẫn điều hướng bình thường, nhãn trơn không kèm số đếm nào.
    expect(item).toHaveAttribute('href', '/notifications');
    expect(item.textContent?.trim()).toBe('Thông báo');
  });

  it('header không còn nút chuông và không có bộ chọn ngôn ngữ', async () => {
    seedTokens();
    stubFetch(3);
    renderShell();

    // Sidebar đã vẽ (mục Thông báo kèm số) nhưng không tồn tại nút
    // chuông nào — trước đây chuông là button mang nhãn "Thông báo".
    await screen.findByRole('link', { name: /Thông báo/ });
    expect(screen.queryByRole('button', { name: 'Thông báo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('sự kiện stream SSE cập nhật huy hiệu ngay mà không gọi lại REST', async () => {
    seedTokens();
    const counter = { unreadCalls: 0 };
    stubFetch(1, counter);
    const EventSourceFake = stubEventSource();
    renderShell();

    const item = await screen.findByRole('link', { name: /Thông báo/ });
    expect(await within(item).findByText('1')).toBeInTheDocument();

    // Stream được mở đúng route, mang access token qua query.
    expect(EventSourceFake.instances).toHaveLength(1);
    const source = EventSourceFake.instances[0]!;
    expect(source.url).toContain('/api/v1/notifications/unread-count/stream');
    expect(source.url).toContain('access_token=access-test');

    // Server đẩy số mới → huy hiệu đổi theo, REST không bị gọi thêm.
    act(() => { source.emitUnread(5); });
    expect(await within(item).findByText('5')).toBeInTheDocument();
    expect(counter.unreadCalls).toBe(1);
  });

  it('không polling: qua 3 phút vẫn chỉ gọi unread-count đúng lần khởi tạo', async () => {
    vi.useFakeTimers();
    const counter = { unreadCalls: 0 };
    try {
      seedTokens();
      stubFetch(2, counter);
      stubEventSource();
      renderShell();

      // Cho các truy vấn khởi tạo chạy xong trong thời gian giả lập.
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(counter.unreadCalls).toBe(1);

      // Ba phút trôi qua: không có lần gọi lặp nào (trước đây là 60 giây/lần).
      await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
      expect(counter.unreadCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
