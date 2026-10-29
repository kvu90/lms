import { act, cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from './root';
import Shell from './shell';
import { queryClient } from '#lib/query-client';
import { baSessionResponse, isGetSessionUrl } from '#test/ba-session';

/**
 * Test cho huy hiệu số conversation chưa đọc ở mục Tin nhắn trên
 * sidebar (lát M1, issue #204): số lấy từ GET /messages/unread-count,
 * trường `conversations` (KHÔNG phải tổng số tin và KHÔNG lẫn trường
 * `notifications` của cùng đáp ứng) — lớn hơn 0 thì hiện huy hiệu cạnh
 * nhãn mục Tin nhắn, bằng 0 thì không hiện. Chiến lược làm tươi của
 * lát này là refetchInterval 30 giây + refetch khi focus cửa sổ
 * (không mở socket ở vỏ app — đánh đổi đã chốt trong hồ sơ audit):
 * test khoá cả hai đầu — số đổi sau một chu kỳ refetch và endpoint
 * được gọi lại đúng chu kỳ, không gọi dày hơn. Dựng đúng cây thật
 * (App → Shell → AppSidebar) như sidebar-notification-count.spec.
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

/**
 * Stub fetch cho vỏ app; `counts` là dãy số conversation chưa đọc mà
 * endpoint trả theo từng lần gọi (lần cuối lặp lại), counter ghi số
 * lần endpoint được gọi để khoá chu kỳ làm tươi.
 */
function stubFetch(counts: number[], counter?: { messageUnreadCalls: number }) {
  let served = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (isGetSessionUrl(url)) return baSessionResponse({ id: ADMIN_ID, username: 'admin', email: 'admin@example.com' });
      if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
      if (url === '/api/v1/users/me/capabilities') return jsonResponse(ACCESS);
      if (url === '/api/v1/courses') return jsonResponse([]);
      if (url === '/api/v1/guardian-links/mine/students') return jsonResponse([]);
      if (url === '/api/v1/notifications/unread-count') return jsonResponse({ unread: 0 });
      if (url === '/api/v1/messages/unread-count') {
        if (counter) counter.messageUnreadCalls += 1;
        const conversations = counts[Math.min(served, counts.length - 1)]!;
        served += 1;
        // Trường notifications cố ý khác hẳn để khoá việc badge chỉ
        // được lấy trường conversations.
        return jsonResponse({ conversations, notifications: 99 });
      }
      if (url === '/api/v1/auth/refresh') return jsonResponse({}, 401);
      return jsonResponse({}, 404);
    }),
  );
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
              { path: 'messages', element: <div data-testid="messages-probe" /> },
            ],
          },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
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

describe('số conversation chưa đọc trên sidebar (M1)', () => {
  it('hiện huy hiệu đúng số conversation chưa đọc cạnh mục Tin nhắn', async () => {
    stubFetch([4]);
    renderShell();

    const item = await screen.findByRole('link', { name: /Tin nhắn/ });
    // Huy hiệu nằm trong chính mục Tin nhắn và mang số của trường
    // conversations (4), không phải trường notifications (99).
    expect(await within(item).findByText('4')).toBeInTheDocument();
  });

  it('không hiện huy hiệu khi không còn conversation chưa đọc', async () => {
    stubFetch([0]);
    renderShell();

    const item = await screen.findByRole('link', { name: 'Tin nhắn' });
    expect(item).toHaveAttribute('href', '/messages');
    expect(item.textContent?.trim()).toBe('Tin nhắn');
  });

  it('cập nhật huy hiệu sau chu kỳ refetch 30 giây, không gọi endpoint dày hơn chu kỳ', async () => {
    vi.useFakeTimers();
    const counter = { messageUnreadCalls: 0 };
    try {
      stubFetch([2, 5], counter);
      renderShell();

      // Nhích thời gian giả từng bước nhỏ tới khi huy hiệu đầu tiên
      // hiện (mọi chờ đợi đều qua advanceTimersByTimeAsync — findBy/
      // waitFor của Testing Library treo dưới fake timers). Tổng
      // thời gian chờ bị chặn ở 10 giây giả, xa dưới chu kỳ 30 giây
      // nên chưa thể chạm lần refetch nào.
      const messageItem = () => screen.queryByRole('link', { name: /Tin nhắn/ });
      const badgeText = (text: string) => {
        const item = messageItem();
        return item ? within(item).queryByText(text) : null;
      };
      for (let i = 0; i < 100 && !badgeText('2'); i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      }
      expect(counter.messageUnreadCalls).toBe(1);
      expect(badgeText('2')).not.toBeNull();

      // Chưa hết chu kỳ 30 giây: không gọi lại, số giữ nguyên.
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(counter.messageUnreadCalls).toBe(1);
      expect(badgeText('2')).not.toBeNull();

      // Hết chu kỳ: gọi lại đúng một lần và huy hiệu đổi theo số mới.
      for (let i = 0; i < 200 && counter.messageUnreadCalls < 2; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      }
      expect(counter.messageUnreadCalls).toBe(2);
      for (let i = 0; i < 50 && !badgeText('5'); i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      }
      expect(badgeText('5')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
