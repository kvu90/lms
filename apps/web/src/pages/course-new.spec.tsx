import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { CourseNewPage } from './course-new';

/**
 * Spec wizard tạo khoá (K1 — issue #68): năm đường tạo khoá trên màn
 * riêng `/courses/new`. Kiểm hai đường chính bằng endpoint thật:
 * nhân bản khoá có sẵn (chọn nguồn → tên/mã điền sẵn → tạo, chuyển
 * thẳng tới builder của bản sao) và khoá trắng; đường khung SGK phải
 * hiển thị trạng thái chờ nối K0b một cách trung thực.
 */
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';
const SOURCE_ID = '01900000-0000-7000-8000-000000000010';
const COPY_ID = '01900000-0000-7000-8000-000000000099';
const BLANK_ID = '01900000-0000-7000-8000-000000000098';

const SOURCE = {
  id: SOURCE_ID,
  category: CATEGORY_ID,
  fullName: 'Toán 10 — Học kỳ 1',
  shortName: 'TOAN10-HK1',
  idNumber: '',
  summary: '',
  format: 'topics',
  visible: true,
  isTemplate: false,
  startDate: '2026-09-05',
  endDate: null,
  groupMode: 0,
  enableCompletion: true,
};

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
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/courses/categories/tree')
        return respond([{ ...SOURCE, id: CATEGORY_ID, name: 'THPT', children: [] }]);
      if (url === '/api/v1/courses' && method === 'GET') return respond([SOURCE]);
      if (url === '/api/v1/courses/templates') return respond([]);
      if (url === '/api/v1/access/contexts') return respond([]);
      if (url === `/api/v1/courses/${SOURCE_ID}/duplicate` && method === 'POST')
        return respond({ ...SOURCE, id: COPY_ID, visible: false }, 201);
      if (url === '/api/v1/courses' && method === 'POST') return respond({ ...SOURCE, id: BLANK_ID }, 201);
      return respond({}, 404);
    }),
  );
}

function renderWizard() {
  localStorage.setItem('lms.accessToken', 'test-token');
  const router = createMemoryRouter(
    [
      { path: '/courses/new', element: <CourseNewPage /> },
      { path: '/courses/:id/builder', element: <p>builder-page</p> },
    ],
    { initialEntries: ['/courses/new'] },
  );
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

describe('Wizard tạo khoá K1', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('nhân bản khoá: chọn nguồn thì tên/mã được điền sẵn, tạo gọi POST duplicate kèm mốc bắt đầu mới và vào thẳng builder', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderWizard();

    await userEvent.click(await screen.findByTestId('wizard-path-duplicate'));
    await userEvent.selectOptions(await screen.findByLabelText('Khoá nguồn để nhân bản'), SOURCE_ID);
    // Tên/mã bản sao được điền sẵn từ khoá nguồn — giáo viên không phải gõ lại.
    expect((await screen.findByLabelText('Tên đầy đủ của khoá học') as HTMLInputElement).value).toBe('Toán 10 — Học kỳ 1 (bản sao)');
    expect((screen.getByLabelText('Tên ngắn của khoá học') as HTMLInputElement).value).toBe('TOAN10-HK1-copy');
    await userEvent.type(screen.getByLabelText('Ngày bắt đầu'), '2027-09-06');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo khoá và xây dựng' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${SOURCE_ID}/duplicate` && c.method === 'POST')).toBe(true),
    );
    const call = calls.find((c) => c.url === `/api/v1/courses/${SOURCE_ID}/duplicate`);
    expect(call?.body).toEqual({
      fullName: 'Toán 10 — Học kỳ 1 (bản sao)',
      shortName: 'TOAN10-HK1-copy',
      category: CATEGORY_ID,
      startDate: '2027-09-06',
    });
    expect(await screen.findByText('builder-page')).toBeTruthy();
  });

  it('khoá trắng: điền tên/mã/danh mục rồi POST /courses', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderWizard();

    await userEvent.click(await screen.findByTestId('wizard-path-blank'));
    await userEvent.type(await screen.findByLabelText('Tên đầy đủ của khoá học'), 'Ngữ văn 11');
    await userEvent.type(screen.getByLabelText('Tên ngắn của khoá học'), 'VAN11');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo khoá và xây dựng' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/courses' && c.method === 'POST')).toBe(true));
    const call = calls.find((c) => c.url === '/api/v1/courses' && c.method === 'POST');
    expect(call?.body).toEqual({ fullName: 'Ngữ văn 11', shortName: 'VAN11', category: CATEGORY_ID });
  });

  it('đường khung SGK hiển thị trạng thái chờ nối K0b, không giả vờ có dữ liệu', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderWizard();

    await userEvent.click(await screen.findByTestId('wizard-path-textbook'));
    const panel = await screen.findByTestId('wizard-textbook-panel');
    expect(panel.textContent).toContain('K0b');
  });
});
