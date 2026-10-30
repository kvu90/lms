import { cleanup, render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import QuestionsRoute from './questions';
import StimuliRoute from './question-stimuli';
import ExamsRoute from './exams';
import ExamPaperNewRoute from '#features/exams/routes/exam-paper-new';
import ExamPaperEditRoute from '#features/exams/routes/exam-paper-edit';
import LegacyExamPapersRoute from '#features/exams/routes/legacy-exam-papers';
import LegacyExamPaperNewRoute from '#features/exams/routes/legacy-exam-paper-new';
import LegacyExamPaperEditRoute from '#features/exams/routes/legacy-exam-paper-edit';
import MatricesRoute from './matrices';
import MatrixNewRoute from '#features/matrices/routes/question-matrix-new';
import MatrixEditRoute from '#features/matrices/routes/question-matrix-edit';
import LegacyMatrixNewRoute from '#features/matrices/routes/legacy-matrix-new';
import LegacyMatrixEditRoute from '#features/matrices/routes/legacy-matrix-edit';
import SystemBankRoute from './system-bank';
import SystemBankQuestionsRoute from './system-bank-questions';
import SystemBankExamsRoute from './system-bank-exams';
import LegacySystemBankPapersRoute from './legacy-system-bank-papers';
import SystemBankMatricesRoute from './system-bank-matrices';
import ContentBankRoute from '#features/content-bank/routes/content-bank';
import ContentBankNewRoute from '#features/content-bank/routes/content-bank-new';
import ContentBankEditRoute from '#features/content-bank/routes/content-bank-edit';
import LegacyContentBankRoute from '#features/content-bank/routes/legacy-contentbank';
import LegacyContentBankNewRoute from '#features/content-bank/routes/legacy-contentbank-new';
import LegacyContentBankEditRoute from '#features/content-bank/routes/legacy-contentbank-edit';

/**
 * Spec hợp nhất của lớp tương thích đường dẫn cũ (chuẩn đường dẫn
 * #221): cả hai họ URL cũ — cụm ngân hàng (query `?bank=...` và các
 * path `/exam-papers*`, `/questions/matrices/*`, `/system-bank/papers`)
 * và họ Kho học liệu viết dính `/contentbank*` — đều phải CHUYỂN
 * HƯỚNG THAY THẾ sang path mới tương ứng. Mỗi họ chạy bảng ca của
 * mình qua route module thật trong memory router và khẳng định
 * pathname (và phần query còn giữ) ở đích. Hai họ dùng hai stub
 * fetch khác nhau vì trang đích khác nhau: họ ngân hàng dùng hồ sơ
 * admin, họ kho học liệu dùng hồ sơ giáo viên.
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

const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';
const SYSTEM_CTX_ID = '01900000-0000-7000-8000-0000000000a1';
const ITEM_ID = '01900000-0000-7000-8000-0000000000e5';


/**
 * Lớp tương thích đường dẫn cũ (chuẩn đường dẫn #221, mục 3.5 của
 * hồ sơ): URL cũ ?bank=...&section=... và /questions/matrices/* phải
 * CHUYỂN HƯỚNG THAY THẾ sang path mới tương ứng — kiểm bằng route
 * module thật trong memory router, khẳng định pathname cuối cùng.
 * Query thuộc diện F2 còn lại (ngoài bank/section) được giữ nguyên.
 */
describe('URL ngân hàng cũ — chuyển hướng sang path mới (issue #221)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function stubRedirectFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond({ ...PROFILE, username: 'admin' });
        if (url === '/api/v1/users/me/capabilities')
          return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
        if (url === '/api/v1/courses') return respond([]);
        if (url === '/api/v1/questions/categories')
          return respond([{ id: CATEGORY_ID, name: 'General', contextId: SYSTEM_CTX_ID, info: '', parent: null }]);
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  }

  const MATRIX_ID = '01900000-0000-7000-8000-0000000000c9';
  const REDIRECT_CASES: Array<{ from: string; toPath: string; toSearch?: string }> = [
    { from: '/questions?bank=my-questions', toPath: '/questions', toSearch: '' },
    { from: '/questions?bank=my-questions&section=stimuli', toPath: '/questions/stimuli' },
    { from: '/questions?bank=my-papers', toPath: '/exams' },
    { from: '/questions?bank=my-matrices', toPath: '/matrices' },
    { from: '/questions?bank=system', toPath: '/system-bank/questions' },
    { from: '/questions?bank=system&section=questions', toPath: '/system-bank/questions' },
    { from: '/questions?bank=system&section=papers', toPath: '/system-bank/exams' },
    { from: '/questions?bank=system&section=matrices', toPath: '/system-bank/matrices' },
    { from: '/questions?bank=system&section=papers&x=1', toPath: '/system-bank/exams', toSearch: '?x=1' },
    { from: '/exam-papers', toPath: '/exams' },
    { from: '/exam-papers/new', toPath: '/exams/new' },
    { from: '/exam-papers/01900000-0000-7000-8000-0000000000d7/edit', toPath: '/exams/01900000-0000-7000-8000-0000000000d7/edit' },
    { from: '/system-bank/papers', toPath: '/system-bank/exams' },
    { from: '/questions/matrices/new', toPath: '/matrices/new' },
    { from: `/questions/matrices/${MATRIX_ID}/edit`, toPath: `/matrices/${MATRIX_ID}/edit` },
    { from: '/system-bank', toPath: '/system-bank/questions' },
  ];

  for (const redirectCase of REDIRECT_CASES) {
    it(`chuyển hướng ${redirectCase.from} → ${redirectCase.toPath}`, async () => {
      stubRedirectFetch();
      const router = createMemoryRouter(
        [
          { path: '/questions', element: <QuestionsRoute /> },
          { path: '/questions/stimuli', element: <StimuliRoute /> },
          { path: '/exams', element: <ExamsRoute /> },
          { path: '/exams/new', element: <ExamPaperNewRoute /> },
          { path: '/exams/:paperId/edit', element: <ExamPaperEditRoute /> },
          { path: '/exam-papers', element: <LegacyExamPapersRoute /> },
          { path: '/exam-papers/new', element: <LegacyExamPaperNewRoute /> },
          { path: '/exam-papers/:paperId/edit', element: <LegacyExamPaperEditRoute /> },
          { path: '/matrices', element: <MatricesRoute /> },
          { path: '/matrices/new', element: <MatrixNewRoute /> },
          { path: '/matrices/:matrixId/edit', element: <MatrixEditRoute /> },
          { path: '/questions/matrices/new', element: <LegacyMatrixNewRoute /> },
          { path: '/questions/matrices/:matrixId/edit', element: <LegacyMatrixEditRoute /> },
          { path: '/system-bank', element: <SystemBankRoute /> },
          { path: '/system-bank/questions', element: <SystemBankQuestionsRoute /> },
          { path: '/system-bank/exams', element: <SystemBankExamsRoute /> },
          { path: '/system-bank/papers', element: <LegacySystemBankPapersRoute /> },
          { path: '/system-bank/matrices', element: <SystemBankMatricesRoute /> },
        ],
        { initialEntries: [redirectCase.from] },
      );
      render(
        <TestProviders>
          <RouterProvider router={router} />
        </TestProviders>,
      );

      await waitFor(() => expect(router.state.location.pathname).toBe(redirectCase.toPath));
      if (redirectCase.toSearch !== undefined) {
        expect(router.state.location.search).toBe(redirectCase.toSearch);
      }
    });
  }
});

/**
 * Stub fetch cho họ kho học liệu: phiên giáo viên, bề mặt
 * contentbank trả danh sách rỗng; các endpoint khác 404.
 */
function stubContentBankRedirectFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities')
        return respond({ userId: PROFILE.id, isSiteAdmin: false, assignments: [], contexts: [] });
      if (url === '/api/v1/contentbank/spaces') return respond([]);
      if (url === '/api/v1/contentbank') return respond([]);
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const REDIRECT_CASES: Array<{ from: string; toPath: string; toSearch?: string }> = [
  { from: '/contentbank', toPath: '/content-bank', toSearch: '' },
  { from: '/contentbank?reviewStatus=pending', toPath: '/content-bank', toSearch: '?reviewStatus=pending' },
  { from: '/contentbank/new', toPath: '/content-bank/new', toSearch: '' },
  { from: `/contentbank/${ITEM_ID}/edit`, toPath: `/content-bank/${ITEM_ID}/edit`, toSearch: '' },
];

describe('URL kho học liệu cũ — chuyển hướng sang path mới (issue #221, R3)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  for (const redirectCase of REDIRECT_CASES) {
    it(`chuyển hướng ${redirectCase.from} → ${redirectCase.toPath}`, async () => {
      stubContentBankRedirectFetch();
      const router = createMemoryRouter(
        [
          { path: '/content-bank', element: <ContentBankRoute /> },
          { path: '/content-bank/new', element: <ContentBankNewRoute /> },
          { path: '/content-bank/:id/edit', element: <ContentBankEditRoute /> },
          { path: '/contentbank', element: <LegacyContentBankRoute /> },
          { path: '/contentbank/new', element: <LegacyContentBankNewRoute /> },
          { path: '/contentbank/:id/edit', element: <LegacyContentBankEditRoute /> },
        ],
        { initialEntries: [redirectCase.from] },
      );
      render(
        <TestProviders>
          <RouterProvider router={router} />
        </TestProviders>,
      );

      await waitFor(() => expect(router.state.location.pathname).toBe(redirectCase.toPath));
      if (redirectCase.toSearch !== undefined) {
        expect(router.state.location.search).toBe(redirectCase.toSearch);
      }
    });
  }
});
