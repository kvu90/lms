import { cleanup, render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { TestProviders } from '#test/providers';
import { PermissionsProvider } from '#lib/permissions';
import { AdminRolesPage } from './admin-roles';
import { AdminUsersPage } from './admin-users';
import { BadgesPage } from './badges';
import { CalendarPage } from './calendar';
import { CourseAdminPage } from './course-admin';
import { CoursesPage } from './courses';
import { GradebookPage } from './grades';
import { LearningPlanPage } from './learning-plan';
import { PrivacyPage, ReportsPage, TokensPage } from './platform';
import { QuestionsPage } from './questions';

/**
 * Spec bề rộng Lát 3 + Lát 4 (UI/UX, issue #42, hồ sơ §3.2): mỗi trang
 * phải đứng đúng bậc PageShell đã chốt — medium (max-w-5xl), wide
 * (max-w-7xl), full (không cap). Chỉ khẳng định khung trang trên cây
 * DOM thật; hành vi từng trang đã có spec riêng. Stub fetch trả mảng
 * rỗng cho mọi GET: các trang rơi vào trạng thái rỗng/lỗi nhưng khung
 * PageShell + PageHeader vẫn dựng ngay từ đầu.
 */
const WIDTH_CLASSES: Record<string, string> = {
  medium: 'max-w-5xl',
  wide: 'max-w-7xl',
  full: 'w-full',
};

function expectShellWidth(container: HTMLElement, width: 'medium' | 'wide' | 'full') {
  const shell = container.querySelector('[data-slot="page-shell"]');
  expect(shell).not.toBeNull();
  expect(shell).toHaveAttribute('data-width', width);
  const inner = shell!.firstElementChild;
  expect(inner).not.toBeNull();
  expect(inner!.className).toContain(WIDTH_CLASSES[width]);
  expect(container.querySelector('[data-slot="page-header"]')).not.toBeNull();
}

function stubEmptyFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
}

function renderPage(element: ReactElement, path = '/', routePath?: string) {
  const router = createMemoryRouter([{ path: routePath ?? path, element }], { initialEntries: [path] });
  return render(
    <TestProviders>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </TestProviders>,
  );
}

describe('UI Lát 3 + 4 — bậc bề rộng PageShell theo hồ sơ §3.2', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it.each([
    ['badges', <BadgesPage key="b" />],
    ['tokens', <TokensPage key="t" />],
    ['privacy', <PrivacyPage key="p" />],
  ])('medium: %s', (_name, element) => {
    stubEmptyFetch();
    const { container } = renderPage(element);
    expectShellWidth(container, 'medium');
  });

  it.each([
    ['courses', <CoursesPage key="c" />],
    ['learning-plan', <LearningPlanPage key="l" />],
    ['reports', <ReportsPage key="r" />],
  ])('wide: %s', (_name, element) => {
    stubEmptyFetch();
    const { container } = renderPage(element);
    expectShellWidth(container, 'wide');
  });

  it.each([
    ['calendar', <CalendarPage key="cal" />, '/calendar', '/calendar'],
    ['admin-roles', <AdminRolesPage key="ar" />, '/admin/roles', '/admin/roles'],
    ['admin-users', <AdminUsersPage key="au" />, '/admin/users', '/admin/users'],
  ])('full: %s', (_name, element, path, routePath) => {
    stubEmptyFetch();
    const { container } = renderPage(element, path, routePath);
    expectShellWidth(container, 'full');
  });

  it('full: questions (dựng shell sau khi cổng capability mở)', async () => {
    // Trang ngân hàng câu hỏi gác theo capability (issue #55): chưa nạp
    // xong quyền thì hiện trạng thái chờ, vai không có quyền thì hiện
    // trạng thái cấm — PageShell chỉ dựng khi cổng mở. Stub cấp site
    // admin như spec riêng của trang rồi chờ shell xuất hiện.
    localStorage.setItem('lms.accessToken', 'test-token');
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/users/me')
          return json({
            id: '01900000-0000-7000-8000-0000000000a9',
            username: 'teacher1',
            firstName: 'Lan Anh',
            lastName: 'Nguyễn',
            email: 'teacher1@example.com',
            suspended: false,
            deleted: false,
            isGuest: false,
            forcePasswordChange: false,
            lastLogin: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            customFields: [],
          });
        if (url === '/api/v1/users/me/capabilities')
          return json({ userId: '01900000-0000-7000-8000-0000000000a9', isSiteAdmin: true, assignments: [], contexts: [] });
        return json([]);
      }),
    );
    const { container } = renderPage(<QuestionsPage />, '/questions', '/questions');
    await waitFor(() => expectShellWidth(container, 'full'));
  });

  it('full: grades theo khoá', () => {
    stubEmptyFetch();
    const { container } = renderPage(
      <GradebookPage />,
      '/courses/course-1/grades',
      '/courses/:id/grades',
    );
    expectShellWidth(container, 'full');
  });

  it('full: quản trị khoá học', () => {
    stubEmptyFetch();
    const { container } = renderPage(
      <CourseAdminPage />,
      '/courses/course-1/admin',
      '/courses/:id/admin',
    );
    expectShellWidth(container, 'full');
  });
});
