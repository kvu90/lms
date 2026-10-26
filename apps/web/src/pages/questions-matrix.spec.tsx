import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { QuestionsPage } from './questions';
import { MatrixNewPage } from './question-matrix';

/**
 * Ngân hàng ma trận (MB-1, issue #111) ở tầng UI:
 *  - collapse riêng "Ma trận của tôi" liệt kê ma trận cá nhân + Thêm mới;
 *  - section "Ngân hàng ma trận chung" trong Ngân hàng hệ thống: chọn
 *    bank → thấy mẫu → Copy về ngân hàng của tôi gọi đúng endpoint;
 *  - màn tạo ma trận riêng (§9) gửi bankId = bank ma trận cá nhân.
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

describe('Matrix bank UI (MB-1)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('hai khu vực phân biệt: trang /matrices có ma trận của tôi; trang /system-bank/matrices có mẫu chung và copy về được', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    // Khu riêng ở path riêng (chuẩn đường dẫn #221): collapse "Ma trận
    // của tôi" mở sẵn ở /matrices → thấy ma trận cá nhân + Thêm mới.
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
    expect(screen.getByRole('button', { name: 'Thêm mới' })).toBeInTheDocument();
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

    await userEvent.click(screen.getByRole('button', { name: 'Copy về ngân hàng của tôi' }));
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
});
