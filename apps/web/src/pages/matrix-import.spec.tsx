import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { MatrixImportPage } from './matrix-import';
import { MatrixEditPage } from './question-matrix';

/**
 * Wizard nhập ma trận từ file (lát I-3, issue #233) ở tầng UI:
 *  - 5 bước đi hết: chọn môn + tải mẫu → tải file → xem trước
 *    (lưới ô + khả dụng) → xác nhận → kết quả mở trang sửa;
 *  - xem trước không hợp lệ: bảng lỗi định vị hiện ra, nút xác nhận
 *    bị khoá, không có ma trận nào được ghi;
 *  - ghi bị 422 kèm matrixImportIssues: ở lại bước xác nhận với bảng
 *    lỗi lúc ghi, không sang bước kết quả;
 *  - màn sửa ma trận: checkbox Vận dụng cao gửi levelSet 'four' khi
 *    lưu (thay cho mọi select levelSet — web không còn select nào).
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

const SUBJECT_ID = '01900000-0000-7000-8000-000000000121';
const CURRICULUM_ID = '01900000-0000-7000-8000-000000000122';
const LEAF_NODE_ID = '01900000-0000-7000-8000-000000000132';
const MY_MATRIX = '01900000-0000-7000-8000-000000000111';
const IMPORTED_MATRIX = '01900000-0000-7000-8000-000000000113';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function validPreview() {
  return {
    valid: true,
    errors: [],
    warnings: ['Đơn vị kiến thức "Phép trừ" không có ô nào — đã dạy nhưng không kiểm tra ở ma trận này.'],
    name: 'Ma trận cuối kỳ Toán 9',
    subjectId: SUBJECT_ID,
    curriculumId: CURRICULUM_ID,
    levelSet: 'three',
    totalScore: 1,
    scopeNote: null,
    perFormScores: { multichoice: 0.5, truefalse: null, shortanswer: null, essay: null },
    rows: [{ nodeId: LEAF_NODE_ID, topicTitle: 'Chủ đề 1: Số tự nhiên', nodeTitle: 'Phép cộng', position: 1, outcomes: [] }],
    cells: [{ curriculumNodeId: LEAF_NODE_ID, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 2, cellScore: 1 }],
    totals: {
      byForm: [{ qtype: 'multichoice', questionCount: 2, score: 1, percent: 100 }],
      byLevel: [{ cognitiveLevel: 'biet', questionCount: 2, score: 1, percent: 100 }],
      totalScore: 1,
      totalQuestions: 2,
    },
    availability: [{ curriculumNodeId: LEAF_NODE_ID, cognitiveLevel: 'biet', qtype: 'multichoice', required: 2, available: 5, deficit: 0 }],
  };
}

function invalidPreview() {
  return {
    valid: false,
    errors: [{ sheet: 'Ma trận', row: 16, column: 'F', code: 'quiz.matrix_import_cell_value_invalid', message: 'Ô F15 phải là số nguyên ≥ 0.' }],
    warnings: [],
    name: null,
    subjectId: null,
    curriculumId: null,
    levelSet: null,
    totalScore: null,
    scopeNote: null,
    perFormScores: {},
    rows: [],
    cells: [],
    totals: { byForm: [], byLevel: [], totalScore: 0, totalQuestions: 0 },
    availability: [],
  };
}

type ImportMode = 'ok' | 'rejected-422';

/** Stub fetch cho wizard: preview/import đổi theo mode; FormData không parse JSON mà ghi dấu 'formdata'. */
function stubFetchImport(calls: RecordedCall[], previewBody: unknown, mode: ImportMode) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body instanceof FormData ? 'formdata' : init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const respond = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities')
        return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
      if (url === '/api/v1/courses') return respond([]);
      if (url === '/api/v1/curriculum/subjects') return respond([{ id: SUBJECT_ID, name: 'Toán học' }]);
      if (url === `/api/v1/curriculum/curricula?subjectId=${SUBJECT_ID}`) {
        return respond([{ id: CURRICULUM_ID, subjectId: SUBJECT_ID, grade: 9 }]);
      }
      if (url.startsWith('/api/v1/exam-matrices/template?')) {
        return new Response(new Blob(['PK']), {
          status: 200,
          headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': 'attachment; filename="mau-ma-tran-toan-9.xlsx"',
          },
        });
      }
      if (url === '/api/v1/exam-matrices/import/preview' && method === 'POST') return respond(previewBody);
      if (url === '/api/v1/exam-matrices/import' && method === 'POST') {
        if (mode === 'rejected-422') {
          return respond({
            type: 'about:blank', title: 'Unprocessable Entity', status: 422,
            code: 'quiz.matrix_import_invalid',
            matrixImportIssues: [{ sheet: 'Ma trận', row: 15, column: 'G', code: 'quiz.matrix_import_cell_value_invalid', message: 'Ô G15 phải là số nguyên ≥ 0.' }],
          }, 422);
        }
        return respond({
          id: IMPORTED_MATRIX, name: 'Ma trận cuối kỳ Toán 9', subjectId: SUBJECT_ID, curriculumId: CURRICULUM_ID,
          totalScore: 1, cells: [{ id: `${IMPORTED_MATRIX}-cell-1` }], warnings: [],
        }, 201);
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/** Stub tối thiểu cho màn sửa ma trận: chi tiết + cây rỗng + khả dụng + PATCH ghi lại body. */
function stubFetchEdit(calls: RecordedCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const respond = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities')
        return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
      if (url === '/api/v1/courses') return respond([]);
      if (url === `/api/v1/exam-matrices/${MY_MATRIX}`) {
        return respond({
          id: MY_MATRIX, name: 'Ma trận ôn tập của tôi', subjectId: SUBJECT_ID, curriculumId: CURRICULUM_ID,
          bankId: null, status: 'draft', isTemplate: false, version: 1,
          presetKind: 'cv7991_periodic', levelSet: 'three', totalScore: 10, cells: [],
        });
      }
      if (url === `/api/v1/curriculum/curricula/${CURRICULUM_ID}/tree`) return respond([]);
      if (url === `/api/v1/exam-matrices/${MY_MATRIX}/availability`) return respond({ sufficient: true, cells: [] });
      if (url === `/api/v1/exam-matrices/${MY_MATRIX}` && method === 'PATCH') return respond({ ok: true });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function renderImport(calls: RecordedCall[], previewBody: unknown, mode: ImportMode) {
  stubFetchImport(calls, previewBody, mode);
  const router = createMemoryRouter(
    [
      { path: '/matrices/import', element: <MatrixImportPage /> },
      { path: '/matrices/:matrixId/edit', element: <div>Trang sửa ma trận</div> },
      { path: '/matrices', element: <div>Danh sách ma trận</div> },
    ],
    { initialEntries: ['/matrices/import'] },
  );
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
  return router;
}

/** Chờ option của một select xuất hiện rồi mới chọn — query môn/chương trình là bất đồng bộ, chọn ngay khi label vừa hiện sẽ gặp select còn rỗng. */
async function selectWithOptions(label: string, value: string) {
  const select = await screen.findByLabelText(label);
  await waitFor(() =>
    expect(select.querySelector(`option[value="${value}"]`)).not.toBeNull(),
  );
  await userEvent.selectOptions(select, value);
}

async function goToUploadStep() {
  await selectWithOptions('Môn học', SUBJECT_ID);
  await selectWithOptions('Chương trình (lớp)', CURRICULUM_ID);
  await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
  expect(await screen.findByLabelText('Chọn file .xlsx đã điền')).toBeInTheDocument();
}

describe('Matrix import wizard (I-3)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('đi hết 5 bước: tải mẫu đúng query → xem trước có lưới + khả dụng → ghi → kết quả mở trang sửa', async () => {
    const calls: RecordedCall[] = [];
    renderImport(calls, validPreview(), 'ok');
    let downloadedName: string | null = null;
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:template');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadedName = this.download;
    });
    try {
      await selectWithOptions('Môn học', SUBJECT_ID);
      await selectWithOptions('Chương trình (lớp)', CURRICULUM_ID);
      await userEvent.click(screen.getByRole('button', { name: 'Tải file mẫu' }));
      await waitFor(() =>
        expect(calls.some((c) => c.url.startsWith('/api/v1/exam-matrices/template?') && c.url.includes('levelSet=three'))).toBe(true),
      );
      await waitFor(() => expect(downloadedName).toBe('mau-ma-tran-toan-9.xlsx'));

      await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
      const fileInput = await screen.findByLabelText('Chọn file .xlsx đã điền');
      await userEvent.upload(fileInput, new File(['fake'], 'ma-tran.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      await userEvent.click(screen.getByRole('button', { name: 'Xem trước' }));

      // Bước 3: tên dự thảo + tổng + cảnh báo + một ô kèm khả dụng.
      expect(await screen.findByText('Ma trận cuối kỳ Toán 9')).toBeInTheDocument();
      expect(screen.getByText('Tổng: 2 câu · 1 điểm')).toBeInTheDocument();
      expect(screen.getByText(/không có ô nào/)).toBeInTheDocument();
      expect(screen.getByText('Chủ đề 1: Số tự nhiên · Phép cộng')).toBeInTheDocument();
      expect(screen.getByText('Cần: 2 · Có: 5 · Thiếu: 0')).toBeInTheDocument();
      expect(calls.some((c) => c.url === '/api/v1/exam-matrices/import/preview' && c.method === 'POST' && c.body === 'formdata')).toBe(true);

      await userEvent.click(screen.getByRole('button', { name: 'Xác nhận ghi ma trận' }));
      expect(await screen.findByRole('button', { name: 'Ghi ma trận' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Ghi ma trận' }));

      // Bước 5: ghi gọi đúng endpoint bằng chính file đã xem trước, kết quả mở được trang sửa.
      await waitFor(() =>
        expect(calls.some((c) => c.url === '/api/v1/exam-matrices/import' && c.method === 'POST' && c.body === 'formdata')).toBe(true),
      );
      expect(await screen.findByText('Ma trận đã sẵn sàng')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Mở trang sửa ma trận' }));
      expect(await screen.findByText('Trang sửa ma trận')).toBeInTheDocument();
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = originalCreateObjectURL;
    }
  });

  it('xem trước không hợp lệ: hiện lỗi định vị, nút xác nhận bị khoá, không gọi bước ghi', async () => {
    const calls: RecordedCall[] = [];
    renderImport(calls, invalidPreview(), 'ok');
    await goToUploadStep();
    const fileInput = screen.getByLabelText('Chọn file .xlsx đã điền');
    await userEvent.upload(fileInput, new File(['fake'], 'ma-tran-loi.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    await userEvent.click(screen.getByRole('button', { name: 'Xem trước' }));

    expect(await screen.findByText('Ô F15 phải là số nguyên ≥ 0.')).toBeInTheDocument();
    expect(screen.getByText('Ma trận')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xác nhận ghi ma trận' })).toBeDisabled();
    expect(calls.some((c) => c.url === '/api/v1/exam-matrices/import')).toBe(false);
  });

  it('ghi bị 422: ở lại bước xác nhận với lỗi lúc ghi, không sang bước kết quả', async () => {
    const calls: RecordedCall[] = [];
    renderImport(calls, validPreview(), 'rejected-422');
    await goToUploadStep();
    const fileInput = screen.getByLabelText('Chọn file .xlsx đã điền');
    await userEvent.upload(fileInput, new File(['fake'], 'ma-tran.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    await userEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Xác nhận ghi ma trận' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ghi ma trận' }));

    expect(await screen.findByText(/chưa ghi ma trận nào/)).toBeInTheDocument();
    expect(screen.getByText('Ô G15 phải là số nguyên ≥ 0.')).toBeInTheDocument();
    expect(screen.queryByText('Ma trận đã sẵn sàng')).toBeNull();
    expect(screen.getByRole('button', { name: 'Chọn file khác' })).toBeInTheDocument();
  });

  it('màn sửa ma trận: tick checkbox Vận dụng cao rồi lưu gửi levelSet four', async () => {
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

    // Checkbox Base UI: nhãn + phần tử role=checkbox đều mang cùng
    // chuỗi, nên chọn theo role + tên (findByLabelText gặp trùng).
    const checkbox = await screen.findByRole('checkbox', { name: 'Thêm mức Vận dụng cao' });
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('true'));
    await userEvent.click(screen.getByRole('button', { name: 'Sửa ma trận' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/exam-matrices/${MY_MATRIX}` && c.method === 'PATCH')).toBe(true),
    );
    const patchCall = calls.find((c) => c.url === `/api/v1/exam-matrices/${MY_MATRIX}` && c.method === 'PATCH');
    expect(patchCall?.body).toMatchObject({ levelSet: 'four' });
  });
});
