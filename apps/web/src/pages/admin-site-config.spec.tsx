import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteSetting } from '@lms/contracts';
import { AdminSiteConfigPage } from './admin-site-config';

/**
 * Spec trang cấu hình site: render setting từ GET /api/v1/site-config
 * (shape `SiteSetting` của contracts site-config ở branch backend), lưu
 * boolean phải PUT `{ value: true }` tới đúng URL
 * /api/v1/site-config/:component/:name, và Đặt lại phải gửi DELETE tới
 * cùng URL đó.
 */
const SETTINGS: SiteSetting[] = [
  {
    component: 'core',
    name: 'messagingallusers',
    type: 'boolean',
    defaultValue: false,
    value: false,
    source: 'default',
  },
  {
    component: 'core',
    name: 'fullname',
    type: 'string',
    defaultValue: 'LMS',
    value: 'LMS Trường tôi',
    source: 'database',
  },
  { component: 'core', name: 'lang', type: 'enum', defaultValue: 'vi', value: 'vi', source: 'default' },
];

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub fetch ghi lại mọi lời gọi; audit trả rỗng để trang yên tĩnh. */
function stubFetch(calls: RecordedCall[], settings: SiteSetting[] = SETTINGS) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/site-config' && method === 'GET') return respond(settings);
      if (url === '/api/v1/site-config/audit') return respond([]);
      if (url.startsWith('/api/v1/site-config/')) return respond(settings[0]);
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/** Render trang cấu hình site qua router bộ nhớ như các spec khác. */
function renderPage() {
  const router = createMemoryRouter([{ path: '/admin/site-config', element: <AdminSiteConfigPage /> }], {
    initialEntries: ['/admin/site-config'],
  });
  render(<RouterProvider router={router} />);
}

describe('Admin site config page', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders settings from the stub grouped by component with source badges', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    expect(await screen.findByText('messagingallusers')).toBeInTheDocument();
    expect(screen.getByText('fullname')).toBeInTheDocument();
    expect(screen.getByDisplayValue('LMS Trường tôi')).toBeInTheDocument();
    expect(screen.getAllByText('mặc định').length).toBeGreaterThan(0);
    expect(screen.getByText('đã ghi đè')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/site-config' && c.method === 'GET')).toBe(true);
  });

  it('saves a boolean via PUT { value: true } to the exact setting URL', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    const checkbox = await screen.findByRole('checkbox', { name: 'Giá trị của core/messagingallusers' });
    await userEvent.click(checkbox);
    // Nút Lưu của chính dòng messagingallusers (checkbox radix cũng là
    // button nên chọn theo đúng nhãn "Lưu" trong cùng <li>).
    const row = checkbox.closest('li');
    expect(row).not.toBeNull();
    const saveByText = [...row!.querySelectorAll('button')].find((b) => b.textContent === 'Lưu');
    expect(saveByText).toBeTruthy();
    await userEvent.click(saveByText!);

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/api/v1/site-config/core/messagingallusers');
    expect(put?.body).toEqual({ value: true });
  });

  it('resets an overridden setting via DELETE to the exact setting URL', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    const resetButton = await screen.findByRole('button', { name: 'Đặt lại' });
    await userEvent.click(resetButton);

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe('/api/v1/site-config/core/fullname');
  });
});
