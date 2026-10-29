import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '@lms/contracts';
import { TestProviders } from '#test/providers';
import { baSessionResponse, isGetSessionUrl } from '#test/ba-session';
import { AdminGuardianLinksPage } from './admin-guardian-links';
import { GuardianLinkView } from '../types/guardians';

/**
 * Spec trang quản lý liên kết giám hộ (gói kích hoạt phụ huynh): bề
 * mặt chỉ dành cho người có capability `guardian:manage` — danh sách
 * liên kết đọc từ GET /guardian-links và tra họ tên qua GET
 * /users/:id; tạo liên kết phải gửi đúng thân (hai id đã chọn + quan
 * hệ) tới POST /guardian-links; thu hồi phải gọi DELETE
 * /guardian-links/:linkId sau xác nhận và hàng chuyển trạng thái đã
 * thu hồi. Người không có `guardian:manage`: trang không dựng bề mặt
 * quản lý nào và không gọi GET /guardian-links (quyền thật vẫn do API
 * thực thi — trang chỉ là lớp trình bày theo ảnh chụp quyền).
 */

const MANAGER_ID = '01900000-0000-7000-8000-0000000000a1';
const STUDENT_ACTOR_ID = '01900000-0000-7000-8000-0000000000a2';
const TENANT_CONTEXT_ID = '01900000-0000-7000-8000-0000000000f1';
const TENANT_ID = '01900000-0000-7000-8000-0000000000e1';
const PARENT_A_ID = '01900000-0000-7000-8000-0000000000b1';
const STUDENT_A_ID = '01900000-0000-7000-8000-0000000000c1';
const PARENT_B_ID = '01900000-0000-7000-8000-0000000000b2';
const STUDENT_B_ID = '01900000-0000-7000-8000-0000000000c2';
const LINK_A_ID = '01900000-0000-7000-8000-0000000000d1';
const LINK_B_ID = '01900000-0000-7000-8000-0000000000d2';

function profileOf(id: string, username: string, firstName: string, lastName: string): UserProfile {
  return {
    id,
    username,
    firstName,
    lastName,
    email: `${username}@example.com`,
    suspended: false,
    deleted: false,
    isGuest: false,
    forcePasswordChange: false,
    lastLogin: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    customFields: [],
  };
}

const MANAGER_PROFILE = profileOf(MANAGER_ID, 'teacher1', 'Lan Anh', 'Nguyễn');
const STUDENT_ACTOR_PROFILE = profileOf(STUDENT_ACTOR_ID, 'student1', 'Minh Quân', 'Trần');
const PARENT_A = profileOf(PARENT_A_ID, 'parent1', 'Văn Đức', 'Trần');
const STUDENT_A = profileOf(STUDENT_A_ID, 'student1', 'Minh Quân', 'Trần');
const PARENT_B = profileOf(PARENT_B_ID, 'parent2', 'Thị Mai', 'Phạm');
const STUDENT_B = profileOf(STUDENT_B_ID, 'student2', 'Thu Hằng', 'Phạm');
const PROFILES = new Map([MANAGER_PROFILE, STUDENT_ACTOR_PROFILE, PARENT_A, STUDENT_A, PARENT_B, STUDENT_B].map((p) => [p.id, p]));

/** Ảnh chụp quyền của người phụ trách: guardian:manage ở context tenant (cấp 30) — đúng hình dạng cổng API kiểm. */
const MANAGER_ACCESS = {
  userId: MANAGER_ID,
  isSiteAdmin: false,
  assignments: [],
  contexts: [
    { contextId: TENANT_CONTEXT_ID, contextLevel: 30, contextPath: '/1/2', capabilities: ['guardian:manage'] },
  ],
  hasLearnerArtifacts: false,
};

/** Ảnh chụp quyền của học viên thuần: không context nào mang guardian:manage. */
const STUDENT_ACCESS = {
  userId: STUDENT_ACTOR_ID,
  isSiteAdmin: false,
  assignments: [],
  contexts: [],
  hasLearnerArtifacts: true,
};

function linkRow(id: string, guardianUserId: string, studentUserId: string, relationship: string, status = 'active'): GuardianLinkView {
  return {
    id,
    tenantId: TENANT_ID,
    guardianUserId,
    studentUserId,
    relationship,
    status,
    createdBy: MANAGER_ID,
    revokedBy: status === 'active' ? null : MANAGER_ID,
    revokedAt: status === 'active' ? null : '2026-10-02T00:00:00.000Z',
    note: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Stub fetch có trạng thái: danh sách liên kết sống trong bộ nhớ của
 * stub — POST thêm hàng, DELETE lật trạng thái — để các test khẳng
 * định được cả lời gọi lẫn bề mặt sau khi cache được làm mới.
 */
function stubFetch(calls: RecordedCall[], actor: { profile: UserProfile; access: unknown }) {
  let links: GuardianLinkView[] = [linkRow(LINK_A_ID, PARENT_A_ID, STUDENT_A_ID, 'Cha')];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return baSessionResponse({ id: actor.profile.id });
      if (url === '/api/v1/users/me') return respond(actor.profile);
      if (url === '/api/v1/users/me/capabilities') return respond(actor.access);
      if (url === '/api/v1/courses') return respond([]);
      if (url === '/api/v1/guardian-links' && method === 'GET') return respond(links);
      if (url === '/api/v1/guardian-links' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { guardianUserId: string; studentUserId: string; relationship: string; note?: string };
        const created = linkRow(LINK_B_ID, body.guardianUserId, body.studentUserId, body.relationship);
        links = [...links, created];
        return respond(created, 201);
      }
      if (url === `/api/v1/guardian-links/${LINK_A_ID}` && method === 'DELETE') {
        links = links.map((link) => (link.id === LINK_A_ID ? { ...link, status: 'revoked' } : link));
        return respond(links.find((link) => link.id === LINK_A_ID));
      }
      if (url.startsWith('/api/v1/users?')) {
        const search = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('search') ?? '';
        const all = [PARENT_A, STUDENT_A, PARENT_B, STUDENT_B];
        const users = all.filter(
          (u) => u.username.includes(search) || `${u.lastName} ${u.firstName}`.includes(search),
        );
        return respond({ users, total: users.length, page: 1, pageSize: 10 });
      }
      if (url.startsWith('/api/v1/users/')) {
        const profile = PROFILES.get(url.slice('/api/v1/users/'.length));
        return profile ? respond(profile) : respond({}, 404);
      }
      return respond({}, 404);
    }),
  );
}

function renderPage() {
  const router = createMemoryRouter(
    [{ path: '/admin/guardian-links', element: <AdminGuardianLinksPage /> }],
    { initialEntries: ['/admin/guardian-links'] },
  );
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

describe('Trang quản lý liên kết giám hộ', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('người có guardian:manage thấy danh sách liên kết kèm họ tên hai phía', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { profile: MANAGER_PROFILE, access: MANAGER_ACCESS });
    renderPage();

    expect(await screen.findByText('Trần Văn Đức (parent1)')).toBeInTheDocument();
    expect(await screen.findByText('Trần Minh Quân (student1)')).toBeInTheDocument();
    expect(screen.getByText('Cha')).toBeInTheDocument();
    expect(screen.getByText('Đang hiệu lực')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thu hồi' })).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/guardian-links' && c.method === 'GET')).toBe(true);
  });

  it('tạo liên kết gửi đúng hai id đã chọn và quan hệ tới POST /guardian-links', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { profile: MANAGER_PROFILE, access: MANAGER_ACCESS });
    renderPage();
    const user = userEvent.setup();

    await screen.findByText('Trần Văn Đức (parent1)');
    await user.type(screen.getByLabelText('Phụ huynh'), 'parent2');
    await user.click(await screen.findByRole('button', { name: /parent2/ }));
    await user.type(screen.getByLabelText('Học viên'), 'student2');
    await user.click(await screen.findByRole('button', { name: /student2/ }));
    await user.type(screen.getByLabelText('Quan hệ với học viên'), 'Mẹ');
    await user.click(screen.getByRole('button', { name: 'Tạo liên kết' }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/v1/guardian-links' && c.method === 'POST');
      expect(post).toBeDefined();
      expect(post!.body).toEqual({
        guardianUserId: PARENT_B_ID,
        studentUserId: STUDENT_B_ID,
        relationship: 'Mẹ',
      });
    });
    // Liên kết mới xuất hiện ngay trong danh sách sau khi tạo.
    expect(await screen.findByText('Phạm Thị Mai (parent2)')).toBeInTheDocument();
    expect(await screen.findByText('Phạm Thu Hằng (student2)')).toBeInTheDocument();
  });

  it('thu hồi gọi DELETE đúng liên kết và hàng chuyển trạng thái đã thu hồi', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { profile: MANAGER_PROFILE, access: MANAGER_ACCESS });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    const user = userEvent.setup();

    await screen.findByText('Trần Văn Đức (parent1)');
    await user.click(screen.getByRole('button', { name: 'Thu hồi' }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.url === `/api/v1/guardian-links/${LINK_A_ID}` && c.method === 'DELETE'),
      ).toBe(true);
    });
    expect(await screen.findByText('Đã thu hồi')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thu hồi' })).not.toBeInTheDocument();
  });

  it('người không có guardian:manage không thấy bề mặt quản lý và trang không gọi API danh sách', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { profile: STUDENT_ACTOR_PROFILE, access: STUDENT_ACCESS });
    renderPage();

    expect(
      await screen.findByText(/không có quyền quản lý liên kết phụ huynh/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tạo liên kết' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/guardian-links')).toBe(false);
  });
});
