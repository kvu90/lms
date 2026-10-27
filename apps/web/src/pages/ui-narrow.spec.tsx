import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { HealthPage } from './health';
import { NotificationsPage } from './notifications';
import { SearchPage } from './platform-search';
import { QuizAttemptPage } from './quiz-attempt';

/**
 * Spec Lát 2 (UI/UX, issue #42): các màn narrow phải đứng trong cột
 * 768px của PageShell (data-width="narrow", lớp trong có max-w-3xl +
 * mx-auto), tiêu đề qua PageHeader (h1), và các luồng chính vẫn chạy.
 * Kiểm trên cây DOM thật (jsdom) theo đúng cách đội review đóng vai
 * người dùng.
 */
function expectNarrowShell(container: HTMLElement) {
  const shell = container.querySelector('[data-slot="page-shell"]');
  expect(shell).not.toBeNull();
  expect(shell).toHaveAttribute('data-width', 'narrow');
  const inner = shell!.firstElementChild;
  expect(inner).not.toBeNull();
  expect(inner!.className).toContain('max-w-3xl');
  expect(inner!.className).toContain('mx-auto');
}

function stubJsonFetch(handler: (url: string) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = handler(url);
      if (body === undefined) {
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('UI Lát 2 — màn narrow trong PageShell 768px', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('health: nội dung trong cột 768, tiêu đề qua PageHeader, dữ liệu thật hiện ra', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'ok',
          timestamp: '2026-10-24T00:00:00.000Z',
          checks: { database: 'up', redis: 'up' },
        }),
      }),
    );
    const { container } = render(
      <MemoryRouter>
        <HealthPage />
      </MemoryRouter>,
    );
    expectNarrowShell(container);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trạng thái API');
    expect(await screen.findByText('Cơ sở dữ liệu')).toBeInTheDocument();
  });

  it('health lỗi tải: hiện Alert destructive thay chữ trần', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { container } = render(
      <MemoryRouter>
        <HealthPage />
      </MemoryRouter>,
    );
    expectNarrowShell(container);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Không tải được trạng thái');
  });

  it('search: tìm được kết quả và trạng thái rỗng là Empty', async () => {
    stubJsonFetch((url) => {
      if (url.includes('/api/v1/search')) {
        return url.includes('q=xyz')
          ? []
          : [{ id: '1', area: 'course', itemId: '7', title: 'Khoá mẫu', content: 'Nội dung mẫu' }];
      }
      return undefined;
    });
    // SearchPage đọc ảnh chụp quyền (đích của kết quả `users` phụ
    // thuộc quyền người tìm) — bọc TestProviders như cây root thật.
    const { container } = render(
      <TestProviders>
        <MemoryRouter>
          <SearchPage />
        </MemoryRouter>
      </TestProviders>,
    );
    expectNarrowShell(container);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tìm kiếm toàn cục');
    await userEvent.type(screen.getByLabelText('Từ khoá tìm kiếm'), 'mẫu');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm kiếm' }));
    expect(await screen.findByText('Khoá mẫu')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Từ khoá tìm kiếm'));
    await userEvent.type(screen.getByLabelText('Từ khoá tìm kiếm'), 'xyz');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm kiếm' }));
    await waitFor(() => expect(container.querySelector('[data-slot="empty"]')).not.toBeNull());
    expect(screen.getByText('Không có kết quả nào bạn được phép xem.')).toBeInTheDocument();
  });

  it('notifications: nút hành động chính nằm ở PageHeader, rỗng hiện Empty', async () => {
    stubJsonFetch((url) => {
      if (url.startsWith('/api/v1/notifications?')) return { items: [], nextCursor: null };
      if (url === '/api/v1/messages/preferences') return [];
      return undefined;
    });
    const { container } = render(
      <TestProviders>
        <MemoryRouter>
          <NotificationsPage />
        </MemoryRouter>
      </TestProviders>,
    );
    expectNarrowShell(container);
    const header = container.querySelector('[data-slot="page-header"]');
    expect(header).not.toBeNull();
    expect(header!.querySelector('button')).toHaveTextContent('Đánh dấu đã đọc tất cả');
    await waitFor(() => expect(container.querySelector('[data-slot="empty"]')).not.toBeNull());
    expect(screen.getByText('Chưa có thông báo nào.')).toBeInTheDocument();
  });

  it('quiz-attempt lỗi tải: Alert trong cột 768', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } })),
    );
    const router = createMemoryRouter([{ path: '/quiz-attempts/:attemptId', element: <QuizAttemptPage /> }], {
      initialEntries: ['/quiz-attempts/att-1'],
    });
    // Trang làm bài đã chuyển sang khuôn TanStack Query (F-01 của
    // #133) nên render phải có QueryClientProvider như mọi spec khác.
    const { container } = render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Không thể tải lượt làm.');
    expectNarrowShell(container);
  });
});
