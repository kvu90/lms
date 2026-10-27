import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { TestProviders } from '#test/providers';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { usePermissions } from './permissions';
import { useCourseGradeData, useCoursesGradeData } from './course-grade-data';

/**
 * Bảo chứng phân loại khoá dạy/học theo định nghĩa “thuộc khoá” đã chốt
 * ở #33 (việc nối tiếp #66): thuộc khoá = ghi danh đang hiệu lực ∪ gán
 * vai tại context khoá. Trước fix #66, permissions.tsx chỉ tính ghi
 * danh (enrolments/me chỉ đọc user_enrolments) nên giáo viên được gán
 * vai tại khoá mà không ghi danh — đúng thiết kế seed — rơi vào cả hai
 * danh sách đều rỗng và trang tổng quan báo chưa ghi danh khoá nào.
 *
 * Từ F-02 (rà soát #133, issue #149) phân loại suy TRỌN từ ảnh chụp
 * capabilities, provider không còn gọi enrolments/me nữa: phía API,
 * nửa “ghi danh” của hợp nhất luôn hiện diện trong ảnh chụp dưới dạng
 * gán vai — tầng ghi danh chốt roleId cho mọi instance (mặc định vai
 * học viên), ghi danh thì cấp vai đó tại context khoá, rút ghi danh
 * thì gỡ vai, đình chỉ thì giữ vai. Fixture dưới đây mô phỏng đúng
 * hợp đồng đó: học sinh “đã ghi danh” có gán vai student trong ảnh
 * chụp hệt học sinh được gán vai trực tiếp.
 */

const TEACHER_ID = '01900000-0000-7000-8000-0000000000a2';
const STUDENT_ID = '01900000-0000-7000-8000-0000000000a3';
const OUTSIDER_ID = '01900000-0000-7000-8000-0000000000a4';
const COURSE_ID = '01900000-0000-7000-8000-000000000010';
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';
const SYS_CTX_ID = '01900000-0000-7000-8000-0000000000e1';
const COURSE_CTX_ID = '01900000-0000-7000-8000-0000000000e2';

const COURSE = {
  id: COURSE_ID,
  category: CATEGORY_ID,
  fullName: 'Khoá học mẫu',
  shortName: 'DEMO101',
  idNumber: '',
  summary: '',
  format: 'topics',
  visible: true,
  startDate: null,
  endDate: null,
  groupMode: 0,
  enableCompletion: true,
};

function profile(id: string, username: string) {
  return {
    id,
    username,
    firstName: 'Người',
    lastName: 'Dùng',
    email: `${username}@example.com`,
    suspended: false,
    deleted: false,
    isGuest: false,
    forcePasswordChange: false,
    lastLogin: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    customFields: [],
  };
}

function assignment(roleShortname: string, roleName: string) {
  return {
    id: '01900000-0000-7000-8000-0000000000f1',
    roleId: '01900000-0000-7000-8000-0000000000b9',
    roleShortname,
    roleName,
    contextId: COURSE_CTX_ID,
    contextLevel: 50,
    contextPath: '/1/9/10',
    instanceId: COURSE_ID,
  };
}

/** Ảnh chụp quyền (GET /users/me/capabilities) theo từng kịch bản. */
function accessView(scenario: Scenario) {
  const base = {
    userId:
      scenario === 'teacher-assigned'
        ? TEACHER_ID
        : scenario === 'outsider'
          ? OUTSIDER_ID
          : STUDENT_ID,
    isSiteAdmin: false,
    contexts: [
      { contextId: SYS_CTX_ID, contextLevel: 10, contextPath: '/1', capabilities: [] as string[] },
    ],
  };
  if (scenario === 'teacher-assigned') {
    return {
      ...base,
      assignments: [assignment('editingteacher', 'Giáo viên phụ trách')],
      contexts: [
        ...base.contexts,
        {
          contextId: COURSE_CTX_ID,
          contextLevel: 50,
          contextPath: '/1/9/10',
          capabilities: ['grade:viewall', 'course:update'],
        },
      ],
    };
  }
  if (scenario === 'student-assigned' || scenario === 'student-enrolled') {
    // Hai kịch bản cho cùng một ảnh chụp: API vật chất hoá ghi danh
    // thành gán vai student tại context khoá, nên học sinh đã ghi danh
    // và học sinh được gán vai trực tiếp không phân biệt được — và
    // không cần phân biệt — trong ảnh chụp.
    return {
      ...base,
      assignments: [assignment('student', 'Học viên')],
      contexts: [
        ...base.contexts,
        { contextId: COURSE_CTX_ID, contextLevel: 50, contextPath: '/1/9/10', capabilities: ['course:view'] },
      ],
    };
  }
  return { ...base, assignments: [] };
}

type Scenario = 'teacher-assigned' | 'student-enrolled' | 'student-assigned' | 'outsider';

/** Mọi URL fetch đã gọi trong lần render hiện tại (để đếm request F-02). */
const fetchCalls: string[] = [];

function stubFetch(scenario: Scenario) {
  fetchCalls.length = 0;
  const me =
    scenario === 'teacher-assigned'
      ? profile(TEACHER_ID, 'teacher1')
      : scenario === 'outsider'
        ? profile(OUTSIDER_ID, 'outsider1')
        : profile(STUDENT_ID, 'student1');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchCalls.push(url);
      const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      // Phiên cookie Better Auth: id phiên khớp hồ sơ của kịch bản.
      if (isGetSessionUrl(url)) return respond(200, baSessionBody({ id: me.id, username: me.username, email: me.email }));
      if (url === '/api/v1/users/me') return respond(200, me);
      if (url === '/api/v1/users/me/capabilities') return respond(200, accessView(scenario));
      if (url === '/api/v1/courses') return respond(200, [COURSE]);
      // KHÔNG stub enrolments/me: provider không được gọi nó nữa —
      // nếu còn gọi, URL rơi về 404 ở đây và ca đếm request bắt được.
      // Dữ liệu hiển thị theo khoá không quyết định phân loại; trả rỗng/403 đều được.
      return respond(404, {});
    }),
  );
}

function ClassificationProbe() {
  const p = usePermissions();
  return (
    <div>
      <div data-testid="ready">{String(p.ready)}</div>
      <div data-testid="course-count">{p.courses.length}</div>
      <div data-testid="teaching">{p.teaching.map((c) => c.course.shortName).join(',')}</div>
      <div data-testid="learning">{p.learning.map((c) => c.course.shortName).join(',')}</div>
    </div>
  );
}

async function renderClassification(scenario: Scenario) {
  stubFetch(scenario);
  // AuthProvider cần context router (giống dashboard.spec): thiếu router
  // thì phiên không dựng được, provider quyền trả trạng thái rỗng.
  const router = createMemoryRouter([{ path: '/', element: <ClassificationProbe /> }]);
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
  // Chờ đủ dữ liệu thật: provider trả ready=true cả ở trạng thái chưa
  // đăng nhập (danh sách rỗng), nên phải chờ danh sách khoá nạp xong
  // (course-count = 1) mới đọc phân loại, tránh đọc trạng thái rỗng đầu.
  await waitFor(() => {
    expect(screen.getByTestId('ready')).toHaveTextContent('true');
    expect(screen.getByTestId('course-count')).toHaveTextContent('1');
  });
  return {
    teaching: screen.getByTestId('teaching').textContent ?? '',
    learning: screen.getByTestId('learning').textContent ?? '',
  };
}

describe('Phân loại khoá dạy/học theo định nghĩa thuộc khoá #33', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('giáo viên được gán vai tại khoá (không ghi danh) thấy khoá ở nhóm teaching', async () => {
    const { teaching, learning } = await renderClassification('teacher-assigned');
    expect(teaching).toBe('DEMO101');
    expect(learning).toBe('');
  });

  it('học sinh ghi danh còn hiệu lực thấy khoá ở nhóm learning', async () => {
    const { teaching, learning } = await renderClassification('student-enrolled');
    expect(teaching).toBe('');
    expect(learning).toBe('DEMO101');
  });

  it('người được gán vai học viên tại context khoá (không ghi danh) vào nhóm learning', async () => {
    const { teaching, learning } = await renderClassification('student-assigned');
    expect(teaching).toBe('');
    expect(learning).toBe('DEMO101');
  });

  it('người ngoài (không ghi danh, không gán vai) không thấy khoá ở nhóm nào', async () => {
    const { teaching, learning } = await renderClassification('outsider');
    expect(teaching).toBe('');
    expect(learning).toBe('');
  });
});

describe('F-02: provider không còn fan-out theo số khoá khi nạp app', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const OTHER_1 = { ...COURSE, id: '01900000-0000-7000-8000-000000000011', shortName: 'OTHER1' };
  const OTHER_2 = { ...COURSE, id: '01900000-0000-7000-8000-000000000012', shortName: 'OTHER2' };

  function stubTeacherApp(courseList: unknown[]) {
    fetchCalls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchCalls.push(url);
        const respond = (status: number, body: unknown) =>
          new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(200, baSessionBody({ id: TEACHER_ID, username: 'teacher1' }));
        if (url === '/api/v1/users/me') return respond(200, profile(TEACHER_ID, 'teacher1'));
        if (url === '/api/v1/users/me/capabilities') return respond(200, accessView('teacher-assigned'));
        if (url === '/api/v1/courses') return respond(200, courseList);
        if (url.endsWith('/gradebook/report')) return respond(200, { rows: [], items: [] });
        if (url.endsWith('/gradebook')) return respond(200, { activities: [] });
        return respond(404, {});
      }),
    );
  }

  function renderApp(element: ReactNode) {
    const router = createMemoryRouter([{ path: '/', element }]);
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
  }

  it('nạp app chỉ tốn đúng 2 request của provider (capabilities + courses), 0 request theo khoá', async () => {
    stubTeacherApp([COURSE, OTHER_1, OTHER_2]);
    renderApp(<ClassificationProbe />);
    await waitFor(() => {
      expect(screen.getByTestId('course-count')).toHaveTextContent('3');
      expect(screen.getByTestId('teaching')).toHaveTextContent('DEMO101');
    });
    // Cho mọi query đang bay cơ hội lộ diện trước khi kết luận số request.
    await waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('true');
    });
    // Trước thay đổi này: provider tự dò thêm report + gradebook cho
    // từng khoá thuộc về (tổng 2 + 2N request; N=1 ở fixture này → 4).
    // Nay dữ liệu điểm KHÔNG còn qua provider: 0 request theo khoá.
    const perCourseCalls = fetchCalls.filter((u) => /\/courses\/[0-9a-f-]{36}\//.test(u));
    expect(perCourseCalls).toEqual([]);
    expect(fetchCalls).not.toEqual(expect.arrayContaining([expect.stringContaining('enrolments/me')]));
    // Request phiên get-session là của AuthProvider (sau cutover cookie
    // #257 nó luôn đi kèm khi nạp app), không phải của provider quyền —
    // loại khỏi số đếm; khẳng định về provider quyền giữ nguyên.
    const providerCalls = fetchCalls.filter((u) => u !== '/api/v1/users/me' && !isGetSessionUrl(u));
    expect(providerCalls.sort()).toEqual(['/api/v1/courses', '/api/v1/users/me/capabilities']);
  });

  function GradeProbe() {
    const many = useCoursesGradeData([COURSE_ID, OTHER_1.id]);
    const single = useCourseGradeData(COURSE_ID);
    return (
      <div>
        <div data-testid="many-report">{many.get(COURSE_ID)?.report ? 'yes' : 'no'}</div>
        <div data-testid="single-report">{single.data?.report ? 'yes' : 'no'}</div>
      </div>
    );
  }

  it('dữ liệu điểm tải lười tại bề mặt tiêu thụ: đúng khoá được yêu cầu, hai hook cùng khoá dedupe còn 1 lượt', async () => {
    stubTeacherApp([COURSE, OTHER_1, OTHER_2]);
    renderApp(<GradeProbe />);
    await waitFor(() => {
      expect(screen.getByTestId('many-report')).toHaveTextContent('yes');
      expect(screen.getByTestId('single-report')).toHaveTextContent('yes');
    });
    const callsFor = (id: string, suffix: string) =>
      fetchCalls.filter((u) => u === `/api/v1/courses/${id}${suffix}`).length;
    // Khoá được yêu cầu: mỗi endpoint đúng 1 lượt dù hai hook cùng đọc.
    expect(callsFor(COURSE_ID, '/gradebook/report')).toBe(1);
    expect(callsFor(COURSE_ID, '/gradebook')).toBe(1);
    expect(callsFor(OTHER_1.id, '/gradebook/report')).toBe(1);
    expect(callsFor(OTHER_1.id, '/gradebook')).toBe(1);
    // Khoá không bề mặt nào yêu cầu: không tốn request nào.
    expect(callsFor(OTHER_2.id, '/gradebook/report')).toBe(0);
    expect(callsFor(OTHER_2.id, '/gradebook')).toBe(0);
  });
});

describe('F-15: provider phơi trạng thái lỗi của query capabilities', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function ErrorProbe() {
    const p = usePermissions();
    return (
      <div>
        <div data-testid="ready">{String(p.ready)}</div>
        <div data-testid="capabilities-error">{p.capabilitiesError ? p.capabilitiesError.message : 'none'}</div>
        <div data-testid="teaching-count">{p.teaching.length}</div>
        <div data-testid="can-view-users">{String(p.canViewUsers)}</div>
      </div>
    );
  }

  it('capabilities trả 500: capabilitiesError khác null, phân loại vẫn suy biến mềm về rỗng', async () => {
    fetchCalls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchCalls.push(url);
        const respond = (status: number, body: unknown) =>
          new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(200, baSessionBody({ id: TEACHER_ID, username: 'teacher1' }));
        if (url === '/api/v1/users/me') return respond(200, profile(TEACHER_ID, 'teacher1'));
        if (url === '/api/v1/users/me/capabilities')
          return respond(500, { type: 'about:blank', title: 'Lỗi máy chủ', status: 500, detail: 'boom', code: 'test.boom' });
        if (url === '/api/v1/courses') return respond(200, [COURSE]);
        return respond(404, {});
      }),
    );
    const router = createMemoryRouter([{ path: '/', element: <ErrorProbe /> }]);
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('true');
      expect(screen.getByTestId('capabilities-error')).toHaveTextContent('boom');
    });
    // Suy biến mềm giữ nguyên: không cờ nào bật, không khoá nào được xếp loại.
    expect(screen.getByTestId('teaching-count')).toHaveTextContent('0');
    expect(screen.getByTestId('can-view-users')).toHaveTextContent('false');
  });
});
