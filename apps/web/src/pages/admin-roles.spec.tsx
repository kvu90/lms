import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { AdminRolesPage } from './admin-roles';

/**
 * Spec F-01 cho trang vai trò: ba danh sách (vai / capability / context)
 * là ba query TanStack qua khoá factory, và mutation gán vai phải làm
 * mới các truy vấn access (trước đây POST xong im lặng, không tải lại).
 */
const ROLE_ID = '01900000-0000-7000-8000-0000000000r1'.replace('r', 'b');
const CAP_ID = '01900000-0000-7000-8000-0000000000c1';
const SYSTEM_CONTEXT_ID = '01900000-0000-7000-8000-000000000010';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(calls: RecordedCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/access/roles')
        return respond([
          { id: ROLE_ID, name: 'Giáo viên', shortName: 'editingteacher', description: '', archetype: 'editingteacher' },
        ]);
      if (url === '/api/v1/access/capabilities')
        return respond([{ id: CAP_ID, name: 'course:view', capType: 'read', contextLevel: 50, component: 'core' }]);
      if (url === '/api/v1/access/contexts')
        return respond([{ id: SYSTEM_CONTEXT_ID, contextLevel: 10, instanceId: '0', path: '/1' }]);
      if (url === '/api/v1/access/assignments' && method === 'POST') return respond({});
      if (url === `/api/v1/access/roles/${ROLE_ID}/capabilities`) return respond([]);
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/admin/roles', element: <AdminRolesPage /> }], {
    initialEntries: ['/admin/roles'],
  });
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

describe('Admin roles page — TanStack queries + assignment invalidation (F-01)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('loads roles, capabilities and contexts through the access queries', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    expect(await screen.findByText('Giáo viên')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/access/roles')).toBe(true);
    expect(calls.some((c) => c.url === '/api/v1/access/capabilities')).toBe(true);
    expect(calls.some((c) => c.url === '/api/v1/access/contexts')).toBe(true);
  });

  it('assignment POSTs to /access/assignments and invalidates the access queries', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByText('Giáo viên');
    const roleLoadsBefore = calls.filter((c) => c.url === '/api/v1/access/roles' && c.method === 'GET').length;
    await userEvent.type(screen.getByLabelText('ID người dùng'), '123');
    await userEvent.click(screen.getByRole('button', { name: 'Gán vai trò' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/access/assignments' && c.method === 'POST')).toBe(true),
    );
    const post = calls.find((c) => c.url === '/api/v1/access/assignments');
    expect(post?.body).toMatchObject({ userId: '123', contextId: SYSTEM_CONTEXT_ID });
    // Sau đột biến, truy vấn access được làm mới (danh sách vai tải lại).
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/v1/access/roles' && c.method === 'GET').length).toBeGreaterThan(
        roleLoadsBefore,
      ),
    );
  });
});
