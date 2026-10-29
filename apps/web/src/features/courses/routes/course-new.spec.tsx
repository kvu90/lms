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
const CLASS_ID = '01900000-0000-7000-8000-0000000000c1';
const NEW_CLASS_ID = '01900000-0000-7000-8000-0000000000c2';

/** Lớp có sẵn của GV (CLASS-1): wizard chọn sẵn lớp đang hoạt động đầu tiên cho khoá mới. */
const MY_CLASS = {
  id: CLASS_ID,
  tenantId: '01900000-0000-7000-8000-0000000000a1',
  name: 'Lớp 10A1',
  code: null,
  schoolYear: '2026-2027',
  ownerId: '01900000-0000-7000-8000-0000000000b1',
  cohortId: '01900000-0000-7000-8000-0000000000d1',
  allowSelfReport: false,
  joinCode: null,
  joinAutoApprove: false,
  onLeave: 'suspend',
  status: 'active',
  description: '',
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
};

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

function stubFetch(calls: RecordedCall[], options: { withClasses?: boolean } = {}) {
  const withClasses = options.withClasses ?? true;
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
      if (url === '/api/v1/classes' && method === 'GET') return respond(withClasses ? [MY_CLASS] : []);
      if (url === '/api/v1/classes' && method === 'POST') return respond({ ...MY_CLASS, id: NEW_CLASS_ID, name: 'Lớp mới' }, 201);
      if (url === `/api/v1/courses/${SOURCE_ID}/copy` && method === 'POST')
        return respond({ ...SOURCE, id: COPY_ID, visible: false }, 201);
      if (url === '/api/v1/courses' && method === 'POST') return respond({ ...SOURCE, id: BLANK_ID }, 201);
      return respond({}, 404);
    }),
  );
}

function renderWizard() {
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

  it('nhân bản khoá: chọn nguồn thì tên/mã được điền sẵn, tạo gọi POST copy kèm mốc bắt đầu mới và vào thẳng builder', async () => {
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
      expect(calls.some((c) => c.url === `/api/v1/courses/${SOURCE_ID}/copy` && c.method === 'POST')).toBe(true),
    );
    const call = calls.find((c) => c.url === `/api/v1/courses/${SOURCE_ID}/copy`);
    expect(call?.body).toEqual({
      fullName: 'Toán 10 — Học kỳ 1 (bản sao)',
      shortName: 'TOAN10-HK1-copy',
      category: CATEGORY_ID,
      startDate: '2027-09-06',
      classId: CLASS_ID,
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
    // CLASS-1: khoá bắt buộc thuộc một lớp — wizard gửi kèm classId của lớp đã chọn sẵn.
    expect(call?.body).toEqual({ fullName: 'Ngữ văn 11', shortName: 'VAN11', category: CATEGORY_ID, classId: CLASS_ID });
  });

  it('GV chưa có lớp nào: wizard chèn bước tạo lớp nội tuyến (1 trường tên) rồi tạo khoá thuộc lớp vừa tạo — không sinh lớp ẩn', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { withClasses: false });
    renderWizard();

    await userEvent.click(await screen.findByTestId('wizard-path-blank'));
    // Không có lớp → ô nhập tên lớp mới hiện ngay trong wizard kèm lời dẫn.
    const classInput = await screen.findByLabelText('Tên lớp mới');
    await userEvent.type(classInput, 'Lớp 11B2');
    await userEvent.type(screen.getByLabelText('Tên đầy đủ của khoá học'), 'Hoá 11');
    await userEvent.type(screen.getByLabelText('Tên ngắn của khoá học'), 'HOA11');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo khoá và xây dựng' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/courses' && c.method === 'POST')).toBe(true));
    const classCall = calls.find((c) => c.url === '/api/v1/classes' && c.method === 'POST');
    expect(classCall?.body).toEqual({ name: 'Lớp 11B2' });
    const courseCall = calls.find((c) => c.url === '/api/v1/courses' && c.method === 'POST');
    expect(courseCall?.body).toEqual({ fullName: 'Hoá 11', shortName: 'HOA11', category: CATEGORY_ID, classId: NEW_CLASS_ID });
  });

  it('đường khung SGK hiển thị trạng thái chờ nối K0b, không giả vờ có dữ liệu', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderWizard();

    await userEvent.click(await screen.findByTestId('wizard-path-book'));
    const panel = await screen.findByTestId('wizard-book-panel');
    expect(panel.textContent).toContain('K0b');
  });
});
