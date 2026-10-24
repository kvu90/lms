import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { usePermissions } from './permissions';

/**
 * Bảo chứng phân loại khoá dạy/học theo định nghĩa “thuộc khoá” đã chốt
 * ở #33 (việc nối tiếp #66): thuộc khoá = ghi danh đang hiệu lực ∪ gán
 * vai tại context khoá. Trước fix, permissions.tsx chỉ tính ghi danh
 * (enrolments/me chỉ đọc user_enrolments) nên giáo viên được gán vai
 * tại khoá mà không ghi danh — đúng thiết kế seed — rơi vào cả hai
 * danh sách đều rỗng và trang tổng quan báo chưa ghi danh khoá nào.
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
  if (scenario === 'student-assigned') {
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

const ENROLLED: Record<Scenario, boolean> = {
  'teacher-assigned': false,
  'student-enrolled': true,
  'student-assigned': false,
  outsider: false,
};

function stubFetch(scenario: Scenario) {
  const me =
    scenario === 'teacher-assigned'
      ? profile(TEACHER_ID, 'teacher1')
      : scenario === 'outsider'
        ? profile(OUTSIDER_ID, 'outsider1')
        : profile(STUDENT_ID, 'student1');
  const enrolled = ENROLLED[scenario];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/users/me') return respond(200, me);
      if (url === '/api/v1/users/me/capabilities') return respond(200, accessView(scenario));
      if (url === '/api/v1/courses') return respond(200, [COURSE]);
      if (url === `/api/v1/courses/${COURSE_ID}/enrolments/me`) {
        return respond(200, { courseId: COURSE_ID, userId: me.id, enrolled, active: enrolled });
      }
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
  localStorage.setItem('lms.accessToken', 'test-token');
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
