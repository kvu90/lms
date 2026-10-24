import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminCurriculumPage, AdminCurriculumTreePage } from './admin-curriculum';

/**
 * Spec trang quản trị chương trình (K0a): danh sách môn thu/mở ra
 * chương trình theo khối, panel nạp dữ liệu chuẩn gọi đúng POST
 * /curriculum/program-import, màn cây hiện node + YCCĐ kèm truy vết
 * nguồn, và 403 từ API hiện thông báo không có quyền thay vì sập trang.
 */

const SUBJECT = { id: 'subj-toan', contextId: 'ctx-sys', name: 'Toán', slug: 'toan', position: 1 };
const STATUS = [
  {
    datasetKey: 'toan',
    subjectName: 'Toán',
    slug: 'toan',
    grades: [1, 2, 3, 4, 5],
    totalRecords: 300,
    importedRecords: 300,
    subjectId: 'subj-toan',
    lastImportedAt: '2026-10-24T00:00:00.000Z',
  },
];
const TREE = {
  curriculum: { id: 'curr-5', subjectId: 'subj-toan', grade: 5 },
  subject: SUBJECT,
  nodes: [
    {
      id: 'node-strand',
      curriculumId: 'curr-5',
      parentId: null,
      title: 'Số và phép tính',
      kind: 'strand',
      position: 1,
      durationPeriods: null,
      durationPercent: null,
      outcomes: [],
      children: [
        {
          id: 'node-lesson',
          curriculumId: 'curr-5',
          parentId: 'node-strand',
          title: 'Đọc, viết được các số có nhiều chữ số',
          kind: 'lesson',
          position: 1,
          durationPeriods: null,
          durationPercent: null,
          outcomes: [
            {
              id: 'outcome-1',
              content: 'Đọc, viết được các số có nhiều chữ số.',
              position: 1,
              sourceKind: 'program',
              sourceRef: 'Thông tư 32/2018/TT-BGDĐT · trang 5 · TOAN-0001',
              derivedFromId: null,
            },
          ],
          children: [],
        },
      ],
    },
  ],
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub fetch ghi lại lời gọi; `forbidden` mô phỏng người không có curriculum:manage (403 mọi lời gọi curriculum). */
function stubFetch(calls: RecordedCall[], forbidden = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (forbidden && url.includes('/curriculum/')) {
        return respond(
          { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Thiếu capability', code: 'access.capability_denied' },
          403,
        );
      }
      if (url === '/api/v1/curriculum/program-import' && method === 'GET') return respond(STATUS);
      if (url === '/api/v1/curriculum/program-import' && method === 'POST') {
        return respond({ datasetKey: 'toan', subjectId: 'subj-toan', created: 0, updated: 0, skipped: 300, outcomesWritten: 0, totalRecords: 300 });
      }
      if (url === '/api/v1/access/contexts') return respond([{ id: 'ctx-sys', contextLevel: 10 }]);
      if (url.startsWith('/api/v1/curriculum/subjects?')) return respond([SUBJECT]);
      if (url.startsWith('/api/v1/curriculum/curricula?')) return respond([{ id: 'curr-5', subjectId: 'subj-toan', grade: 5 }]);
      if (url === '/api/v1/curriculum/curricula/curr-5/tree') return respond(TREE);
      return respond({}, 404);
    }),
  );
}

function renderList() {
  const router = createMemoryRouter([{ path: '/admin/curriculum', element: <AdminCurriculumPage /> }], {
    initialEntries: ['/admin/curriculum'],
  });
  render(<RouterProvider router={router} />);
}

function renderTree() {
  const router = createMemoryRouter(
    [{ path: '/admin/curriculum/curricula/:curriculumId', element: <AdminCurriculumTreePage /> }],
    { initialEntries: ['/admin/curriculum/curricula/curr-5'] },
  );
  render(<RouterProvider router={router} />);
}

describe('Admin curriculum pages', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders dataset status and subjects; expanding a subject lists its curricula', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderList();

    expect(await screen.findByText('đã nạp 300/300 bản ghi')).toBeInTheDocument();
    const toggle = await screen.findByRole('button', { name: /Toán/ });
    await userEvent.click(toggle);

    expect(await screen.findByText('Lớp 5')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cây chương trình' })).toHaveAttribute(
      'href',
      '/admin/curriculum/curricula/curr-5',
    );
    expect(calls.some((c) => c.url.startsWith('/api/v1/curriculum/curricula?subjectId=subj-toan'))).toBe(true);
  });

  it('imports a dataset through POST /curriculum/program-import and shows the result counts', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderList();

    await userEvent.click(await screen.findByRole('button', { name: 'Nạp dữ liệu' }));

    expect(await screen.findByText(/mới 0 · cập nhật 0 · bỏ qua 300/)).toBeInTheDocument();
    const post = calls.find((c) => c.url === '/api/v1/curriculum/program-import' && c.method === 'POST');
    expect(post?.body).toEqual({ datasetKey: 'toan' });
  });

  it('shows the forbidden notice instead of the admin content when the API answers 403', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, true);
    renderList();

    expect(await screen.findByText(/không có quyền quản trị chương trình/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nạp dữ liệu' })).not.toBeInTheDocument();
  });

  it('renders the tree with outcomes and their source trace', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderTree();

    expect(await screen.findByText('Số và phép tính')).toBeInTheDocument();
    expect(await screen.findByText('Đọc, viết được các số có nhiều chữ số.')).toBeInTheDocument();
    expect(screen.getByText(/Nguồn: Thông tư 32\/2018\/TT-BGDĐT/)).toBeInTheDocument();
  });
});
