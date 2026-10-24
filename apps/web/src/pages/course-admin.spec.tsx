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

describe('Course completion criteria (teacher with completion:manage)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('saves the criteria set via PUT /courses/:id/completion/criteria with an activity-completion criterion', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseAdmin();

    const box = await screen.findByTestId('completion-criteria');
    await userEvent.selectOptions(within(box).getByLabelText('Cách tổng hợp tiêu chí'), '2');
    await userEvent.click(within(box).getByRole('button', { name: 'Thêm tiêu chí' }));
    await userEvent.selectOptions(within(box).getByLabelText('Loại tiêu chí'), 'module');
    await userEvent.click(within(box).getByRole('button', { name: 'Lưu tiêu chí hoàn thành' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/completion/criteria` && c.method === 'PUT'),
      ).toBe(true),
    );
    const put = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/completion/criteria` && c.method === 'PUT');
    expect(put?.body).toEqual({ method: 2, criteria: [{ criteriaType: 'module', moduleInstance: MODULE_ID }] });
  });
});

describe('Course builder (teacher)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('creates a section via POST /courses/:id/sections with the entered name', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseAdmin();

    await userEvent.type(await screen.findByLabelText('Tên section mới'), 'Week 1');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo section' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/sections` && c.method === 'POST')).toBe(true),
    );
    const createCall = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/sections` && c.method === 'POST');
    expect(createCall?.body).toEqual({ name: 'Week 1' });
  });

  it('saves a module availability tree via PATCH /courses/:id/modules/:cmId', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseAdmin();

    const availabilityBox = await screen.findByTestId(`module-availability-${MODULE_ID}`);
    await userEvent.selectOptions(within(availabilityBox).getByLabelText('Loại điều kiện mới'), 'date');
    await userEvent.click(within(availabilityBox).getByRole('button', { name: 'Thêm điều kiện' }));
    await userEvent.click(within(availabilityBox).getByRole('button', { name: 'Lưu điều kiện truy cập' }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` &&
            c.method === 'PATCH' &&
            (c.body as { availability?: unknown })?.availability != null,
        ),
      ).toBe(true),
    );
    const patch = calls.find(
      (c) =>
        c.url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` &&
        c.method === 'PATCH' &&
        (c.body as { availability?: unknown })?.availability != null,
    );
    const tree = (patch?.body as { availability: { op: string; c: { type: string; d: string; t: number }[] } })
      .availability;
    expect(tree.op).toBe('&');
    expect(tree.c).toHaveLength(1);
    expect(tree.c[0]?.type).toBe('date');
    expect(tree.c[0]?.d).toBe('>=');
    expect(typeof tree.c[0]?.t).toBe('number');
  });

  it('deletes a module via DELETE /courses/:id/modules/:cmId after confirmation', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderCourseAdmin();

    const moduleRow = await screen.findByTestId(`module-builder-${MODULE_ID}`);
    await userEvent.click(within(moduleRow).getByRole('button', { name: 'Xoá module' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` && c.method === 'DELETE'),
      ).toBe(true),
    );
  });
});

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
    await userEvent.selectOptions(within(groupingRow).getByLabelText('Nhóm cần thêm vào grouping'), GROUP_ID);
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
