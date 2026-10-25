import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { VnBooksSection } from './grades-vn-books';

const COURSE_ID = '01900000-0000-7000-8000-000000000010';
const BOOK_ID = '01900000-0000-7000-8000-0000000000b1';
const STUDENT_ID = '01900000-0000-7000-8000-000000000007';
const ITEM_TX1 = '01900000-0000-7000-8000-000000000101';
const ITEM_CK = '01900000-0000-7000-8000-000000000104';
const BASE = `/api/v1/courses/${COURSE_ID}/grades/vn-books`;

const BOOK = { id: BOOK_ID, courseId: COURSE_ID, term: 'hk1', assessmentMode: 'score', subjectPeriodsPerYear: 35 };
const ITEMS = [
  { id: ITEM_TX1, itemName: 'ĐĐGtx 1', vnRole: 'dgtx', vnOrdinal: 1 },
  { id: ITEM_CK, itemName: 'ĐĐGck', vnRole: 'dgck', vnOrdinal: 1 },
];

function gridWith(students: unknown[]) {
  return { book: BOOK, items: ITEMS, students };
}

const ROW_FINALIZED_DIVERGED = {
  userId: STUDENT_ID,
  userName: 'Nguyen Van A',
  computation: {
    complete: true,
    dtbHk: 6.1,
    columns: [
      { itemId: ITEM_TX1, role: 'dgtx', ordinal: 1, grade: 8, status: 'graded' },
      { itemId: ITEM_CK, role: 'dgck', ordinal: 1, grade: 4, status: 'graded' },
    ],
  },
  snapshot: { dtbHk: 8.3, commentResult: null, version: 1 },
  published: false,
  sourceDiverged: true,
};

/** Stub fetch trả {status, body} theo route; route lạ → 404. Ghi lại mọi lời gọi để khẳng định. */
function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const found = handler(url, init);
      if (!found) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(found.body), {
        status: found.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

function ok(body: unknown) {
  return { status: 200, body };
}

function renderSection() {
  render(
    <TestProviders>
      <VnBooksSection courseId={COURSE_ID} />
    </TestProviders>,
  );
}

describe('VnBooksSection (sổ điểm VN, issue #183)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('hiện lưới điểm cột, ĐTB tính trực tiếp, bản chốt và nhãn lệch nguồn', async () => {
    stubFetch((url) => {
      if (url === BASE) return ok([BOOK]);
      if (url === `${BASE}/${BOOK_ID}/grid`) return ok(gridWith([ROW_FINALIZED_DIVERGED]));
      if (url === `${BASE}/${BOOK_ID}/candidates`) return ok({ bookId: BOOK_ID, candidates: [] });
      return undefined;
    });
    renderSection();
    expect(await screen.findByText('Nguyen Van A')).toBeTruthy();
    expect(screen.getByText('ĐĐGtx 1')).toBeTruthy();
    expect(screen.getByText('ĐĐGck')).toBeTruthy();
    // ĐTB trực tiếp 6.1 (đã tính lại sau sửa cột) và bản chốt cũ 8.3 cùng hiện, kèm nhãn lệch nguồn.
    expect(screen.getByText('6.1')).toBeTruthy();
    expect(screen.getByText('8.3')).toBeTruthy();
    expect(screen.getByText(/Lệch nguồn/)).toBeTruthy();
  });

  it('chốt cả lớp bị chặn: hiện đích danh học sinh bị chặn và lý do chờ kiểm tra bù', async () => {
    stubFetch((url, init) => {
      if (url === BASE) return ok([BOOK]);
      if (url === `${BASE}/${BOOK_ID}/grid`) return ok(gridWith([ROW_FINALIZED_DIVERGED]));
      if (url === `${BASE}/${BOOK_ID}/candidates`) return ok({ bookId: BOOK_ID, candidates: [] });
      if (url === `${BASE}/${BOOK_ID}/finalize-all` && init?.method === 'POST') {
        return {
          status: 400,
          body: {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            code: 'grades.vn_finalize_book_blocked',
            blockedStudents: [{ userId: STUDENT_ID, reason: 'awaiting_makeup', roles: ['dggk'] }],
          },
        };
      }
      return undefined;
    });
    renderSection();
    await screen.findByText('Nguyen Van A');
    await userEvent.click(screen.getByRole('button', { name: 'Chốt cả lớp' }));
    expect(await screen.findByText(/Chưa chốt được cả lớp/)).toBeTruthy();
    expect(screen.getByText(/còn chờ kiểm tra bù/)).toBeTruthy();
  });

  it('sổ tt27: lưới mức 3 mức TT 27 — lưu cả lớp gửi mức mặc định + ngoại lệ trong một lượt gọi batch', async () => {
    const STUDENT_B = '01900000-0000-7000-8000-000000000008';
    const TT27_BOOK = {
      id: BOOK_ID, courseId: COURSE_ID, term: 'hk1', regime: 'tt27', assessmentMode: 'comment', subjectPeriodsPerYear: null,
    };
    const rowOf = (userId: string, userName: string) => ({
      userId, userName, computation: null, snapshot: null, published: false, sourceDiverged: false,
    });
    const calls = stubFetch((url, init) => {
      if (url === BASE) return ok([TT27_BOOK]);
      if (url === `${BASE}/${BOOK_ID}/grid`) return ok({ book: TT27_BOOK, items: [], students: [rowOf(STUDENT_ID, 'Nguyen Van A'), rowOf(STUDENT_B, 'Nguyen Van B')] });
      if (url === `${BASE}/${BOOK_ID}/candidates`) return ok({ bookId: BOOK_ID, candidates: [] });
      if (url === `${BASE}/${BOOK_ID}/comment-results/batch` && init?.method === 'POST') {
        return ok({ bookId: BOOK_ID, savedCount: 2, results: [] });
      }
      return undefined;
    });
    renderSection();
    expect(await screen.findByText('Nguyen Van B')).toBeTruthy();
    // Mức mặc định cả lớp khởi tạo là "Hoàn thành" (mức giữa của TT 27).
    expect(screen.getByLabelText('Mức mặc định cả lớp')).toBeTruthy();
    // Học sinh B là ngoại lệ: đổi mức riêng thành "Chưa hoàn thành".
    await userEvent.click(screen.getByLabelText('Nguyen Van B — Kết quả nhận xét'));
    await userEvent.click(await screen.findByRole('option', { name: 'Chưa hoàn thành' }));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu mức cả lớp' }));
    expect(await screen.findByText(/Đã lưu mức cho 2 học sinh/)).toBeTruthy();
    const batchCall = calls.find((c) => c.url === `${BASE}/${BOOK_ID}/comment-results/batch`);
    expect(batchCall).toBeTruthy();
    expect(JSON.parse(String(batchCall!.init?.body))).toEqual({
      defaultResult: 'Hoàn thành',
      overrides: [{ userId: STUDENT_B, result: 'Chưa hoàn thành' }],
    });
  });

  it('sửa ô điểm của học sinh đã chốt: cảnh báo lệch nguồn hiện TRƯỚC khi lưu, huỷ thì không gọi API lưu điểm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const calls = stubFetch((url) => {
      if (url === BASE) return ok([BOOK]);
      if (url === `${BASE}/${BOOK_ID}/grid`) return ok(gridWith([ROW_FINALIZED_DIVERGED]));
      if (url === `${BASE}/${BOOK_ID}/candidates`) return ok({ bookId: BOOK_ID, candidates: [] });
      return undefined;
    });
    renderSection();
    const input = await screen.findByLabelText('Nguyen Van A — ĐĐGck');
    await userEvent.clear(input);
    await userEvent.type(input, '5');
    const saveButtons = screen.getAllByRole('button', { name: 'Lưu' });
    await userEvent.click(saveButtons[saveButtons.length - 1]!);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('LỆCH NGUỒN');
    // Giáo viên huỷ ở cảnh báo → tuyệt đối không có lời gọi lưu điểm.
    expect(calls.some((c) => c.url.includes('/grades/items/'))).toBe(false);
  });
});
