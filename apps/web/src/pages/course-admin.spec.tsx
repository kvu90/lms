import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { PermissionsProvider } from '@/lib/permissions';
import { CourseAdminPage } from './course-admin';

/**
 * Spec khu xây dựng khoá học (course builder) theo endpoint thật của
 * controller Courses: section qua POST/PATCH/DELETE
 * /courses/:id/sections[/:sectionId], module qua POST
 * /courses/:id/modules và PATCH/DELETE /courses/:id/modules/:cmId, nội
 * dung hiện có qua GET /courses/:id/content. Khu này chỉ render khi người
 * dùng thuộc teaching của khoá — stub dưới đây khai ảnh chụp quyền
 * (GET /users/me/capabilities) của giáo viên có gán editingteacher tại
 * context khoá kèm moodle/grade:viewall và moodle/course:update, đúng
 * nguồn PermissionsProvider dùng để phân loại teaching.
 */
const TEACHER_ID = '01900000-0000-7000-8000-0000000000a2';
const COURSE_ID = '01900000-0000-7000-8000-000000000010';
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';
const SECTION_ID = '01900000-0000-7000-8000-000000000100';
const MODULE_ID = '01900000-0000-7000-8000-000000001000';

const PROFILE = {
  id: TEACHER_ID, username: 'teacher1', firstname: 'Lan Anh', lastname: 'Nguyễn', email: 'teacher1@example.com',
  suspended: false, deleted: false, isGuest: false, forcePasswordChange: false, lastlogin: null,
  timecreated: '2026-01-01T00:00:00.000Z', customFields: [],
};

const COURSE = {
  id: COURSE_ID, category: CATEGORY_ID, fullname: 'Physics 101', shortname: 'PHY101', idnumber: '', summary: 'Mô tả khoá',
  format: 'topics', visible: true, startdate: null, enddate: null, groupmode: 0, enablecompletion: true,
};

const CONTENT = {
  course: COURSE,
  contextId: '01900000-0000-7000-8000-000000000055',
  customFields: [],
  sections: [
    {
      id: SECTION_ID, course: COURSE_ID, section: 0, name: 'General', summary: '', visible: true, availability: null,
      modules: [
        {
          id: MODULE_ID, course: COURSE_ID, section: SECTION_ID, component: 'mod_page', instanceid: '01900000-0000-7000-8000-000000000001',
          name: 'Welcome page', visible: true, groupmode: 0, availability: null, completion: 0, completionview: false,
        },
      ],
    },
  ],
};

const REPORT = { courseId: COURSE_ID, rows: [{ userId: '01900000-0000-7000-8000-000000000007', finalgrade: 85, letter: 'B' }] };
const FORBIDDEN = { type: 'about:blank', title: 'Forbidden', status: 403, code: 'access.capability_denied' };

interface RecordedCall { url: string; method: string; body: unknown }

/** Stub fetch ghi lại mọi lời gọi; mô phỏng giáo viên của khoá COURSE_ID trên các điểm dò quyền. */
function stubFetch(calls: RecordedCall[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/v1/users/me') return respond(PROFILE);
    if (url === '/api/v1/users/me/capabilities') {
      return respond({
        userId: TEACHER_ID, isSiteAdmin: false,
        assignments: [{
          id: '01900000-0000-7000-8000-0000000000f1', roleId: '01900000-0000-7000-8000-0000000000b9',
          roleShortname: 'editingteacher', roleName: 'Teacher',
          contextId: CONTENT.contextId, contextLevel: 50, contextPath: '/1/9/10', instanceId: COURSE_ID,
        }],
        contexts: [
          { contextId: '01900000-0000-7000-8000-0000000000e1', contextLevel: 10, contextPath: '/1', capabilities: [] },
          { contextId: CONTENT.contextId, contextLevel: 50, contextPath: '/1/9/10', capabilities: ['moodle/grade:viewall', 'moodle/course:update', 'moodle/question:useall'] },
        ],
      });
    }
    if (url === '/api/v1/users?pageSize=1') return respond(FORBIDDEN, 403);
    if (url === '/api/v1/access/roles') return respond(FORBIDDEN, 403);
    if (url === '/api/v1/questions/categories') return respond([]);
    if (url === '/api/v1/courses' && method === 'GET') return respond([COURSE]);
    if (url === `/api/v1/courses/${COURSE_ID}/enrolments/me`) return respond({ courseId: COURSE_ID, userId: TEACHER_ID, enrolled: true, active: true });
    if (url === `/api/v1/courses/${COURSE_ID}/grades/report`) return respond(REPORT);
    if (url === `/api/v1/courses/${COURSE_ID}/gradebook`) return respond({ courseId: COURSE_ID, userId: TEACHER_ID, categories: [], courseTotal: null });
    if (url === `/api/v1/courses/${COURSE_ID}` && method === 'GET') return respond({ ...COURSE, contextId: CONTENT.contextId, customFields: [], formatOptions: {} });
    if (url === `/api/v1/courses/${COURSE_ID}/content`) return respond(CONTENT);
    if (url === `/api/v1/courses/${COURSE_ID}/sections` && method === 'POST') {
      return respond({ id: '01900000-0000-7000-8000-000000000101', course: COURSE_ID, section: 1, name: 'Week 1', summary: '', visible: true, availability: null, modules: [] });
    }
    if (url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` && method === 'DELETE') return respond({ deleted: true });
    // Các khu cũ của trang quản trị khoá: trả danh sách rỗng.
    if (url === `/api/v1/courses/${COURSE_ID}/groups`) return respond([]);
    if (url === '/api/v1/cohorts') return respond([]);
    if (url === `/api/v1/courses/${COURSE_ID}/enrol/instances`) return respond([]);
    if (url === `/api/v1/courses/${COURSE_ID}/enrolments`) return respond([]);
    if (url === `/api/v1/courses/${COURSE_ID}/completion`) return respond([]);
    return respond({}, 404);
  }));
}

/** Render trang quản trị khoá trong đúng khung provider của ứng dụng thật. */
function renderCourseAdmin() {
  localStorage.setItem('lms.accessToken', 'test-token');
  const router = createMemoryRouter(
    [{ path: '/courses/:id/admin', element: <CourseAdminPage /> }],
    { initialEntries: [`/courses/${COURSE_ID}/admin`] },
  );
  render(
    <AuthProvider>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </AuthProvider>,
  );
}

describe('Course builder (teacher)', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

  it('creates a section via POST /courses/:id/sections with the entered name', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseAdmin();

    await userEvent.type(await screen.findByLabelText('Tên section mới'), 'Week 1');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo section' }));

    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/sections` && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/sections` && c.method === 'POST');
    expect(createCall?.body).toEqual({ name: 'Week 1' });
  });

  it('deletes a module via DELETE /courses/:id/modules/:cmId after confirmation', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderCourseAdmin();

    const moduleRow = await screen.findByTestId(`module-builder-${MODULE_ID}`);
    await userEvent.click(within(moduleRow).getByRole('button', { name: 'Xoá module' }));

    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` && c.method === 'DELETE')).toBe(true));
  });
});
