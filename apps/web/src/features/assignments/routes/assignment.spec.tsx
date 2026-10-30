import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { AssignmentPage } from './assignment';

/**
 * Spec web của hoạt động Bài tập (mod_assign, issue #179) theo endpoint
 * thật: học sinh nộp tệp → chốt nộp → mở lại; giáo viên chấm nháp →
 * thả dấu → trả bài (từng em + theo đợt); học sinh sau khi được trả
 * thấy điểm/lời phê/dấu chấm trên bài của mình.
 */
const COURSE_ID = '01900000-0000-7000-8000-0000000000c1';
const ASSIGNMENT_ID = '01900000-0000-7000-8000-0000000000d1';
const STUDENT_ID = '01900000-0000-7000-8000-0000000000d2';
const STUDENT2_ID = '01900000-0000-7000-8000-0000000000d3';
const FILE_ID = '01900000-0000-7000-8000-0000000000d4';
const CRIT1_ID = '01900000-0000-7000-8000-0000000000d5';
const CRIT2_ID = '01900000-0000-7000-8000-0000000000d6';
const LEVEL_ID = '01900000-0000-7000-8000-0000000000d7';
const ANNOTATION_ID = '01900000-0000-7000-8000-0000000000d8';

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function record(calls: RecordedCall[], url: string, init?: RequestInit) {
  const method = init?.method ?? 'GET';
  let body: unknown;
  if (init?.body instanceof FormData) body = { formData: [...init.body.keys()] };
  else if (init?.body) {
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = String(init.body);
    }
  }
  calls.push({ url, method, body });
  return method;
}

const rubricFixture = {
  id: '01900000-0000-7000-8000-0000000000d9',
  assignmentId: ASSIGNMENT_ID,
  title: 'Tiêu chí chấm',
  criteria: [
    {
      id: CRIT1_ID, name: 'Đúng nội dung', descriptionForStudent: 'Đủ ý chính', descriptionForGrader: null,
      mode: 'levels', maxScore: null, outcomeId: null, outcomeText: null,
      levels: [{ id: LEVEL_ID, label: 'Tốt', score: 6 }],
    },
    {
      id: CRIT2_ID, name: 'Trình bày', descriptionForStudent: null, descriptionForGrader: null,
      mode: 'score', maxScore: 4, outcomeId: null, outcomeText: null, levels: [],
    },
  ],
};

const assignmentFixture = {
  id: ASSIGNMENT_ID,
  courseId: COURSE_ID,
  cmId: '01900000-0000-7000-8000-0000000000da',
  name: 'Bài tập chụp ảnh bài làm',
  intro: 'Chụp ảnh bài làm và nộp.',
  dueDate: new Date(Date.now() + 24 * 3600_000).toISOString(),
  maxFiles: 5,
  acceptedFileTypes: null,
  grade: 10,
  resultMode: 'score_feedback',
};

function renderPage() {
  const router = createMemoryRouter(
    [{ path: '/courses/:id/assignments/:assignmentId', element: <AssignmentPage /> }],
    { initialEntries: [`/courses/${COURSE_ID}/assignments/${ASSIGNMENT_ID}`] },
  );
  // Trang đã chuyển sang TanStack Query (F-01 đợt 1, #133): render qua
  // TestProviders để có QueryClient như cây provider thật ở root.
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Trang bài tập — luồng nộp bài của học viên', () => {
  it('nộp tệp → chốt nộp → mở lại → chốt nộp lại, trạng thái đi đúng vòng đời', async () => {
    const calls: RecordedCall[] = [];
    const state = {
      status: 'none' as string,
      files: [] as unknown[],
      submittedAt: null as string | null,
      attemptNumber: 0,
    };
    const view = () => ({
      assignment: assignmentFixture,
      rubric: rubricFixture,
      canSubmit: true,
      canManage: false,
      canGrade: false,
      canViewAllSubmissions: false,
      mySubmission: {
        submissionId: state.files.length ? 'sub-1' : null,
        status: state.status,
        attemptNumber: state.attemptNumber,
        submittedAt: state.submittedAt,
        late: false,
        files: state.files,
        grade: null,
        annotations: [],
        rubricEvaluations: [],
        feedbackMessages: [],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = record(calls, url, init);
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}`) return respond(view());
        if (url === '/api/v1/users/me') return respond({ id: STUDENT_ID });
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}/submission/files` && method === 'POST') {
          const file = {
            fileId: FILE_ID, fileName: 'bai-lam.jpg', fileSize: 2048, mimeType: 'image/jpeg',
            contentHash: 'abc', signedUrl: 'https://files.example/bai-lam.jpg', signedUrlExpiresAt: 1,
          };
          state.files = [file];
          state.status = 'draft';
          return respond(file, 201);
        }
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}/submission/submit` && method === 'POST') {
          state.status = 'submitted';
          state.submittedAt = new Date().toISOString();
          state.attemptNumber = 1;
          return respond({ ok: true });
        }
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}/submission/reopen` && method === 'POST') {
          state.status = 'draft';
          return respond({ ok: true });
        }
        return respond({}, 404);
      }),
    );

    renderPage();

    // Rubric công khai + trạng thái chưa nộp.
    const panel = await screen.findByTestId('assign-student-panel');
    expect(panel).toHaveTextContent('Chưa nộp');
    expect(screen.getByText('Đúng nội dung')).toBeTruthy();

    // Tải tệp lên → chuyển sang nháp, tệp hiện trong bài nộp.
    const input = within(panel).getByLabelText('Thêm tệp/ảnh vào bài nộp');
    await userEvent.upload(input, new File(['jpeg-bytes'], 'bai-lam.jpg', { type: 'image/jpeg' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Tải lên' }));
    await waitFor(() => expect(panel).toHaveTextContent('Bản nháp (chưa chốt nộp)'));
    expect(calls.some((c) => c.url.endsWith('/submission/files') && c.method === 'POST')).toBe(true);
    expect(within(panel).getByAltText('bai-lam.jpg')).toBeTruthy();

    // Chốt nộp → Đã nộp; mở lại → về nháp; chốt nộp lại.
    await userEvent.click(within(panel).getByRole('button', { name: 'Chốt nộp bài' }));
    await waitFor(() => expect(panel).toHaveTextContent('Đã nộp'));
    await userEvent.click(within(panel).getByRole('button', { name: 'Mở lại để sửa' }));
    await waitFor(() => expect(panel).toHaveTextContent('Bản nháp (chưa chốt nộp)'));
    await userEvent.click(within(panel).getByRole('button', { name: 'Chốt nộp bài' }));
    await waitFor(() => expect(panel).toHaveTextContent('Đã nộp'));
    expect(calls.filter((c) => c.url.endsWith('/submission/submit')).length).toBe(2);
    expect(calls.filter((c) => c.url.endsWith('/submission/reopen')).length).toBe(1);
  });

  it('bài nộp quá hạn hiện nhãn trễ và kết quả sau trả bài hiện điểm + lời phê + dấu chấm', async () => {
    const calls: RecordedCall[] = [];
    const past = new Date(Date.now() - 3600_000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        record(calls, url, init);
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}`) {
          return respond({
            assignment: { ...assignmentFixture, dueDate: past },
            rubric: rubricFixture,
            canSubmit: true,
            canManage: false,
            canGrade: false,
            canViewAllSubmissions: false,
            mySubmission: {
              submissionId: 'sub-1',
              status: 'graded',
              attemptNumber: 1,
              submittedAt: past,
              late: true,
              files: [
                {
                  fileId: FILE_ID, fileName: 'bai-lam.jpg', fileSize: 2048, mimeType: 'image/jpeg',
                  contentHash: 'abc', signedUrl: 'https://files.example/bai-lam.jpg', signedUrlExpiresAt: 1,
                },
              ],
              grade: {
                grade: 8.5, level: null, feedback: 'Làm tốt', feedbackProgress: null,
                feedbackStrengths: 'Đúng ý chính', feedbackWeaknesses: null,
                graderId: STUDENT2_ID, gradedAt: past, attemptNumber: 1, status: 'released', releasedAt: past,
              },
              annotations: [
                {
                  id: ANNOTATION_ID, submissionId: 'sub-1', fileId: FILE_ID, page: 1, x: 20, y: 30,
                  kind: 'correct', color: null, text: 'Đúng', points: null,
                  authorId: STUDENT2_ID, createdAt: past, updatedAt: past,
                },
              ],
              rubricEvaluations: [{ criterionId: CRIT1_ID, levelId: LEVEL_ID, score: null, note: null }],
              feedbackMessages: [],
            },
          });
        }
        if (url === '/api/v1/users/me') return respond({ id: STUDENT_ID });
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}/submissions/${STUDENT_ID}/messages`) {
          return respond({ id: 'm1', authorId: STUDENT_ID, body: 'Em cảm ơn cô', createdAt: past }, 201);
        }
        return respond({}, 404);
      }),
    );

    renderPage();

    const result = await screen.findByTestId('assign-result');
    expect(result).toHaveTextContent('Điểm: 8.5/10');
    expect(result).toHaveTextContent('Làm tốt');
    expect(result).toHaveTextContent('Đúng ý chính');
    expect(result).toHaveTextContent('Tốt (6)');
    // Nhãn trễ + dấu chấm đúng trên ảnh.
    expect(screen.getByTestId('assign-student-panel')).toHaveTextContent('Nộp trễ');
    expect(screen.getByTitle('Đúng')).toBeTruthy();

    // Học sinh gửi được tin trao đổi trên bài đã trả (khối hội thoại hiện sau khi /users/me về).
    await userEvent.type(await screen.findByLabelText('Trao đổi về bài này'), 'Em cảm ơn cô');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url === `/api/v1/assignments/${ASSIGNMENT_ID}/submissions/${STUDENT_ID}/messages` && c.method === 'POST',
        ),
      ).toBe(true),
    );
  });
});

describe('Trang bài tập — luồng chấm của giáo viên', () => {
  it('danh sách bài nộp → chấm nháp → thả dấu → trả bài từng em + theo đợt; sửa cài đặt qua PATCH', async () => {
    const calls: RecordedCall[] = [];
    const detail = {
      gradeStatus: 'none' as string,
      grade: null as null | Record<string, unknown>,
      annotations: [] as unknown[],
    };
    const summaries = [
      {
        userId: STUDENT_ID, displayName: 'Trần Minh Quân', status: 'submitted', attemptNumber: 1,
        submittedAt: new Date().toISOString(), late: false, fileCount: 1, grade: null, level: null,
        feedback: null, gradeStatus: 'none',
      },
      {
        userId: STUDENT2_ID, displayName: 'Phạm Thu Hằng', status: 'none', attemptNumber: 0,
        submittedAt: null, late: false, fileCount: 0, grade: null, level: null, feedback: null, gradeStatus: 'none',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = record(calls, url, init);
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}` && method === 'GET') {
          return respond({
            assignment: assignmentFixture,
            rubric: rubricFixture,
            canSubmit: false,
            canManage: true,
            canGrade: true,
            canViewAllSubmissions: true,
            mySubmission: {
              submissionId: null, status: 'none', attemptNumber: 0, submittedAt: null, late: false,
              files: [], grade: null, annotations: [], rubricEvaluations: [], feedbackMessages: [],
            },
          });
        }
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}` && method === 'PATCH') {
          return respond({ ...assignmentFixture, name: 'Bài tập đã sửa tên' });
        }
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}/submissions`) return respond(summaries);
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}/submissions/${STUDENT_ID}`) {
          return respond({
            userId: STUDENT_ID, status: 'submitted', attemptNumber: 1, submittedAt: new Date().toISOString(),
            late: false,
            files: [
              {
                fileId: FILE_ID, fileName: 'bai-lam.jpg', fileSize: 2048, mimeType: 'image/jpeg',
                contentHash: 'abc', signedUrl: 'https://files.example/bai-lam.jpg', signedUrlExpiresAt: 1,
              },
            ],
            grade: detail.grade, annotations: detail.annotations, rubricEvaluations: [],
            revisions: [], feedbackMessages: [],
          });
        }
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}/submissions/${STUDENT_ID}/annotations` && method === 'POST') {
          const ann = {
            id: ANNOTATION_ID, submissionId: 'sub-1', fileId: FILE_ID, page: 1, x: 0, y: 0, kind: 'correct',
            color: null, text: null, points: null, authorId: STUDENT2_ID,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          };
          detail.annotations = [ann];
          return respond(ann, 201);
        }
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}/submissions/${STUDENT_ID}/grade` && method === 'POST') {
          detail.grade = {
            grade: 8.5, level: null, feedback: '', feedbackProgress: null, feedbackStrengths: null,
            feedbackWeaknesses: null, graderId: STUDENT2_ID, gradedAt: new Date().toISOString(),
            attemptNumber: 1, status: 'draft', releasedAt: null,
          };
          return respond(detail.grade);
        }
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}/submissions/${STUDENT_ID}/release` && method === 'POST') {
          detail.grade = { ...(detail.grade as Record<string, unknown>), status: 'released' };
          return respond(detail.grade);
        }
        if (url === `/api/v1/assignments/${ASSIGNMENT_ID}/release-batch` && method === 'POST') {
          return respond({ releasedCount: 1, skippedUserIds: [STUDENT2_ID] });
        }
        if (url === '/api/v1/assign-comment-bank') return respond([]);
        return respond({}, 404);
      }),
    );

    renderPage();

    // Danh sách bài nộp có tên học sinh + trạng thái (tải bất đồng bộ — chờ tên hiện).
    const teacherPanel = await screen.findByTestId('assign-teacher-panel');
    await within(teacherPanel).findByText('Trần Minh Quân');
    expect(teacherPanel).toHaveTextContent('Trần Minh Quân');
    expect(teacherPanel).toHaveTextContent('Phạm Thu Hằng');
    expect(teacherPanel).toHaveTextContent('Chưa chấm');

    // Mở bề mặt chấm của học sinh đã nộp.
    const gradeButtons = within(teacherPanel).getAllByRole('button', { name: 'Chấm bài' });
    await userEvent.click(gradeButtons[0]!);
    const grading = await screen.findByTestId('assign-grading-panel');
    expect(grading).toHaveTextContent('Chấm bài: Trần Minh Quân');
    expect(within(grading).getByAltText('bai-lam.jpg')).toBeTruthy();

    // Thả dấu đúng lên ảnh (jsdom: rect bằng 0 nên điểm rơi về (0,0) — vẫn là một lần POST hợp lệ).
    const img = within(grading).getByAltText('bai-lam.jpg');
    const wrap = img.parentElement!;
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    await userEvent.click(img);
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/assignments/${ASSIGNMENT_ID}/submissions/${STUDENT_ID}/annotations` && c.method === 'POST'),
      ).toBe(true),
    );
    const annCall = calls.find((c) => c.url.endsWith('/annotations') && c.method === 'POST');
    expect(annCall?.body).toMatchObject({ fileId: FILE_ID, kind: 'correct' });

    // Lưu gói chấm nháp với điểm 8.5.
    await userEvent.type(within(grading).getByLabelText('Điểm (thang 10)'), '8.5');
    await userEvent.click(within(grading).getByRole('button', { name: 'Lưu gói chấm (nháp)' }));
    await waitFor(() => expect(grading).toHaveTextContent('Đã lưu gói chấm nháp'));
    const gradeCall = calls.find((c) => c.url.endsWith('/grade') && c.method === 'POST');
    expect(gradeCall?.body).toMatchObject({ grade: 8.5 });

    // Trả bài cho học sinh này.
    await userEvent.click(within(grading).getByRole('button', { name: 'Trả bài cho học sinh này' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/release') && c.method === 'POST')).toBe(true),
    );

    // Trả bài theo đợt: kết quả hiện rõ số trả/số bỏ qua.
    await userEvent.click(within(teacherPanel).getByRole('button', { name: 'Trả bài theo đợt' }));
    await waitFor(() => expect(teacherPanel).toHaveTextContent('Đã trả 1 bài; bỏ qua 1 bài chưa đủ điều kiện.'));

    // Sửa cài đặt: đổi tên bài → PATCH.
    const manage = await screen.findByTestId('assign-manage-panel');
    const nameInput = within(manage).getByLabelText('Tên bài tập');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Bài tập đã sửa tên');
    await userEvent.click(within(manage).getByRole('button', { name: 'Lưu cài đặt' }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/assignments/${ASSIGNMENT_ID}` && c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.url === `/api/v1/assignments/${ASSIGNMENT_ID}` && c.method === 'PATCH');
    expect(patch?.body).toMatchObject({ name: 'Bài tập đã sửa tên', resultMode: 'score_feedback' });
  });
});
