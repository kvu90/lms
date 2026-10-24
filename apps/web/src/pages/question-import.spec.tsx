import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionImportPage } from './question-import';

/**
 * Spec trang nhập đề từ file (issue #52): tải file → các mục chờ duyệt
 * hiện ra → giáo viên sửa/chốt đáp án + gắn YCCĐ tại bước duyệt → duyệt
 * thì trang gọi PATCH (lưu bản đã sửa) rồi POST approve theo đúng hợp
 * đồng của module question-import.
 */
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';
const BATCH_ID = '01900000-0000-7000-8000-000000000002';
const ITEM_MC = '01900000-0000-7000-8000-000000000003';
const ITEM_TF = '01900000-0000-7000-8000-000000000004';
const OUTCOME_ID = '01900000-0000-7000-8000-000000000005';
const SUBJECT_ID = '01900000-0000-7000-8000-000000000006';
const CURRICULUM_ID = '01900000-0000-7000-8000-000000000007';
const QUESTION_ID = '01900000-0000-7000-8000-000000000008';

interface RecordedCall { url: string; method: string; body: unknown }

interface FakeItem {
  id: string; ordinal: number; sourceNumber: number; qtype: string; status: string;
  payload: Record<string, unknown> & {
    answers: { text: string; fraction: number }[];
    outcomeLinks: { outcomeId: string; cognitiveLevel: string }[];
    truefalseCorrect: boolean | null;
  };
  issues: { severity: string; code: string; message: string }[];
  questionId: string | null;
  rawText: string;
}

function makeItems(): FakeItem[] {
  return [
    {
      id: ITEM_MC, ordinal: 1, sourceNumber: 1, qtype: 'multichoice', status: 'pending',
      payload: {
        name: 'Thủ đô của Pháp là gì?', qtype: 'multichoice', questionText: 'Thủ đô của Pháp là gì?',
        defaultMark: 1,
        answers: [{ text: 'London', fraction: 0 }, { text: 'Paris', fraction: 1 }],
        options: { single: true }, truefalseCorrect: null, outcomeLinks: [],
      },
      issues: [], questionId: null, rawText: 'Câu 1: Thủ đô của Pháp là gì?',
    },
    {
      id: ITEM_TF, ordinal: 2, sourceNumber: 2, qtype: 'truefalse', status: 'pending',
      payload: {
        name: 'Nước sôi ở 100 độ C.', qtype: 'truefalse', questionText: 'Nước sôi ở 100 độ C.',
        defaultMark: 1, answers: [], options: {}, truefalseCorrect: null, outcomeLinks: [],
      },
      issues: [{ severity: 'error', code: 'tf_answer_unknown', message: 'Chưa xác định được mệnh đề này là Đúng hay Sai.' }],
      questionId: null, rawText: 'Câu 2: Nước sôi ở 100 độ C.',
    },
  ];
}

function stubFetch(calls: RecordedCall[]) {
  const items = makeItems();
  const batchView = () => ({
    batch: { id: BATCH_ID, categoryId: CATEGORY_ID, fileName: 'de-mau.docx', fileKind: 'docx', status: 'in_review', totalItems: 2, createdAt: '2026-10-24T00:00:00.000Z' },
    counts: {
      total: 2,
      pending: items.filter((i) => i.status === 'pending').length,
      approved: items.filter((i) => i.status === 'approved').length,
      rejected: items.filter((i) => i.status === 'rejected').length,
    },
    items,
  });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = init?.body ?? null;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* giữ nguyên */ } }
    calls.push({ url, method, body });

    if (url.endsWith('/api/v1/questions/categories')) return json([{ id: CATEGORY_ID, name: 'Ngân hàng Toán' }]);
    if (url.endsWith('/api/v1/access/contexts')) return json([{ id: 'sys', contextLevel: 10 }]);
    if (url.includes('/api/v1/curriculum/subjects')) return json([{ id: SUBJECT_ID, name: 'Toán' }]);
    if (url.includes('/api/v1/curriculum/curricula?')) return json([{ id: CURRICULUM_ID, grade: 10 }]);
    if (url.includes(`/api/v1/curriculum/curricula/${CURRICULUM_ID}/tree`)) {
      return json({ nodes: [{ id: 'node1', title: 'Hàm số', outcomes: [{ id: OUTCOME_ID, content: 'Nhận biết được khái niệm hàm số.' }], children: [] }] });
    }
    if (url.endsWith('/api/v1/question-imports') && method === 'GET') return json([]);
    if (url.endsWith('/api/v1/question-imports') && method === 'POST') return json(batchView(), 201);
    if (url.endsWith(`/api/v1/question-imports/${BATCH_ID}`)) return json(batchView());
    const itemMatch = /\/items\/([0-9a-f-]+)$/.exec(url);
    if (itemMatch && method === 'PATCH') {
      const item = items.find((i) => i.id === itemMatch[1])!;
      item.payload = (body as { payload: FakeItem['payload'] }).payload;
      item.issues = item.payload.truefalseCorrect === null && item.payload.qtype === 'truefalse'
        ? [{ severity: 'error', code: 'tf_answer_unknown', message: 'Chưa xác định được mệnh đề này là Đúng hay Sai.' }]
        : [];
      return json(item);
    }
    const approveMatch = /\/items\/([0-9a-f-]+)\/approve$/.exec(url);
    if (approveMatch && method === 'POST') {
      const item = items.find((i) => i.id === approveMatch[1])!;
      item.status = 'approved';
      item.questionId = QUESTION_ID;
      return json({ item, questionId: QUESTION_ID }, 201);
    }
    return json({ message: `unhandled ${method} ${url}` }, 404);
  }));
}

function renderPage() {
  const router = createMemoryRouter(
    [{ path: '/questions/import', element: <QuestionImportPage /> }],
    { initialEntries: ['/questions/import'] },
  );
  return render(<RouterProvider router={router} />);
}

describe('QuestionImportPage', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('tải file → hiện hàng đợi → duyệt câu trắc nghiệm (PATCH rồi approve)', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();
    const user = userEvent.setup();

    await user.selectOptions(await screen.findByLabelText('Danh mục đích'), CATEGORY_ID);
    const file = new File(['docx-bytes'], 'de-mau.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    await user.upload(screen.getByLabelText('File đề (.docx, .pdf)'), file);
    await user.click(screen.getByRole('button', { name: 'Tải lên và tách câu' }));

    // Hàng đợi hiện ra với cả hai mục và vấn đề của mục đúng/sai.
    expect(await screen.findByText('1. Thủ đô của Pháp là gì?')).toBeTruthy();
    expect(screen.getByText('Chưa xác định được mệnh đề này là Đúng hay Sai.')).toBeTruthy();
    const uploadCall = calls.find((c) => c.url.endsWith('/api/v1/question-imports') && c.method === 'POST');
    expect(uploadCall?.body).toBeInstanceOf(FormData);
    expect((uploadCall?.body as FormData).get('categoryId')).toBe(CATEGORY_ID);

    const mcCard = screen.getByText('1. Thủ đô của Pháp là gì?').closest('[data-slot="card"]') as HTMLElement;
    await user.click(within(mcCard).getByRole('button', { name: 'Duyệt vào ngân hàng' }));

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes(`/items/${ITEM_MC}/approve`) && c.method === 'POST')).toBe(true);
    });
    const patchIdx = calls.findIndex((c) => c.url.includes(`/items/${ITEM_MC}`) && c.method === 'PATCH');
    const approveIdx = calls.findIndex((c) => c.url.includes(`/items/${ITEM_MC}/approve`));
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    expect(approveIdx).toBeGreaterThan(patchIdx);
    expect(await screen.findByText(/Đã vào ngân hàng, mã câu hỏi/)).toBeTruthy();
  });

  it('chốt đáp án đúng/sai + gắn YCCĐ tại bước duyệt rồi duyệt', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();
    const user = userEvent.setup();

    await user.selectOptions(await screen.findByLabelText('Danh mục đích'), CATEGORY_ID);
    await user.upload(screen.getByLabelText('File đề (.docx, .pdf)'), new File(['x'], 'de.docx'));
    await user.click(screen.getByRole('button', { name: 'Tải lên và tách câu' }));

    const tfCard = (await screen.findByText('2. Nước sôi ở 100 độ C.')).closest('[data-slot="card"]') as HTMLElement;
    const radios = within(tfCard).getAllByRole('radio');
    await user.click(radios[0]!); // đáp án đúng là "đúng"

    await user.selectOptions(within(tfCard).getByLabelText('Chọn môn học'), SUBJECT_ID);
    const outcomeSelect = within(tfCard).getByLabelText('Chọn yêu cầu cần đạt');
    await waitFor(() => {
      expect(within(tfCard).getByRole('option', { name: /Nhận biết được khái niệm hàm số/ })).toBeTruthy();
    });
    await user.selectOptions(outcomeSelect, OUTCOME_ID);
    await user.click(within(tfCard).getByRole('button', { name: 'Thêm YCCĐ' }));
    expect(within(tfCard).getByText('Nhận biết được khái niệm hàm số.')).toBeTruthy();

    await user.click(within(tfCard).getByRole('button', { name: 'Duyệt vào ngân hàng' }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes(`/items/${ITEM_TF}/approve`) && c.method === 'POST')).toBe(true);
    });
    const patch = calls.find((c) => c.url.includes(`/items/${ITEM_TF}`) && c.method === 'PATCH');
    const payload = (patch?.body as { payload: FakeItem['payload'] }).payload;
    expect(payload.truefalseCorrect).toBe(true);
    expect(payload.outcomeLinks).toEqual([{ outcomeId: OUTCOME_ID, cognitiveLevel: 'biet' }]);
  });
});
