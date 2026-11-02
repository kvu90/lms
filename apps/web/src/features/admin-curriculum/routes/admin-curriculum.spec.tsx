import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminCurriculumPage, AdminCurriculumTreePage } from './admin-curriculum';
import { TestProviders } from '#test/providers';

/**
 * Spec trang quản trị chương trình (K0a): danh sách môn thu/mở ra
 * chương trình theo khối, panel nạp dữ liệu chuẩn gọi đúng POST
 * /curriculum/program-import, màn cây trình bày bảng chương trình
 * bằng Data Table dùng chung (ba cột Mạch / chủ đề — Nội dung — Yêu
 * cầu cần đạt, mỗi YCCĐ một dòng riêng) kèm bộ chọn Môn/Lớp và ô tìm
 * kiếm, và 403 từ API hiện thông báo không có quyền thay vì sập trang.
 */

const SUBJECT = { id: 'subj-toan', contextId: 'ctx-sys', name: 'Toán', slug: 'toan', position: 1 };
const SUBJECT_VAN = { id: 'subj-van', contextId: 'ctx-sys', name: 'Ngữ văn', slug: 'ngu-van', position: 2 };
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

/** Cây Toán lớp 6 cho ca đổi khối: một nội dung nhận diện riêng khác hẳn cây lớp 5. */
const TREE_GRADE6 = {
  curriculum: { id: 'curr-6', subjectId: 'subj-toan', grade: 6 },
  subject: SUBJECT,
  nodes: [
    {
      id: 'node-strand-6',
      curriculumId: 'curr-6',
      parentId: null,
      title: 'Số nguyên',
      kind: 'strand',
      position: 1,
      durationPeriods: null,
      durationPercent: null,
      outcomes: [],
      children: [
        {
          id: 'node-lesson-6',
          curriculumId: 'curr-6',
          parentId: 'node-strand-6',
          title: 'Nội dung lớp 6 duy nhất',
          kind: 'lesson',
          position: 1,
          durationPeriods: null,
          durationPercent: null,
          outcomes: [
            {
              id: 'outcome-6',
              content: 'Nhận biết được số nguyên âm.',
              position: 1,
              sourceKind: 'program',
              sourceRef: null,
              derivedFromId: null,
            },
          ],
          children: [],
        },
      ],
    },
  ],
};

/** Cây Ngữ văn lớp 6 cho ca đổi môn: môn Ngữ văn chỉ có chương trình lớp 6. */
const TREE_VAN = {
  curriculum: { id: 'curr-v6', subjectId: 'subj-van', grade: 6 },
  subject: SUBJECT_VAN,
  nodes: [
    {
      id: 'node-strand-v',
      curriculumId: 'curr-v6',
      parentId: null,
      title: 'Đọc hiểu văn bản',
      kind: 'strand',
      position: 1,
      durationPeriods: null,
      durationPercent: null,
      outcomes: [],
      children: [
        {
          id: 'node-lesson-v',
          curriculumId: 'curr-v6',
          parentId: 'node-strand-v',
          title: 'Nội dung Ngữ văn duy nhất',
          kind: 'lesson',
          position: 1,
          durationPeriods: null,
          durationPercent: null,
          outcomes: [
            {
              id: 'outcome-v',
              content: 'Đọc hiểu được văn bản truyện.',
              position: 1,
              sourceKind: 'program',
              sourceRef: null,
              derivedFromId: null,
            },
          ],
          children: [],
        },
      ],
    },
  ],
};

/** Cây nhỏ hai bài có YCCĐ phân biệt rõ cho ca tìm kiếm. */
const SEARCH_TREE = {
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
          id: 'lesson-add',
          curriculumId: 'curr-5',
          parentId: 'node-strand',
          title: 'Phép cộng số tự nhiên',
          kind: 'lesson',
          position: 1,
          durationPeriods: null,
          durationPercent: null,
          outcomes: [
            {
              id: 'outcome-add',
              content: 'Cộng được hai số tự nhiên.',
              position: 1,
              sourceKind: 'program',
              sourceRef: null,
              derivedFromId: null,
            },
          ],
          children: [],
        },
        {
          id: 'lesson-frac',
          curriculumId: 'curr-5',
          parentId: 'node-strand',
          title: 'Phép nhân phân số',
          kind: 'lesson',
          position: 2,
          durationPeriods: null,
          durationPercent: null,
          outcomes: [
            {
              id: 'outcome-frac',
              content: 'Nhân được hai phân số.',
              position: 1,
              sourceKind: 'program',
              sourceRef: null,
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

/** Cây lớn cho ca phân trang: mạch A 12 bài (bài đầu 2 YCCĐ, còn lại 1) + mạch B 3 bài = 16 dòng YCCĐ. */
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

interface StubOptions {
  /** Mô phỏng người không có curriculum:manage (403 mọi lời gọi curriculum). */
  forbidden?: boolean;
  /** Cây của curr-5 khi không khai `trees` riêng. */
  tree?: unknown;
  /** Danh sách môn trả cho GET /curriculum/subjects (mặc định chỉ Toán). */
  subjects?: unknown[];
  /** Chương trình theo môn cho GET /curriculum/curricula?subjectId= (mặc định Toán chỉ có curr-5). */
  curriculaBySubject?: Record<string, unknown[]>;
  /** Cây theo id chương trình cho GET /curriculum/curricula/:id/tree. */
  trees?: Record<string, unknown>;
}

/** Stub fetch ghi lại lời gọi, trả dữ kiện theo cấu hình của từng ca. */
function stubFetch(calls: RecordedCall[], options: StubOptions = {}) {
  const { forbidden = false, subjects = [SUBJECT] } = options;
  const curriculaBySubject: Record<string, unknown[]> = options.curriculaBySubject ?? {
    'subj-toan': [{ id: 'curr-5', subjectId: 'subj-toan', grade: 5 }],
  };
  const trees: Record<string, unknown> = options.trees ?? { 'curr-5': options.tree ?? TREE };
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
        return respond({ datasetKey: 'toan', subjectId: 'subj-toan', created: 0, updated: 0, skipped: 300, outcomesWritten: 0, totalRecords: 300, orphanedNodes: 0, retiredOutcomes: 0, changeCounts: { textChanged: 0, added: 0, removed: 0, moved: 0, revived: 0, shiftSuspected: 0 }, changes: [], changesOmitted: 0 });
      }
      if (url === '/api/v1/access/contexts') return respond([{ id: 'ctx-sys', contextLevel: 10 }]);
      if (url.startsWith('/api/v1/curriculum/subjects?')) return respond(subjects);
      const treeMatch = /^\/api\/v1\/curriculum\/curricula\/([^/]+)\/tree$/.exec(url);
      if (treeMatch) {
        const found = trees[treeMatch[1]!];
        return found ? respond(found) : respond({}, 404);
      }
      if (url.startsWith('/api/v1/curriculum/curricula?')) {
        const subjectId = new URLSearchParams(url.split('?')[1]).get('subjectId') ?? '';
        return respond(curriculaBySubject[subjectId] ?? []);
      }
      return respond({}, 404);
    }),
  );
}

function renderList() {
  const router = createMemoryRouter([{ path: '/admin/curriculum', element: <AdminCurriculumPage /> }], {
    initialEntries: ['/admin/curriculum'],
  });
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

function renderTree(curriculumId = 'curr-5') {
  const router = createMemoryRouter(
    [{ path: '/admin/curriculum/curricula/:curriculumId', element: <AdminCurriculumTreePage /> }],
    { initialEntries: [`/admin/curriculum/curricula/${curriculumId}`] },
  );
  return render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

/**
 * Chọn một lựa chọn trong ô Select của `@lms/ui` theo nhãn nhìn
 * thấy: bấm nút mở (định danh bằng id của SelectTrigger) rồi bấm lựa
 * chọn trong danh sách xổ — danh sách xổ render qua portal ở tầng
 * document nên truy vấn bằng `screen`.
 */
async function chooseOption(triggerId: string, optionLabel: string) {
  await waitFor(() => expect(document.querySelector(`#${triggerId}`)).not.toBeNull());
  await userEvent.click(document.querySelector(`#${triggerId}`)!);
  await userEvent.click(await screen.findByRole('option', { name: optionLabel }));
}

/** Các dòng thân bảng đang hiển thị trên trang hiện tại của Data Table. */
function bodyRows(container: HTMLElement) {
  return [...container.querySelectorAll('tbody tr')];
}

describe('Trang quản trị chương trình', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('render trạng thái dataset và môn học; mở rộng một môn liệt kê các chương trình của nó', async () => {
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

  it('nhập dataset qua POST /curriculum/program-import và hiện số lượng kết quả', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderList();

    await userEvent.click(await screen.findByRole('button', { name: 'Đồng bộ lại' }));

    expect(await screen.findByText(/mới 0 · cập nhật 0 · bỏ qua 300/)).toBeInTheDocument();
    const post = calls.find((c) => c.url === '/api/v1/curriculum/program-import' && c.method === 'POST');
    expect(post?.body).toEqual({ datasetKey: 'toan' });
  });

  it('hiện thông báo cấm thay vì nội dung admin khi API trả 403', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { forbidden: true });
    renderList();

    expect(await screen.findByText(/không có quyền quản trị chương trình/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Đồng bộ lại' })).not.toBeInTheDocument();
  });

  it('render cây kèm outcome và vết nguồn của chúng', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderTree();

    expect(await screen.findByText('Số và phép tính')).toBeInTheDocument();
    expect(await screen.findByText('Đọc, viết được các số có nhiều chữ số.')).toBeInTheDocument();
    expect(screen.getByText(/Nguồn: Thông tư 32\/2018\/TT-BGDĐT/)).toBeInTheDocument();
  });

  it('bảng chương trình có đủ ba cột Mạch / chủ đề, Nội dung, Yêu cầu cần đạt theo cấu trúc bảng chính thức', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderTree();

    expect(await screen.findByRole('columnheader', { name: 'Mạch / chủ đề' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Nội dung' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Yêu cầu cần đạt' })).toBeInTheDocument();
    // Dòng của bài: ô Mạch / chủ đề mang tên mạch, ô Nội dung mang
    // tên bài, ô Yêu cầu cần đạt mang nguyên văn YCCĐ của bài đó.
    const row = screen.getByText('Đọc, viết được các số có nhiều chữ số').closest('tr');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Số và phép tính');
    expect(row!.textContent).toContain('Đọc, viết được các số có nhiều chữ số.');
  });

  it('mỗi YCCĐ hiển thị thành một dòng riêng của bảng, không gộp chung một ô', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { tree: BIG_TREE });
    const { container } = renderTree();

    // Tên bài A1 hiện ở cả hai dòng YCCĐ của nó — mỗi dòng một lần.
    expect(await screen.findAllByText('Nội dung A1')).toHaveLength(2);
    const firstOutcomeRow = screen.getByText('Yêu cầu cần đạt A1.').closest('tr');
    const secondOutcomeRow = screen.getByText('Yêu cầu cần đạt A1 bổ sung.').closest('tr');
    expect(firstOutcomeRow).not.toBeNull();
    expect(secondOutcomeRow).not.toBeNull();
    // Hai YCCĐ của cùng một bài nằm ở hai dòng khác nhau; mỗi dòng
    // chỉ chứa đúng một YCCĐ của bài đó.
    expect(firstOutcomeRow).not.toBe(secondOutcomeRow);
    expect(firstOutcomeRow!.textContent).not.toContain('Yêu cầu cần đạt A1 bổ sung.');
    expect(secondOutcomeRow!.textContent).not.toContain('Yêu cầu cần đạt A1.');
    // Trang đầu chứa đúng 10 dòng YCCĐ (cỡ trang của Data Table).
    expect(bodyRows(container)).toHaveLength(10);
  });

  it('phân trang do Data Table đảm nhiệm: trang đầu 10 dòng YCCĐ, nút Sau chuyển sang các dòng tiếp theo', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { tree: BIG_TREE });
    renderTree();

    // Trang 1: 10 dòng YCCĐ đầu (A1 có 2 dòng, A2–A9 mỗi bài 1 dòng);
    // dòng của A10 và mạch B chưa hiện.
    expect(await screen.findAllByText('Nội dung A1')).toHaveLength(2);
    expect(screen.getByText('Nội dung A9')).toBeInTheDocument();
    expect(screen.queryByText('Nội dung A10')).not.toBeInTheDocument();
    expect(screen.queryByText('Hình học và đo lường')).not.toBeInTheDocument();
    expect(screen.getByText('Trang 1 / 2')).toBeInTheDocument();

    // Hai nút cùng nhãn trợ năng "Sau" (trang kế và trang cuối theo
    // mẫu Data Table); nút trang kế đứng trước trong DOM.
    await userEvent.click(screen.getAllByRole('button', { name: 'Sau' })[0]!);

    // Trang 2: phần còn của mạch A + toàn bộ mạch B; dòng của trang 1 không còn.
    expect(await screen.findByText('Nội dung A11')).toBeInTheDocument();
    expect(screen.getByText('Nội dung A12')).toBeInTheDocument();
    expect(screen.getByText('Nội dung B3')).toBeInTheDocument();
    expect(screen.getAllByText('Hình học và đo lường').length).toBeGreaterThan(0);
    expect(screen.queryByText('Nội dung A1')).not.toBeInTheDocument();
    expect(screen.getByText('Trang 2 / 2')).toBeInTheDocument();
    // Chuyển trang là việc phía client của Data Table: cây chỉ được tải đúng một lần.
    expect(calls.filter((c) => c.url === '/api/v1/curriculum/curricula/curr-5/tree')).toHaveLength(1);
  });

  it('thao tác tại dòng vẫn hoạt động ở trang 2 của bảng', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { tree: BIG_TREE });
    renderTree();

    expect(await screen.findAllByText('Nội dung A1')).toHaveLength(2);
    await userEvent.click(screen.getAllByRole('button', { name: 'Sau' })[0]!);

    // Sửa node ở dòng của bài A11 trỏ đúng màn sửa của node đó (nút
    // Sửa đầu tiên trong dòng là của node, trước nút Sửa của YCCĐ).
    const row = (await screen.findByText('Nội dung A11')).closest('tr');
    expect(row).not.toBeNull();
    const editLinks = within(row!).getAllByRole('link', { name: 'Sửa' });
    expect(editLinks[0]).toHaveAttribute('href', '/admin/curriculum/nodes/lesson-a11/edit');
  });

  it('bộ chọn Lớp chuyển tới chương trình của khối được chọn', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, {
      curriculaBySubject: {
        'subj-toan': [
          { id: 'curr-5', subjectId: 'subj-toan', grade: 5 },
          { id: 'curr-6', subjectId: 'subj-toan', grade: 6 },
        ],
      },
      trees: { 'curr-5': TREE, 'curr-6': TREE_GRADE6 },
    });
    renderTree();

    expect(await screen.findByText('Đọc, viết được các số có nhiều chữ số')).toBeInTheDocument();
    await chooseOption('curriculum-tree-grade', 'Lớp 6');

    // Cây lớp 6 của cùng môn được tải và trình bày thay cho cây lớp 5.
    expect(await screen.findByText('Nội dung lớp 6 duy nhất')).toBeInTheDocument();
    expect(screen.queryByText('Đọc, viết được các số có nhiều chữ số')).not.toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/curriculum/curricula/curr-6/tree')).toBe(true);
  });

  it('bộ chọn Môn chuyển tới cây chương trình của môn được chọn', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, {
      subjects: [SUBJECT, SUBJECT_VAN],
      curriculaBySubject: {
        'subj-toan': [{ id: 'curr-5', subjectId: 'subj-toan', grade: 5 }],
        'subj-van': [{ id: 'curr-v6', subjectId: 'subj-van', grade: 6 }],
      },
      trees: { 'curr-5': TREE, 'curr-v6': TREE_VAN },
    });
    renderTree();

    expect(await screen.findByText('Đọc, viết được các số có nhiều chữ số')).toBeInTheDocument();
    await chooseOption('curriculum-tree-subject', 'Ngữ văn');

    // Môn Ngữ văn không có lớp 5 nên trang chuyển tới chương trình
    // khối nhỏ nhất của môn đó (lớp 6) và trình bày cây của nó.
    expect(await screen.findByText('Nội dung Ngữ văn duy nhất')).toBeInTheDocument();
    expect(screen.queryByText('Đọc, viết được các số có nhiều chữ số')).not.toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/curriculum/curricula/curr-v6/tree')).toBe(true);
  });

  it('ô tìm kiếm lọc các dòng theo văn bản Nội dung và văn bản YCCĐ', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { trees: { 'curr-5': SEARCH_TREE } });
    renderTree();

    expect(await screen.findByText('Phép cộng số tự nhiên')).toBeInTheDocument();
    expect(screen.getByText('Phép nhân phân số')).toBeInTheDocument();

    // Chuỗi chỉ có trong YCCĐ của bài phân số: chỉ còn dòng của bài đó.
    await userEvent.type(
      screen.getByPlaceholderText('Tìm trong Nội dung / Yêu cầu cần đạt…'),
      'hai phân số',
    );
    expect(await screen.findByText('Nhân được hai phân số.')).toBeInTheDocument();
    expect(screen.queryByText('Phép cộng số tự nhiên')).not.toBeInTheDocument();
    expect(screen.queryByText('Cộng được hai số tự nhiên.')).not.toBeInTheDocument();

    // Xoá trắng ô tìm kiếm thì mọi dòng quay lại.
    await userEvent.clear(screen.getByPlaceholderText('Tìm trong Nội dung / Yêu cầu cần đạt…'));
    expect(await screen.findByText('Phép cộng số tự nhiên')).toBeInTheDocument();
  });
});
