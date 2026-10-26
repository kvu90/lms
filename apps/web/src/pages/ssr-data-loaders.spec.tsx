/**
 * Kiểm chứng luồng nghiệp vụ của lát SL-1 (#7) — server loader +
 * dehydrate cho 5 route đã có TanStack:
 *
 *   (a) Người dùng CÓ phiên: loader của từng route trả dehydrated
 *       state chứa ĐÚNG các query key hiện hữu của trang đó, trạng
 *       thái success, dữ liệu đúng như API trả — để trang mở ra là
 *       hiện dữ liệu ngay. Riêng dashboard: dữ liệu điểm theo khoá
 *       chỉ prefetch cho khoá người dùng thuộc về, và khối quản trị
 *       chỉ prefetch khi có quyền quản trị — loader không rò dữ liệu
 *       ngoài vai của phiên, cũng không thiếu dữ liệu của vai đó.
 *   (b) Hydrate state vào cache phía client rồi render hook thật của
 *       trang: dữ liệu của server hiện ngay và KHÔNG phát sinh fetch
 *       trùng cho cùng query (đây là giá trị nghiệp vụ của lát —
 *       trang hết vòng chờ + tải hai lần).
 *   (c) CHƯA đăng nhập: loader không gọi bất kỳ API dữ liệu nghiệp
 *       vụ nào và trả state rỗng — mặt công khai (bản prerender)
 *       không dính dữ liệu cá nhân.
 *
 * Cộng kiểm chứng tính tất định của hai helper khoảng ngày theo
 * múi giờ ứng dụng: mốc biên tháng/tuần phải ra cùng một khoảng ở
 * mọi múi giờ của tiến trình chạy test, vì server (UTC) và client
 * (VN) phải tính ra cùng một query key.
 *
 * Cách kiểm: stub `fetch` ở biên mạng (loader gọi API nội bộ qua
 * URL tuyệt đối như `lib/server-api.ts`), so dữ liệu dehydrate với
 * payload stub theo từng query key — không soi chi tiết triển khai
 * trong của loader ngoài các key/dữ liệu mà trang thật tiêu thụ.
 */
import { render, screen } from '@testing-library/react';
import { QueryClientProvider, hashKey, hydrate, type DehydratedState } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { currentMonthRangeIso, upcomingDaysRangeIso, useCalendarEvents } from '../lib/calendar';
import { loader as calendarLoader } from './calendar';
import { loader as badgesLoader } from './badges';
import { loader as siteConfigLoader } from './admin-site-config';
import { loader as notificationsLoader } from './notifications';
import { loader as homeLoader } from '../routes/home-index';

/** Cookie phiên Better Auth như trình duyệt gửi kèm request đã đăng nhập. */
const SESSION_COOKIE = 'better-auth.session_token=phien-thu';

function sessionRequest(path: string): Request {
  return new Request(`http://localhost${path}`, { headers: { Cookie: SESSION_COOKIE } });
}

function anonymousRequest(path: string): Request {
  return new Request(`http://localhost${path}`);
}

interface StubRoute {
  status?: number;
  body: unknown;
}

/**
 * Stub fetch theo pathname: loader gọi URL tuyệt đối tới API nội bộ,
 * phía client gọi đường dẫn tương đối — cả hai đều quy về pathname.
 * Trả spy để đếm lượt gọi (khẳng định "không fetch trùng/không gọi
 * khi ẩn danh" là khẳng định về số lượt gọi này).
 */
function stubApi(routes: Record<string, StubRoute>) {
  const spy = vi.fn(async (input: unknown) => {
    const raw = typeof input === 'string' ? input : (input as { url: string }).url;
    const pathname = new URL(raw, 'http://localhost').pathname;
    const route = routes[pathname];
    if (!route) return { ok: false, status: 404, json: async () => ({ title: 'Not Found' }) };
    const status = route.status ?? 200;
    return { ok: status < 400, status, json: async () => route.body };
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** Tìm một query trong dehydrated state theo query key của trang. */
function findQuery(state: DehydratedState, key: readonly unknown[]) {
  return state.queries.find((q) => q.queryHash === hashKey(key));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SL-1 — khoảng ngày theo múi giờ ứng dụng (tất định hai phía)', () => {
  it('mốc 00:30 ngày 1/11 giờ VN thuộc khoảng tháng 11, không phải tháng 10', () => {
    // 2026-10-31T17:30:00Z = 00:30 ngày 01/11/2026 giờ Việt Nam.
    const range = currentMonthRangeIso(new Date('2026-10-31T17:30:00.000Z'));
    expect(range).toEqual({
      from: '2026-10-31T17:00:00.000Z',
      to: '2026-11-30T16:59:59.999Z',
    });
  });

  it('giữa tháng 10 giờ VN cho đúng biên tháng 10', () => {
    // 2026-10-26T02:00:00Z = 09:00 ngày 26/10/2026 giờ Việt Nam.
    const range = currentMonthRangeIso(new Date('2026-10-26T02:00:00.000Z'));
    expect(range).toEqual({
      from: '2026-09-30T17:00:00.000Z',
      to: '2026-10-31T16:59:59.999Z',
    });
  });

  it('cửa sổ 30 ngày của dashboard bắt đầu từ 00:00 hôm nay giờ VN và dài đúng 30 ngày', () => {
    const range = upcomingDaysRangeIso(30, new Date('2026-10-26T02:00:00.000Z'));
    expect(range).toEqual({
      from: '2026-10-25T17:00:00.000Z',
      to: '2026-11-24T17:00:00.000Z',
    });
  });
});

const CALENDAR_EVENTS = [
  {
    id: 'ev-1',
    name: 'Họp phụ huynh trực tuyến',
    timeStart: '2026-10-27T02:00:00.000Z',
    timeEnd: '2026-10-27T03:00:00.000Z',
  },
];

function stubCalendarApi() {
  return stubApi({
    '/api/v1/calendar/events': { body: CALENDAR_EVENTS },
    '/api/v1/calendar/subscriptions': { body: [] },
    '/api/v1/calendar/export-token': {
      body: { token: 'token-xuat-lich', url: 'https://lms.example/calendar.ics' },
    },
  });
}

describe('SL-1 — loader /calendar', () => {
  it('có phiên: dehydrate đủ ba query của trang với đúng dữ liệu API', async () => {
    stubCalendarApi();
    const { dehydratedState } = await calendarLoader({ request: sessionRequest('/calendar') });

    const range = currentMonthRangeIso();
    expect(findQuery(dehydratedState, queryKeys.calendarEvents(range.from, range.to))?.state.data).toEqual(
      CALENDAR_EVENTS,
    );
    expect(findQuery(dehydratedState, queryKeys.calendarSubscriptions)?.state.status).toBe('success');
    expect(findQuery(dehydratedState, queryKeys.calendarExportToken)?.state.data).toEqual({
      token: 'token-xuat-lich',
      url: 'https://lms.example/calendar.ics',
    });
  });

  it('chưa đăng nhập: không gọi API nào, state rỗng (mặt công khai sạch)', async () => {
    const spy = stubCalendarApi();
    const { dehydratedState } = await calendarLoader({ request: anonymousRequest('/calendar') });
    expect(spy).not.toHaveBeenCalled();
    expect(dehydratedState.queries).toEqual([]);
  });

  it('hydrate vào client: hook của trang hiện dữ liệu server ngay, không fetch trùng', async () => {
    const serverSpy = stubCalendarApi();
    const { dehydratedState } = await calendarLoader({ request: sessionRequest('/calendar') });
    serverSpy.mockClear();

    // Phía client sau điều hướng: fetch stub trả dữ liệu KHÁC hẳn —
    // nếu trang fetch lại thì tên sự kiện mới sẽ thắng và test đỏ.
    const clientSpy = stubApi({
      '/api/v1/calendar/events': {
        body: [{ id: 'ev-2', name: 'Sự kiện chỉ có khi fetch lại phía client' }],
      },
    });
    const client = createQueryClient();
    hydrate(client, dehydratedState);

    function Probe() {
      const range = currentMonthRangeIso();
      const events = useCalendarEvents(range.from, range.to);
      return <div>{events.data?.map((e) => e.name).join(' | ')}</div>;
    }
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Họp phụ huynh trực tuyến')).toBeInTheDocument();
    expect(clientSpy).not.toHaveBeenCalled();
  });
});

describe('SL-1 — loader /badges', () => {
  it('có phiên: dehydrate huy hiệu của tôi + danh mục huy hiệu', async () => {
    stubApi({
      '/api/v1/badges/mine': { body: [{ id: 'mine-1', badgeName: 'Ngôi sao tuần' }] },
      '/api/v1/badges': { body: [{ id: 'all-1', name: 'Huy hiệu hệ thống' }] },
    });
    const { dehydratedState } = await badgesLoader({ request: sessionRequest('/badges') });
    expect(findQuery(dehydratedState, queryKeys.myBadges)?.state.data).toEqual([
      { id: 'mine-1', badgeName: 'Ngôi sao tuần' },
    ]);
    expect(findQuery(dehydratedState, queryKeys.badgesAll)?.state.data).toEqual([
      { id: 'all-1', name: 'Huy hiệu hệ thống' },
    ]);
  });

  it('chưa đăng nhập: không gọi API, state rỗng', async () => {
    const spy = stubApi({});
    const { dehydratedState } = await badgesLoader({ request: anonymousRequest('/badges') });
    expect(spy).not.toHaveBeenCalled();
    expect(dehydratedState.queries).toEqual([]);
  });
});

describe('SL-1 — loader /admin/site-config', () => {
  it('có phiên + quyền: dehydrate cấu hình + nhật ký kiểm toán', async () => {
    stubApi({
      '/api/v1/site-config': { body: [{ key: 'site_name', value: 'LMS Thử nghiệm' }] },
      '/api/v1/site-config/audit': { body: [{ id: 'audit-1', key: 'site_name' }] },
    });
    const { dehydratedState } = await siteConfigLoader({
      request: sessionRequest('/admin/site-config'),
    });
    expect(findQuery(dehydratedState, queryKeys.siteConfig)?.state.data).toEqual([
      { key: 'site_name', value: 'LMS Thử nghiệm' },
    ]);
    expect(findQuery(dehydratedState, queryKeys.siteConfigAudit)?.state.data).toEqual([
      { id: 'audit-1', key: 'site_name' },
    ]);
  });

  it('API từ chối (403): query lỗi KHÔNG lọt vào state — trang client tự báo không quyền như trước', async () => {
    stubApi({
      '/api/v1/site-config': { status: 403, body: { title: 'Forbidden' } },
      '/api/v1/site-config/audit': { body: [] },
    });
    const { dehydratedState } = await siteConfigLoader({
      request: sessionRequest('/admin/site-config'),
    });
    expect(findQuery(dehydratedState, queryKeys.siteConfig)).toBeUndefined();
    expect(findQuery(dehydratedState, queryKeys.siteConfigAudit)?.state.status).toBe('success');
  });
});

describe('SL-1 — loader /notifications', () => {
  it('có phiên: dehydrate trang đầu bộ lọc mặc định + tuỳ chọn + ghi đè theo khoá (đã bóc mảng courses)', async () => {
    const page = { items: [], nextCursor: 'con-tro-2' };
    stubApi({
      '/api/v1/notifications': { body: page },
      '/api/v1/messages/preferences': { body: [{ id: 'pref-1' }] },
      '/api/v1/messages/preferences/courses': { body: { courses: [{ courseId: 'course-1', muted: true }] } },
    });
    const { dehydratedState } = await notificationsLoader({
      request: sessionRequest('/notifications'),
    });

    const groups = findQuery(dehydratedState, queryKeys.notificationGroups('all', false));
    expect(groups?.state.status).toBe('success');
    expect((groups?.state.data as { pages: unknown[] }).pages).toEqual([page]);

    expect(findQuery(dehydratedState, queryKeys.messagePreferences)?.state.data).toEqual([
      { id: 'pref-1' },
    ]);
    // Trang kỳ vọng MẢNG ghi đè (queryFn phía client bóc .courses) —
    // dehydrate phải mang đúng hình mảng đó, không phải nguyên thân đáp ứng.
    expect(findQuery(dehydratedState, queryKeys.messageCourseOverrides)?.state.data).toEqual([
      { courseId: 'course-1', muted: true },
    ]);
  });

  it('chưa đăng nhập: không gọi API, state rỗng', async () => {
    const spy = stubApi({});
    const { dehydratedState } = await notificationsLoader({
      request: anonymousRequest('/notifications'),
    });
    expect(spy).not.toHaveBeenCalled();
    expect(dehydratedState.queries).toEqual([]);
  });
});

/** Ảnh chụp quyền của một học viên thuộc đúng một khoá (gán vai tại context khoá). */
const STUDENT_ACCESS = {
  userId: '11111111-1111-7111-8111-111111111111',
  isSiteAdmin: false,
  hasLearnerArtifacts: true,
  assignments: [
    {
      id: '22222222-2222-7222-8222-222222222222',
      roleId: '33333333-3333-7333-8333-333333333333',
      roleShortname: 'student',
      roleName: 'Học viên',
      contextId: '44444444-4444-7444-8444-444444444444',
      contextLevel: 50,
      contextPath: '/1/3/9',
      instanceId: 'course-1',
    },
  ],
  contexts: [
    {
      contextId: '55555555-5555-7555-8555-555555555555',
      contextLevel: 10,
      contextPath: '/1',
      capabilities: [],
    },
    {
      contextId: '44444444-4444-7444-8444-444444444444',
      contextLevel: 50,
      contextPath: '/1/3/9',
      capabilities: ['grade:view'],
    },
  ],
};

const GRADE_REPORT = { courseId: 'course-1', rows: [] };
const GRADEBOOK = { courseId: 'course-1', items: [] };

function stubHomeApi(access: unknown) {
  return stubApi({
    '/api/v1/users/me/capabilities': { body: access },
    '/api/v1/courses': { body: [{ id: 'course-1', category: 'cat-1', fullname: 'Toán 10' }] },
    '/api/v1/dashboard/overview': { body: { days: 7 } },
    '/api/v1/badges/mine': { body: [] },
    '/api/v1/notifications/unread-count': { body: { unread: 3 } },
    '/api/v1/calendar/events': { body: CALENDAR_EVENTS },
    '/api/v1/courses/course-1/grades/report': { body: GRADE_REPORT },
    '/api/v1/courses/course-1/gradebook': { body: GRADEBOOK },
    '/api/v1/users': { body: { users: [], total: 0 } },
    '/api/v1/courses/categories/tree': { body: [] },
    '/api/v1/access/roles': { body: [] },
  });
}

describe('SL-1 — loader / (dashboard)', () => {
  it('học viên: dehydrate query gốc + khối học viên + điểm của khoá thuộc về; KHÔNG có query quản trị', async () => {
    stubHomeApi(STUDENT_ACCESS);
    const { dehydratedState } = await homeLoader({ request: sessionRequest('/') });

    expect(findQuery(dehydratedState, queryKeys.capabilities)?.state.data).toEqual(STUDENT_ACCESS);
    expect(findQuery(dehydratedState, queryKeys.courses)?.state.status).toBe('success');
    expect(findQuery(dehydratedState, queryKeys.dashboardOverview)?.state.status).toBe('success');
    expect(findQuery(dehydratedState, queryKeys.myBadges)?.state.status).toBe('success');
    expect(findQuery(dehydratedState, queryKeys.notifications)?.state.data).toEqual({ unread: 3 });
    const range = upcomingDaysRangeIso(30);
    expect(
      findQuery(dehydratedState, queryKeys.calendarEvents(range.from, range.to))?.state.data,
    ).toEqual(CALENDAR_EVENTS);
    expect(findQuery(dehydratedState, queryKeys.courseAccess('course-1'))?.state.data).toEqual({
      report: GRADE_REPORT,
      gradebook: GRADEBOOK,
    });

    // Người không có quyền quản trị thì loader không tải dữ liệu quản trị.
    expect(findQuery(dehydratedState, queryKeys.adminUsers(1, 100))).toBeUndefined();
    expect(findQuery(dehydratedState, queryKeys.categoryTree)).toBeUndefined();
    expect(findQuery(dehydratedState, queryKeys.roles)).toBeUndefined();
  });

  it('quản trị viên: dehydrate thêm ba query của khối quản trị', async () => {
    stubHomeApi({ ...STUDENT_ACCESS, isSiteAdmin: true, assignments: [] });
    const { dehydratedState } = await homeLoader({ request: sessionRequest('/') });
    expect(findQuery(dehydratedState, queryKeys.adminUsers(1, 100))?.state.status).toBe('success');
    expect(findQuery(dehydratedState, queryKeys.categoryTree)?.state.status).toBe('success');
    expect(findQuery(dehydratedState, queryKeys.roles)?.state.status).toBe('success');
    // Không thuộc khoá nào thì không có dữ liệu điểm theo khoá.
    expect(findQuery(dehydratedState, queryKeys.courseAccess('course-1'))).toBeUndefined();
  });

  it('chưa đăng nhập: không gọi API nào, state rỗng — bản prerender mặt công khai không dính dữ liệu cá nhân', async () => {
    const spy = stubHomeApi(STUDENT_ACCESS);
    const { dehydratedState } = await homeLoader({ request: anonymousRequest('/') });
    expect(spy).not.toHaveBeenCalled();
    expect(dehydratedState.queries).toEqual([]);
  });
});
