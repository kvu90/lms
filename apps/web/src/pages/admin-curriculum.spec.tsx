import { cleanup, render, screen, within } from '@testing-library/react';
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

function lessonNode(id: string, parentId: string, title: string, position: number, outcomeTexts: string[]) {
  return {
    id,
    curriculumId: 'curr-5',
    parentId,
    title,
    kind: 'lesson',
    position,
    durationPeriods: null,
    durationPercent: null,
    outcomes: outcomeTexts.map((content, i) => ({
      id: `${id}-outcome-${i + 1}`,
      content,
      position: i + 1,
      sourceKind: 'program',
      sourceRef: 'Thông tư 32/2018/TT-BGDĐT · trang 5 · TOAN-0001',
      derivedFromId: null,
    })),
    children: [],
  };
}

/** Cây lớn cho ca phân trang: mạch A 12 dòng + mạch B 3 dòng = 15 dòng Nội dung (trang chứa 10 dòng). */
const BIG_TREE = {
  curriculum: { id: 'curr-5', subjectId: 'subj-toan', grade: 5 },
  subject: SUBJECT,
  nodes: [
    {
      id: 'strand-a',
      curriculumId: 'curr-5',
      parentId: null,
      title: 'Số và phép tính',
      kind: 'strand',
      position: 1,
      durationPeriods: null,
      durationPercent: null,
      outcomes: [],
      children: Array.from({ length: 12 }, (_, i) =>
        lessonNode(`lesson-a${i + 1}`, 'strand-a', `Nội dung A${i + 1}`, i + 1, [
          `Yêu cầu cần đạt A${i + 1}.`,
          ...(i === 0 ? ['Yêu cầu cần đạt A1 bổ sung.'] : []),
        ]),
      ),
    },
    {
      id: 'strand-b',
      curriculumId: 'curr-5',
      parentId: null,
      title: 'Hình học và đo lường',
      kind: 'strand',
      position: 2,
      durationPeriods: null,
      durationPercent: null,
      outcomes: [],
      children: Array.from({ length: 3 }, (_, i) =>
        lessonNode(`lesson-b${i + 1}`, 'strand-b', `Nội dung B${i + 1}`, i + 1, [`Yêu cầu cần đạt B${i + 1}.`]),
      ),
    },
  ],
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub fetch ghi lại lời gọi; `forbidden` mô phỏng người không có curriculum:manage (403 mọi lời gọi curriculum). */
function stubFetch(calls: RecordedCall[], forbidden = false, tree: unknown = TREE) {
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
        return respond({ datasetKey: 'toan', subjectId: 'subj-toan', created: 0, updated: 0, skipped: 300, outcomesWritten: 0, totalRecords: 300, orphanedNodes: 0, orphanedOutcomes: 0 });
      }
      if (url === '/api/v1/access/contexts') return respond([{ id: 'ctx-sys', contextLevel: 10 }]);
      if (url.startsWith('/api/v1/curriculum/subjects?')) return respond([SUBJECT]);
      if (url.startsWith('/api/v1/curriculum/curricula?')) return respond([{ id: 'curr-5', subjectId: 'subj-toan', grade: 5 }]);
      if (url === '/api/v1/curriculum/curricula/curr-5/tree') return respond(tree);
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

    await userEvent.click(await screen.findByRole('button', { name: 'Đồng bộ lại' }));

    expect(await screen.findByText(/mới 0 · cập nhật 0 · bỏ qua 300/)).toBeInTheDocument();
    const post = calls.find((c) => c.url === '/api/v1/curriculum/program-import' && c.method === 'POST');
    expect(post?.body).toEqual({ datasetKey: 'toan' });
  });

  it('shows the forbidden notice instead of the admin content when the API answers 403', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, true);
    renderList();

    expect(await screen.findByText(/không có quyền quản trị chương trình/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Đồng bộ lại' })).not.toBeInTheDocument();
  });

  it('renders the tree with outcomes and their source trace', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderTree();

    expect(await screen.findByText('Số và phép tính')).toBeInTheDocument();
    expect(await screen.findByText('Đọc, viết được các số có nhiều chữ số.')).toBeInTheDocument();
    expect(screen.getByText(/Nguồn: Thông tư 32\/2018\/TT-BGDĐT/)).toBeInTheDocument();
  });

  it('presents the programme the Ministry way: strand groups a Nội dung | Yêu cầu cần đạt table', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderTree();

    // Bảng mẫu Bộ: cột Nội dung | Yêu cầu cần đạt, mạch là tiêu đề nhóm của bảng.
    expect(await screen.findByRole('columnheader', { name: 'Nội dung' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Yêu cầu cần đạt' })).toBeInTheDocument();
    expect(screen.getByText('Số và phép tính')).toBeInTheDocument();
    // Nội dung của bài nằm ở cột Nội dung, YCCĐ nguyên văn ở cột YCCĐ của cùng dòng.
    const row = screen.getByText('Đọc, viết được các số có nhiều chữ số').closest('tr');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Đọc, viết được các số có nhiều chữ số.');
  });

  it('paginates the tree: one page of content rows at a time, next page shows the following rows', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, false, BIG_TREE);
    renderTree();

    // Trang 1: đúng 10 dòng đầu của mạch A; dòng 11 và mạch B chưa hiện.
    expect(await screen.findByText('Nội dung A1')).toBeInTheDocument();
    expect(screen.getByText('Nội dung A10')).toBeInTheDocument();
    expect(screen.queryByText('Nội dung A11')).not.toBeInTheDocument();
    expect(screen.queryByText('Hình học và đo lường')).not.toBeInTheDocument();
    expect(screen.getByText('Trang 1 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trang trước' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' }));

    // Trang 2: phần còn của mạch A + toàn bộ mạch B; dòng của trang 1 không còn.
    expect(await screen.findByText('Nội dung A11')).toBeInTheDocument();
    expect(screen.getByText('Nội dung A12')).toBeInTheDocument();
    expect(screen.getByText('Nội dung B3')).toBeInTheDocument();
    expect(screen.queryByText('Nội dung A1')).not.toBeInTheDocument();
    expect(screen.getByText('Trang 2 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trang sau' })).toBeDisabled();
    // Chuyển trang là việc phía client: cây chỉ được tải đúng một lần.
    expect(calls.filter((c) => c.url === '/api/v1/curriculum/curricula/curr-5/tree')).toHaveLength(1);
  });

  it('repeats a strand heading with (tiếp) when the strand spans pages, and row actions still work on page 2', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, false, BIG_TREE);
    renderTree();

    expect(await screen.findByText('Nội dung A1')).toBeInTheDocument();
    expect(screen.queryByText('(tiếp)')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' }));

    // Mạch A bắt đầu ở trang 1, sang trang 2 phải lặp lại tiêu đề kèm dấu (tiếp) như văn bản in.
    expect(await screen.findByText('(tiếp)')).toBeInTheDocument();
    expect(screen.getByText('Số và phép tính')).toBeInTheDocument();
    expect(screen.getByText('Hình học và đo lường')).toBeInTheDocument();
    // Thao tác tại dòng ở trang 2 còn nguyên: Sửa node trỏ đúng màn sửa của node đó.
    const row = screen.getByText('Nội dung A11').closest('tr');
    expect(row).not.toBeNull();
    const editLinks = within(row!).getAllByRole('link', { name: 'Sửa' });
    expect(editLinks[0]).toHaveAttribute('href', '/admin/curriculum/nodes/lesson-a11/edit');
  });

  it('renders every outcome as its own dash-bulleted item in the outcomes cell', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, false, BIG_TREE);
    renderTree();

    const row = (await screen.findByText('Nội dung A1')).closest('tr');
    expect(row).not.toBeNull();
    const items = within(row!).getAllByRole('listitem');
    // Hai YCCĐ của dòng A1 = hai mục riêng, mỗi mục mở đầu bằng gạch đầu dòng như nguyên văn của Bộ.
    const outcomeItems = items.filter((li) => li.textContent?.includes('Yêu cầu cần đạt A1'));
    expect(outcomeItems).toHaveLength(2);
    for (const li of outcomeItems) {
      expect(li.textContent?.trimStart().startsWith('–')).toBe(true);
    }
    expect(outcomeItems[0]!.textContent).toContain('Yêu cầu cần đạt A1.');
    expect(outcomeItems[1]!.textContent).toContain('Yêu cầu cần đạt A1 bổ sung.');
  });
});
