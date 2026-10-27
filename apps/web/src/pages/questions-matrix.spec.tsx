import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { QuestionsPage } from './questions';
import { MatrixEditPage, MatrixNewPage } from './question-matrix';

/**
 * Ngân hàng ma trận (MB-1, issue #111) ở tầng UI:
 *  - trang /matrices liệt kê ma trận cá nhân hiện thẳng (không bọc
 *    thẻ thu/mở — chốt 23:43 ngày 26/10/2026) + nút Ma trận mới ở
 *    PageHeader;
 *  - section "Ngân hàng ma trận chung" trong Ngân hàng hệ thống: chọn
 *    bank → thấy mẫu → nút "Lấy về" gọi đúng endpoint;
 *  - màn tạo ma trận riêng (§9) gửi bankId = bank ma trận cá nhân;
 *  - màn sửa ma trận: thêm ô neo ĐƠN VỊ KIẾN THỨC — body POST mang
 *    curriculumNodeId của node đã chọn, không còn learningOutcomeId
 *    (ma trận neo ĐVK theo #249/#259).
 */

const PROFILE = {
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
};

const PERSONAL_MATRIX_BANK = '01900000-0000-7000-8000-000000000101';
const TEAM_MATRIX_BANK = '01900000-0000-7000-8000-000000000102';
const MY_MATRIX = '01900000-0000-7000-8000-000000000111';
const TEMPLATE_MATRIX = '01900000-0000-7000-8000-000000000112';
const SUBJECT_ID = '01900000-0000-7000-8000-000000000121';
const CURRICULUM_ID = '01900000-0000-7000-8000-000000000122';
const TOPIC_NODE_ID = '01900000-0000-7000-8000-000000000131';
const LEAF_NODE_ID = '01900000-0000-7000-8000-000000000132';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function matrixView(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    subjectId: SUBJECT_ID,
    curriculumId: CURRICULUM_ID,
    contextId: '01900000-0000-7000-8000-0000000000a1',
    bankId: null,
    status: 'ready',
    isTemplate: false,
    derivedFromMatrixId: null,
    version: 1,
    presetKind: 'cv7991_periodic',
    levelSet: 'three',
    totalScore: 10,
    cells: [{ id: `${id}-cell-1` }, { id: `${id}-cell-2` }],
    warnings: [],
    ...extra,
  };
}

function stubFetch(calls: RecordedCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities')
        return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
      if (url === '/api/v1/courses') return respond([]);
      if (url === '/api/v1/questions/categories') return respond([]);
      if (url === '/api/v1/question-banks') {
        return respond([
          {
            id: '01900000-0000-7000-8000-000000000100', name: 'Ngân hàng của tôi', scope: 'personal',
            bankKind: 'question', defaultCategoryId: null, categoryIds: [],
            capabilities: { use: true, add: true, moderate: false, copy: true },
          },
        ]);
      }
      if (url === '/api/v1/question-banks?kind=matrix') {
        return respond([
          {
            id: PERSONAL_MATRIX_BANK, name: 'Ngân hàng của tôi', scope: 'personal', bankKind: 'matrix',
            defaultCategoryId: null, categoryIds: [],
            capabilities: { use: true, add: false, moderate: true, copy: true, matrixView: true, matrixManage: true, matrixCopy: true, matrixShare: true, matrixModerate: true },
          },
          {
            id: TEAM_MATRIX_BANK, name: 'Ngân hàng ma trận tổ Toán', scope: 'team', bankKind: 'matrix',
            defaultCategoryId: null, categoryIds: [],
            capabilities: { use: true, add: false, moderate: false, copy: true, matrixView: true, matrixManage: false, matrixCopy: true, matrixShare: false, matrixModerate: false },
          },
        ]);
      }
      if (url === `/api/v1/question-banks/${PERSONAL_MATRIX_BANK}/matrices`) {
        return respond([matrixView(MY_MATRIX, 'Ma trận ôn tập của tôi', { bankId: PERSONAL_MATRIX_BANK })]);
      }
      if (url === `/api/v1/question-banks/${TEAM_MATRIX_BANK}/matrices`) {
        return respond([
          matrixView(TEMPLATE_MATRIX, 'Mẫu giữa kỳ Toán 9', { bankId: TEAM_MATRIX_BANK, isTemplate: true }),
        ]);
      }
      if (url === `/api/v1/question-banks/${TEAM_MATRIX_BANK}/matrix-contributions?status=pending`) return respond([]);
      if (url === `/api/v1/exam-matrices/${TEMPLATE_MATRIX}/copy` && method === 'POST') {
        return respond(matrixView('01900000-0000-7000-8000-000000000113', 'Mẫu giữa kỳ Toán 9', {
          bankId: PERSONAL_MATRIX_BANK, status: 'draft', derivedFromMatrixId: TEMPLATE_MATRIX,
        }));
      }
      if (url === '/api/v1/curriculum/subjects') return respond([{ id: SUBJECT_ID, name: 'Toán học' }]);
      if (url === `/api/v1/curriculum/curricula?subjectId=${SUBJECT_ID}`) {
        return respond([{ id: CURRICULUM_ID, subjectId: SUBJECT_ID, grade: 9 }]);
      }
      if (url === '/api/v1/exam-matrices' && method === 'POST') return respond(matrixView(MY_MATRIX, 'Mới'));
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/** Stub cho màn SỬA ma trận: chi tiết ma trận + cây chương trình (chủ đề → ĐVK) + khả dụng. */
function stubFetchEdit(calls: RecordedCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities')
        return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
      if (url === '/api/v1/courses') return respond([]);
      if (url === `/api/v1/exam-matrices/${MY_MATRIX}`) {
        return respond({
          id: MY_MATRIX, name: 'Ma trận ôn tập của tôi', subjectId: SUBJECT_ID, curriculumId: CURRICULUM_ID,
          bankId: PERSONAL_MATRIX_BANK, status: 'draft', isTemplate: false, version: 1,
          presetKind: 'cv7991_periodic', levelSet: 'three', totalScore: 10, cells: [],
        });
      }
      if (url === `/api/v1/curriculum/curricula/${CURRICULUM_ID}/tree`) {
        return respond([
          {
            id: TOPIC_NODE_ID, title: 'Chủ đề 1: Số tự nhiên', outcomes: [],
            children: [{ id: LEAF_NODE_ID, title: 'Đơn vị kiến thức: Phép cộng', outcomes: [], children: [] }],
          },
        ]);
      }
      if (url === `/api/v1/exam-matrices/${MY_MATRIX}/availability`) return respond({ sufficient: true, cells: [] });
      if (url === `/api/v1/exam-matrices/${MY_MATRIX}/cells` && method === 'POST') {
        return respond({ id: `${MY_MATRIX}-cell-new` });
      }
      if (url === `/api/v1/exam-matrices/${MY_MATRIX}/specification`) {
        // Bản đặc tả SUY RA: hai ô ở hai ĐVK khác nhau; cột YCCĐ của mỗi
        // ô = mọi YCCĐ thuộc ĐVK của ô đó (ô không neo YCCĐ — #249).
        // API đặc tả là nguồn sự thật duy nhất cho mã YCCĐ: mỗi
        // outcome mang sẵn position + code (đợt #161), web chỉ hiển thị.
        const outcome = (id: string, content: string, record: string, position: number) => ({
          outcomeId: id, content, sourceKind: 'program',
          sourceRef: `Thông tư 32/2018/TT-BGDĐT — chuong-trinh.pdf, trang 5 — bản ghi ${record}`,
          programContent: content, derivedContent: null,
          position, code: `${record}.${String(position).padStart(2, '0')}`,
        });
        return respond({
          matrix: { id: MY_MATRIX, name: 'Ma trận ôn tập của tôi', totalScore: 6, levelSet: 'three' },
          subject: { id: SUBJECT_ID, name: 'Toán học' },
          curriculum: { id: CURRICULUM_ID, grade: 9 },
          purpose: 'Đề kiểm tra định kỳ môn Toán học theo Công văn 7991.',
          topics: [{
            topicId: TOPIC_NODE_ID, topicTitle: 'Chủ đề 1: Số tự nhiên',
            nodes: [
              {
                nodeId: LEAF_NODE_ID, nodeTitle: 'Phép cộng',
                outcomes: [
                  outcome('oc-1', 'Nhận biết được phép cộng trong phạm vi 10.', 'TOAN-0001', 1),
                  outcome('oc-2', 'Thực hiện được phép cộng trong phạm vi 10.', 'TOAN-0001', 2),
                ],
                cells: [{
                  cellId: 'cell-spec-1', cognitiveLevel: 'biet', qtype: 'multichoice',
                  questionCount: 2, cellScore: 2, minutes: null, slotNumbers: null, drawNote: null,
                }],
              },
              {
                nodeId: '01900000-0000-7000-8000-000000000133', nodeTitle: 'Phép trừ',
                outcomes: [outcome('oc-3', 'Nhận biết được phép trừ trong phạm vi 10.', 'TOAN-0002', 1)],
                cells: [{
                  cellId: 'cell-spec-2', cognitiveLevel: 'hieu', qtype: 'truefalse',
                  questionCount: 1, cellScore: 4, minutes: null, slotNumbers: null, drawNote: null,
                }],
              },
            ],
          }],
          totals: { totalQuestions: 6, totalScore: 6 },
        });
      }
      if (url === `/api/v1/exam-matrices/${MY_MATRIX}/specification/export?format=xlsx`) {
        // Bản xuất thật là file nhị phân (xlsx là zip, mở đầu "PK") kèm
        // Content-Disposition mang tên file server đặt — ca test xuất
        // đặc tả khẳng định web giữ đúng tên này khi tải về.
        return new Response(new Blob(['PK']), {
          status: 200,
          headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': 'attachment; filename="ban-dac-ta-01900000.xlsx"',
          },
        });
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Matrix bank UI (MB-1)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('hai khu vực phân biệt: trang /matrices có ma trận của tôi; trang /system-bank/matrices có mẫu chung và copy về được', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    // Khu riêng ở path riêng (chuẩn đường dẫn #221): danh sách ma
    // trận cá nhân hiện THẲNG ở /matrices (không bọc thẻ thu/mở —
    // chốt 23:43 ngày 26/10/2026) → thấy ma trận cá nhân + nút Ma
    // trận mới ở PageHeader, không còn nút Thêm mới trong danh sách.
    // (Tên ma trận cũng xuất hiện ở <option> của select đề xuất đóng góp
    // nên đếm mọi phần tử khớp thay vì findByText đơn nhất.)
    const myRouter = createMemoryRouter([{ path: '/matrices', element: <QuestionsPage area="my-matrices" /> }], {
      initialEntries: ['/matrices'],
    });
    render(
      <TestProviders>
        <RouterProvider router={myRouter} />
      </TestProviders>,
    );
    expect((await screen.findAllByText('Ma trận ôn tập của tôi')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Ma trận mới' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thêm mới' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sửa' })).toBeInTheDocument();
    cleanup();

    // Khu hệ thống ở /system-bank/matrices: chọn bank tổ → thấy mẫu
    // → copy về.
    const systemRouter = createMemoryRouter(
      [{ path: '/system-bank/matrices', element: <QuestionsPage area="system-matrices" /> }],
      { initialEntries: ['/system-bank/matrices'] },
    );
    const { container } = render(
      <TestProviders>
        <RouterProvider router={systemRouter} />
      </TestProviders>,
    );
    expect(await screen.findByText('Ngân hàng ma trận chung')).toBeInTheDocument();
    const bankSelect = container.querySelector<HTMLSelectElement>('#shared-matrix-bank');
    if (!bankSelect) throw new Error('shared matrix bank select not found');
    await userEvent.selectOptions(bankSelect, TEAM_MATRIX_BANK);
    expect(await screen.findByText('Mẫu giữa kỳ Toán 9')).toBeInTheDocument();
    expect(screen.getByText('Mẫu')).toBeInTheDocument();

    // Nút tại dòng mang nhãn gọn "Lấy về" và tên đầy đủ cho
    // title/aria-label (ủy quyền quyết chữ của Lão gia, 26/10/2026).
    const copyButton = screen.getByRole('button', { name: 'Lấy về ngân hàng của tôi' });
    expect(copyButton).toHaveTextContent('Lấy về');
    expect(copyButton).toHaveAttribute('title', 'Lấy về ngân hàng của tôi');
    await userEvent.click(copyButton);
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/exam-matrices/${TEMPLATE_MATRIX}/copy` && c.method === 'POST')).toBe(true),
    );
    expect(await screen.findByText('Đã copy ma trận về ngân hàng của bạn.')).toBeInTheDocument();
  });

  it('màn tạo ma trận riêng gửi đúng bankId của bank ma trận cá nhân (§9)', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    const router = createMemoryRouter(
      [
        { path: '/matrices', element: <div>Danh sách ngân hàng</div> },
        { path: '/matrices/new', element: <MatrixNewPage /> },
      ],
      { initialEntries: ['/matrices/new'] },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    await userEvent.type(await screen.findByLabelText('Tên ma trận'), 'Ma trận cuối kỳ Toán 9');
    await userEvent.selectOptions(screen.getByLabelText('Môn học'), SUBJECT_ID);
    await waitFor(() => expect(screen.getByLabelText('Chương trình (lớp)')).not.toBeDisabled());
    await userEvent.selectOptions(screen.getByLabelText('Chương trình (lớp)'), CURRICULUM_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Tạo ma trận' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/exam-matrices' && c.method === 'POST')).toBe(true),
    );
    const createCall = calls.find((c) => c.url === '/api/v1/exam-matrices' && c.method === 'POST');
    expect(createCall?.body).toMatchObject({
      name: 'Ma trận cuối kỳ Toán 9',
      subjectId: SUBJECT_ID,
      curriculumId: CURRICULUM_ID,
      bankId: PERSONAL_MATRIX_BANK,
    });
    expect(await screen.findByText('Danh sách ngân hàng')).toBeInTheDocument();
  });

  it('màn sửa ma trận: thêm ô gửi curriculumNodeId của ĐVK đã chọn, không còn learningOutcomeId', async () => {
    const calls: RecordedCall[] = [];
    stubFetchEdit(calls);
    const router = createMemoryRouter(
      [{ path: '/matrices/:matrixId/edit', element: <MatrixEditPage /> }],
      { initialEntries: [`/matrices/${MY_MATRIX}/edit`] },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    // Bộ chọn ô là bộ chọn ĐƠN VỊ KIẾN THỨC (node của cây chương trình),
    // chọn node lá rồi thêm ô với mức/dạng mặc định. Cây chương trình là
    // query riêng sau chi tiết — chờ option của node lá xuất hiện đã.
    const nodeSelect = await screen.findByLabelText('Đơn vị kiến thức');
    await waitFor(() =>
      expect(nodeSelect.querySelector(`option[value="${LEAF_NODE_ID}"]`)).not.toBeNull(),
    );
    await userEvent.selectOptions(nodeSelect, LEAF_NODE_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Thêm ô' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/exam-matrices/${MY_MATRIX}/cells` && c.method === 'POST')).toBe(true),
    );
    const addCall = calls.find((c) => c.url === `/api/v1/exam-matrices/${MY_MATRIX}/cells` && c.method === 'POST');
    expect(addCall?.body).toMatchObject({
      curriculumNodeId: LEAF_NODE_ID,
      cognitiveLevel: 'biet',
      qtype: 'multichoice',
      questionCount: 1,
      cellScore: 1,
    });
    expect(addCall?.body).not.toHaveProperty('learningOutcomeId');
  });

  it('màn sửa ma trận: xem bản đặc tả thấy YCCĐ đúng ĐVK của từng ô (kèm mã vị trí) và xuất Excel gọi đúng endpoint, giữ tên file server trả', async () => {
    const calls: RecordedCall[] = [];
    stubFetchEdit(calls);
    let downloadedName: string | null = null;
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:spec-export');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadedName = this.download;
    });
    try {
      const router = createMemoryRouter(
        [{ path: '/matrices/:matrixId/edit', element: <MatrixEditPage /> }],
        { initialEntries: [`/matrices/${MY_MATRIX}/edit`] },
      );
      render(
        <TestProviders>
          <RouterProvider router={router} />
        </TestProviders>,
      );

      // Đặc tả chỉ tải khi giáo viên mở mục Bản đặc tả ở trang ma trận.
      await screen.findByLabelText('Đơn vị kiến thức');
      expect(calls.some((c) => c.url === `/api/v1/exam-matrices/${MY_MATRIX}/specification`)).toBe(false);
      await userEvent.click(screen.getByRole('button', { name: 'Xem bản đặc tả' }));
      await waitFor(() =>
        expect(calls.some((c) => c.url === `/api/v1/exam-matrices/${MY_MATRIX}/specification` && c.method === 'GET')).toBe(true),
      );

      // Dòng của ô "Phép cộng" mang đúng hai YCCĐ thuộc ĐVK Phép cộng
      // (kèm mã vị trí tiền tố), KHÔNG lẫn YCCĐ của ĐVK Phép trừ.
      const addRow = (await screen.findByText('Phép cộng')).closest('tr');
      expect(addRow?.textContent).toContain('Nhận biết được phép cộng trong phạm vi 10.');
      expect(addRow?.textContent).toContain('Thực hiện được phép cộng trong phạm vi 10.');
      expect(addRow?.textContent).toContain('TOAN-0001.01');
      expect(addRow?.textContent).toContain('TOAN-0001.02');
      expect(addRow?.textContent).not.toContain('phép trừ');
      expect(addRow?.textContent).toContain('Biết');
      expect(addRow?.textContent).toContain('Trắc nghiệm');

      const subRow = screen.getByText('Phép trừ').closest('tr');
      expect(subRow?.textContent).toContain('Nhận biết được phép trừ trong phạm vi 10.');
      expect(subRow?.textContent).toContain('TOAN-0002.01');
      // Câu Đúng–Sai chùm: 1 ô × 4 ý như cách đếm của bản xuất.
      expect(subRow?.textContent).toContain('4');
      expect(await screen.findByText('Tổng: 6 câu · 6 điểm')).toBeInTheDocument();

      // Xuất bản đặc tả: gọi đúng endpoint export xlsx và tải file với
      // đúng tên server trả trong Content-Disposition.
      await userEvent.click(screen.getByRole('button', { name: 'Xuất Excel' }));
      await waitFor(() =>
        expect(
          calls.some((c) => c.url === `/api/v1/exam-matrices/${MY_MATRIX}/specification/export?format=xlsx` && c.method === 'GET'),
        ).toBe(true),
      );
      await waitFor(() => expect(downloadedName).toBe('ban-dac-ta-01900000.xlsx'));
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = originalCreateObjectURL;
    }
  });
});
