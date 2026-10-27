import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { TeacherCurriculumPage } from './teacher-curriculum';

/**
 * Spec trang xem chương trình của GIÁO VIÊN (issue #161, lát T2):
 * bảng chương trình theo mẫu Bộ (Mạch nội dung | Nội dung | Yêu cầu
 * cần đạt) đọc qua ngữ cảnh khoá giáo viên dạy (`forCourseId` trên
 * mọi lời gọi curriculum), chế độ chỉ xem (không nút Sửa/Xoá/Thêm),
 * YCCĐ nhiều dòng giữ cấu trúc dòng (điểm T3), và 403 hiện thông báo
 * giải thích đúng trường hợp thay vì trang trắng.
 */

const SUBJECT = { id: 'subj-toan', contextId: 'ctx-sys', name: 'Toán', slug: 'toan', position: 1 };
const COURSE = {
  id: 'course-1',
  category: 'cat-1',
  fullName: 'Toán 5 — lớp 5A',
  shortName: 'TOAN5A',
  idNumber: '',
  summary: '',
  format: 'topics',
  visible: true,
  startDate: null,
  endDate: null,
  groupMode: 0,
  groupModeForce: false,
  enableCompletion: false,
  subjectId: 'subj-toan',
  grade: 5,
  isTemplate: false,
  sortOrder: 0,
};

/** Cây có một YCCĐ NHIỀU DÒNG (ý cha + ý con đã tách dòng ở dataset) để chốt điểm T3. */
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
              content: 'Thực hiện được các phép tính với số có nhiều chữ số:\n– Cộng, trừ các số có nhiều chữ số.\n– Nhân, chia với số có hai chữ số.',
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
}

/**
 * Stub fetch ghi lại lời gọi. `mode`:
 * - 'ok': giáo viên có khoá dạy, mọi lời đọc curriculum mang forCourseId đều qua.
 * - 'forbidden-with-course': có khoá nhưng API trả 403 (khoá không cấp quyền xem).
 * - 'no-course': không có khoá nào và đọc trực tiếp cũng 403.
 */
function stubFetch(calls: RecordedCall[], mode: 'ok' | 'forbidden-with-course' | 'no-course' = 'ok') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/courses') return respond(mode === 'no-course' ? [] : [COURSE]);
      if (url === '/api/v1/access/contexts') return respond([{ id: 'ctx-sys', contextLevel: 10 }]);
      if (url.includes('/curriculum/') && mode !== 'ok') {
        return respond(
          { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Thiếu capability', code: 'access.capability_denied' },
          403,
        );
      }
      if (url.startsWith('/api/v1/curriculum/subjects?')) return respond([SUBJECT]);
      if (url.startsWith('/api/v1/curriculum/curricula?')) return respond([{ id: 'curr-5', subjectId: 'subj-toan', grade: 5 }]);
      if (url.startsWith('/api/v1/curriculum/curricula/curr-5/tree')) return respond(TREE);
      return respond({}, 404);
    }),
  );
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/curriculum', element: <TeacherCurriculumPage /> }], {
    initialEntries: ['/curriculum'],
  });
  // Trang đọc dữ liệu qua TanStack Query (F-01 của #133) nên render
  // trong TestProviders như mọi spec trang đã chuyển khuôn.
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

describe('Teacher curriculum page', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('hiện bảng chương trình theo mẫu Bộ qua ngữ cảnh khoá dạy, YCCĐ nhiều dòng giữ cấu trúc dòng, không nút thao tác', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    // Bảng mẫu Bộ: mạch làm tiêu đề nhóm, hai cột Nội dung | Yêu cầu cần đạt.
    expect(await screen.findByText('Số và phép tính')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Nội dung' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Yêu cầu cần đạt' })).toBeInTheDocument();
    expect(screen.getByText('Đọc, viết được các số có nhiều chữ số')).toBeInTheDocument();
    // Điểm T3: từng dòng của YCCĐ là một phần tử riêng (không dính thành một đoạn).
    expect(screen.getByText('Thực hiện được các phép tính với số có nhiều chữ số:')).toBeInTheDocument();
    expect(screen.getByText('– Cộng, trừ các số có nhiều chữ số.')).toBeInTheDocument();
    expect(screen.getByText('– Nhân, chia với số có hai chữ số.')).toBeInTheDocument();
    // Truy vết nguồn vẫn hiện như bề mặt quản trị.
    expect(screen.getByText(/Nguồn: Thông tư 32\/2018\/TT-BGDĐT/)).toBeInTheDocument();

    // Mọi lời đọc curriculum đều qua ngữ cảnh khoá giáo viên dạy.
    const curriculumCalls = calls.filter((c) => c.url.includes('/curriculum/'));
    expect(curriculumCalls.length).toBeGreaterThanOrEqual(3);
    expect(curriculumCalls.every((c) => c.url.includes('forCourseId=course-1'))).toBe(true);

    // Chỉ xem: không nút Sửa/Xoá/Thêm nào của khu quản trị.
    expect(screen.queryByRole('button', { name: 'Sửa' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Xoá' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Thêm/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Thêm/ })).not.toBeInTheDocument();
  });

  it('hiện thông báo khoá không cấp quyền khi API trả 403 dù đã chọn khoá', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, 'forbidden-with-course');
    renderPage();

    expect(await screen.findByText(/Khoá đã chọn không cấp quyền xem chương trình/)).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Nội dung' })).not.toBeInTheDocument();
  });

  it('hiện giải thích chưa có khoá dạy khi người dùng không có khoá và đọc trực tiếp bị 403', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, 'no-course');
    renderPage();

    expect(await screen.findByText(/Bạn chưa có khoá nào đang dạy/)).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Nội dung' })).not.toBeInTheDocument();
  });
});
