import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { PermissionsProvider } from '#lib/permissions';
import { CourseAdminPage } from './course-admin';

/**
 * Spec khu xây dựng khoá học (course builder) theo endpoint thật của
 * controller Courses: section qua POST/PATCH/DELETE
 * /courses/:id/sections[/:sectionId], module qua POST
 * /courses/:id/modules và PATCH/DELETE /courses/:id/modules/:cmId, nội
 * dung hiện có qua GET /courses/:id/content. Khu này chỉ render khi người
 * dùng thuộc teaching của khoá — stub dưới đây khai ảnh chụp quyền
 * (GET /users/me/capabilities) của giáo viên có gán editingteacher tại
 * context khoá kèm grade:viewall và course:update, đúng
 * nguồn PermissionsProvider dùng để phân loại teaching.
 */
const TEACHER_ID = '01900000-0000-7000-8000-0000000000a2';
const COURSE_ID = '01900000-0000-7000-8000-000000000010';
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';
const SECTION_ID = '01900000-0000-7000-8000-000000000100';
const MODULE_ID = '01900000-0000-7000-8000-000000001000';

const PROFILE = {
  id: TEACHER_ID,
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

const COURSE = {
  id: COURSE_ID,
  category: CATEGORY_ID,
  fullName: 'Physics 101',
  shortName: 'PHY101',
  idNumber: '',
  summary: 'Mô tả khoá',
  format: 'topics',
  visible: true,
  startDate: null,
  endDate: null,
  groupMode: 0,
  enableCompletion: true,
};

const CONTENT = {
  course: COURSE,
  contextId: '01900000-0000-7000-8000-000000000055',
  customFields: [],
  sections: [
    {
      id: SECTION_ID,
      course: COURSE_ID,
      section: 0,
      name: 'General',
      summary: '',
      visible: true,
      availability: null,
      modules: [
        {
          id: MODULE_ID,
          course: COURSE_ID,
          section: SECTION_ID,
          component: 'mod_page',
          instanceId: '01900000-0000-7000-8000-000000000001',
          name: 'Welcome page',
          visible: true,
          groupMode: 0,
          availability: null,
          completion: 0,
          completionView: false,
        },
      ],
    },
  ],
};

const REPORT = {
  courseId: COURSE_ID,
  rows: [{ userId: '01900000-0000-7000-8000-000000000007', finalGrade: 85, letter: 'B' }],
};
const FORBIDDEN = { type: 'about:blank', title: 'Forbidden', status: 403, code: 'access.capability_denied' };

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub fetch ghi lại mọi lời gọi; mô phỏng giáo viên của khoá COURSE_ID trên các điểm dò quyền. */
function stubFetch(calls: RecordedCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities') {
        return respond({
          userId: TEACHER_ID,
          isSiteAdmin: false,
          assignments: [
            {
              id: '01900000-0000-7000-8000-0000000000f1',
              roleId: '01900000-0000-7000-8000-0000000000b9',
              roleShortname: 'editingteacher',
              roleName: 'Teacher',
              contextId: CONTENT.contextId,
              contextLevel: 50,
              contextPath: '/1/9/10',
              instanceId: COURSE_ID,
            },
          ],
          contexts: [
            {
              contextId: '01900000-0000-7000-8000-0000000000e1',
              contextLevel: 10,
              contextPath: '/1',
              capabilities: [],
            },
            {
              contextId: CONTENT.contextId,
              contextLevel: 50,
              contextPath: '/1/9/10',
              capabilities: [
                'grade:viewall',
                'course:update',
                'question:useall',
                'completion:manage',
              ],
            },
          ],
        });
      }
      if (url === '/api/v1/users?pageSize=1') return respond(FORBIDDEN, 403);
      if (url === '/api/v1/access/roles') return respond(FORBIDDEN, 403);
      if (url === '/api/v1/questions/categories') return respond([]);
      if (url === '/api/v1/courses' && method === 'GET') return respond([COURSE]);
      if (url === `/api/v1/courses/${COURSE_ID}/enrolments/me`)
        return respond({ courseId: COURSE_ID, userId: TEACHER_ID, enrolled: true, active: true });
      if (url === `/api/v1/courses/${COURSE_ID}/grades/report`) return respond(REPORT);
      if (url === `/api/v1/courses/${COURSE_ID}/gradebook`)
        return respond({ courseId: COURSE_ID, userId: TEACHER_ID, categories: [], courseTotal: null });
      if (url === `/api/v1/courses/${COURSE_ID}` && method === 'GET')
        return respond({ ...COURSE, contextId: CONTENT.contextId, customFields: [], formatOptions: {} });
      if (url === `/api/v1/courses/${COURSE_ID}/content`) return respond(CONTENT);
      if (url === `/api/v1/courses/${COURSE_ID}/sections` && method === 'POST') {
        return respond({
          id: '01900000-0000-7000-8000-000000000101',
          course: COURSE_ID,
          section: 1,
          name: 'Week 1',
          summary: '',
          visible: true,
          availability: null,
          modules: [],
        });
      }
      if (url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` && method === 'DELETE')
        return respond({ deleted: true });
      if (url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` && method === 'PATCH')
        return respond({ ...CONTENT.sections[0]!.modules[0] });
      if (url === `/api/v1/courses/${COURSE_ID}/sections/${SECTION_ID}` && method === 'PATCH')
        return respond({ ...CONTENT.sections[0], modules: undefined });
      if (url === `/api/v1/courses/${COURSE_ID}/groupings`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/grades/items`) return respond([]);
      // Các khu cũ của trang quản trị khoá: trả danh sách rỗng.
      if (url === `/api/v1/courses/${COURSE_ID}/groups`) return respond([]);
      if (url === '/api/v1/cohorts') return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/enrol/instances`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/enrolments`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/completion`) return respond([]);
      // Tiêu chí hoàn thành: PUT thay toàn bộ bộ tiêu chí, recalculate trả về số bản ghi đã tính lại.
      if (url === `/api/v1/courses/${COURSE_ID}/completion/criteria`) {
        if (init?.method === 'PUT') return respond({ method: 1, criteria: [] });
        return respond({ method: 1, criteria: [] });
      }
      if (url === `/api/v1/courses/${COURSE_ID}/completion/recalculate` && init?.method === 'POST')
        return respond({ courseId: COURSE_ID, enrolled: 1, evaluated: 1, completed: 0 });
      return respond({}, 404);
    }),
  );
}

/** Render trang quản trị khoá trong đúng khung provider của ứng dụng thật. */
function renderCourseAdmin() {
  localStorage.setItem('lms.accessToken', 'test-token');
  const router = createMemoryRouter([{ path: '/courses/:id/admin', element: <CourseAdminPage /> }], {
    initialEntries: [`/courses/${COURSE_ID}/admin`],
  });
  render(
    <TestProviders>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </TestProviders>,
  );
}

const GROUP_ID = '01900000-0000-7000-8000-000000002001';
const GROUPING_ID = '01900000-0000-7000-8000-000000002010';
const COHORT_ID = '01900000-0000-7000-8000-000000002020';
const MEMBER_ID = '01900000-0000-7000-8000-000000000007';
const NEW_MEMBER_ID = '01900000-0000-7000-8000-000000000008';

const GROUP_ROW = { id: GROUP_ID, courseId: COURSE_ID, name: 'Nhóm 1', idNumber: '', description: '' };
const COHORT_ROW = {
  id: COHORT_ID,
  name: 'K2026',
  idNumber: 'K26',
  description: '',
  contextId: '01900000-0000-7000-8000-0000000000e1',
  visible: true,
};

/**
 * Stub cho giáo viên có thêm `course:managegroups` tại context khoá
 * và `cohort:manage` — đúng hai capability backend đòi cho khu
 * grouping và thành viên cohort. Trạng thái grouping/thành viên giữ trong
 * closure để các thao tác POST/DELETE phản ánh lại ở lần GET sau.
 */
function stubFetchGroups(calls: RecordedCall[]) {
  let groupingList: { id: string; courseId: string; name: string; idNumber: string; description: string }[] = [];
  let groupingGroupList: (typeof GROUP_ROW)[] = [];
  let memberList: { userId: string; timeAdded: string }[] = [
    { userId: MEMBER_ID, timeAdded: '2026-01-02T00:00:00.000Z' },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities') {
        return respond({
          userId: TEACHER_ID,
          isSiteAdmin: false,
          assignments: [
            {
              id: '01900000-0000-7000-8000-0000000000f1',
              roleId: '01900000-0000-7000-8000-0000000000b9',
              roleShortname: 'editingteacher',
              roleName: 'Teacher',
              contextId: CONTENT.contextId,
              contextLevel: 50,
              contextPath: '/1/9/10',
              instanceId: COURSE_ID,
            },
          ],
          contexts: [
            {
              contextId: '01900000-0000-7000-8000-0000000000e1',
              contextLevel: 10,
              contextPath: '/1',
              capabilities: [],
            },
            {
              contextId: CONTENT.contextId,
              contextLevel: 50,
              contextPath: '/1/9/10',
              capabilities: [
                'grade:viewall',
                'course:update',
                'course:managegroups',
                'cohort:manage',
              ],
            },
          ],
        });
      }
      if (url === '/api/v1/courses' && method === 'GET') return respond([COURSE]);
      if (url === `/api/v1/courses/${COURSE_ID}/enrolments/me`)
        return respond({ courseId: COURSE_ID, userId: TEACHER_ID, enrolled: true, active: true });
      if (url === `/api/v1/courses/${COURSE_ID}/grades/report`) return respond(REPORT);
      if (url === `/api/v1/courses/${COURSE_ID}/gradebook`)
        return respond({ courseId: COURSE_ID, userId: TEACHER_ID, categories: [], courseTotal: null });
      if (url === `/api/v1/courses/${COURSE_ID}` && method === 'GET')
        return respond({ ...COURSE, contextId: CONTENT.contextId, customFields: [], formatOptions: {} });
      if (url === `/api/v1/courses/${COURSE_ID}/content`) return respond(CONTENT);
      if (url === `/api/v1/courses/${COURSE_ID}/groups`) return respond([GROUP_ROW]);
      if (url === `/api/v1/courses/${COURSE_ID}/groupings` && method === 'GET') return respond(groupingList);
      if (url === `/api/v1/courses/${COURSE_ID}/groupings` && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { name: string; idNumber?: string; description?: string };
        const created = {
          id: GROUPING_ID,
          courseId: COURSE_ID,
          name: body.name,
          idNumber: body.idNumber ?? '',
          description: body.description ?? '',
        };
        groupingList = [created];
        return respond(created);
      }
      if (url === `/api/v1/courses/${COURSE_ID}/groupings/${GROUPING_ID}/groups` && method === 'GET')
        return respond(groupingGroupList);
      if (url === `/api/v1/courses/${COURSE_ID}/groupings/${GROUPING_ID}/groups` && method === 'POST') {
        groupingGroupList = [GROUP_ROW];
        return respond({ added: true });
      }
      if (url === '/api/v1/cohorts') return respond([COHORT_ROW]);
      if (url === `/api/v1/cohorts/${COHORT_ID}/members` && method === 'GET') return respond(memberList);
      if (url === `/api/v1/cohorts/${COHORT_ID}/members` && method === 'POST') {
        memberList = [...memberList, { userId: NEW_MEMBER_ID, timeAdded: '2026-01-03T00:00:00.000Z' }];
        return respond({ added: true });
      }
      if (url === `/api/v1/cohorts/${COHORT_ID}/members/${MEMBER_ID}` && method === 'DELETE') {
        memberList = memberList.filter((m) => m.userId !== MEMBER_ID);
        return respond({ removed: true });
      }
      if (url === `/api/v1/courses/${COURSE_ID}/enrol/instances`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/enrolments`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/completion`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/grades/items`) return respond([]);
      return respond({}, 404);
    }),
  );
}

describe('Groupings & cohort members (teacher with manage capabilities)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('creates a grouping via POST /courses/:id/groupings', async () => {
    const calls: RecordedCall[] = [];
    stubFetchGroups(calls);
    renderCourseAdmin();

    await userEvent.type(await screen.findByLabelText('Tên grouping'), 'Tập A');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo grouping' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/groupings` && c.method === 'POST')).toBe(true),
    );
    const createCall = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/groupings` && c.method === 'POST');
    expect(createCall?.body).toEqual({ name: 'Tập A' });
    expect(await screen.findByTestId(`grouping-${GROUPING_ID}`)).toBeTruthy();
  });

  it('adds a course group into a grouping via POST groupings/:id/groups', async () => {
    const calls: RecordedCall[] = [];
    stubFetchGroups(calls);
    renderCourseAdmin();

    await userEvent.type(await screen.findByLabelText('Tên grouping'), 'Tập A');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo grouping' }));
    const groupingRow = await screen.findByTestId(`grouping-${GROUPING_ID}`);
    await userEvent.click(within(groupingRow).getByRole('button', { name: 'Xem nhóm trong grouping' }));
    // Select của @lms/ui: bấm trigger theo nhãn rồi bấm option theo chữ hiển thị.
    await userEvent.click(within(groupingRow).getByLabelText('Nhóm cần thêm vào grouping'));
    await userEvent.click(await screen.findByRole('option', { name: 'Nhóm 1' }));
    await userEvent.click(within(groupingRow).getByRole('button', { name: 'Thêm vào grouping' }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url === `/api/v1/courses/${COURSE_ID}/groupings/${GROUPING_ID}/groups` && c.method === 'POST',
        ),
      ).toBe(true),
    );
    const addCall = calls.find(
      (c) => c.url === `/api/v1/courses/${COURSE_ID}/groupings/${GROUPING_ID}/groups` && c.method === 'POST',
    );
    expect(addCall?.body).toEqual({ groupId: GROUP_ID });
    await waitFor(() => expect(within(groupingRow).getByText('Nhóm 1')).toBeTruthy());
  });

  it('lists, adds and removes cohort members through /cohorts/:id/members', async () => {
    const calls: RecordedCall[] = [];
    stubFetchGroups(calls);
    renderCourseAdmin();

    const cohortRow = await screen.findByTestId(`cohort-${COHORT_ID}`);
    await userEvent.click(within(cohortRow).getByRole('button', { name: 'Xem thành viên' }));
    await waitFor(() => expect(within(cohortRow).getByText(new RegExp(MEMBER_ID))).toBeTruthy());

    await userEvent.type(within(cohortRow).getByLabelText('ID người dùng thêm vào cohort'), NEW_MEMBER_ID);
    await userEvent.click(within(cohortRow).getByRole('button', { name: 'Thêm thành viên' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === `/api/v1/cohorts/${COHORT_ID}/members` &&
            c.method === 'POST' &&
            (c.body as { userId?: string })?.userId === NEW_MEMBER_ID,
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(within(cohortRow).getByText(new RegExp(NEW_MEMBER_ID))).toBeTruthy());

    const memberLine = within(cohortRow).getByText(new RegExp(MEMBER_ID)).closest('li');
    await userEvent.click(within(memberLine as HTMLElement).getByRole('button', { name: 'Gỡ khỏi cohort' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/cohorts/${COHORT_ID}/members/${MEMBER_ID}` && c.method === 'DELETE'),
      ).toBe(true),
    );
  });
});

const SUSPENDED_ID = '01900000-0000-7000-8000-000000000009';
const ENROL_INSTANCE_ID = '01900000-0000-7000-8000-000000000300';

/**
 * Stub cho khu quản trị NHÓM của khoá (GN-1/GN-3, issue #234): một nhóm
 * "Nhóm 1" có sẵn một thành viên; danh sách ghi danh của khoá gồm thành
 * viên đó (đang học), một học sinh đang học chưa thuộc nhóm và một học
 * sinh đã tạm khoá — bộ chọn thêm thành viên chỉ được hiện học sinh đang
 * ghi danh hiệu lực chưa thuộc nhóm. `manageGroups: false` mô phỏng giáo
 * viên không có `course:managegroups`: thấy nhóm/thành viên nhưng không
 * có công cụ quản lý. Trạng thái nhóm/thành viên/chế độ nhóm giữ trong
 * closure để các thao tác ghi phản ánh ở lần đọc sau.
 */
function stubFetchGroupAdmin(calls: RecordedCall[], opts?: { manageGroups?: boolean }) {
  const manageGroups = opts?.manageGroups ?? true;
  let groupList = [{ ...GROUP_ROW }];
  let groupMemberList: { userId: string; timeAdded: string }[] = [
    { userId: MEMBER_ID, timeAdded: '2026-01-02T00:00:00.000Z' },
  ];
  let courseState = { ...COURSE, groupMode: 0, groupModeForce: false };
  const enrolmentRows = [
    { id: '01900000-0000-7000-8000-000000000301', enrolId: ENROL_INSTANCE_ID, userId: MEMBER_ID, status: 0, timeStart: '2026-01-01T00:00:00.000Z', timeEnd: null, enrolMethod: 'manual' },
    { id: '01900000-0000-7000-8000-000000000302', enrolId: ENROL_INSTANCE_ID, userId: NEW_MEMBER_ID, status: 0, timeStart: '2026-01-01T00:00:00.000Z', timeEnd: null, enrolMethod: 'manual' },
    { id: '01900000-0000-7000-8000-000000000303', enrolId: ENROL_INSTANCE_ID, userId: SUSPENDED_ID, status: 1, timeStart: '2026-01-01T00:00:00.000Z', timeEnd: null, enrolMethod: 'manual' },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities') {
        return respond({
          userId: TEACHER_ID,
          isSiteAdmin: false,
          assignments: [
            {
              id: '01900000-0000-7000-8000-0000000000f1',
              roleId: '01900000-0000-7000-8000-0000000000b9',
              roleShortname: 'editingteacher',
              roleName: 'Teacher',
              contextId: CONTENT.contextId,
              contextLevel: 50,
              contextPath: '/1/9/10',
              instanceId: COURSE_ID,
            },
          ],
          contexts: [
            {
              contextId: '01900000-0000-7000-8000-0000000000e1',
              contextLevel: 10,
              contextPath: '/1',
              capabilities: [],
            },
            {
              contextId: CONTENT.contextId,
              contextLevel: 50,
              contextPath: '/1/9/10',
              capabilities: [
                'grade:viewall',
                'course:update',
                ...(manageGroups ? ['course:managegroups'] : []),
              ],
            },
          ],
        });
      }
      if (url === '/api/v1/courses' && method === 'GET') return respond([COURSE]);
      if (url === `/api/v1/courses/${COURSE_ID}/enrolments/me`)
        return respond({ courseId: COURSE_ID, userId: TEACHER_ID, enrolled: true, active: true });
      if (url === `/api/v1/courses/${COURSE_ID}` && method === 'GET')
        return respond({ ...courseState, contextId: CONTENT.contextId, customFields: [], formatOptions: {} });
      if (url === `/api/v1/courses/${COURSE_ID}` && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { groupMode?: number; groupModeForce?: boolean };
        courseState = {
          ...courseState,
          ...(body.groupMode !== undefined ? { groupMode: body.groupMode } : {}),
          ...(body.groupModeForce !== undefined ? { groupModeForce: body.groupModeForce } : {}),
        };
        return respond({ ...courseState, contextId: CONTENT.contextId, customFields: [], formatOptions: {} });
      }
      if (url === `/api/v1/courses/${COURSE_ID}/content`) return respond(CONTENT);
      if (url === `/api/v1/courses/${COURSE_ID}/groups` && method === 'GET') return respond(groupList);
      if (url === `/api/v1/courses/${COURSE_ID}/groups/${GROUP_ID}` && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { name?: string };
        groupList = groupList.map((g) => (g.id === GROUP_ID ? { ...g, ...(body.name ? { name: body.name } : {}) } : g));
        return respond(groupList.find((g) => g.id === GROUP_ID));
      }
      if (url === `/api/v1/courses/${COURSE_ID}/groups/${GROUP_ID}` && method === 'DELETE') {
        groupList = groupList.filter((g) => g.id !== GROUP_ID);
        return respond({ deleted: true });
      }
      if (url === `/api/v1/courses/${COURSE_ID}/groups/${GROUP_ID}/members` && method === 'GET')
        return respond(groupMemberList);
      if (url === `/api/v1/courses/${COURSE_ID}/groups/${GROUP_ID}/members` && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { userId: string };
        groupMemberList = [...groupMemberList, { userId: body.userId, timeAdded: '2026-01-03T00:00:00.000Z' }];
        return respond({ added: true });
      }
      if (url === `/api/v1/courses/${COURSE_ID}/groups/${GROUP_ID}/members/${MEMBER_ID}` && method === 'DELETE') {
        groupMemberList = groupMemberList.filter((m) => m.userId !== MEMBER_ID);
        return respond({ removed: true });
      }
      if (url === `/api/v1/courses/${COURSE_ID}/groupings`) return respond([]);
      if (url === '/api/v1/cohorts') return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/enrol/instances`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/enrolments`) return respond(enrolmentRows);
      if (url === `/api/v1/courses/${COURSE_ID}/completion`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/grades/items`) return respond([]);
      return respond({}, 404);
    }),
  );
}

describe('Course groups admin (GN-1/GN-3, issue #234)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('lists group members, adds an actively enrolled student from the picker and removes a member', async () => {
    const calls: RecordedCall[] = [];
    stubFetchGroupAdmin(calls);
    renderCourseAdmin();

    const groupRow = await screen.findByTestId(`group-${GROUP_ID}`);
    await userEvent.click(within(groupRow).getByRole('button', { name: 'Xem thành viên' }));
    await waitFor(() => expect(within(groupRow).getByText(new RegExp(MEMBER_ID))).toBeTruthy());

    // Bộ chọn chỉ có học sinh đang ghi danh hiệu lực chưa thuộc nhóm:
    // học sinh đã tạm khoá không xuất hiện.
    await userEvent.click(await within(groupRow).findByLabelText('Học sinh cần thêm vào nhóm'));
    expect(await screen.findByRole('option', { name: NEW_MEMBER_ID })).toBeTruthy();
    expect(screen.queryByRole('option', { name: SUSPENDED_ID })).toBeNull();
    await userEvent.click(screen.getByRole('option', { name: NEW_MEMBER_ID }));
    await userEvent.click(within(groupRow).getByRole('button', { name: 'Thêm vào nhóm' }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === `/api/v1/courses/${COURSE_ID}/groups/${GROUP_ID}/members` &&
            c.method === 'POST' &&
            (c.body as { userId?: string })?.userId === NEW_MEMBER_ID,
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(within(groupRow).getByText(new RegExp(NEW_MEMBER_ID))).toBeTruthy());

    const memberLine = within(groupRow).getByText(new RegExp(MEMBER_ID)).closest('li');
    await userEvent.click(within(memberLine as HTMLElement).getByRole('button', { name: 'Gỡ khỏi nhóm' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url === `/api/v1/courses/${COURSE_ID}/groups/${GROUP_ID}/members/${MEMBER_ID}` && c.method === 'DELETE',
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(within(groupRow).queryByText(new RegExp(MEMBER_ID))).toBeNull());
  });

  it('renames a group inline via PATCH and deletes it via DELETE after confirmation', async () => {
    const calls: RecordedCall[] = [];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    stubFetchGroupAdmin(calls);
    renderCourseAdmin();

    const groupRow = await screen.findByTestId(`group-${GROUP_ID}`);
    // Nút Đổi tên chỉ hiện sau khi ảnh chụp quyền (course:managegroups) tải xong — chờ bất đồng bộ.
    await userEvent.click(await within(groupRow).findByRole('button', { name: 'Đổi tên' }));
    const nameInput = within(groupRow).getByLabelText('Tên mới của nhóm Nhóm 1');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Nhóm 1 (đổi)');
    await userEvent.click(within(groupRow).getByRole('button', { name: 'Lưu tên' }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === `/api/v1/courses/${COURSE_ID}/groups/${GROUP_ID}` &&
            c.method === 'PATCH' &&
            (c.body as { name?: string })?.name === 'Nhóm 1 (đổi)',
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(within(groupRow).getByText('Nhóm 1 (đổi)')).toBeTruthy());

    await userEvent.click(within(groupRow).getByRole('button', { name: 'Xoá nhóm' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/groups/${GROUP_ID}` && c.method === 'DELETE'),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByTestId(`group-${GROUP_ID}`)).toBeNull());
  });

  it('saves the course group mode (mode + force) via PATCH /courses/:id', async () => {
    const calls: RecordedCall[] = [];
    stubFetchGroupAdmin(calls);
    renderCourseAdmin();

    await screen.findByTestId(`group-${GROUP_ID}`);
    // Thẻ chế độ nhóm chỉ hiện sau khi ảnh chụp quyền tải xong — chờ bất đồng bộ.
    await userEvent.click(await screen.findByLabelText('Chế độ nhóm'));
    await userEvent.click(await screen.findByRole('option', { name: 'Nhóm tách biệt' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Ép buộc chế độ này/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu chế độ nhóm' }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === `/api/v1/courses/${COURSE_ID}` &&
            c.method === 'PATCH' &&
            (c.body as { groupMode?: number; groupModeForce?: boolean })?.groupMode === 1 &&
            (c.body as { groupMode?: number; groupModeForce?: boolean })?.groupModeForce === true,
        ),
      ).toBe(true),
    );
  });

  it('a teacher without course:managegroups sees groups and members but no group management tools', async () => {
    const calls: RecordedCall[] = [];
    stubFetchGroupAdmin(calls, { manageGroups: false });
    renderCourseAdmin();

    const groupRow = await screen.findByTestId(`group-${GROUP_ID}`);
    expect(within(groupRow).queryByRole('button', { name: 'Đổi tên' })).toBeNull();
    expect(within(groupRow).queryByRole('button', { name: 'Xoá nhóm' })).toBeNull();
    expect(screen.queryByLabelText('Tên nhóm mới')).toBeNull();

    await userEvent.click(within(groupRow).getByRole('button', { name: 'Xem thành viên' }));
    await waitFor(() => expect(within(groupRow).getByText(new RegExp(MEMBER_ID))).toBeTruthy());
    expect(within(groupRow).queryByRole('button', { name: 'Gỡ khỏi nhóm' })).toBeNull();
    expect(within(groupRow).queryByLabelText('Học sinh cần thêm vào nhóm')).toBeNull();
  });
});
