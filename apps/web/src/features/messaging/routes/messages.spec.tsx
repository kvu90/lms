import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '#lib/auth';
import { createQueryClient } from '#lib/query-client';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { formatWithOptions } from '#utils/date-format';
import { MessagesPage } from './messages';

/**
 * Kênh realtime được mock ở đúng biên lib `#lib/messaging-socket`:
 * test cũ (chặn liên lạc, hợp đồng tạo conversation) không cần socket
 * thật; test realtime bên dưới điều khiển handlers mà trang đăng ký
 * để giả lập sự kiện server đẩy xuống.
 */
const realtime = vi.hoisted(() => ({
  handlers: null as null | Record<string, (payload: never) => void>,
  connects: 0,
  handle: {
    sync: vi.fn(async () => ({})),
    joinConversation: vi.fn(),
    typing: vi.fn(),
    disconnect: vi.fn(),
  },
}));
vi.mock('../api/messaging-socket', () => ({
  connectMessagingRealtime: (handlers: Record<string, (payload: never) => void>) => {
    realtime.connects += 1;
    realtime.handlers = handlers;
    return realtime.handle;
  },
}));

/**
 * Lớp adapter hồ sơ người: mặc định giữ nguyên triển khai thật
 * (mọi trường mở rộng đều null — chưa có nguồn backend). Riêng
 * các ca của giai đoạn 2 vòng sửa PR #610 (hàng liên lạc thành
 * liên kết) cần trường CÓ giá trị để khẳng định, nên mock cho
 * phép ghi đè từng ca qua `profileOverride` — ca nào không đặt
 * thì hành vi y như thật.
 */
const profileOverride = vi.hoisted(() => ({
  value: null as null | Record<string, string | null>,
}));
vi.mock('../api/person-profile-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/person-profile-adapter')>();
  return {
    ...actual,
    getPersonProfile: (
      person: Parameters<typeof actual.getPersonProfile>[0],
      roleLine?: Parameters<typeof actual.getPersonProfile>[1],
    ) => {
      const base = actual.getPersonProfile(person, roleLine);
      return profileOverride.value ? { ...base, ...profileOverride.value } : base;
    },
  };
});

/**
 * Spec chặn liên lạc theo endpoint thật của messaging: chặn qua
 * POST /messages/contacts/:userId/block, danh sách đã chặn qua
 * GET /messages/contacts/blocked, bỏ chặn qua DELETE trên cùng đường block.
 * Kèm spec hợp đồng tạo conversation: web phải gửi `memberIds` (đúng schema
 * phía API/contracts) để người được chỉ định thật sự thành thành viên.
 */
const ME_ID = '01900000-0000-7000-8000-0000000000a1';
const OTHER_ID = '01900000-0000-7000-8000-0000000000b2';
const CONV_ID = '01900000-0000-7000-8000-0000000000c3';

const PROFILE = {
  id: ME_ID,
  username: 'me',
  firstName: 'Tôi',
  lastName: 'Đây',
  email: 'me@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  customFields: [],
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub fetch ghi lời gọi; trạng thái chặn thay đổi theo POST/DELETE block. */
function stubFetch(calls: RecordedCall[]) {
  const state = { blocked: [] as string[] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/courses')
        return respond({ courses: [{ courseId: COURSE_ID, fullName: 'Khoá học mẫu', shortName: 'KHOA' }] });
      if (url.startsWith(`/api/v1/messages/courses/${COURSE_ID}/members`))
        return respond({
          members: [{ userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser', role: 'student', relationship: 'contact' }],
          nextCursor: null,
        });
      if (url === '/api/v1/messages/conversations' && method === 'POST')
        return respond({ id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID] });
      if (url === '/api/v1/messages/conversations')
        return respond([{ id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID] }]);
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 0, notifications: 0 });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: state.blocked });
      if (url === `/api/v1/messages/contacts/${OTHER_ID}/block` && method === 'POST') {
        state.blocked = [OTHER_ID];
        return respond({ blocked: state.blocked });
      }
      if (url === `/api/v1/messages/contacts/${OTHER_ID}/block` && method === 'DELETE') {
        state.blocked = [];
        return respond({ blocked: state.blocked });
      }
      if (url === `/api/v1/messages/conversations/${CONV_ID}`)
        return respond({ id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID], messages: [] });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/read`) return respond({});
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/**
 * Mở một hội thoại nhóm từ danh sách của tab Nhóm: chuyển sang
 * tab Nhóm rồi bấm hàng của nhóm trong danh sách phẳng — đúng
 * đường người dùng đi từ khi hội thoại nhóm rời khỏi danh sách
 * của tab Tất cả.
 */
async function openGroupFromList(name: RegExp) {
  await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
  await userEvent.click(await screen.findByRole('button', { name }));
}

/**
 * Mở sheet "Tin nhắn mới" từ nút ở đầu khung trái (lát MSG-T3) và trả
 * phần tử dialog của sheet để các ca giới hạn truy vấn trong sheet.
 */
async function openNewMessageSheet() {
  await userEvent.click(await screen.findByRole('button', { name: 'Tin nhắn mới' }));
  return screen.findByRole('dialog');
}

/**
 * Mở menu hành động ở đầu khung chat (issue #591): các hành
 * động phụ của header (chặn, báo cáo, tắt tiếng, tắt chat)
 * nằm trong menu này thay cho hàng nút thứ hai trước đây.
 */
async function openHeaderActionsMenu() {
  await userEvent.click(screen.getByTestId('header-actions'));
  await screen.findByRole('menu');
}

/** Render trang tin nhắn trong AuthProvider như ứng dụng thật (cây provider như root: QueryClientProvider bọc ngoài). */
function renderMessages(entry = '/messages') {
  const router = createMemoryRouter([{ path: '/messages', element: <MessagesPage /> }], {
    initialEntries: [entry],
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('Trang tin nhắn — chặn và bỏ chặn liên hệ', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('chặn đối tác trò chuyện qua POST contacts/:userId/block và bỏ chặn qua DELETE', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderMessages();

    const convButton = await screen.findByRole('button', { name: new RegExp(OTHER_ID) });
    await userEvent.click(convButton);

    // Mục chặn trong menu hành động ở đầu khung mang kèm TÊN
    // người đối thoại (giữ quyết 23:16 ngày 26/10/2026 — sửa
    // bug nút chặn không tên; issue #591 chuyển nút thành
    // mục menu trong cùng một hàng header).
    await openHeaderActionsMenu();
    await userEvent.click(await screen.findByRole('menuitem', { name: /^Chặn liên lạc / }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/contacts/${OTHER_ID}/block` && c.method === 'POST')).toBe(
        true,
      ),
    );

    // Danh sách đã chặn nằm trong sheet "Tin nhắn mới" (lát MSG-T3:
    // Danh bạ hạ thành sheet, không còn là tab của khung trái).
    const sheet = await openNewMessageSheet();
    const blockedRow = await within(sheet).findByTestId(`blocked-${OTHER_ID}`);
    expect(blockedRow).toHaveTextContent(OTHER_ID);
    expect(await screen.findByText('Đã chặn liên hệ này.')).toBeInTheDocument();
    // Trong cuộc trò chuyện, mục chặn ở menu header đã thay
    // bằng trạng thái đã chặn + mục bỏ chặn kèm tên.
    expect(screen.queryByRole('button', { name: /^Chặn liên lạc / })).not.toBeInTheDocument();
    await openHeaderActionsMenu();
    expect(await screen.findByRole('menuitem', { name: /^Bỏ chặn / })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^Chặn liên lạc / })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(blockedRow).getByRole('button', { name: 'Bỏ chặn' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/contacts/${OTHER_ID}/block` && c.method === 'DELETE')).toBe(
        true,
      ),
    );
    await waitFor(() => expect(screen.queryByTestId(`blocked-${OTHER_ID}`)).not.toBeInTheDocument());
  });
});

const CONV2_ID = '01900000-0000-7000-8000-0000000000d4';
const FIRST_MESSAGE = {
  id: '01900000-0000-7000-8000-0000000000e5',
  conversationId: CONV_ID,
  userIdFrom: OTHER_ID,
  subject: '',
  fullMessage: 'tin đầu tiên',
  createdAt: '2026-01-01T00:00:00.000Z',
  seq: 1,
  clientMessageId: null,
};

/** Stub fetch cho các test realtime: gửi tin trả bản server có seq + clientMessageId đã nhận. */
function stubRealtimeFetch(calls: RecordedCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      const respond = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations')
        return respond([
          {
            id: CONV_ID, type: 2, name: 'Nhóm một', members: [ME_ID, OTHER_ID],
            unread: 1, lastReadSeq: 0, lastMessageSeq: 1, lastMessage: FIRST_MESSAGE,
          },
          {
            id: CONV2_ID, type: 2, name: 'Nhóm hai', members: [ME_ID, OTHER_ID],
            unread: 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null,
          },
        ]);
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [] });
      // Cây nhóm của MSG-T1: hai hội thoại nhóm của bộ dữ kiện này là
      // nhóm tự do do tôi quản trị — tab Nhóm hiện chúng từ cây này.
      if (url === '/api/v1/messages/group-tree')
        return respond({
          classes: [],
          coursesOutsideClasses: [],
          freeGroups: [
            { id: CONV_ID, name: 'Nhóm một', myRole: 'staff', conversationId: CONV_ID, unread: 0 },
            { id: CONV2_ID, name: 'Nhóm hai', myRole: 'staff', conversationId: CONV2_ID, unread: 2 },
          ],
          canCreateFreeGroup: true,
        });
      if (url === `/api/v1/messages/conversations/${CONV_ID}`)
        return respond({
          id: CONV_ID, type: 2, name: 'Nhóm một', members: [ME_ID, OTHER_ID],
          messages: [FIRST_MESSAGE], hasMoreBefore: false,
          memberReadMarkers: [
            { userId: ME_ID, lastReadSeq: 1 },
            { userId: OTHER_ID, lastReadSeq: 0 },
          ],
        });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/read`) return respond({ marked: 1, lastReadSeq: 1 });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/messages` && method === 'POST')
        return respond({
          id: '01900000-0000-7000-8000-0000000000f6',
          conversationId: CONV_ID,
          userIdFrom: ME_ID,
          subject: '',
          fullMessage: body?.text,
          createdAt: '2026-01-01T00:01:00.000Z',
          seq: 2,
          clientMessageId: body?.clientMessageId ?? null,
        });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Trang tin nhắn — gửi lạc quan và cập nhật realtime', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('gửi kèm clientMessageId và khử trùng echo socket của chính tin nhắn đó', async () => {
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm một/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();

    const input = screen.getByLabelText('Nội dung tin nhắn');
    await userEvent.type(input, 'xin chào lạc quan');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));

    // Lời gọi gửi tin phải mang clientMessageId để server chống trùng.
    await waitFor(() => {
      const send = calls.find((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}/messages` && c.method === 'POST');
      expect(send).toBeDefined();
      expect(typeof (send?.body as { clientMessageId?: unknown }).clientMessageId).toBe('string');
      expect((send?.body as { text?: unknown }).text).toBe('xin chào lạc quan');
    });
    // Từ lát M1, xem trước ở danh sách cũng phản ánh tin vừa gửi nên
    // các khẳng định chống trùng dưới đây được khoanh trong khung tin.
    expect(await within(thread).findByText('xin chào lạc quan')).toBeInTheDocument();

    // Echo của chính tin đó qua socket (cùng id + clientMessageId) không nhân đôi.
    const sendCall = calls.find((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}/messages` && c.method === 'POST');
    const clientMessageId = (sendCall?.body as { clientMessageId: string }).clientMessageId;
    act(() => {
      realtime.handlers?.onNewMessage({
        conversationId: CONV_ID,
        message: {
          id: '01900000-0000-7000-8000-0000000000f6',
          conversationId: CONV_ID,
          userIdFrom: ME_ID,
          subject: '',
          fullMessage: 'xin chào lạc quan',
          createdAt: '2026-01-01T00:01:00.000Z',
          seq: 2,
          clientMessageId,
        },
      } as never);
    });
    expect(within(thread).getAllByText('xin chào lạc quan')).toHaveLength(1);
  });

  it('thêm tin nhắn realtime từ đối tác và cập nhật chưa đọc từ conversation.updated', async () => {
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm một/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();
    const detailCallsBefore = calls.filter((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}`).length;

    act(() => {
      realtime.handlers?.onNewMessage({
        conversationId: CONV_ID,
        message: {
          id: '01900000-0000-7000-8000-0000000000f7',
          conversationId: CONV_ID,
          userIdFrom: OTHER_ID,
          subject: '',
          fullMessage: 'tin realtime đến',
          createdAt: '2026-01-01T00:02:00.000Z',
          seq: 2,
          clientMessageId: null,
        },
      } as never);
      realtime.handlers?.onConversationUpdated({
        conversationId: CONV2_ID,
        message: {
          id: '01900000-0000-7000-8000-0000000000f8',
          conversationId: CONV2_ID,
          userIdFrom: OTHER_ID,
          subject: '',
          fullMessage: 'tin ở nhóm hai',
          createdAt: '2026-01-01T00:03:00.000Z',
          seq: 1,
          clientMessageId: null,
        },
        unreadCount: 3,
      } as never);
    });

    // Tin realtime hiện ngay trong cuộc trò chuyện đang mở, không tải lại chi tiết.
    expect(await within(thread).findByText('tin realtime đến')).toBeInTheDocument();
    expect(calls.filter((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}`).length).toBe(detailCallsBefore);
    // Conversation khác nhận số chưa đọc theo sự kiện.
    expect(await screen.findByRole('button', { name: /Nhóm hai.*3 chưa đọc/ })).toBeInTheDocument();
  });

  it('bỏ qua conversation.updated cũ có seq nhỏ hơn seq đã áp dụng', async () => {
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    // Số chưa đọc của nhóm hiện trên hàng của danh sách ở tab
    // Nhóm — chuyển sang tab đó trước khi quan sát huy hiệu.
    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    await screen.findByRole('button', { name: /Nhóm một/ });
    const updatedPayload = (seq: number, text: string, unreadCount: number) => ({
      conversationId: CONV2_ID,
      message: {
        id: `01900000-0000-7000-8000-0000000000f${seq}`,
        conversationId: CONV2_ID,
        userIdFrom: OTHER_ID,
        subject: '',
        fullMessage: text,
        createdAt: '2026-01-01T00:05:00.000Z',
        seq,
        clientMessageId: null,
      },
      unreadCount,
    }) as never;

    // Sự kiện mới (seq 2) áp bình thường: huy hiệu của nút cây lên 5.
    // (Cây không hiện xem trước nội dung tin — khẳng định xem trước
    // của danh sách phẳng cũ không còn bề mặt tương ứng ở MSG-T3.)
    act(() => {
      realtime.handlers?.onConversationUpdated(updatedPayload(2, 'tin mới nhất nhóm hai', 5));
    });
    expect(await screen.findByRole('button', { name: /Nhóm hai.*5 chưa đọc/ })).toBeInTheDocument();

    // Sự kiện cũ hơn (seq 1) đến muộn: bị bỏ qua — huy hiệu không
    // nhảy lùi lên 9 theo số của thời điểm cũ.
    act(() => {
      realtime.handlers?.onConversationUpdated(updatedPayload(1, 'tin cũ nhóm hai', 9));
    });
    expect(screen.getByRole('button', { name: /Nhóm hai.*5 chưa đọc/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nhóm hai.*9 chưa đọc/ })).not.toBeInTheDocument();
  });
});

const THIRD_ID = '01900000-0000-7000-8000-0000000000c9';
const COURSE_ID = '01900000-0000-7000-8000-0000000000f1';

/**
 * Stub fetch cho các test Lớp B (issue #33): danh bạ chuyển sang luồng
 * yêu cầu–chấp nhận (hàng chờ có trạng thái), xoá mềm trả dòng tin kèm
 * dấu vết, báo cáo trả 201. Kèm mô hình chốt lại 24/10/2026: tìm bạn
 * theo KHOÁ qua GET /messages/courses + roster thành viên của khoá,
 * và tên hiển thị đi kèm các response danh sách (profiles / displayName
 * trên từng mục hàng chờ).
 */
function stubDomainFetch(calls: RecordedCall[]) {
  const PEOPLE: Record<string, { userId: string; displayName: string; username: string }> = {
    [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' },
    [THIRD_ID]: { userId: THIRD_ID, displayName: 'Người Thứ Ba', username: 'thirduser' },
  };
  const state = {
    contacts: [] as string[],
    incoming: [{ createdAt: '2026-01-01T00:00:00.000Z', ...PEOPLE[OTHER_ID] }] as {
      userId: string; createdAt: string; displayName: string; username: string;
    }[],
    outgoing: [] as { userId: string; createdAt: string; displayName: string; username: string }[],
  };
  const ownMessage = {
    id: '01900000-0000-7000-8000-0000000000d5',
    conversationId: CONV_ID,
    userIdFrom: ME_ID,
    fullMessage: 'tin của tôi sẽ xoá',
    // Tin mới gửi trong vòng cửa sổ thu hồi (15 phút) để nút Thu hồi
    // hiện trong test vòng đời; các test cũ không phụ thuộc mốc này.
    createdAt: new Date().toISOString(),
    seq: 1,
    clientMessageId: null,
    deletedAt: null as string | null,
    deletedBy: null as string | null,
  };
  const peerMessage = {
    id: '01900000-0000-7000-8000-0000000000e6',
    conversationId: CONV_ID,
    userIdFrom: OTHER_ID,
    fullMessage: 'tin của bạn học',
    createdAt: '2026-01-01T00:01:00.000Z',
    seq: 2,
    clientMessageId: null,
    deletedAt: null,
    deletedBy: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations' && method === 'GET')
        return respond([{ id: CONV_ID, type: 2, name: 'Nhóm lớp', members: [ME_ID, OTHER_ID], unread: 0, lastMessageSeq: 2, lastMessage: null }]);
      // Cây nhóm MSG-T1: 'Nhóm lớp' là nhóm tự do — mở qua tab Nhóm.
      if (url === '/api/v1/messages/group-tree')
        return respond({
          classes: [],
          coursesOutsideClasses: [],
          freeGroups: [
            { id: CONV_ID, name: 'Nhóm lớp', myRole: 'staff', conversationId: CONV_ID, unread: 0 },
          ],
          canCreateFreeGroup: true,
        });
      if (url === '/api/v1/messages/contacts')
        return respond({
          contacts: state.contacts,
          profiles: Object.fromEntries(state.contacts.map((id) => [id, PEOPLE[id]])),
        });
      if (url === '/api/v1/messages/contacts/requests') return respond({ incoming: state.incoming, outgoing: state.outgoing });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [] });
      if (url === '/api/v1/messages/courses')
        return respond({ courses: [{ courseId: COURSE_ID, fullName: 'Khoá học mẫu', shortName: 'KHOA' }] });
      if (url.startsWith(`/api/v1/messages/courses/${COURSE_ID}/members`))
        return respond({
          members: [
            {
              ...PEOPLE[THIRD_ID],
              role: 'student',
              relationship: state.outgoing.some((o) => o.userId === THIRD_ID) ? 'pending_outgoing' : 'none',
            },
            {
              ...PEOPLE[OTHER_ID],
              role: 'teacher',
              relationship: state.contacts.includes(OTHER_ID) ? 'contact' : 'pending_incoming',
            },
          ],
          nextCursor: null,
        });
      if (url === `/api/v1/messages/contacts/requests/${OTHER_ID}/accept` && method === 'POST') {
        state.contacts = [OTHER_ID];
        state.incoming = [];
        return respond({ contacts: state.contacts });
      }
      if (url === `/api/v1/messages/contacts/${THIRD_ID}` && method === 'POST') {
        state.outgoing = [{ createdAt: '2026-01-01T00:02:00.000Z', ...PEOPLE[THIRD_ID] }];
        return respond({ status: 'pending', contacts: state.contacts });
      }
      if (url === `/api/v1/messages/conversations/${CONV_ID}`)
        return respond({
          id: CONV_ID, type: 2, name: 'Nhóm lớp', members: [ME_ID, OTHER_ID],
          enabled: true, canModerate: false, canManage: false,
          messages: [ownMessage, peerMessage], hasMoreBefore: false, memberReadMarkers: [],
        });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/read`) return respond({ marked: 2, lastReadSeq: 2 });
      if (url === `/api/v1/messages/${ownMessage.id}` && method === 'DELETE') {
        ownMessage.deletedAt = '2026-01-01T00:03:00.000Z';
        ownMessage.deletedBy = ME_ID;
        return respond(ownMessage);
      }
      if (url === `/api/v1/messages/${ownMessage.id}/recall` && method === 'POST') {
        // Thu hồi: server trả dòng tin kèm dấu thu hồi, nội dung đã vô
        // hiệu với thành viên thường (xem trước cũng rỗng).
        ownMessage.fullMessage = '';
        (ownMessage as unknown as Record<string, unknown>).recalledAt = new Date().toISOString();
        (ownMessage as unknown as Record<string, unknown>).recalledBy = ME_ID;
        return respond(ownMessage);
      }
      if (url === `/api/v1/messages/conversations/${CONV_ID}/report` && method === 'POST')
        return respond({ id: '01900000-0000-7000-8000-0000000000f9', status: 'open', reporterId: ME_ID });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Messages page — Lớp B contacts (request–accept)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('chấp nhận yêu cầu liên hệ đến và gửi yêu cầu mới từ danh sách khoá học', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    // Yêu cầu đang chờ hiện trong sheet "Tin nhắn mới" (lát MSG-T3 —
    // Danh bạ không còn là tab): nút mở sheet mang huy hiệu 1 lời
    // mời; trong sheet, lời mời hiện bằng TÊN người gửi, không phải
    // UUID; chấp nhận qua đúng endpoint.
    expect(await screen.findByRole('button', { name: /Tin nhắn mới/ })).toHaveTextContent('1');
    const sheet = await openNewMessageSheet();
    const incomingRow = await within(sheet).findByTestId(`incoming-request-${OTHER_ID}`);
    expect(incomingRow).toHaveTextContent('Bạn Học');
    expect(incomingRow).not.toHaveTextContent(OTHER_ID);
    await userEvent.click(within(incomingRow).getByRole('button', { name: 'Chấp nhận' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/contacts/requests/${OTHER_ID}/accept` && c.method === 'POST')).toBe(true),
    );
    // Quan hệ hình thành: liên hệ xuất hiện trong mục liên hệ của
    // sheet (hiện tên), hàng chờ sạch.
    const contactRow = await within(sheet).findByTestId(`contact-${OTHER_ID}`);
    expect(contactRow).toHaveTextContent('Bạn Học');
    expect(within(sheet).queryByTestId(`incoming-request-${OTHER_ID}`)).not.toBeInTheDocument();

    // Tìm bạn theo KHOÁ (không còn tìm theo tên, không còn form nhập
    // ID): chọn ngữ cảnh khoá trong sheet → dòng roster hiện tên +
    // username → bấm Kết bạn → POST contacts/:userId, trạng thái chờ
    // duyệt hiện ra bằng tên người nhận.
    await userEvent.click(within(sheet).getByRole('button', { name: 'Khoá học mẫu' }));
    const resultRow = await within(sheet).findByTestId(`roster-member-${THIRD_ID}`);
    expect(resultRow).toHaveTextContent('Người Thứ Ba');
    expect(resultRow).toHaveTextContent('@thirduser');
    await userEvent.click(within(resultRow).getByRole('button', { name: 'Kết bạn' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/contacts/${THIRD_ID}` && c.method === 'POST')).toBe(true),
    );
    expect(await within(sheet).findByText('Đã gửi yêu cầu kết bạn — chờ phía kia chấp nhận.')).toBeInTheDocument();
    expect(await within(sheet).findByText(/Người Thứ Ba \(đang chờ duyệt\)/)).toBeInTheDocument();
    // Không còn bất kỳ ô nhập ID người dùng nào trên trang.
    expect(screen.queryByLabelText(/ID người dùng/)).not.toBeInTheDocument();
  });
});

describe('Messages page — Lớp B conversation actions (soft delete + report)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('xoá mềm tin nhắn của tôi (tin nhắn đối tác không có nút xoá) và báo cáo cuộc trò chuyện', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm lớp/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của tôi sẽ xoá')).toBeInTheDocument();
    expect(await within(thread).findByText('tin của bạn học')).toBeInTheDocument();

    // Chỉ tin của mình có menu ⋯ chứa mục xoá (không canModerate):
    // đúng một nút mở menu trong cả thread (tin của bạn học không có
    // hành động nào ngoài Trả lời nên không có ⋯), và mục Xoá tin
    // nhắn nằm trong menu đó.
    const moreButtons = screen.getAllByRole('button', { name: 'Thao tác khác' });
    expect(moreButtons).toHaveLength(1);
    await userEvent.click(moreButtons[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Xoá tin nhắn' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith('/api/v1/messages/') && c.method === 'DELETE')).toBe(true),
    );
    // Phía học sinh: tin đã xoá biến mất khỏi khung, tin của bạn học còn nguyên.
    await waitFor(() => expect(within(thread).queryByText('tin của tôi sẽ xoá')).not.toBeInTheDocument());
    expect(within(thread).getByText('tin của bạn học')).toBeInTheDocument();

    // Báo cáo cuộc trò chuyện qua đúng endpoint và có xác nhận hiển thị
    // (mục báo cáo nằm trong menu hành động ở đầu khung từ issue #591).
    await openHeaderActionsMenu();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Báo cáo cuộc trò chuyện' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}/report` && c.method === 'POST')).toBe(true),
    );
    expect(await screen.findByText(/Đã gửi báo cáo/)).toBeInTheDocument();
  });
});

const CONV3_ID = '01900000-0000-7000-8000-0000000000d9';
const UNKNOWN_CONV_ID = '01900000-0000-7000-8000-0000000000ff';
const DEEP_LINK_MESSAGE = {
  id: '01900000-0000-7000-8000-0000000000e9',
  conversationId: CONV3_ID,
  userIdFrom: OTHER_ID,
  subject: '',
  fullMessage: 'tin mở bằng deep-link',
  createdAt: '2026-01-01T00:00:00.000Z',
  seq: 1,
  clientMessageId: null,
};

/**
 * Stub cho deep-link: danh sách chỉ có CONV_ID; chi tiết của CONV3_ID
 * tồn tại ở endpoint theo id (mô phỏng conversation chưa nằm trong
 * danh sách đã nạp); id lạ trả 404.
 */
function stubDeepLinkFetch(calls: RecordedCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations')
        return respond([
          { id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID], unread: 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null },
        ]);
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [] });
      if (url === `/api/v1/messages/conversations/${CONV3_ID}`)
        return respond({
          id: CONV3_ID, type: 2, name: 'Nhóm deep-link', members: [ME_ID, OTHER_ID],
          messages: [DEEP_LINK_MESSAGE], hasMoreBefore: false, memberReadMarkers: [],
        });
      if (url === `/api/v1/messages/conversations/${CONV3_ID}/read`) return respond({ marked: 1, lastReadSeq: 1 });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Messages page — notification deep-link (việc nối tiếp #33)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('mở cuộc trò chuyện nêu bởi ?conversation= khi nó nằm trong danh sách đã tải', async () => {
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages(`/messages?conversation=${CONV_ID}`);

    // Không cú bấm nào: khung trò chuyện tự mở đúng conversation của
    // deep-link, tin của nó hiện ra và nó được đánh dấu đã đọc.
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}/read` && c.method === 'POST'),
      ).toBe(true),
    );
  });

  it('fetch theo id và mở cuộc trò chuyện khi nó không nằm trong danh sách đã tải', async () => {
    const calls: RecordedCall[] = [];
    stubDeepLinkFetch(calls);
    renderMessages(`/messages?conversation=${CONV3_ID}`);

    // Conversation không có trong danh sách đã nạp: trang lấy chi
    // tiết thẳng theo id, chèn nó vào danh sách và mở ra. Theo
    // ngữ nghĩa hợp của phán quyết nghiệm thu preview PR #607,
    // hội thoại nhóm vừa chèn HIỆN ở tab Tất cả như mọi hội
    // thoại khác; khẳng định "có mặt trong danh sách" vì vậy
    // kiểm trực tiếp hàng của nó ở tab Tất cả, kèm khẳng định
    // khung phải đã mở đúng hội thoại (phần GET + đánh dấu đã
    // đọc ở dưới giữ nguyên).
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin mở bằng deep-link')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Nhóm deep-link/ })).toBeInTheDocument();
    expect(
      calls.some((c) => c.url === `/api/v1/messages/conversations/${CONV3_ID}` && c.method === 'GET'),
    ).toBe(true);
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/messages/conversations/${CONV3_ID}/read` && c.method === 'POST'),
      ).toBe(true),
    );
  });

  it('bỏ qua id ?conversation= lạ và giữ nguyên trang', async () => {
    const calls: RecordedCall[] = [];
    stubDeepLinkFetch(calls);
    renderMessages(`/messages?conversation=${UNKNOWN_CONV_ID}`);

    // Deep-link đã được thử (GET chi tiết theo id → 404) nhưng trang
    // không mở gì và không vỡ: danh sách vẫn hiện, khung phải vẫn ở
    // trạng thái chưa chọn conversation.
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/messages/conversations/${UNKNOWN_CONV_ID}` && c.method === 'GET'),
      ).toBe(true),
    );
    expect(await screen.findByRole('button', { name: new RegExp(OTHER_ID) })).toBeInTheDocument();
    expect(screen.getByText('Chọn một cuộc hội thoại ở cột trái để đọc và trả lời.')).toBeInTheDocument();
    expect(
      calls.some((c) => c.url === `/api/v1/messages/conversations/${UNKNOWN_CONV_ID}/read`),
    ).toBe(false);
  });
});

describe('Trang tin nhắn — hợp đồng tạo cuộc trò chuyện', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('post memberIds khi bắt đầu trò chuyện từ liên hệ danh sách khoá học và mở nó với người được chỉ định làm thành viên', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderMessages();

    // Bắt đầu cuộc trò chuyện từ dòng roster của một liên hệ trong khoá
    // của mình (tìm theo tên và form nhập ID đều đã bỏ) — roster nằm
    // trong sheet "Tin nhắn mới", ngữ cảnh theo khoá (lát MSG-T3).
    const sheet = await openNewMessageSheet();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Khoá học mẫu' }));
    const resultRow = await within(sheet).findByTestId(`roster-member-${OTHER_ID}`);
    expect(resultRow).toHaveTextContent('Bạn Học');
    await userEvent.click(within(resultRow).getByRole('button', { name: 'Nhắn tin' }));

    // Lời gọi tạo conversation phải mang đúng trường hợp đồng phía API
    // (`memberIds`); gửi tên trường khác là thành viên bị rơi ở tầng validate.
    await waitFor(() => {
      const create = calls.find((c) => c.url === '/api/v1/messages/conversations' && c.method === 'POST');
      expect(create).toBeDefined();
      expect(create?.body).toEqual({ memberIds: [OTHER_ID] });
    });

    // Conversation vừa tạo mở ra với người được chỉ định là một thành viên:
    // mục chặn dành cho thành viên đó có trong menu hành động ở đầu khung.
    await openHeaderActionsMenu();
    expect(await screen.findByRole('menuitem', { name: /^Chặn liên lạc / })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
  });

  it('hiện nút Nhắn tin trực tiếp trên dòng danh sách gắn cờ canDirectMessage (giáo viên → học viên đã ghi danh, không cần kết bạn trước)', async () => {
    const calls: RecordedCall[] = [];
    // Khuôn stubFetch nhưng roster mang hai học sinh CHƯA kết bạn:
    // một người được API gắn cờ canDirectMessage (học sinh của khoá
    // GV đang xem), một người không — chỉ người đầu có nút nhắn thẳng.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond(PROFILE);
        if (url === '/api/v1/messages/courses')
          return respond({ courses: [{ courseId: COURSE_ID, fullName: 'Khoá học mẫu', shortName: 'KHOA' }] });
        if (url.startsWith(`/api/v1/messages/courses/${COURSE_ID}/members`))
          return respond({
            members: [
              { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser', role: 'student', relationship: 'none', canDirectMessage: true },
              { userId: THIRD_ID, displayName: 'Người Thứ Ba', username: 'thirduser', role: 'student', relationship: 'none', canDirectMessage: false },
            ],
            nextCursor: null,
          });
        if (url === '/api/v1/messages/conversations' && method === 'POST')
          return respond({ id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID] });
        if (url === '/api/v1/messages/conversations')
          return respond([{ id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID] }]);
        if (url === '/api/v1/messages/unread-count') return respond({ conversations: 0, notifications: 0 });
        if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [] });
        if (url === `/api/v1/messages/conversations/${CONV_ID}`)
          return respond({ id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID], messages: [] });
        if (url === `/api/v1/messages/conversations/${CONV_ID}/read`) return respond({});
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    renderMessages();

    const sheet = await openNewMessageSheet();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Khoá học mẫu' }));
    const directRow = await within(sheet).findByTestId(`roster-member-${OTHER_ID}`);
    const plainRow = await within(sheet).findByTestId(`roster-member-${THIRD_ID}`);
    // Dòng được gắn cờ: có nút "Nhắn tin" ngay cả khi chưa kết bạn
    // (nút Kết bạn vẫn còn bên cạnh — nhắn thẳng không ép qua kết bạn).
    expect(within(directRow).getByRole('button', { name: 'Nhắn tin' })).toBeInTheDocument();
    expect(within(directRow).getByRole('button', { name: 'Kết bạn' })).toBeInTheDocument();
    // Dòng không gắn cờ: chỉ có Kết bạn, không có đường nhắn thẳng.
    expect(within(plainRow).queryByRole('button', { name: 'Nhắn tin' })).not.toBeInTheDocument();
    expect(within(plainRow).getByRole('button', { name: 'Kết bạn' })).toBeInTheDocument();

    await userEvent.click(within(directRow).getByRole('button', { name: 'Nhắn tin' }));
    await waitFor(() => {
      const create = calls.find((c) => c.url === '/api/v1/messages/conversations' && c.method === 'POST');
      expect(create).toBeDefined();
      expect(create?.body).toEqual({ memberIds: [OTHER_ID] });
    });
    // Hội thoại vừa tạo mở ra: menu hành động ở đầu khung có mục
    // chặn kèm tên thành viên đó (issue #591).
    await openHeaderActionsMenu();
    expect(await screen.findByRole('menuitem', { name: /^Chặn liên lạc / })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
  });
});

describe('Messages page — vòng đời tin nhắn theo vai (thu hồi + invalidate)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('chỉ hiện nút thu hồi cho tin nhắn gần đây của tôi, thu hồi qua POST, và giữ dòng đã thu hồi sau conversation.invalidate', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm lớp/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của tôi sẽ xoá')).toBeInTheDocument();

    // Chỉ tin của mình (mới gửi, trong cửa sổ 15 phút) có mục Thu hồi
    // trong menu ⋯; tin của bạn học không có menu nào.
    const moreButtons = screen.getAllByRole('button', { name: 'Thao tác khác' });
    expect(moreButtons).toHaveLength(1);
    await userEvent.click(moreButtons[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Thu hồi' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/01900000-0000-7000-8000-0000000000d5/recall` && c.method === 'POST')).toBe(true),
    );
    // Nội dung bị vô hiệu, khung hiện dòng đã thu hồi thay vì nội dung cũ.
    expect(await within(thread).findByText('Tin nhắn đã được thu hồi.')).toBeInTheDocument();
    expect(within(thread).queryByText('tin của tôi sẽ xoá')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Thu hồi' })).not.toBeInTheDocument();

    // Sự kiện conversation.invalidate tải lại cửa sổ tin: dòng đã thu
    // hồi vẫn còn (không bị ghi đè thành xoá hay trở lại nội dung cũ).
    act(() => {
      realtime.handlers?.onConversationInvalidate({ conversationId: CONV_ID } as never);
    });
    await waitFor(() =>
      expect(calls.filter((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}`).length).toBeGreaterThan(1),
    );
    expect(await within(thread).findByText('Tin nhắn đã được thu hồi.')).toBeInTheDocument();
  });
});

/**
 * Spec lát M1 (issue #204) cho trang tin nhắn: (1) danh sách tự sắp
 * xếp lại khi có hoạt động mới qua sự kiện realtime
 * `conversation.updated` và hiện mốc thời gian tương đối của tin
 * cuối; (2) nháp soạn tin giữ riêng theo từng conversation, gửi xong
 * chỉ xoá nháp của conversation đó; (3) composer nhiều dòng — Enter
 * gửi, Shift+Enter xuống dòng không gửi.
 */
const CONV_A = '01900000-0000-7000-8000-0000000000aa';
const CONV_B = '01900000-0000-7000-8000-0000000000bb';

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** Stub fetch cho lát M1: hai conversation có sẵn tin cuối, gửi tin trả bản đã lưu như server. */
function stubFetchM1(calls: RecordedCall[]) {
  const lastA = {
    id: 'm-a1', conversationId: CONV_A, userIdFrom: OTHER_ID, fullMessage: 'tin A gần nhất',
    createdAt: isoMinutesAgo(120), seq: 3, clientMessageId: null,
  };
  const lastB = {
    id: 'm-b1', conversationId: CONV_B, userIdFrom: OTHER_ID, fullMessage: 'tin B gần nhất',
    createdAt: isoMinutesAgo(30), seq: 4, clientMessageId: null,
  };
  const summaries = [
    { id: CONV_A, type: 1, name: 'Hội thoại A', members: [ME_ID, OTHER_ID], unread: 0, lastReadSeq: 3, lastMessageSeq: 3, lastMessage: lastA },
    { id: CONV_B, type: 1, name: 'Hội thoại B', members: [ME_ID, OTHER_ID], unread: 0, lastReadSeq: 4, lastMessageSeq: 4, lastMessage: lastB },
  ];
  let sentSeq = 100;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const respond = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations' && method === 'GET') return respond(summaries);
      if (url === `/api/v1/messages/conversations/${CONV_A}`)
        return respond({ ...summaries[0], messages: [lastA], hasMoreBefore: false, memberReadMarkers: [] });
      if (url === `/api/v1/messages/conversations/${CONV_B}`)
        return respond({ ...summaries[1], messages: [lastB], hasMoreBefore: false, memberReadMarkers: [] });
      const sendMatch = /^\/api\/v1\/messages\/conversations\/([^/]+)\/messages$/.exec(url);
      if (sendMatch && method === 'POST') {
        sentSeq += 1;
        return respond({
          id: `m-sent-${sentSeq}`,
          conversationId: sendMatch[1],
          userIdFrom: ME_ID,
          fullMessage: (body as { text?: string })?.text ?? '',
          createdAt: new Date().toISOString(),
          seq: sentSeq,
          clientMessageId: (body as { clientMessageId?: string })?.clientMessageId ?? null,
        });
      }
      if (/^\/api\/v1\/messages\/conversations\/[^/]+\/read$/.test(url)) return respond({ marked: 0, lastReadSeq: 0 });
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 0, notifications: 0 });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [] });
      if (url === '/api/v1/messages/contacts') return respond({ contacts: [] });
      if (url === '/api/v1/messages/contacts/requests') return respond({ incoming: [], outgoing: [] });
      if (url === '/api/v1/messages/courses') return respond({ courses: [] });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/** Thứ tự hiện tại của các nút conversation trong danh sách (theo tên). */
function conversationOrder(): string[] {
  return screen
    .getAllByRole('button', { name: /Hội thoại [AB]/ })
    .map((b) => (b.textContent ?? '').trim());
}

/** Thứ tự rút gọn của danh sách: mảng 'A'/'B' theo vị trí hiện tại (nút hội thoại kèm avatar + trích đoạn nên khớp theo chuỗi con). */
function conversationOrderShort(): string[] {
  return conversationOrder().map((s) => (s.includes('Hội thoại A') ? 'A' : 'B'));
}

describe('Messages page — M1: sắp xếp, thời gian tương đối, nháp, composer', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('hiện nhãn giờ của tin cuối theo định dạng demo và đẩy conversation có tin mới lên đầu khi nhận conversation.updated', async () => {
    // Ghim đồng hồ cho riêng ca này về một mốc cố định lấy tại đầu
    // ca: nhãn giờ tính từ Date.now() ở CẢ hai phía — stub dựng
    // mốc tin cuối bằng isoMinutesAgo (Date.now lúc dựng stub) còn
    // hàm nhãn giờ đọc Date.now lúc hiển thị — hai lần đọc đồng hồ
    // thật lệch nhau qua biên phút/giờ làm nhãn "30 phút trước" /
    // "2 giờ trước" trượt ngẫu nhiên trên máy tải nặng. Ghim để cả
    // hai phía dùng chung một đồng hồ; khôi phục khi ca kết thúc.
    // (new Date() không bị ghim ảnh hưởng nên tin realtime ở dưới vẫn
    // mang mốc thật, chỉ lệch mốc ghim vài mili-giây — vẫn "vừa xong".)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    onTestFinished(() => nowSpy.mockRestore());
    const calls: RecordedCall[] = [];
    stubFetchM1(calls);
    renderMessages();

    // Thứ tự ban đầu theo đúng đáp ứng của server: A trước, B sau.
    await screen.findByRole('button', { name: /Hội thoại A/ });
    expect(conversationOrderShort()).toEqual(['A', 'B']);
    // Nhãn giờ của tin cuối theo đúng hàm phía demo (issue
    // #608): dưới 1 giờ hiện dạng "30m"; trong cùng ngày hiện
    // giờ đồng hồ 12 giờ — không còn nhãn "x giờ/phút trước".
    const twoHoursAgoIso = new Date(Date.now() - 120 * 60_000).toISOString();
    expect(screen.getByTestId(`conversation-last-time-${CONV_A}`)).toHaveTextContent(
      formatWithOptions(twoHoursAgoIso, 'vi', { hour: 'numeric', minute: '2-digit', hour12: true }),
    );
    expect(screen.getByTestId(`conversation-last-time-${CONV_B}`)).toHaveTextContent('30m');

    // Tin mới tới B qua realtime: B lên đầu, xem trước và mốc thời
    // gian đổi theo tin mới, số chưa đọc của B hiện theo sự kiện.
    act(() => {
      realtime.handlers?.onConversationUpdated({
        conversationId: CONV_B,
        message: {
          id: 'm-b2', conversationId: CONV_B, userIdFrom: OTHER_ID, fullMessage: 'tin mới từ B',
          createdAt: new Date().toISOString(), seq: 5, clientMessageId: null,
        },
        unreadCount: 1,
      } as never);
    });

    await waitFor(() => expect(conversationOrderShort()).toEqual(['B', 'A']));
    expect(screen.getByText('tin mới từ B')).toBeInTheDocument();
    expect(screen.getByTestId(`conversation-last-time-${CONV_B}`)).toHaveTextContent('vừa xong');
    expect(conversationOrder()[0]).toContain('(1 chưa đọc)');
  });

  it('tiêu đề danh sách chỉ là chữ Tin nhắn cắt gọn một dòng và không còn hậu tố số chưa đọc', async () => {
    // Hình dạng phía demo (issue #608): tiêu đề đầu cột là
    // đúng một chữ tiêu đề mang truncate (thiếu bề ngang thì
    // cắt ba chấm ở chính tiêu đề) và KHÔNG mang hậu tố tổng
    // số chưa đọc — số chưa đọc chỉ sống ở huy hiệu trên từng
    // hàng hội thoại. jsdom không có layout thật nên ca này
    // ghim đúng cơ chế: tiêu đề mang class truncate, nội dung
    // chữ của tiêu đề là đúng "Tin nhắn" kể cả sau khi có tin
    // chưa đọc, và hàng của hội thoại nhận tin mới mang hậu tố
    // chưa đọc của riêng nó.
    const calls: RecordedCall[] = [];
    stubFetchM1(calls);
    renderMessages();

    await screen.findByRole('button', { name: /Hội thoại A/ });
    // Sự kiện realtime đẩy số chưa đọc của B lên 1.
    act(() => {
      realtime.handlers?.onConversationUpdated({
        conversationId: CONV_B,
        message: {
          id: 'm-b2', conversationId: CONV_B, userIdFrom: OTHER_ID, fullMessage: 'tin mới từ B',
          createdAt: new Date().toISOString(), seq: 5, clientMessageId: null,
        },
        unreadCount: 1,
      } as never);
    });
    await screen.findByText('tin mới từ B');

    const heading = [...document.querySelectorAll('h2')].find((el) => el.textContent?.includes('Tin nhắn'));
    expect(heading).toBeDefined();
    expect(heading).toHaveClass('truncate');
    expect((heading as HTMLElement).textContent?.trim()).toBe('Tin nhắn');
    // Số chưa đọc nằm ở hàng của B (hậu tố sr-only của hàng),
    // không nằm trong tiêu đề.
    expect(conversationOrder()[0]).toContain('(1 chưa đọc)');
  });

  it('giữ nháp riêng theo từng conversation và chỉ xoá nháp của conversation vừa gửi', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM1(calls);
    renderMessages();

    const composer = async () => (await screen.findByLabelText('Nội dung tin nhắn')) as HTMLTextAreaElement;

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    await userEvent.type(await composer(), 'nháp của A');

    // Sang B: composer trống; soạn nháp riêng của B.
    await userEvent.click(screen.getByRole('button', { name: /Hội thoại B/ }));
    expect((await composer()).value).toBe('');
    await userEvent.type(await composer(), 'nháp của B');

    // Quay lại A: nháp của A còn nguyên.
    await userEvent.click(screen.getByRole('button', { name: /Hội thoại A/ }));
    expect((await composer()).value).toBe('nháp của A');

    // Gửi ở A: đúng nội dung nháp A được POST, composer của A trống.
    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url === `/api/v1/messages/conversations/${CONV_A}/messages`
            && c.method === 'POST'
            && (c.body as { text?: string })?.text === 'nháp của A',
        ),
      ).toBe(true),
    );
    expect((await composer()).value).toBe('');

    // Nháp của B không bị lần gửi ở A đụng vào.
    await userEvent.click(screen.getByRole('button', { name: /Hội thoại B/ }));
    expect((await composer()).value).toBe('nháp của B');
  });

  it('composer nhiều dòng: Enter gửi tin, Shift+Enter xuống dòng không gửi', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM1(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const composer = (await screen.findByLabelText('Nội dung tin nhắn')) as HTMLTextAreaElement;
    // Composer là textarea nhiều dòng, không còn là input một dòng.
    expect(composer.tagName).toBe('TEXTAREA');

    await userEvent.type(composer, 'dòng một{shift>}{enter}{/shift}dòng hai');
    expect(composer.value).toBe('dòng một\ndòng hai');
    // Shift+Enter chỉ xuống dòng — chưa có lượt gửi nào.
    expect(
      calls.some((c) => c.url === `/api/v1/messages/conversations/${CONV_A}/messages` && c.method === 'POST'),
    ).toBe(false);

    // Enter thường: gửi đúng cả hai dòng, composer trống sau gửi.
    await userEvent.type(composer, '{enter}');
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url === `/api/v1/messages/conversations/${CONV_A}/messages`
            && c.method === 'POST'
            && (c.body as { text?: string })?.text === 'dòng một\ndòng hai',
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(composer.value).toBe(''));
  });
});

/**
 * Spec lát M2 (issue #212) cho trang tin nhắn: (1) composer hiện bộ
 * đếm ký tự theo trần mặc định dùng chung 10.000 và CHẶN gửi ở client
 * khi nháp vượt trần (giữ nguyên nháp, báo rõ, không bắn request);
 * (2) server trả 429 `messaging.rate_limited` thì trang hiện thông
 * báo "gửi quá nhanh" cạnh composer thay vì chỉ để tin rơi vào trạng
 * thái failed câm.
 */
describe('Messages page — M2: trần ký tự + lỗi gửi rõ ràng', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('chặn gửi ở client khi nháp vượt trần 10.000 ký tự và ô soạn không còn bộ đếm ký tự', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM1(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const composer = (await screen.findByLabelText('Nội dung tin nhắn')) as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: 'a'.repeat(10001) } });
    // Bản demo không có bộ đếm ký tự ở ô soạn (issue #591 bỏ
    // hẳn); trần ký tự vẫn được cổng gửi chặn như cũ.
    expect(screen.queryByTestId('message-char-count')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tin nhắn quá dài — tối đa 10000 ký tự.');
    // Không có request gửi nào bị bắn đi, nháp giữ nguyên để sửa.
    expect(
      calls.some((c) => c.method === 'POST' && /\/conversations\/[^/]+\/messages$/.test(c.url)),
    ).toBe(false);
    expect(composer.value).toHaveLength(10001);
  });

  it('server trả 429 thì hiện thông báo gửi quá nhanh cạnh composer', async () => {
    const calls: RecordedCall[] = [];
    // Stub như M1 nhưng đường gửi luôn bị throttle ở server.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        const respond = (payload: unknown, status = 200) =>
          new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond(PROFILE);
        if (url === '/api/v1/messages/conversations' && method === 'GET') {
          return respond([
            { id: CONV_A, type: 1, name: 'Hội thoại A', members: [ME_ID, OTHER_ID], unread: 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null },
          ]);
        }
        if (url === `/api/v1/messages/conversations/${CONV_A}`)
          return respond({
            id: CONV_A, type: 1, name: 'Hội thoại A', members: [ME_ID, OTHER_ID], unread: 0,
            lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null, messages: [], hasMoreBefore: false, memberReadMarkers: [],
          });
        if (/^\/api\/v1\/messages\/conversations\/[^/]+\/messages$/.test(url) && method === 'POST') {
          return respond(
            { type: 'about:blank', title: 'Too Many Requests', status: 429, code: 'messaging.rate_limited', detail: 'You are sending messages too quickly' },
            429,
          );
        }
        if (/^\/api\/v1\/messages\/conversations\/[^/]+\/read$/.test(url)) return respond({ marked: 0, lastReadSeq: 0 });
        if (url === '/api/v1/messages/unread-count') return respond({ conversations: 0, notifications: 0 });
        if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [] });
        if (url === '/api/v1/messages/contacts') return respond({ contacts: [] });
        if (url === '/api/v1/messages/contacts/requests') return respond({ incoming: [], outgoing: [] });
        if (url === '/api/v1/messages/courses') return respond({ courses: [] });
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const composer = (await screen.findByLabelText('Nội dung tin nhắn')) as HTMLTextAreaElement;
    await userEvent.type(composer, 'tin bình thường');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Bạn đang gửi tin quá nhanh');
    // Tin vẫn mang trạng thái failed để người dùng thử lại sau cửa sổ.
    expect(await screen.findByText('Gửi thất bại')).toBeInTheDocument();
  });
});

/**
 * Lát M3 (issue #229) — trả lời trích dẫn phía web: khối trích dẫn
 * hiện trong bong bóng (kèm trạng thái tin gốc đã xoá), nút Trả lời
 * mở chip ở ô soạn, gửi kèm replyToMessageId, và bấm khối trích dẫn
 * của tin chưa tải thì trang xin cửa sổ quanh seq của tin gốc.
 */
const M3_ORIG = {
  id: 'm3-orig', conversationId: CONV_A, userIdFrom: OTHER_ID, fullMessage: 'Câu gốc để trả lời',
  createdAt: '2026-01-01T10:00:00.000Z', seq: 5, clientMessageId: null,
  replyToMessageId: null, replyTo: null,
};
const M3_OLD = {
  id: 'm3-old', conversationId: CONV_A, userIdFrom: OTHER_ID, fullMessage: 'Tin rất cũ ở đầu hội thoại',
  createdAt: '2026-01-01T09:00:00.000Z', seq: 1, clientMessageId: null,
  replyToMessageId: null, replyTo: null,
};
const M3_REPLY = {
  id: 'm3-reply', conversationId: CONV_A, userIdFrom: ME_ID, fullMessage: 'Tôi trả lời câu gốc',
  createdAt: '2026-01-01T10:01:00.000Z', seq: 6, clientMessageId: null,
  replyToMessageId: M3_ORIG.id,
  replyTo: { id: M3_ORIG.id, seq: 5, userIdFrom: OTHER_ID, excerpt: 'Câu gốc để trả lời', unavailable: false },
};
const M3_REPLY_DEAD = {
  id: 'm3-reply-dead', conversationId: CONV_A, userIdFrom: OTHER_ID, fullMessage: 'Trả lời một tin đã mất',
  createdAt: '2026-01-01T10:02:00.000Z', seq: 7, clientMessageId: null,
  replyToMessageId: 'm3-gone',
  replyTo: { id: 'm3-gone', seq: 2, userIdFrom: OTHER_ID, excerpt: '', unavailable: true },
};
const M3_REPLY_OLD = {
  id: 'm3-reply-old', conversationId: CONV_A, userIdFrom: ME_ID, fullMessage: 'Trả lời tin rất cũ',
  createdAt: '2026-01-01T10:03:00.000Z', seq: 8, clientMessageId: null,
  replyToMessageId: M3_OLD.id,
  replyTo: { id: M3_OLD.id, seq: 1, userIdFrom: OTHER_ID, excerpt: 'Tin rất cũ ở đầu hội thoại', unavailable: false },
};

function stubFetchM3(calls: RecordedCall[], detailMessages: unknown[]) {
  const summary = {
    id: CONV_A, type: 1, name: 'Hội thoại A', members: [ME_ID, OTHER_ID], unread: 0,
    lastReadSeq: 8, lastMessageSeq: 8, lastMessage: detailMessages[detailMessages.length - 1] ?? null,
  };
  let sentSeq = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const respond = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations' && method === 'GET') return respond([summary]);
      if (url === `/api/v1/messages/conversations/${CONV_A}` && method === 'GET')
        return respond({ ...summary, messages: detailMessages, hasMoreBefore: false, memberReadMarkers: [] });
      if (url.startsWith(`/api/v1/messages/conversations/${CONV_A}/messages?`) && method === 'GET')
        return respond({ messages: [M3_OLD], hasMoreBefore: false });
      const sendMatch = /^\/api\/v1\/messages\/conversations\/([^/]+)\/messages$/.exec(url);
      if (sendMatch && method === 'POST') {
        sentSeq += 1;
        const replyToMessageId = (body as { replyToMessageId?: string })?.replyToMessageId ?? null;
        return respond({
          id: `m3-sent-${sentSeq}`,
          conversationId: sendMatch[1],
          userIdFrom: ME_ID,
          fullMessage: (body as { text?: string })?.text ?? '',
          createdAt: new Date().toISOString(),
          seq: sentSeq,
          clientMessageId: (body as { clientMessageId?: string })?.clientMessageId ?? null,
          replyToMessageId,
          replyTo: replyToMessageId === M3_ORIG.id ? M3_REPLY.replyTo : null,
        });
      }
      if (/^\/api\/v1\/messages\/conversations\/[^/]+\/read$/.test(url)) return respond({ marked: 0, lastReadSeq: 0 });
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 0, notifications: 0 });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [], profiles: {} });
      if (url === '/api/v1/messages/contacts')
        return respond({ contacts: [OTHER_ID], profiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } } });
      if (url === '/api/v1/messages/contacts/requests') return respond({ incoming: [], outgoing: [], profiles: {} });
      if (url === '/api/v1/messages/courses') return respond({ courses: [] });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Messages page — M3: trả lời trích dẫn (issue #229)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('hiện khối trích dẫn trong bong bóng; tin gốc đã xoá thì hiện dòng đã xoá, không lộ nội dung', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM3(calls, [M3_ORIG, M3_REPLY, M3_REPLY_DEAD]);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));

    const quote = await screen.findByTestId(`quote-block-${M3_REPLY.id}`);
    expect(quote).toHaveTextContent('Bạn Học');
    expect(quote).toHaveTextContent('Câu gốc để trả lời');

    const deadQuote = await screen.findByTestId(`quote-block-${M3_REPLY_DEAD.id}`);
    expect(deadQuote).toHaveTextContent('Tin gốc đã bị xoá');
    expect(deadQuote).not.toHaveTextContent('m3-gone');
  });

  it('bấm Trả lời thì hiện chip ở ô soạn; gửi đi kèm replyToMessageId và chip biến mất sau khi gửi', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM3(calls, [M3_ORIG, M3_REPLY]);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    // Thread đã dựng xong khi khối trích dẫn của tin trả lời hiện ra
    // (text gốc xuất hiện 2 nơi: bong bóng + excerpt — dùng testid).
    await screen.findByTestId(`quote-block-${M3_REPLY.id}`);

    // Nút Trả lời của tin gốc (tin đầu tiên có nút này trong thread).
    const replyButtons = await screen.findAllByRole('button', { name: 'Trả lời' });
    await userEvent.click(replyButtons[0]);

    const chip = await screen.findByTestId('reply-chip');
    expect(chip).toHaveTextContent('Đang trả lời Bạn Học');
    expect(chip).toHaveTextContent('Câu gốc để trả lời');

    const composer = (await screen.findByLabelText('Nội dung tin nhắn')) as HTMLTextAreaElement;
    await userEvent.type(composer, 'đồng ý với câu này');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));

    await waitFor(() => {
      const sendCall = calls.find((c) => c.method === 'POST' && /\/messages$/.test(c.url));
      expect(sendCall?.body).toMatchObject({ text: 'đồng ý với câu này', replyToMessageId: M3_ORIG.id });
    });
    expect(screen.queryByTestId('reply-chip')).not.toBeInTheDocument();
  });

  it('huỷ chip trích dẫn thì gửi như tin thường (không replyToMessageId)', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM3(calls, [M3_ORIG]);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    await screen.findAllByText('Câu gốc để trả lời');
    await userEvent.click((await screen.findAllByRole('button', { name: 'Trả lời' }))[0]);
    await screen.findByTestId('reply-chip');
    await userEvent.click(screen.getByRole('button', { name: 'Huỷ trả lời' }));
    expect(screen.queryByTestId('reply-chip')).not.toBeInTheDocument();

    const composer = (await screen.findByLabelText('Nội dung tin nhắn')) as HTMLTextAreaElement;
    await userEvent.type(composer, 'tin thường thôi');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() => {
      const sendCall = calls.find((c) => c.method === 'POST' && /\/messages$/.test(c.url));
      expect(sendCall?.body).toMatchObject({ text: 'tin thường thôi' });
      expect((sendCall?.body as { replyToMessageId?: string })?.replyToMessageId).toBeUndefined();
    });
  });

  it('bấm khối trích dẫn của tin chưa tải thì xin cửa sổ quanh seq tin gốc và hiện tin gốc', async () => {
    const calls: RecordedCall[] = [];
    // Chi tiết hội thoại chỉ chứa tin trả lời — tin gốc (seq 1) chưa tải.
    stubFetchM3(calls, [M3_REPLY_OLD]);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const quote = await screen.findByTestId(`quote-block-${M3_REPLY_OLD.id}`);
    await userEvent.click(quote);

    // Trang xin cửa sổ kết thúc tại tin gốc: beforeSeq = seq gốc + 1.
    await waitFor(() => {
      expect(
        calls.some((c) => c.method === 'GET' && c.url.includes(`/conversations/${CONV_A}/messages?beforeSeq=2&limit=50`)),
      ).toBe(true);
    });
    // Tin gốc sau khi tải về hiện thành bong bóng riêng — cùng text
    // lúc này có 2 nơi: excerpt trong khối trích dẫn + nội dung tin gốc.
    await waitFor(() => {
      expect(screen.getAllByText('Tin rất cũ ở đầu hội thoại')).toHaveLength(2);
    });
  });
});

/**
 * Lát M4 (issue #237): ô tìm ở danh sách hội thoại lọc theo tên hiển
 * thị ngay trên danh sách đã tải; ô tìm trong hội thoại gọi endpoint
 * search của API, hiện kết quả (người gửi + excerpt), bấm kết quả thì
 * trang xin cửa sổ quanh seq của tin đích như đường nhảy của M3.
 * Luật tầm nhìn (thành viên/chặn/thu hồi) nằm ở API — spec này khóa
 * đúng luồng hiển thị và hợp đồng lời gọi.
 */
const CONV_CLASS = '01900000-0000-7000-8000-0000000000bb';
const M4_BASE = {
  id: 'm4-base', conversationId: CONV_A, userIdFrom: ME_ID, fullMessage: 'Tin nền trong hội thoại',
  createdAt: '2026-01-01T10:00:00.000Z', seq: 3, clientMessageId: null,
  replyToMessageId: null, replyTo: null,
};
const M4_HIT_MESSAGE = {
  id: 'm4-hit', conversationId: CONV_A, userIdFrom: OTHER_ID, fullMessage: 'Tin ở xa chứa nội dung cần tìm',
  createdAt: '2026-01-01T09:00:00.000Z', seq: 9, clientMessageId: null,
  replyToMessageId: null, replyTo: null,
};
const M4_HIT_RESULT = {
  id: 'm4-hit', conversationId: CONV_A, userIdFrom: OTHER_ID, seq: 9,
  excerpt: '…chứa nội dung cần tìm…', createdAt: '2026-01-01T09:00:00.000Z',
};

function stubFetchM4(calls: RecordedCall[], opts: { failSearch?: boolean } = {}) {
  const summaries = [
    {
      id: CONV_A, type: 1, name: 'Hội thoại A', members: [ME_ID, OTHER_ID], unread: 0,
      lastReadSeq: 3, lastMessageSeq: 3, lastMessage: M4_BASE,
    },
    {
      id: CONV_CLASS, type: 2, name: 'Lớp Toán 10A1', members: [ME_ID, OTHER_ID], unread: 0,
      lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null,
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations' && method === 'GET') return respond(summaries);
      if (url === `/api/v1/messages/conversations/${CONV_A}` && method === 'GET')
        return respond({ ...summaries[0], messages: [M4_BASE], hasMoreBefore: false, memberReadMarkers: [] });
      if (url.startsWith(`/api/v1/messages/conversations/${CONV_A}/search?`) && method === 'GET') {
        if (opts.failSearch) return respond({ message: 'boom' }, 500);
        const q = decodeURIComponent(new URLSearchParams(url.split('?')[1]).get('q') ?? '');
        return respond({ results: q.includes('cần tìm') ? [M4_HIT_RESULT] : [] });
      }
      if (url.startsWith(`/api/v1/messages/conversations/${CONV_A}/messages?`) && method === 'GET')
        return respond({ messages: [M4_HIT_MESSAGE], hasMoreBefore: false });
      if (/^\/api\/v1\/messages\/conversations\/[^/]+\/read$/.test(url)) return respond({ marked: 0, lastReadSeq: 0 });
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 0, notifications: 0 });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [], profiles: {} });
      if (url === '/api/v1/messages/contacts')
        return respond({ contacts: [OTHER_ID], profiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } } });
      if (url === '/api/v1/messages/contacts/requests') return respond({ incoming: [], outgoing: [], profiles: {} });
      if (url === '/api/v1/messages/courses') return respond({ courses: [] });
      // Cây nhóm MSG-T1: 'Lớp Toán 10A1' là nhóm tự do — tab Nhóm
      // hiện nó từ cây này (lát MSG-T3).
      if (url === '/api/v1/messages/group-tree')
        return respond({
          classes: [],
          coursesOutsideClasses: [],
          freeGroups: [
            { id: CONV_CLASS, name: 'Lớp Toán 10A1', myRole: 'staff', conversationId: CONV_CLASS, unread: 0 },
          ],
          canCreateFreeGroup: true,
        });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Messages page — M4: tìm kiếm (issue #237)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('ô tìm ở danh sách lọc theo tên hiển thị; không khớp thì hiện dòng trạng thái rỗng', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM4(calls);
    renderMessages();

    // Tab Tất cả: ô tìm lọc MỌI hội thoại theo tên hiển thị —
    // 'Lớp Toán 10A1' là hội thoại nhóm và theo ngữ nghĩa hợp
    // của phán quyết nghiệm thu preview PR #607 nó cũng nằm
    // trong danh sách của tab này (ngoài danh sách của tab
    // Nhóm được kiểm ở phần sau của ca này).
    expect(await screen.findByRole('button', { name: /Hội thoại A/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lớp Toán 10A1/ })).toBeInTheDocument();

    const filter = screen.getByLabelText('Tìm cuộc trò chuyện');
    await userEvent.type(filter, 'toán');
    expect(screen.queryByRole('button', { name: /Hội thoại A/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lớp Toán 10A1/ })).toBeInTheDocument();

    await userEvent.clear(filter);
    await userEvent.type(filter, 'không tồn tại đâu');
    expect(await screen.findByText('Không có cuộc trò chuyện nào khớp.')).toBeInTheDocument();

    await userEvent.clear(filter);
    expect(await screen.findByRole('button', { name: /Hội thoại A/ })).toBeInTheDocument();

    // Ở tab Nhóm, cùng một ô tìm duy nhất đó (nhãn ô đổi theo
    // tab) lọc danh sách nhóm theo tên lớp/khoá/nhóm.
    await userEvent.click(screen.getByRole('tab', { name: 'Nhóm' }));
    expect(await screen.findByRole('button', { name: /Lớp Toán 10A1/ })).toBeInTheDocument();
    const treeFilter = screen.getByLabelText('Tìm lớp, khoá, nhóm…');
    await userEvent.type(treeFilter, 'không tồn tại đâu');
    expect(screen.queryByRole('button', { name: /Lớp Toán 10A1/ })).not.toBeInTheDocument();
    expect(await screen.findByText('Không có lớp, khoá hay nhóm nào khớp.')).toBeInTheDocument();
  });

  it('tìm trong hội thoại: gửi đúng từ khoá lên API, hiện kết quả, bấm kết quả thì xin cửa sổ quanh seq và hiện tin đích', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM4(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    // Tìm trong hội thoại ẩn sau nút bật/tắt ở header (issue #256).
    // Đường vào tìm kiếm đã dời vào menu đầu khung như phía
    // demo (issue #608): mở menu ⋯ rồi chọn mục Tìm trong cuộc
    // trò chuyện — chức năng tìm kiếm giữ nguyên.
    await userEvent.click(screen.getByTestId('header-actions'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Tìm trong cuộc trò chuyện' }));

    const searchInput = screen.getByRole('searchbox', { name: 'Tìm trong cuộc trò chuyện' });
    await userEvent.type(searchInput, 'cần tìm');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm' }));

    // Hợp đồng lời gọi: GET search của đúng conversation, q đã mã hoá.
    await waitFor(() => {
      expect(
        calls.some((c) => c.method === 'GET'
          && c.url.startsWith(`/api/v1/messages/conversations/${CONV_A}/search?`)
          && decodeURIComponent(c.url).includes('q=cần tìm')),
      ).toBe(true);
    });

    const result = await screen.findByTestId('search-result-m4-hit');
    expect(result).toHaveTextContent('Bạn Học');
    expect(result).toHaveTextContent('cần tìm');

    // Tin đích (seq 9) chưa có trong khung: bấm kết quả phải xin cửa
    // sổ beforeSeq = 10 rồi bong bóng của tin đích hiện ra.
    await userEvent.click(result);
    await waitFor(() => {
      expect(
        calls.some((c) => c.method === 'GET' && c.url.includes(`/conversations/${CONV_A}/messages?beforeSeq=10&limit=50`)),
      ).toBe(true);
    });
    expect(await screen.findByText('Tin ở xa chứa nội dung cần tìm')).toBeInTheDocument();
  });

  it('tìm không khớp thì hiện trạng thái rỗng; API lỗi thì hiện thông báo lỗi', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM4(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    // Tìm trong hội thoại ẩn sau nút bật/tắt ở header (issue #256).
    // Đường vào tìm kiếm đã dời vào menu đầu khung như phía
    // demo (issue #608): mở menu ⋯ rồi chọn mục Tìm trong cuộc
    // trò chuyện — chức năng tìm kiếm giữ nguyên.
    await userEvent.click(screen.getByTestId('header-actions'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Tìm trong cuộc trò chuyện' }));

    const searchInput = screen.getByRole('searchbox', { name: 'Tìm trong cuộc trò chuyện' });
    await userEvent.type(searchInput, 'xyz không khớp');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm' }));
    expect(await screen.findByText('Không tìm thấy tin nào khớp.')).toBeInTheDocument();
  });

  it('API tìm lỗi thì hiện thông báo lỗi rõ ràng thay vì danh sách trống', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM4(calls, { failSearch: true });
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    // Tìm trong hội thoại ẩn sau nút bật/tắt ở header (issue #256).
    // Đường vào tìm kiếm đã dời vào menu đầu khung như phía
    // demo (issue #608): mở menu ⋯ rồi chọn mục Tìm trong cuộc
    // trò chuyện — chức năng tìm kiếm giữ nguyên.
    await userEvent.click(screen.getByTestId('header-actions'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Tìm trong cuộc trò chuyện' }));

    const searchInput = screen.getByRole('searchbox', { name: 'Tìm trong cuộc trò chuyện' });
    await userEvent.type(searchInput, 'cần tìm');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Không tìm được tin nhắn.');
  });
});

/* ================= M5: ghim / lưu trữ / tắt tiếng (issue #240) ================= */

const M5_CONV_A = '01900000-0000-7000-8000-0000000000a5';
const M5_CONV_B = '01900000-0000-7000-8000-0000000000b5';

interface M5ConvState {
  id: string; name: string; unread: number;
  pinnedAt: string | null; archivedAt: string | null; muted: boolean; activity: number;
}

/**
 * Stub M5 mô phỏng đúng luật server: danh sách chính chỉ gồm hội
 * thoại chưa lưu (đã ghim lên đầu, còn lại theo hoạt động), mục đã
 * lưu là đường GET riêng; PATCH state đổi đúng cờ được gửi và trả
 * trạng thái đầy đủ.
 */
function stubFetchM5(calls: RecordedCall[]) {
  const convs: M5ConvState[] = [
    { id: M5_CONV_A, name: 'Hội thoại A', unread: 2, pinnedAt: null, archivedAt: null, muted: false, activity: 1 },
    { id: M5_CONV_B, name: 'Hội thoại B', unread: 0, pinnedAt: null, archivedAt: null, muted: false, activity: 2 },
  ];
  const summary = (c: M5ConvState) => ({
    id: c.id, type: 1, name: c.name, members: [ME_ID, OTHER_ID], unread: c.unread,
    lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null,
    pinnedAt: c.pinnedAt, archivedAt: c.archivedAt, muted: c.muted,
  });
  const byServerOrder = (list: M5ConvState[]) => [...list].sort((x, y) =>
    Number(y.pinnedAt !== null) - Number(x.pinnedAt !== null) || y.activity - x.activity);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations' && method === 'GET')
        return respond(byServerOrder(convs.filter((c) => !c.archivedAt)).map(summary));
      if (url === '/api/v1/messages/conversations?archived=true' && method === 'GET')
        return respond(byServerOrder(convs.filter((c) => c.archivedAt)).map(summary));
      const stateMatch = url.match(/^\/api\/v1\/messages\/conversations\/([^/]+)\/state$/);
      if (stateMatch && method === 'PATCH') {
        const conv = convs.find((c) => c.id === stateMatch[1]);
        if (!conv) return respond({ code: 'messaging.conversation_not_found' }, 404);
        const patch = JSON.parse(String(init?.body)) as { pinned?: boolean; archived?: boolean; muted?: boolean };
        if (patch.pinned !== undefined) conv.pinnedAt = patch.pinned ? '2026-01-02T00:00:00.000Z' : null;
        if (patch.archived !== undefined) conv.archivedAt = patch.archived ? '2026-01-02T00:00:00.000Z' : null;
        if (patch.muted !== undefined) conv.muted = patch.muted;
        return respond({
          conversationId: conv.id, pinned: conv.pinnedAt !== null, pinnedAt: conv.pinnedAt,
          archived: conv.archivedAt !== null, archivedAt: conv.archivedAt, muted: conv.muted,
        });
      }
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 1, notifications: 0 });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [], profiles: {} });
      if (url === '/api/v1/messages/contacts')
        return respond({ contacts: [OTHER_ID], profiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } } });
      if (url === '/api/v1/messages/contacts/requests') return respond({ incoming: [], outgoing: [], profiles: {} });
      if (url === '/api/v1/messages/courses') return respond({ courses: [] });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Messages page — M5: ghim / lưu trữ / tắt tiếng (issue #240)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('ghim qua menu đưa hội thoại lên đầu kèm icon ghim; tắt tiếng làm mờ số chưa đọc', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetchM5(calls);
    renderMessages();

    // Thứ tự server ban đầu: B (hoạt động mới hơn) trước A.
    expect(await screen.findByRole('button', { name: /Hội thoại A/ })).toBeInTheDocument();
    const listButtons = () => screen.getAllByRole('button', { name: /Hội thoại [AB]/ });
    expect(listButtons()[0]).toHaveTextContent('Hội thoại B');

    // Mở menu của A → Ghim.
    await userEvent.click(screen.getByTestId(`conversation-actions-${M5_CONV_A}`));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Ghim cuộc trò chuyện' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH'
        && c.url === `/api/v1/messages/conversations/${M5_CONV_A}/state`
        && (c.body as { pinned?: boolean }).pinned === true)).toBe(true);
    });
    // Sau khi ghim: A lên đầu và mang icon ghim (chuẩn app nhắn tin, issue #256).
    await waitFor(() => expect(listButtons()[0]).toHaveTextContent('Hội thoại A'));
    expect(await screen.findByTestId(`conversation-pinned-${M5_CONV_A}`)).toBeInTheDocument();

    // Tắt tiếng A: số chưa đọc của A chuyển sang dạng mờ.
    await userEvent.click(screen.getByTestId(`conversation-actions-${M5_CONV_A}`));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Tắt tiếng' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH'
        && c.url === `/api/v1/messages/conversations/${M5_CONV_A}/state`
        && (c.body as { muted?: boolean }).muted === true)).toBe(true);
    });
    await waitFor(() => {
      const dimmed = [...document.querySelectorAll('.opacity-60')].map((el) => el.textContent ?? '');
      expect(dimmed.some((text) => text.includes('2 chưa đọc'))).toBe(true);
    });
  });

  it('lưu trữ: hội thoại rời danh sách chính, hiện ở mục đã lưu; bỏ lưu đưa về danh sách chính', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetchM5(calls);
    renderMessages();

    expect(await screen.findByRole('button', { name: /Hội thoại B/ })).toBeInTheDocument();

    // Lưu trữ B qua menu → B biến khỏi danh sách chính.
    await userEvent.click(screen.getByTestId(`conversation-actions-${M5_CONV_B}`));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Lưu trữ' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH'
        && c.url === `/api/v1/messages/conversations/${M5_CONV_B}/state`
        && (c.body as { archived?: boolean }).archived === true)).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Hội thoại B/ })).not.toBeInTheDocument();
    });

    // Mở mục Đã lưu trữ trong tab Tất cả (issue #564): trang xin đúng đường ?archived=true và thấy B ở đó.
    await userEvent.click(screen.getByRole('button', { name: 'Đã lưu trữ' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'GET' && c.url === '/api/v1/messages/conversations?archived=true')).toBe(true);
    });
    expect(await screen.findByRole('button', { name: /Hội thoại B/ })).toBeInTheDocument();
    // Theo cấu trúc mục của issue #564, danh sách chính (mục Gần
    // đây) vẫn hiện song song với mục Đã lưu trong cùng tab, nên
    // "chỉ B ở mục đã lưu" phải kiểm trong phạm vi chính mục đó:
    // A vẫn ở danh sách chính nhưng không có trong mục đã lưu.
    const archivedSection = screen.getByRole('button', { name: 'Đã lưu trữ' }).parentElement as HTMLElement;
    expect(within(archivedSection).queryByRole('button', { name: /Hội thoại A/ })).not.toBeInTheDocument();

    // Bỏ lưu trữ B ngay trong mục đã lưu → B rời mục đã lưu và về
    // lại danh sách chính ngay trong cùng tab (không cần chuyển tab
    // như thời mục đã lưu còn là tab riêng).
    await userEvent.click(screen.getByTestId(`conversation-actions-${M5_CONV_B}`));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Bỏ lưu trữ' }));
    await waitFor(() => {
      expect(within(archivedSection).queryByRole('button', { name: /Hội thoại B/ })).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('button', { name: /Hội thoại B/ })).toBeInTheDocument();
  });
});

const T3_DM_A = '01900000-0000-7000-8000-0000000000a1';
const T3_DM_B = '01900000-0000-7000-8000-0000000000b1';
const T3_CLASS_ID = '01900000-0000-7000-8000-0000000000c1';
const T3_COURSE_ID = '01900000-0000-7000-8000-0000000000c2';
const T3_CLASS_CONV = '01900000-0000-7000-8000-0000000000d1';
const T3_COURSE_CONV = '01900000-0000-7000-8000-0000000000d2';
const T3_GROUP_CONV = '01900000-0000-7000-8000-0000000000d5';

/**
 * Stub fetch cho các ca MSG-T3: hai hội thoại 1–1 (một chưa đọc),
 * một hội thoại nhóm tự do chỉ thuộc cây, và cây Lớp → Khoá → Nhóm
 * con theo vai DẠY. `studentView` đổi mọi vai của cây thành HỌC.
 * `canCreateFreeGroup` là cờ server trả trong cây (chỉ quản trị
 * viên hệ thống/chủ trung tâm mới true) — nút tạo nhóm hiện theo
 * cờ này, KHÔNG theo vai trên cây; mặc định suy từ `studentView`
 * (góc học sinh thì false, góc dạy thì true). `groupUnread` đặt
 * số chưa đọc của hội thoại nhóm tự do (mặc định 0) và
 * `groupPinnedAt` đặt trạng thái ghim của chính hội thoại đó
 * (mặc định chưa ghim) — hai tuỳ chọn này phục vụ các ca về
 * ngữ nghĩa hợp của tab Tất cả / Chưa đọc và mục Ghim của tab
 * Nhóm theo phán quyết nghiệm thu preview của PR #607.
 * `groupPinnedArchived` đặt hội thoại nhóm vào trạng thái VỪA
 * GHIM VỪA LƯU TRỮ: hội thoại rời danh sách chính, chỉ còn ở
 * danh sách đã lưu (đường ?archived=true), còn cây nhóm mang
 * mốc ghim trên chính nút nhóm tự do — đúng hình dữ kiện server
 * trả khi hai trạng thái cá nhân độc lập cùng bật; ca dùng
 * tuỳ chọn này kiểm mục Ghim của tab Nhóm phân loại theo dữ
 * kiện cây chứ không theo danh sách chưa lưu trữ.
 */
function stubMsgT3Fetch(calls: RecordedCall[], opts: { studentView?: boolean; canCreateFreeGroup?: boolean; groupUnread?: number; groupPinnedAt?: string | null; groupPinnedArchived?: boolean } = {}) {
  const role = opts.studentView ? 'learning' : 'teaching';
  const groupPinnedAt = opts.groupPinnedAt ?? (opts.groupPinnedArchived ? '2026-01-02T00:00:00.000Z' : null);
  const dmMessage = {
    id: '01900000-0000-7000-8000-0000000000e1', conversationId: T3_DM_A, userIdFrom: OTHER_ID,
    subject: '', fullMessage: 'tin của bạn một', createdAt: '2026-01-01T00:00:00.000Z', seq: 1, clientMessageId: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations' && method === 'GET')
        return respond([
          { id: T3_DM_A, type: 1, name: 'Bạn Một', members: [ME_ID, OTHER_ID], unread: 1, lastReadSeq: 0, lastMessageSeq: 1, lastMessage: dmMessage },
          { id: T3_DM_B, type: 1, name: 'Bạn Hai', members: [ME_ID, THIRD_ID], unread: 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null },
          // Nhóm vừa ghim vừa lưu trữ thì KHÔNG còn ở danh sách
          // chính (chỉ ở danh sách đã lưu) — đúng cổng hiển thị
          // của server cho hai trạng thái cá nhân độc lập.
          ...(opts.groupPinnedArchived
            ? []
            : [{ id: T3_GROUP_CONV, type: 2, name: 'Nhóm Riêng', members: [ME_ID, OTHER_ID], unread: opts.groupUnread ?? 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null, pinnedAt: groupPinnedAt }]),
        ]);
      if (url === '/api/v1/messages/conversations?archived=true' && method === 'GET')
        return respond(opts.groupPinnedArchived
          ? [{ id: T3_GROUP_CONV, type: 2, name: 'Nhóm Riêng', members: [ME_ID, OTHER_ID], unread: opts.groupUnread ?? 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null, pinnedAt: groupPinnedAt, archivedAt: '2026-01-03T00:00:00.000Z' }]
          : []);
      if (url === '/api/v1/messages/group-tree')
        return respond({
          classes: [{
            classId: T3_CLASS_ID, name: 'Lớp 10A1', myRole: role, conversationId: T3_CLASS_CONV, unread: 1, pinnedAt: null,
            courses: [{
              courseId: T3_COURSE_ID, name: 'Toán 10', myRole: role, conversationId: T3_COURSE_CONV, unread: 1, pinnedAt: null,
              groups: [{ groupId: '01900000-0000-7000-8000-0000000000c3', name: 'Nhóm 1', myRole: role, conversationId: null, unread: 0, pinnedAt: null }],
            }],
          }],
          coursesOutsideClasses: [],
          freeGroups: opts.studentView
            ? []
            : [{ id: T3_GROUP_CONV, name: 'Nhóm Riêng', myRole: 'staff', conversationId: T3_GROUP_CONV, unread: opts.groupUnread ?? 0, pinnedAt: groupPinnedAt }],
          canCreateFreeGroup: opts.canCreateFreeGroup ?? !opts.studentView,
        });
      if (url === `/api/v1/messages/classes/${T3_CLASS_ID}/conversation`)
        return respond({ id: T3_CLASS_CONV, type: 2, name: 'Lớp 10A1', members: [ME_ID, OTHER_ID] });
      if (url === `/api/v1/messages/courses/${T3_COURSE_ID}/conversation`)
        return respond({ id: T3_COURSE_CONV, type: 2, name: 'Toán 10', members: [ME_ID, OTHER_ID] });
      if (url === `/api/v1/messages/conversations/${T3_DM_A}`)
        return respond({ id: T3_DM_A, type: 1, name: 'Bạn Một', members: [ME_ID, OTHER_ID], messages: [dmMessage], hasMoreBefore: false, memberReadMarkers: [] });
      if (url === `/api/v1/messages/conversations/${T3_CLASS_CONV}`)
        return respond({ id: T3_CLASS_CONV, type: 2, name: 'Lớp 10A1', members: [ME_ID, OTHER_ID], messages: [], hasMoreBefore: false, memberReadMarkers: [] });
      if (url === `/api/v1/messages/conversations/${T3_COURSE_CONV}`)
        return respond({ id: T3_COURSE_CONV, type: 2, name: 'Toán 10', members: [ME_ID, OTHER_ID], messages: [], hasMoreBefore: false, memberReadMarkers: [] });
      if (url === `/api/v1/messages/conversations/${T3_GROUP_CONV}`)
        return respond({ id: T3_GROUP_CONV, type: 2, name: 'Nhóm Riêng', members: [ME_ID, OTHER_ID], messages: [], hasMoreBefore: false, memberReadMarkers: [] });
      if (/^\/api\/v1\/messages\/conversations\/[^/]+\/read$/.test(url)) return respond({ marked: 0, lastReadSeq: 0 });
      if (url === '/api/v1/messages/conversations' && method === 'POST')
        return respond({ id: T3_GROUP_CONV, type: 2, name: 'Nhóm mới lập', members: [ME_ID, OTHER_ID] });
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 1, notifications: 0 });
      if (url === '/api/v1/messages/contacts')
        return respond({ contacts: [OTHER_ID], profiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } } });
      if (url === '/api/v1/messages/contacts/requests') return respond({ incoming: [], outgoing: [], profiles: {} });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [], profiles: {} });
      if (url === '/api/v1/messages/courses') return respond({ courses: [] });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/**
 * Lát MSG-T3 (chuỗi cấu trúc nhắn tin của issue #33, tiếp nối bề
 * mặt #256) với cấu trúc tab của issue #606: khung trái có bốn
 * tab lọc ngang hàng Tất cả / Chưa đọc / Nhóm / Yêu thích. Theo
 * phán quyết nghiệm thu preview của PR #607, Tất cả và Chưa
 * đọc chứa MỌI hội thoại (1–1 lẫn nhóm — hợp như tab All của
 * bản demo), tab Nhóm là góc nhìn cấu trúc lớp/khoá/nhóm của
 * cùng các hội thoại đó, Danh bạ hạ thành sheet "Tin nhắn
 * mới". Từ issue #564, mục Đã lưu trữ không còn là tab riêng
 * mà là một mục thu gọn trong tab Tất cả; các ca dưới khoá
 * đúng các quyết định đó: đổi cấu trúc tab là các ca này phải
 * đỏ.
 */
describe('Messages page — phân tab, danh sách nhóm, sheet Tin nhắn mới', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('khung trái có bốn tab Tất cả / Chưa đọc / Nhóm / Yêu thích, không còn tab Trò chuyện, tab Danh bạ hay tab Đã lưu trữ; mục Đã lưu trữ trong tab Tất cả nạp danh sách riêng', async () => {
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    expect(await screen.findByRole('tab', { name: 'Tất cả' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Chưa đọc' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Nhóm' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Yêu thích' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Trò chuyện' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Danh bạ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Đã lưu trữ' })).not.toBeInTheDocument();

    // Mở mục Đã lưu trữ trong tab Tất cả (issue #564): trang
    // xin đúng đường ?archived=true; stub không có mục nào nên
    // hiện trạng thái rỗng của mục đã lưu.
    await userEvent.click(screen.getByRole('button', { name: 'Đã lưu trữ' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'GET' && c.url === '/api/v1/messages/conversations?archived=true')).toBe(true);
    });
    expect(await screen.findByText('Chưa có cuộc trò chuyện nào được lưu trữ.')).toBeInTheDocument();
  });

  it('tab Tất cả chứa mọi hội thoại gồm cả nhóm và đếm tổng thật; tab Chưa đọc chỉ hiện hội thoại có tin chưa đọc', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    // Số đếm của tab Tất cả là tổng thật của danh sách (2 hội
    // thoại 1–1 + 1 hội thoại nhóm = 3), không còn đếm riêng
    // tập 1–1 như ngữ nghĩa phân vùng cũ.
    expect(await screen.findByRole('tab', { name: 'Tất cả' })).toHaveTextContent('(3)');
    expect(await screen.findByRole('button', { name: /Bạn Một/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bạn Hai/ })).toBeInTheDocument();
    // Hội thoại nhóm hiện ở tab Tất cả với đúng nhận diện nhóm.
    expect(screen.getByRole('button', { name: /Nhóm Riêng/ })).toBeInTheDocument();

    // Chỉ hội thoại 1–1 "Bạn Một" có tin chưa đọc trong bộ dữ
    // kiện này (nhóm chưa đọc = 0): tab Chưa đọc đếm (1) và
    // chỉ liệt kê đúng hội thoại đó.
    expect(screen.getByRole('tab', { name: 'Chưa đọc' })).toHaveTextContent('(1)');
    await userEvent.click(screen.getByRole('tab', { name: 'Chưa đọc' }));
    expect(screen.getByRole('button', { name: /Bạn Một/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bạn Hai/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nhóm Riêng/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Tất cả' }));
    expect(screen.getByRole('button', { name: /Bạn Một/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bạn Hai/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nhóm Riêng/ })).toBeInTheDocument();
  });

  it('hàng hội thoại trực tiếp đang mở mang đúng trạng thái chọn của demo: khung bọc có nền bg-muted, ring 1px khảm trong và overflow-hidden; nền fallback của avatar là bg-background/50', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Bạn Một/ }));
    expect(await screen.findByLabelText('Tin nhắn')).toBeInTheDocument();

    const activeButton = screen.getByRole('button', { name: /Bạn Một/ });
    expect(activeButton).toHaveAttribute('aria-current', 'true');
    // Khung bọc hàng (phần tử cha của nút mở hội thoại) mang
    // toàn bộ trạng thái chọn như chuỗi class hàng của demo
    // (điểm C16): nền muted, ring 1px màu border khảm trong
    // và overflow-hidden để nội dung hàng — gồm cả nút menu
    // trạng thái — bị cắt theo góc bo tròn của hàng.
    const rowFrame = activeButton.parentElement as HTMLElement;
    expect(rowFrame).toHaveClass('overflow-hidden', 'bg-muted', 'ring-1', 'ring-border', 'ring-inset');
    // Fallback của avatar trên hàng đang chọn mang nền
    // background/50 như class điều kiện của demo.
    const activeFallback = activeButton.querySelector('[data-slot="avatar-fallback"]');
    expect(activeFallback).not.toBeNull();
    expect(activeFallback).toHaveClass('bg-background/50');

    // Hàng chưa chọn không mang bất kỳ class trạng thái chọn
    // nào: các class trên là hệ quả của trạng thái, không
    // phải lớp nền tĩnh của mọi hàng.
    const inactiveButton = screen.getByRole('button', { name: /Bạn Hai/ });
    expect(inactiveButton).not.toHaveAttribute('aria-current');
    const inactiveFrame = inactiveButton.parentElement as HTMLElement;
    expect(inactiveFrame).not.toHaveClass('bg-muted', 'ring-1', 'ring-border');
    expect(inactiveButton.querySelector('[data-slot="avatar-fallback"]')).not.toHaveClass('bg-background/50');
  });

  it('tab Chưa đọc chứa hội thoại nhóm có tin chưa đọc kèm huy hiệu; số đếm của tab khớp danh sách đã liệt kê', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls, { groupUnread: 2 });
    renderMessages();

    // Tổng chưa đọc tính trên mọi loại hội thoại: "Bạn Một"
    // (1–1) + "Nhóm Riêng" (nhóm) = 2 hội thoại có tin chưa
    // đọc. Tiêu đề cột chỉ là chữ như bản demo (issue #608,
    // điểm B10 — không hậu tố số chưa đọc) nên tổng đó đọc ở
    // số đếm của tab Chưa đọc, và số đếm phải khớp danh sách
    // tab liệt kê — không còn cảnh tab báo (0) trong khi vẫn
    // còn tin chưa đọc.
    expect(await screen.findByRole('heading', { name: 'Tin nhắn' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Chưa đọc' })).toHaveTextContent('(2)');
    await userEvent.click(screen.getByRole('tab', { name: 'Chưa đọc' }));
    expect(screen.getByRole('button', { name: /Bạn Một.*1 chưa đọc/ })).toBeInTheDocument();
    // Hàng nhóm hiện huy hiệu số chưa đọc như hàng 1–1.
    expect(screen.getByRole('button', { name: /Nhóm Riêng.*2 chưa đọc/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bạn Hai/ })).not.toBeInTheDocument();
  });

  it('tab Nhóm tách mục Ghim khi một hội thoại nhóm đã ghim; chưa có nhóm ghim thì danh sách giữ dạng phẳng không tiêu đề mục', async () => {
    // Có nhóm đã ghim (trạng thái ghim nằm ở danh sách hội
    // thoại — cây server không mang trường ghim): tab Nhóm
    // tách mục Ghim chứa hàng nhóm đó, các mục còn lại nằm ở
    // mục Nhóm.
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls, { groupPinnedAt: '2026-01-02T00:00:00.000Z' });
    renderMessages();

    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    expect(await screen.findByRole('button', { name: 'Ghim' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nhóm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nhóm Riêng/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lớp 10A1/ })).toBeInTheDocument();

    cleanup();
    // Chưa có nhóm nào ghim: không tiêu đề mục nào xuất hiện,
    // danh sách phẳng như hình dạng đã nghiệm thu trước đây.
    const calls2: RecordedCall[] = [];
    stubMsgT3Fetch(calls2);
    renderMessages();
    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    expect(await screen.findByRole('button', { name: /Nhóm Riêng/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ghim' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nhóm' })).not.toBeInTheDocument();
  });

  it('tab Nhóm xếp nhóm tự do vừa ghim vừa lưu trữ vào mục Ghim theo mốc ghim trên cây, dù hội thoại không nằm trong danh sách chưa lưu trữ', async () => {
    // Ghim và lưu trữ là hai trạng thái cá nhân độc lập: nhóm
    // bật cả hai thì rời danh sách hội thoại chính (chỉ còn ở
    // danh sách đã lưu, vốn nạp lười và tab Nhóm không hề gọi
    // tới), nhưng cây nhóm vẫn mang mốc ghim trên chính nút
    // nhóm tự do. Hàng của nhóm phải nằm ở mục Ghim — phân
    // loại theo dữ kiện cây; nếu phân loại theo danh sách chưa
    // lưu trữ thì nhóm bị xếp sai vào mục Nhóm.
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls, { groupPinnedArchived: true });
    renderMessages();

    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    expect(await screen.findByRole('button', { name: 'Ghim' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nhóm' })).toBeInTheDocument();
    // Hàng nhóm nằm TRONG mục Ghim và không có ở mục Nhóm.
    const pinnedSection = screen.getByRole('button', { name: 'Ghim' }).parentElement as HTMLElement;
    expect(within(pinnedSection).getByRole('button', { name: /Nhóm Riêng/ })).toBeInTheDocument();
    const groupsSection = screen.getByRole('button', { name: 'Nhóm' }).parentElement as HTMLElement;
    expect(within(groupsSection).queryByRole('button', { name: /Nhóm Riêng/ })).not.toBeInTheDocument();
    expect(within(groupsSection).getByRole('button', { name: /Lớp 10A1/ })).toBeInTheDocument();
    // Việc phân mục diễn ra mà trang không hề nạp danh sách đã
    // lưu trữ: trạng thái ghim đến từ cây, không phải từ danh
    // sách đã lưu nạp lười phía web.
    expect(calls.some((c) => c.method === 'GET' && c.url === '/api/v1/messages/conversations?archived=true')).toBe(false);
  });

  it('tab Nhóm hiện mọi mục nhóm dạng danh sách phẳng theo vai; bấm dòng khoá và dòng lớp mở ngay chat qua ensure', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    // Số đếm của tab Nhóm là số mục của danh sách phẳng trong
    // ngoặc đơn (lớp + khoá + nhóm con + nhóm tự do = 4), không
    // còn là huy hiệu tổng chưa đọc như cấu trúc cũ.
    expect(screen.getByRole('tab', { name: 'Nhóm' })).toHaveTextContent('(4)');
    // Mọi mục hiện ngay trong danh sách phẳng, không cần thao
    // tác thu/mở nào: lớp, khoá trong lớp, nhóm con của khoá và
    // nhóm tự do là các hàng ngang hàng; không còn nút chevron.
    const classRow = await screen.findByRole('button', { name: /Lớp 10A1/ });
    expect(classRow).toHaveTextContent('Đang dạy');
    // Huy hiệu chưa đọc của chính nút lớp (server tính: 1) vẫn
    // ở trên hàng của nó.
    expect(classRow).toHaveTextContent('1');
    expect(await screen.findByRole('button', { name: /Toán 10/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nhóm 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nhóm Riêng/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mở rộng|Thu gọn/ })).not.toBeInTheDocument();

    // Bấm dòng khoá: ensure conversation của khoá rồi mở khung phải.
    await userEvent.click(screen.getByRole('button', { name: /Toán 10/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'GET' && c.url === `/api/v1/messages/courses/${T3_COURSE_ID}/conversation`)).toBe(true),
    );
    expect(await screen.findByLabelText('Tin nhắn')).toBeInTheDocument();

    // Bấm dòng lớp: ensure conversation của lớp rồi mở khung phải.
    await userEvent.click(screen.getByRole('button', { name: /Lớp 10A1/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'GET' && c.url === `/api/v1/messages/classes/${T3_CLASS_ID}/conversation`)).toBe(true),
    );
  });

  it('nút Tạo nhóm chỉ hiện khi server cấp cờ canCreateFreeGroup: người có cờ tạo được nhóm từ sheet; giáo viên có vai dạy trên dữ kiện nhóm nhưng không có cờ thì không thấy nút; học sinh cũng không thấy nút', async () => {
    // Góc có cờ (quản trị viên hệ thống/chủ trung tâm): nút hiện và
    // luồng tạo nhóm chạy đủ — POST đúng thân type 2.
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls, { canCreateFreeGroup: true });
    renderMessages();

    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    await userEvent.click(await screen.findByRole('button', { name: /Tạo nhóm/ }));
    const sheet = await screen.findByRole('dialog');
    await userEvent.type(within(sheet).getByLabelText('Tên nhóm'), 'Nhóm mới lập');
    const contactRow = await within(sheet).findByTestId(`group-contact-${OTHER_ID}`);
    await userEvent.click(within(contactRow).getByRole('button'));
    await userEvent.click(within(sheet).getByRole('button', { name: /Tạo nhóm/ }));
    await waitFor(() => {
      const create = calls.find((c) => c.url === '/api/v1/messages/conversations' && c.method === 'POST');
      expect(create?.body).toEqual({ type: 2, name: 'Nhóm mới lập', memberIds: [OTHER_ID] });
    });

    cleanup();
    // Góc giáo viên: cây vẫn mang vai DẠY ở mọi nút nhưng server
    // không cấp cờ — nút phải ẩn (trước đây trang tự suy từ vai nên
    // giáo viên vẫn thấy nút dù API đã chặn).
    const teacherCalls: RecordedCall[] = [];
    stubMsgT3Fetch(teacherCalls, { canCreateFreeGroup: false });
    renderMessages();
    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    expect(await screen.findByRole('button', { name: /Lớp 10A1/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tạo nhóm/ })).not.toBeInTheDocument();

    cleanup();
    const studentCalls: RecordedCall[] = [];
    stubMsgT3Fetch(studentCalls, { studentView: true });
    renderMessages();
    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    expect(await screen.findByRole('button', { name: /Lớp 10A1/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tạo nhóm/ })).not.toBeInTheDocument();
  });

  it('nhớ tab và hội thoại gần nhất: nạp lại trang thì gặp lại đúng ngữ cảnh, không cần bấm lại', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Bạn Một/ }));
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của bạn một')).toBeInTheDocument();

    cleanup();
    const calls2: RecordedCall[] = [];
    stubMsgT3Fetch(calls2);
    renderMessages();

    // Không bấm gì: hội thoại gần nhất tự mở lại.
    const thread2 = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread2).findByText('tin của bạn một')).toBeInTheDocument();
  });

  it('mở hội thoại rồi bấm quay lại thì khung phải về trạng thái chưa chọn', async () => {
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm một/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();
    expect(screen.queryByText('Chọn một cuộc hội thoại ở cột trái để đọc và trả lời.')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Quay lại danh sách trò chuyện' }));
    expect(await screen.findByText('Chọn một cuộc hội thoại ở cột trái để đọc và trả lời.')).toBeInTheDocument();
  });
});

/**
 * Fix nhân đôi tin (issue #33): sự cố production 26/10/2026 — một
 * thao tác gửi thành hai dòng tin cách nhau 4ms mang HAI
 * clientMessageId khác nhau. Gốc: send() mint khoá mới ở mỗi lượt gọi
 * và không có khoá chống gọi trùng, nên hai submit trong cùng một
 * nhịp render (khi draft ở state chưa kịp xoá) đều lọt. Server chống
 * trùng theo clientMessageId chỉ đúng khi client GIỮ khoá của bản
 * nháp. Hai ca dưới khoá chặt hành vi: (a) hai submit liên tiếp của
 * cùng một bản nháp trong cùng một nhịp → đúng một request/một tin;
 * (b) bản nháp mới sau khi gửi thành công phải mang khoá MỚI — hai
 * tin liên tiếp hợp lệ không bị gộp oan.
 */
function stubDupSendFetch(calls: RecordedCall[]) {
  let releaseSend: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let seq = 1;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      const respond = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations')
        return respond([
          {
            id: CONV_ID, type: 2, name: 'Nhóm một', members: [ME_ID, OTHER_ID],
            unread: 1, lastReadSeq: 0, lastMessageSeq: 1, lastMessage: FIRST_MESSAGE,
          },
        ]);
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [] });
      // Cây nhóm MSG-T1: 'Nhóm một' là nhóm tự do — mở qua tab Nhóm.
      if (url === '/api/v1/messages/group-tree')
        return respond({
          classes: [],
          coursesOutsideClasses: [],
          freeGroups: [
            { id: CONV_ID, name: 'Nhóm một', myRole: 'staff', conversationId: CONV_ID, unread: 0 },
          ],
          canCreateFreeGroup: true,
        });
      if (url === `/api/v1/messages/conversations/${CONV_ID}`)
        return respond({
          id: CONV_ID, type: 2, name: 'Nhóm một', members: [ME_ID, OTHER_ID],
          messages: [FIRST_MESSAGE], hasMoreBefore: false,
          memberReadMarkers: [
            { userId: ME_ID, lastReadSeq: 1 },
            { userId: OTHER_ID, lastReadSeq: 0 },
          ],
        });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/read`) return respond({ marked: 1, lastReadSeq: 1 });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/messages` && method === 'POST') {
        // Giữ lượt gửi treo tới khi test mở cổng — tái hiện cửa sổ mà
        // lượt submit thứ hai trong cùng nhịp ập vào.
        await gate;
        seq += 1;
        return respond({
          id: `01900000-0000-7000-8000-0000000000e${seq}`,
          conversationId: CONV_ID,
          userIdFrom: ME_ID,
          subject: '',
          fullMessage: body?.text,
          createdAt: '2026-01-01T00:01:00.000Z',
          seq,
          clientMessageId: body?.clientMessageId ?? null,
        });
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return {
    releaseSend: () => releaseSend?.(),
  };
}

describe('Messages page — fix nhân đôi tin: khoá idempotency theo bản nháp', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  const sendPosts = (calls: RecordedCall[]) =>
    calls.filter((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}/messages` && c.method === 'POST');

  it('hai submit liên tiếp của cùng một bản nháp trong cùng một nhịp chỉ thành một tin', async () => {
    const calls: RecordedCall[] = [];
    const { releaseSend } = stubDupSendFetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm một/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();

    const input = screen.getByLabelText('Nội dung tin nhắn');
    await userEvent.type(input, 'tin chống trùng');
    const form = input.closest('form');
    expect(form).not.toBeNull();

    // Hai sự kiện submit trong CÙNG một nhịp (một act duy nhất, chưa
    // kịp render lại xoá draft) — đúng dấu vết sự cố 4ms ở production:
    // cả hai lượt đều đọc được draft còn nguyên.
    act(() => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Chỉ đúng MỘT request ra khỏi client, mang một clientMessageId.
    await waitFor(() => expect(sendPosts(calls)).toHaveLength(1));
    const key = (sendPosts(calls)[0]?.body as { clientMessageId?: unknown }).clientMessageId;
    expect(typeof key).toBe('string');
    expect((sendPosts(calls)[0]?.body as { text?: unknown }).text).toBe('tin chống trùng');
    // Trong lúc lượt gửi đang bay, nút Gửi bị vô hiệu.
    expect(screen.getByRole('button', { name: 'Gửi' })).toBeDisabled();
    // Danh sách chỉ hiện MỘT bản của tin (bản lạc quan đang gửi).
    expect(within(thread).getAllByText('tin chống trùng')).toHaveLength(1);

    releaseSend();
    // Server xác nhận xong: lượt gửi đã nhả — gõ thêm một ký tự
    // thì nút Gửi mở lại (nút vẫn vô hiệu khi nháp trống theo quy
    // tắc của issue #564, nên không assert mở lại trên nháp trống).
    await userEvent.type(input, 'x');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Gửi' })).not.toBeDisabled());
    expect(within(thread).getAllByText('tin chống trùng')).toHaveLength(1);
    expect(sendPosts(calls)).toHaveLength(1);
  });

  it('bản nháp mới sau khi gửi thành công mang khoá mới — hai tin liên tiếp không bị gộp oan', async () => {
    const calls: RecordedCall[] = [];
    const { releaseSend } = stubDupSendFetch(calls);
    releaseSend();
    renderMessages();

    await openGroupFromList(/Nhóm một/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();

    const input = screen.getByLabelText('Nội dung tin nhắn');
    await userEvent.type(input, 'tin thứ nhất');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() => expect(sendPosts(calls)).toHaveLength(1));
    expect(await within(thread).findByText('tin thứ nhất')).toBeInTheDocument();

    await userEvent.type(input, 'tin thứ hai');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() => expect(sendPosts(calls)).toHaveLength(2));

    const firstKey = (sendPosts(calls)[0]?.body as { clientMessageId?: unknown }).clientMessageId;
    const secondKey = (sendPosts(calls)[1]?.body as { clientMessageId?: unknown }).clientMessageId;
    expect(typeof firstKey).toBe('string');
    expect(typeof secondKey).toBe('string');
    expect(secondKey).not.toBe(firstKey);
    expect(within(thread).getAllByText('tin thứ nhất')).toHaveLength(1);
    expect(await within(thread).findByText('tin thứ hai')).toBeInTheDocument();
    expect(within(thread).getAllByText('tin thứ hai')).toHaveLength(1);
  });
});

const T4_COURSE_CONV = '01900000-0000-7000-8000-0000000000f2';
const T4_FREE_CONV = '01900000-0000-7000-8000-0000000000f3';
const T4_FOURTH_ID = '01900000-0000-7000-8000-0000000000f4';
const T4_STUDENT_ID = '01900000-0000-7000-8000-0000000000f5';

/**
 * Stub fetch cho các ca MSG-T4 phía GIÁO VIÊN: một chat cấp khoá
 * (tôi là GV phụ trách, canManage) với roster gồm một HS nhắn thẳng
 * được, một đồng GV chưa kết bạn và một HS đã là liên hệ; một nhóm
 * tự do do tôi tạo. Roster khoá KHÔNG chứa chính người xem (đúng
 * hành vi SQL phía server: người xem + quan hệ chặn bị loại tại
 * nguồn).
 */
function stubMsgT4Fetch(calls: RecordedCall[]) {
  const profiles = {
    [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' },
    [THIRD_ID]: { userId: THIRD_ID, displayName: 'Cô Đồng Nghiệp', username: 'thirduser' },
    [T4_FOURTH_ID]: { userId: T4_FOURTH_ID, displayName: 'Bạn Bốn', username: 'fourthuser' },
  };
  const studentMessage = {
    id: '01900000-0000-7000-8000-0000000000f6', conversationId: T4_COURSE_CONV, userIdFrom: OTHER_ID,
    subject: '', fullMessage: 'em chào cô', createdAt: '2026-01-01T00:00:00.000Z', seq: 1, clientMessageId: null,
  };
  const freeMessage = {
    id: '01900000-0000-7000-8000-0000000000f7', conversationId: T4_FREE_CONV, userIdFrom: OTHER_ID,
    subject: '', fullMessage: 'chào cả nhóm', createdAt: '2026-01-01T00:00:00.000Z', seq: 1, clientMessageId: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations' && method === 'GET')
        return respond([
          {
            id: T4_COURSE_CONV, type: 2, name: 'Toán 10', component: 'core_course', itemType: 'course', itemId: COURSE_ID,
            members: [ME_ID, OTHER_ID, THIRD_ID, T4_FOURTH_ID], unread: 0, lastReadSeq: 0, lastMessageSeq: 1, lastMessage: studentMessage,
          },
        ]);
      if (url === '/api/v1/messages/group-tree')
        return respond({
          classes: [],
          coursesOutsideClasses: [
            { courseId: COURSE_ID, name: 'Toán 10', myRole: 'teaching', conversationId: T4_COURSE_CONV, unread: 0, groups: [] },
          ],
          freeGroups: [
            { id: T4_FREE_CONV, name: 'Nhóm ôn tập', myRole: 'staff', conversationId: T4_FREE_CONV, unread: 0 },
          ],
          canCreateFreeGroup: false,
        });
      if (url === `/api/v1/messages/courses/${COURSE_ID}/conversation`)
        return respond({
          id: T4_COURSE_CONV, type: 2, name: 'Toán 10', component: 'core_course', itemType: 'course', itemId: COURSE_ID,
          members: [ME_ID, OTHER_ID, THIRD_ID, T4_FOURTH_ID],
        });
      if (url === `/api/v1/messages/conversations/${T4_COURSE_CONV}`)
        return respond({
          id: T4_COURSE_CONV, type: 2, name: 'Toán 10', component: 'core_course', itemType: 'course', itemId: COURSE_ID,
          members: [ME_ID, OTHER_ID, THIRD_ID, T4_FOURTH_ID], memberProfiles: profiles,
          messages: [studentMessage], hasMoreBefore: false,
          memberReadMarkers: [{ userId: OTHER_ID, lastReadSeq: 1 }],
          enabled: true, canManage: true, canModerate: true, createdBy: THIRD_ID,
        });
      if (url === `/api/v1/messages/conversations/${T4_FREE_CONV}`)
        return respond({
          id: T4_FREE_CONV, type: 2, name: 'Nhóm ôn tập', component: null, itemType: null, itemId: null,
          members: [ME_ID, OTHER_ID, T4_FOURTH_ID], memberProfiles: profiles,
          messages: [freeMessage], hasMoreBefore: false, memberReadMarkers: [],
          enabled: true, canManage: true, canModerate: false, createdBy: ME_ID,
        });
      if (url.startsWith(`/api/v1/messages/courses/${COURSE_ID}/members`))
        return respond({
          members: [
            { ...profiles[OTHER_ID], role: 'student', relationship: 'none', canDirectMessage: true },
            { ...profiles[THIRD_ID], role: 'teacher', relationship: 'none', canDirectMessage: false },
            { ...profiles[T4_FOURTH_ID], role: 'student', relationship: 'contact', canDirectMessage: true },
          ],
          nextCursor: null,
        });
      if (url === `/api/v1/messages/conversations/${T4_FREE_CONV}/members/${OTHER_ID}` && method === 'DELETE')
        return respond({ id: T4_FREE_CONV, type: 2, name: 'Nhóm ôn tập', members: [ME_ID, T4_FOURTH_ID] });
      if (url === '/api/v1/messages/conversations' && method === 'POST')
        return respond({ id: '01900000-0000-7000-8000-0000000000f8', type: 1, name: null, members: [ME_ID, OTHER_ID] });
      if (url === '/api/v1/messages/conversations/01900000-0000-7000-8000-0000000000f8')
        return respond({ id: '01900000-0000-7000-8000-0000000000f8', type: 1, name: null, members: [ME_ID, OTHER_ID], messages: [], hasMoreBefore: false, memberReadMarkers: [] });
      if (url === `/api/v1/messages/contacts/${THIRD_ID}` && method === 'POST') return respond({ status: 'pending' });
      if (/^\/api\/v1\/messages\/conversations\/[^/]+\/read$/.test(url)) return respond({ marked: 0, lastReadSeq: 0 });
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 0, notifications: 0 });
      if (url === '/api/v1/messages/contacts')
        return respond({ contacts: [T4_FOURTH_ID], profiles });
      if (url === '/api/v1/messages/contacts/requests') return respond({ incoming: [], outgoing: [], profiles: {} });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [], profiles: {} });
      if (url === '/api/v1/messages/courses')
        return respond({ courses: [{ courseId: COURSE_ID, fullName: 'Toán 10', shortName: 'T10' }] });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/** Mở chat cấp khoá Toán 10 từ danh sách của tab Nhóm (đường ensure) và chờ khung chat hiện. */
async function openT4CourseChat() {
  await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
  await userEvent.click(await screen.findByRole('button', { name: /Toán 10/ }));
  expect(await screen.findByLabelText('Tin nhắn')).toBeInTheDocument();
}

/** Mở panel Info của khung chat đang mở và chờ dòng thành viên đầu tiên của panel nạp xong. */
async function openT4InfoPanel(firstRowTestId: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Thông tin cuộc trò chuyện' }));
  expect(await screen.findByTestId(firstRowTestId)).toBeInTheDocument();
}

/**
 * Lát MSG-T4 (panel thành viên + menu trên avatar, mục 4.3 của hồ
 * sơ cấu trúc nhắn tin): các ca dưới khoá đúng luật quan hệ đã chốt
 * — GV nhắn thẳng HS của khoá mình, HS↔HS phải kết bạn, quản trị
 * nhóm cấu trúc chỉ dẫn về roster, nhóm tự do mới gỡ được thành
 * viên tại chỗ. Đổi các luật này thì ca tương ứng phải đỏ.
 */
describe('Messages page — MSG-T4: panel thành viên + menu avatar', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('panel Info của chat khoá hiện thông tin nhóm, công tắc cho người quản lý và thành viên phân Giáo viên/Học sinh từ roster khoá', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    await openT4InfoPanel(`member-panel-row-${OTHER_ID}`);

    // Thông tin nhóm: loại Khoá học + công tắc Tắt chat cho
    // người quản lý (issue #591: công tắc nằm trong menu hành
    // động ở đầu khung thay cho nút ở hàng thứ hai).
    expect(screen.getByText('Khoá học')).toBeInTheDocument();
    await openHeaderActionsMenu();
    expect(await screen.findByRole('menuitem', { name: 'Tắt chat' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    // Roster được nạp hết trang từ endpoint roster của khoá.
    expect(calls.some((c) => c.method === 'GET' && c.url === `/api/v1/messages/courses/${COURSE_ID}/members?limit=100`)).toBe(true);
    // Phân nhóm đúng vai: đồng GV ở nhóm Giáo viên, hai HS ở nhóm
    // Học sinh. Tiêu đề mục là thẻ <p> — huy hiệu vai trên từng dòng
    // mang cùng chữ nên phải neo theo selector.
    expect(screen.getByText('Giáo viên', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Học sinh', { selector: 'p' })).toBeInTheDocument();
    const teacherRow = screen.getByTestId(`member-panel-row-${THIRD_ID}`);
    expect(within(teacherRow).getByText('Cô Đồng Nghiệp')).toBeInTheDocument();
    const studentRow = screen.getByTestId(`member-panel-row-${OTHER_ID}`);
    expect(within(studentRow).getByText('Bạn Học')).toBeInTheDocument();
    // Mốc đã xem giữ nguyên hành vi panel cũ: HS đã đọc tới tin mới nhất thì mang huy hiệu Đã xem.
    expect(within(studentRow).getByText('Đã xem')).toBeInTheDocument();
  });

  it('GV bấm avatar HS thuộc khoá: menu có Nhắn riêng (không ép kết bạn) và mở ngay hội thoại 1–1', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    await openT4InfoPanel(`member-panel-row-${OTHER_ID}`);

    const row = screen.getByTestId(`member-panel-row-${OTHER_ID}`);
    await userEvent.click(within(row).getByRole('button', { name: 'Thao tác với Bạn Học' }));
    expect(await screen.findByRole('menuitem', { name: 'Nhắn riêng' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Kết bạn' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('menuitem', { name: 'Nhắn riêng' }));
    await waitFor(() => {
      const create = calls.find((c) => c.url === '/api/v1/messages/conversations' && c.method === 'POST');
      expect(create?.body).toEqual({ memberIds: [OTHER_ID] });
    });
  });

  it('đồng GV chưa kết bạn và không có cờ nhắn thẳng: menu chỉ Kết bạn, gửi yêu cầu xong dòng chuyển trạng thái chờ', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    await openT4InfoPanel(`member-panel-row-${THIRD_ID}`);

    const row = screen.getByTestId(`member-panel-row-${THIRD_ID}`);
    await userEvent.click(within(row).getByRole('button', { name: 'Thao tác với Cô Đồng Nghiệp' }));
    expect(await screen.findByRole('menuitem', { name: 'Kết bạn' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Nhắn riêng' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('menuitem', { name: 'Kết bạn' }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === `/api/v1/messages/contacts/${THIRD_ID}` && c.method === 'POST')).toBe(true);
    });
    expect(await screen.findByText('Đã gửi yêu cầu kết bạn — chờ phía kia chấp nhận.')).toBeInTheDocument();

    // Mở lại menu của dòng đó: hành động kết bạn thay bằng trạng thái chờ phản hồi.
    await userEvent.click(within(row).getByRole('button', { name: 'Thao tác với Cô Đồng Nghiệp' }));
    expect(await screen.findByRole('menuitem', { name: 'Đang chờ phản hồi' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Kết bạn' })).not.toBeInTheDocument();
  });

  it('avatar trên dòng tin bấm được và mở menu quan hệ của tác giả tin', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    // Panel Info KHÔNG mở — avatar của tin "em chào cô" vẫn bấm được.
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('em chào cô')).toBeInTheDocument();
    await userEvent.click(within(thread).getByRole('button', { name: 'Thao tác với Bạn Học' }));
    expect(await screen.findByRole('menuitem', { name: 'Nhắn riêng' })).toBeInTheDocument();
  });

  it('người quản lý chat khoá: menu thành viên dẫn về màn roster của khoá, tuyệt đối không có gỡ thành viên trong chat', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    await openT4InfoPanel(`member-panel-row-${OTHER_ID}`);

    const row = screen.getByTestId(`member-panel-row-${OTHER_ID}`);
    await userEvent.click(within(row).getByRole('button', { name: 'Thao tác với Bạn Học' }));
    expect(await screen.findByRole('menuitem', { name: 'Quản lý danh sách khoá' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Gỡ khỏi nhóm' })).not.toBeInTheDocument();
  });

  it('Xem thông tin mở hồ sơ rút gọn của thành viên trong phạm vi khoá chung', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    await openT4InfoPanel(`member-panel-row-${OTHER_ID}`);

    const row = screen.getByTestId(`member-panel-row-${OTHER_ID}`);
    await userEvent.click(within(row).getByRole('button', { name: 'Thao tác với Bạn Học' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Xem thông tin' }));

    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Thông tin thành viên')).toBeInTheDocument();
    expect(within(sheet).getByText('Bạn Học')).toBeInTheDocument();
    expect(within(sheet).getByText('Học sinh')).toBeInTheDocument();
    expect(within(sheet).getByText('Toán 10')).toBeInTheDocument();
    // Quan hệ theo cờ nhắn thẳng GV→HS của roster, không lộ dữ kiện ngoài khoá chung.
    expect(within(sheet).getByText('Học viên của lớp/khoá của bạn')).toBeInTheDocument();
  });

  it('nhóm tự do: panel phân Quản trị viên (người tạo) / Thành viên; người quản lý gỡ được thành viên tại chỗ', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm ôn tập/);
    await openT4InfoPanel(`member-panel-row-${OTHER_ID}`);

    // Loại "Nhóm tự do" khẳng định trong phạm vi panel (cây bên trái
    // cũng có một tiêu đề mục cùng chữ).
    expect(within(screen.getByTestId('member-panel')).getByText('Nhóm tự do')).toBeInTheDocument();
    // Tiêu đề hai mục phân vai (thẻ <p>; huy hiệu vai trên dòng mang cùng chữ).
    expect(screen.getByText('Quản trị viên', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Thành viên', { selector: 'p' })).toBeInTheDocument();
    // Người tạo nhóm là tôi: dòng của tôi mang huy hiệu Người tạo nhóm.
    const myRow = screen.getByTestId(`member-panel-row-${ME_ID}`);
    expect(within(myRow).getByText('Người tạo nhóm')).toBeInTheDocument();

    const row = screen.getByTestId(`member-panel-row-${OTHER_ID}`);
    await userEvent.click(within(row).getByRole('button', { name: 'Thao tác với Bạn Học' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Gỡ khỏi nhóm' }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === `/api/v1/messages/conversations/${T4_FREE_CONV}/members/${OTHER_ID}` && c.method === 'DELETE')).toBe(true);
    });
    // Gỡ xong: dòng của thành viên đó rời panel.
    await waitFor(() => {
      expect(screen.queryByTestId(`member-panel-row-${OTHER_ID}`)).not.toBeInTheDocument();
    });
  });

  it('nhóm tự do: dòng thành viên mang đủ ba huy hiệu vẫn giữ sàn bề ngang cho cột tên và huy hiệu được phép rớt dòng', async () => {
    // Cùng họ co bề ngang với tiêu đề danh sách bị cắt ba
    // chấm: ba huy hiệu không co lại được (người tạo nhóm +
    // vai + đã xem) ép cột tên linh hoạt về gần 0px trong
    // panel 320px, làm tên xếp chồng từng ký tự. jsdom
    // không có layout thật nên ca này ghim cơ chế: phần tử
    // dòng cho phép rớt dòng (flex-wrap) và nút mở menu của
    // dòng mang sàn bề ngang min-w-36 cho avatar + tên.
    // Trên bản cũ dòng là flex một hàng và nút không có
    // sàn — ca này đỏ.
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm ôn tập/);
    await openT4InfoPanel(`member-panel-row-${OTHER_ID}`);

    // Dòng của tôi mang cả ba huy hiệu: người tạo nhóm, vai
    // quản trị viên và trạng thái đã xem/chưa xem.
    const myRow = screen.getByTestId(`member-panel-row-${ME_ID}`);
    expect(within(myRow).getByText('Người tạo nhóm')).toBeInTheDocument();
    expect(myRow).toHaveClass('flex-wrap');
    expect(within(myRow).getByRole('button', { name: /Thao tác với/ })).toHaveClass('min-w-36');
  });
});

/**
 * Stub fetch cho ca MSG-T4 phía HỌC SINH: tôi là HS của khoá Toán
 * 10, đã có hội thoại 1–1 với GV (GV đã mở trước) nhưng chưa kết
 * bạn với GV lẫn bạn học cùng khoá; roster theo góc nhìn HS không
 * mang cờ nhắn thẳng nào.
 */
function stubMsgT4StudentFetch(calls: RecordedCall[]) {
  const studentProfile = { ...PROFILE, id: T4_STUDENT_ID, username: 'student1' };
  const profiles = {
    [OTHER_ID]: { userId: OTHER_ID, displayName: 'Cô Giáo', username: 'teacheruser' },
    [T4_FOURTH_ID]: { userId: T4_FOURTH_ID, displayName: 'Bạn Bốn', username: 'fourthuser' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: studentProfile.id, username: studentProfile.username, email: studentProfile.email }));
      if (url === '/api/v1/users/me') return respond(studentProfile);
      if (url === '/api/v1/messages/conversations' && method === 'GET')
        return respond([
          { id: '01900000-0000-7000-8000-0000000000f9', type: 1, name: null, members: [T4_STUDENT_ID, OTHER_ID], unread: 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null },
          {
            id: T4_COURSE_CONV, type: 2, name: 'Toán 10', component: 'core_course', itemType: 'course', itemId: COURSE_ID,
            members: [T4_STUDENT_ID, OTHER_ID, T4_FOURTH_ID], unread: 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null,
          },
        ]);
      if (url === '/api/v1/messages/group-tree')
        return respond({
          classes: [],
          coursesOutsideClasses: [
            { courseId: COURSE_ID, name: 'Toán 10', myRole: 'learning', conversationId: T4_COURSE_CONV, unread: 0, groups: [] },
          ],
          freeGroups: [],
          canCreateFreeGroup: false,
        });
      if (url === `/api/v1/messages/courses/${COURSE_ID}/conversation`)
        return respond({
          id: T4_COURSE_CONV, type: 2, name: 'Toán 10', component: 'core_course', itemType: 'course', itemId: COURSE_ID,
          members: [T4_STUDENT_ID, OTHER_ID, T4_FOURTH_ID],
        });
      if (url === `/api/v1/messages/conversations/${T4_COURSE_CONV}`)
        return respond({
          id: T4_COURSE_CONV, type: 2, name: 'Toán 10', component: 'core_course', itemType: 'course', itemId: COURSE_ID,
          members: [T4_STUDENT_ID, OTHER_ID, T4_FOURTH_ID], memberProfiles: profiles,
          messages: [], hasMoreBefore: false, memberReadMarkers: [],
          enabled: true, canManage: false, canModerate: false, createdBy: OTHER_ID,
        });
      if (url.startsWith(`/api/v1/messages/courses/${COURSE_ID}/members`))
        return respond({
          members: [
            { ...profiles[OTHER_ID], role: 'teacher', relationship: 'none', canDirectMessage: false },
            { ...profiles[T4_FOURTH_ID], role: 'student', relationship: 'none', canDirectMessage: false },
          ],
          nextCursor: null,
        });
      if (/^\/api\/v1\/messages\/conversations\/[^/]+\/read$/.test(url)) return respond({ marked: 0, lastReadSeq: 0 });
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 0, notifications: 0 });
      if (url === '/api/v1/messages/contacts') return respond({ contacts: [], profiles: {} });
      if (url === '/api/v1/messages/contacts/requests') return respond({ incoming: [], outgoing: [], profiles: {} });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [], profiles: {} });
      if (url === '/api/v1/messages/courses')
        return respond({ courses: [{ courseId: COURSE_ID, fullName: 'Toán 10', shortName: 'T10' }] });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Messages page — MSG-T4 phía học sinh: không nới luật nhắn riêng', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('HS mở panel: không công tắc quản lý; GV đã có hội thoại mở trước thì nhắn riêng được, bạn học cùng khoá thì chỉ Kết bạn', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4StudentFetch(calls);
    renderMessages();

    await openT4CourseChat();
    await openT4InfoPanel(`member-panel-row-${OTHER_ID}`);

    // Không có thẩm quyền quản lý: không công tắc tắt chat, không mục quản lý roster.
    expect(screen.queryByRole('button', { name: 'Tắt chat' })).not.toBeInTheDocument();

    // GV của tôi: hội thoại 1–1 đã tồn tại (GV mở trước) → Nhắn riêng hiện, Kết bạn không hiện.
    const teacherRow = screen.getByTestId(`member-panel-row-${OTHER_ID}`);
    await userEvent.click(within(teacherRow).getByRole('button', { name: 'Thao tác với Cô Giáo' }));
    expect(await screen.findByRole('menuitem', { name: 'Nhắn riêng' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Kết bạn' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Quản lý danh sách khoá' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    // Bạn học cùng khoá, chưa kết bạn, chưa có hội thoại: chỉ Kết bạn — HS↔HS giữ đúng luật.
    const friendRow = screen.getByTestId(`member-panel-row-${T4_FOURTH_ID}`);
    await userEvent.click(within(friendRow).getByRole('button', { name: 'Thao tác với Bạn Bốn' }));
    expect(await screen.findByRole('menuitem', { name: 'Kết bạn' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Nhắn riêng' })).not.toBeInTheDocument();
  });
});

/**
 * Lát dọn gọn UI nhắn tin (nối tiếp issue #33 — ghi nhận phản ánh
 * khi kiểm tra production): hai lỗi TRÌNH BÀY đã chốt cách sửa —
 * (1) avatar phải neo ở ĐẦU dòng tin, không còn neo đáy + hack
 * translate theo footer khiến avatar nằm ngang hàng hàng tuỳ chọn
 * dưới bong bóng; (2) các menu nổi ở bề mặt nhắn tin (menu ⋯ trên
 * tin, menu quan hệ trên avatar/tên thành viên, và — lát bổ sung sau
 * ghi nhận của đội đánh giá PR #298 — menu ⋯ trên từng hội thoại ở
 * danh sách) phải có bề rộng tử tế và từng mục nằm trên MỘT dòng,
 * thay cho bề rộng mặc định bị ghim theo nút gọt hẹp. Các ca dưới
 * khoá đúng hai hợp đồng trình bày này qua
 * DOM người dùng thật sự nhận được; hành vi/handler không đổi nên
 * các describe cũ ở trên vẫn là nơi gác luồng nghiệp vụ.
 */
describe('Messages page — dọn gọn trình bày (avatar neo đáy dòng + menu không xuống dòng)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    realtime.handlers = null;
  });

  /**
   * Mọi avatar trong khung chat: neo ĐÁY dòng tin (self-end)
   * như bản demo (issue #608 — đảo lựa chọn neo đầu dòng trước
   * đây của package ui), hết hack translate theo footer.
   */
  function expectAvatarsAnchoredToMessageBottom(thread: HTMLElement) {
    const avatars = thread.querySelectorAll('[data-slot="message-avatar"]');
    expect(avatars.length).toBeGreaterThan(0);
    for (const avatar of avatars) {
      expect(avatar.className).toContain('self-end');
      expect(avatar.className).not.toContain('self-start');
      expect(avatar.className).not.toContain('-translate-y-8');
      expect(avatar.className).not.toContain('message-footer');
    }
  }

  /** Menu nổi đang mở: content mang bề rộng đã chốt (không còn bề rộng theo nút gọt) và mọi mục không xuống dòng. */
  function expectOpenMenuTidy() {
    const content = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(content).not.toBeNull();
    expect(content!.className).toContain('w-max');
    expect(content!.className).toContain('min-w-52');
    expect(content!.className).toContain('max-w-[calc(100vw-2rem)]');
    expect(content!.className).not.toContain('w-(--anchor-width)');
    const items = [
      ...screen.getAllByRole('menuitem'),
      ...screen.queryAllByRole('menuitemcheckbox'),
    ];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.className).toContain('whitespace-nowrap');
    }
  }

  it('avatar neo đáy dòng tin cho cả tin của mình và tin người khác', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm lớp/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của tôi sẽ xoá')).toBeInTheDocument();
    expect(await within(thread).findByText('tin của bạn học')).toBeInTheDocument();
    expectAvatarsAnchoredToMessageBottom(thread);
  });

  it('menu quan hệ mở từ avatar trên dòng tin: bề rộng tử tế, mọi mục một dòng', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('em chào cô')).toBeInTheDocument();
    expectAvatarsAnchoredToMessageBottom(thread);

    await userEvent.click(within(thread).getByRole('button', { name: 'Thao tác với Bạn Học' }));
    expect(await screen.findByRole('menuitem', { name: 'Nhắn riêng' })).toBeInTheDocument();
    expectOpenMenuTidy();
  });

  it('menu ⋯ trên tin (gồm mục checkbox chọn hàng loạt): bề rộng tử tế, mọi mục một dòng', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('em chào cô')).toBeInTheDocument();

    // Tin của HS trong khoá người xem quản lý: menu ⋯ có mục checkbox
    // "Chọn tin để gỡ hàng loạt" — nhãn dài nhất của menu này.
    await userEvent.click(screen.getByTestId('message-actions-01900000-0000-7000-8000-0000000000f6'));
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Chọn tin để gỡ hàng loạt' })).toBeInTheDocument();
    expectOpenMenuTidy();
  });

  it('menu ⋯ trên hội thoại ở danh sách: bề rộng tử tế, mọi mục một dòng', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetchM5(calls);
    renderMessages();

    expect(await screen.findByRole('button', { name: /Hội thoại A/ })).toBeInTheDocument();

    // Trạng thái chưa ghim: nhãn "Ghim cuộc trò chuyện" là nhãn bị bẻ
    // hai dòng khi menu còn bề rộng mặc định (điểm sót lát trước).
    await userEvent.click(screen.getByTestId(`conversation-actions-${M5_CONV_A}`));
    expect(await screen.findByRole('menuitem', { name: 'Ghim cuộc trò chuyện' })).toBeInTheDocument();
    expectOpenMenuTidy();
  });
});

/**
 * Lát sửa dứt điểm trình bày tin nhắn (nối tiếp issue #33 — quyết
 * định 23:16 ngày 26/10/2026, sổ quyết định mục D): ba hợp đồng
 * trình bày mới thay cho cách đặt cũ đã bị chất vấn —
 * (1) cụm hành động trên tin là toolbar NỔI cạnh bong bóng (định
 *     vị tuyệt đối theo bong bóng, ngoài luồng dọc), thay cho một
 *     hàng trong luồng chiếm chiều cao của mọi dòng tin;
 * (2) dòng thời gian chỉ hiện ở tin nhắn CUỐI đang xem — tin khác
 *     chỉ còn footer khi mang ghi chú trạng thái gắn riêng;
 * (3) nút Chặn ở header: chat nhóm KHÔNG còn nút nào, chat 1–1
 *     đúng MỘT nút kèm tên người đối thoại; ở nhóm, chặn đi qua
 *     menu hành động của thành viên bằng đúng handler của trang.
 * Đổi ngược các quyết này thì ca tương ứng phải đỏ.
 */
describe('Messages page — sửa dứt điểm trình bày (toolbar nổi + giờ ở tin cuối + nút Chặn)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('toolbar hành động nổi cạnh bong bóng, ngoài luồng dọc: tin mình nổi phía trái, tin người khác nổi phía phải', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm lớp/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của tôi sẽ xoá')).toBeInTheDocument();
    expect(await within(thread).findByText('tin của bạn học')).toBeInTheDocument();

    const ownRow = within(thread).getByText('tin của tôi sẽ xoá').closest('[data-slot="message"]')!;
    const peerRow = within(thread).getByText('tin của bạn học').closest('[data-slot="message"]')!;
    const ownActions = ownRow.querySelector('[data-slot="message-actions"]');
    const peerActions = peerRow.querySelector('[data-slot="message-actions"]');
    expect(ownActions).not.toBeNull();
    expect(peerActions).not.toBeNull();
    // Cụm nằm TRONG bong bóng (định vị tuyệt đối theo bong bóng)
    // chứ không còn là một hàng con của cột nội dung như bản cũ.
    expect(ownActions!.closest('[data-slot="bubble"]')).not.toBeNull();
    expect(peerActions!.closest('[data-slot="bubble"]')).not.toBeNull();
    for (const actions of [ownActions!, peerActions!]) {
      expect(actions.className).toContain('absolute');
      expect(actions.className).toContain('top-0');
    }
    expect(ownActions!.className).toContain('right-full');
    expect(peerActions!.className).toContain('left-full');
  });

  it('mỗi bong bóng đều mang giờ của chính nó trong bong bóng, không còn dòng giờ chung ở tin cuối', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm lớp/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của bạn học')).toBeInTheDocument();

    // Cả hai tin đều có dòng giờ riêng NẰM TRONG bong bóng của
    // chính tin đó (issue #591, như bản demo) — giờ lấy theo
    // đúng mốc tạo của từng tin.
    const firstRow = within(thread).getByText('tin của tôi sẽ xoá').closest('[data-slot="message"]')!;
    const lastRow = within(thread).getByText('tin của bạn học').closest('[data-slot="message"]')!;
    const firstTime = firstRow.querySelector('[data-testid^="message-time-"]');
    const lastTime = lastRow.querySelector('[data-testid^="message-time-"]');
    expect(firstTime).not.toBeNull();
    expect(lastTime).not.toBeNull();
    expect(firstTime!.closest('[data-slot="bubble"]')).not.toBeNull();
    expect(lastTime!.closest('[data-slot="bubble"]')).not.toBeNull();
    // Giờ trong bong bóng theo định dạng 12 giờ của bản demo
    // (issue #608): tính giá trị kỳ vọng bằng đúng bộ tuỳ chọn
    // Intl mà component dùng, không dùng formatTime 24 giờ nữa.
    expect(lastTime!.textContent).toContain(
      formatWithOptions('2026-01-01T00:01:00.000Z', 'vi', { hour: 'numeric', minute: '2-digit', hour12: true }),
    );
    // Không tin nào mang ghi chú trạng thái nên không còn
    // footer dòng tin nào trong luồng.
    expect(thread.querySelectorAll('[data-slot="message-footer"]')).toHaveLength(0);
  });

  it('header chat nhóm không còn nút hay mục menu Chặn/Bỏ chặn nào', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm lớp/);
    expect(await screen.findByLabelText('Tin nhắn')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Chặn liên lạc/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Bỏ chặn/ })).not.toBeInTheDocument();
    // Cả trong menu hành động ở đầu khung cũng không có mục
    // chặn cho chat nhóm (chặn ở nhóm đi qua menu của từng
    // thành viên).
    await openHeaderActionsMenu();
    expect(screen.queryByRole('menuitem', { name: /^Chặn liên lạc/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^Bỏ chặn/ })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
  });

  it('header chat 1–1: menu hành động chứa đúng một mục Chặn kèm tên người đối thoại và không còn nút Chặn riêng', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderMessages();

    const convButton = await screen.findByRole('button', { name: new RegExp(OTHER_ID) });
    await userEvent.click(convButton);

    expect(screen.queryByRole('button', { name: /^Chặn liên lạc / })).not.toBeInTheDocument();
    await openHeaderActionsMenu();
    const blockItems = await screen.findAllByRole('menuitem', { name: /^Chặn liên lạc / });
    expect(blockItems).toHaveLength(1);
    await userEvent.keyboard('{Escape}');
  });

  it('chặn một thành viên nhóm qua menu hành động trong panel: gọi đúng POST contacts/:userId/block của trang', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    await openT4InfoPanel(`member-panel-row-${OTHER_ID}`);
    const studentRow = screen.getByTestId(`member-panel-row-${OTHER_ID}`);
    await userEvent.click(within(studentRow).getByRole('button', { name: 'Thao tác với Bạn Học' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Chặn liên lạc' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/contacts/${OTHER_ID}/block` && c.method === 'POST')).toBe(true),
    );
  });
});

/**
 * Stub fetch cho các ca hồi quy của các vòng sửa PR #530: chi tiết
 * nhóm một có trạng thái (tin gửi thành công nằm trong chi tiết cho
 * tới khi bị gỡ — giả lập tin đã bị xoá cứng phía server; tin cũng
 * có thể được thêm vào chi tiết — giả lập tin đến trong lúc mất kết
 * nối), và đáp ứng POST gửi tin có thể bị GIỮ LẠI để test chèn sự
 * kiện socket xác nhận đến trước đáp ứng REST.
 */
function stubFix530Fetch(calls: RecordedCall[]) {
  const SAVED_ID = '01900000-0000-7000-8000-0000000000f6';
  const state = {
    detailMessages: [FIRST_MESSAGE] as Record<string, unknown>[],
    sendGate: null as Promise<void> | null,
    releaseSend: null as (() => void) | null,
  };
  const controls = {
    /** Giữ đáp ứng POST gửi tin đang bay cho tới khi `releaseSend` được gọi. */
    holdSend() {
      state.sendGate = new Promise<void>((resolve) => {
        state.releaseSend = resolve;
      });
    },
    /** Thả đáp ứng POST đang bị giữ. */
    releaseSend() {
      state.releaseSend?.();
      state.sendGate = null;
      state.releaseSend = null;
    },
    /** Gỡ một tin khỏi chi tiết phía server (giả lập tin đã bị xoá cứng). */
    removeFromDetail(messageId: string) {
      state.detailMessages = state.detailMessages.filter((m) => m.id !== messageId);
    },
    /** Thêm một tin vào chi tiết phía server (giả lập tin đến trong lúc mất kết nối). */
    addToDetail(message: Record<string, unknown>) {
      state.detailMessages = [...state.detailMessages, message];
    },
    savedId: SAVED_ID,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      const respond = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations')
        return respond([
          {
            id: CONV_ID, type: 2, name: 'Nhóm một', members: [ME_ID, OTHER_ID],
            unread: 1, lastReadSeq: 0, lastMessageSeq: 1, lastMessage: FIRST_MESSAGE,
          },
          {
            id: CONV2_ID, type: 2, name: 'Nhóm hai', members: [ME_ID, OTHER_ID],
            unread: 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null,
          },
        ]);
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [] });
      // Cây nhóm: hai hội thoại là nhóm tự do, mở qua tab Nhóm như bộ dữ kiện realtime.
      if (url === '/api/v1/messages/group-tree')
        return respond({
          classes: [],
          coursesOutsideClasses: [],
          freeGroups: [
            { id: CONV_ID, name: 'Nhóm một', myRole: 'staff', conversationId: CONV_ID, unread: 0 },
            { id: CONV2_ID, name: 'Nhóm hai', myRole: 'staff', conversationId: CONV2_ID, unread: 2 },
          ],
          canCreateFreeGroup: true,
        });
      if (url === `/api/v1/messages/conversations/${CONV_ID}`)
        return respond({
          id: CONV_ID, type: 2, name: 'Nhóm một', members: [ME_ID, OTHER_ID],
          messages: state.detailMessages, hasMoreBefore: false,
          memberReadMarkers: [
            { userId: ME_ID, lastReadSeq: 1 },
            { userId: OTHER_ID, lastReadSeq: 0 },
          ],
        });
      if (url === `/api/v1/messages/conversations/${CONV2_ID}`)
        return respond({
          id: CONV2_ID, type: 2, name: 'Nhóm hai', members: [ME_ID, OTHER_ID],
          messages: [], hasMoreBefore: false, memberReadMarkers: [],
        });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/read`) return respond({ marked: 1, lastReadSeq: 1 });
      if (url === `/api/v1/messages/conversations/${CONV2_ID}/read`) return respond({ marked: 0, lastReadSeq: 0 });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/messages` && method === 'POST') {
        const saved = {
          id: SAVED_ID,
          conversationId: CONV_ID,
          userIdFrom: ME_ID,
          subject: '',
          fullMessage: body?.text,
          createdAt: '2026-01-01T00:01:00.000Z',
          seq: 2,
          clientMessageId: body?.clientMessageId ?? null,
        };
        state.detailMessages = [...state.detailMessages, saved];
        if (state.sendGate) await state.sendGate;
        return respond(saved);
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return controls;
}

describe('Messages page — hồi quy vòng sửa PR #530 (tin ở hội thoại không hoạt động + tin tạm sau xác nhận)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('hiện tin mới nhận lúc hội thoại không hoạt động khi mở lại hội thoại đó trong cửa sổ dữ kiện còn tươi', async () => {
    const calls: RecordedCall[] = [];
    stubFix530Fetch(calls);
    renderMessages();

    // Mở nhóm một: chi tiết nạp vào cache, khung hiện tin đầu tiên.
    // (Vùng khung tin bị dựng lại mỗi lần chuyển hội thoại nên mọi
    // khẳng định về khung đều lấy node HIỆN HÀNH theo nhãn, không
    // giữ node đã chụp từ hội thoại trước.)
    await openGroupFromList(/Nhóm một/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();

    // Chuyển hẳn sang nhóm hai — từ đây nhóm một không còn hoạt động:
    // khung hiện hành không còn tin của nhóm một.
    await userEvent.click(await screen.findByRole('button', { name: /Nhóm hai/ }));
    await waitFor(() =>
      expect(within(screen.getByLabelText('Tin nhắn')).queryByText('tin đầu tiên')).not.toBeInTheDocument(),
    );

    // Tin mới đến ở nhóm một trong lúc người dùng đang ở nhóm hai:
    // server đẩy cả sự kiện tin mới lẫn sự kiện cập nhật hội thoại.
    const incoming = {
      id: '01900000-0000-7000-8000-0000000000f7',
      conversationId: CONV_ID,
      userIdFrom: OTHER_ID,
      subject: '',
      fullMessage: 'tin đến lúc đang ở nhóm hai',
      createdAt: '2026-01-01T00:02:00.000Z',
      seq: 2,
      clientMessageId: null,
    };
    act(() => {
      realtime.handlers?.onNewMessage({ conversationId: CONV_ID, message: incoming } as never);
      realtime.handlers?.onConversationUpdated({ conversationId: CONV_ID, message: incoming, unreadCount: 1 } as never);
    });

    // Mở lại nhóm một ngay trong cửa sổ còn tươi của cache chi tiết:
    // tin mới phải có mặt trong khung tin, không chỉ ở xem trước.
    await userEvent.click(await screen.findByRole('button', { name: /Nhóm một/ }));
    const reopenedThread = await screen.findByLabelText('Tin nhắn');
    expect(await within(reopenedThread).findByText('tin đến lúc đang ở nhóm hai')).toBeInTheDocument();
    expect(within(reopenedThread).getByText('tin đầu tiên')).toBeInTheDocument();
  });

  it('không hiện lại nội dung tin tạm sau khi tin thật đã được xác nhận qua socket rồi bị xoá cứng khỏi cửa sổ', async () => {
    const calls: RecordedCall[] = [];
    const controls = stubFix530Fetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm một/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();

    // Giữ đáp ứng REST của lượt gửi để sự kiện socket xác nhận đến trước.
    controls.holdSend();
    const input = screen.getByLabelText('Nội dung tin nhắn');
    await userEvent.type(input, 'nội dung sẽ bị xoá cứng');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() => {
      const send = calls.find((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}/messages` && c.method === 'POST');
      expect(send).toBeDefined();
    });
    // Bản tạm hiện trong khung trong lúc chờ xác nhận.
    expect(await within(thread).findByText('nội dung sẽ bị xoá cứng')).toBeInTheDocument();
    const sendCall = calls.find((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}/messages` && c.method === 'POST');
    const clientMessageId = (sendCall?.body as { clientMessageId: string }).clientMessageId;

    // Socket xác nhận tin thật trước (cùng id + clientMessageId mà server sẽ trả qua REST).
    act(() => {
      realtime.handlers?.onNewMessage({
        conversationId: CONV_ID,
        message: {
          id: controls.savedId,
          conversationId: CONV_ID,
          userIdFrom: ME_ID,
          subject: '',
          fullMessage: 'nội dung sẽ bị xoá cứng',
          createdAt: '2026-01-01T00:01:00.000Z',
          seq: 2,
          clientMessageId,
        },
      } as never);
    });
    expect(within(thread).getAllByText('nội dung sẽ bị xoá cứng')).toHaveLength(1);

    // Đáp ứng REST về sau đó: lượt gửi hoàn tất (gõ thêm một ký
    // tự thì nút Gửi hết bị khoá — nút vẫn vô hiệu khi nháp trống
    // theo quy tắc của issue #564), tin không nhân đôi.
    await act(async () => {
      controls.releaseSend();
    });
    await userEvent.type(input, 'x');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Gửi' })).toBeEnabled());
    expect(within(thread).getAllByText('nội dung sẽ bị xoá cứng')).toHaveLength(1);

    // Phía server xoá cứng tin thật; sự kiện invalidate nạp lại cửa sổ
    // không còn tin đó — nội dung không được hiện lại dưới dạng bản tạm.
    controls.removeFromDetail(controls.savedId);
    const detailCallsBefore = calls.filter(
      (c) => c.url === `/api/v1/messages/conversations/${CONV_ID}` && c.method === 'GET',
    ).length;
    act(() => {
      realtime.handlers?.onConversationInvalidate({ conversationId: CONV_ID } as never);
    });
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}` && c.method === 'GET').length,
      ).toBeGreaterThan(detailCallsBefore),
    );
    await waitFor(() => expect(within(thread).queryByText('nội dung sẽ bị xoá cứng')).not.toBeInTheDocument());
    expect(within(thread).getByText('tin đầu tiên')).toBeInTheDocument();
  });
});

describe('Messages page — hồi quy vòng sửa 2 PR #530 (xoá mềm ở hội thoại không hoạt động + ghim thác vô hiệu và nối lại)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('tin bị xoá mềm ở hội thoại không hoạt động không còn hiện nguyên nội dung khi mở lại trong cửa sổ tươi', async () => {
    const calls: RecordedCall[] = [];
    stubFix530Fetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm một/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();

    // Chuyển hẳn sang nhóm hai — nhóm một không còn hoạt động.
    await userEvent.click(await screen.findByRole('button', { name: /Nhóm hai/ }));
    await waitFor(() =>
      expect(within(screen.getByLabelText('Tin nhắn')).queryByText('tin đầu tiên')).not.toBeInTheDocument(),
    );

    // Xoá mềm phía server: phân phối thật chỉ phát message.deleted +
    // conversation.updated, KHÔNG phát conversation.invalidate.
    act(() => {
      realtime.handlers?.onMessageDeleted({
        conversationId: CONV_ID,
        messageId: FIRST_MESSAGE.id,
        deletedBy: OTHER_ID,
      } as never);
      realtime.handlers?.onConversationUpdated({
        conversationId: CONV_ID,
        message: FIRST_MESSAGE,
        unreadCount: 0,
      } as never);
    });

    // Mở lại nhóm một trong cửa sổ tươi: người xem không có quyền kiểm
    // duyệt không được thấy lại nội dung tin đã xoá mềm.
    await userEvent.click(await screen.findByRole('button', { name: /Nhóm một/ }));
    const reopened = await screen.findByLabelText('Tin nhắn');
    await waitFor(() => expect(within(reopened).queryByText('tin đầu tiên')).not.toBeInTheDocument());
  });

  it('tin đã xoá cứng phía server không còn hiện khi mở lại hội thoại không hoạt động trong cửa sổ tươi', async () => {
    const calls: RecordedCall[] = [];
    const controls = stubFix530Fetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm một/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();

    // Chuyển hẳn sang nhóm hai — từ đây nhóm một không còn hoạt động.
    await userEvent.click(await screen.findByRole('button', { name: /Nhóm hai/ }));
    await waitFor(() =>
      expect(within(screen.getByLabelText('Tin nhắn')).queryByText('tin đầu tiên')).not.toBeInTheDocument(),
    );

    // Phía server xoá cứng tin của nhóm một; server phát message.deleted
    // trước rồi conversation.invalidate sau (đúng thứ tự luồng thật).
    controls.removeFromDetail(FIRST_MESSAGE.id);
    act(() => {
      realtime.handlers?.onMessageDeleted({
        conversationId: CONV_ID,
        messageId: FIRST_MESSAGE.id,
        deletedBy: OTHER_ID,
      } as never);
      realtime.handlers?.onConversationInvalidate({ conversationId: CONV_ID } as never);
    });

    // Mở lại nhóm một ngay trong cửa sổ tươi của cache chi tiết:
    // tin đã xoá cứng không được hiện lại trong khung.
    await userEvent.click(await screen.findByRole('button', { name: /Nhóm một/ }));
    const reopened = await screen.findByLabelText('Tin nhắn');
    await waitFor(() => expect(within(reopened).queryByText('tin đầu tiên')).not.toBeInTheDocument());
  });

  it('tin đến ở hội thoại không hoạt động trong lúc mất kết nối hiện ra khi mở lại sau khi nối lại', async () => {
    const calls: RecordedCall[] = [];
    const controls = stubFix530Fetch(calls);
    renderMessages();

    await openGroupFromList(/Nhóm một/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: /Nhóm hai/ }));
    await waitFor(() =>
      expect(within(screen.getByLabelText('Tin nhắn')).queryByText('tin đầu tiên')).not.toBeInTheDocument(),
    );

    // Trong lúc mất kết nối, nhóm một nhận tin mới phía server —
    // không sự kiện socket nào tới được client trong thời gian đó.
    controls.addToDetail({
      id: '01900000-0000-7000-8000-0000000000f9',
      conversationId: CONV_ID,
      userIdFrom: OTHER_ID,
      subject: '',
      fullMessage: 'tin đến trong lúc mất kết nối',
      createdAt: '2026-01-01T00:03:00.000Z',
      seq: 2,
      clientMessageId: null,
    });

    // Socket nối lại.
    realtime.handle.sync.mockClear();
    act(() => {
      realtime.handlers?.onReconnect({} as never);
    });

    // Mở lại nhóm một: tin đến trong lúc mất kết nối phải có mặt.
    await userEvent.click(await screen.findByRole('button', { name: /Nhóm một/ }));
    const reopened = await screen.findByLabelText('Tin nhắn');
    expect(await within(reopened).findByText('tin đến trong lúc mất kết nối')).toBeInTheDocument();
    expect(within(reopened).getByText('tin đầu tiên')).toBeInTheDocument();
  });
});

/**
 * Dựng lại trang chat theo mẫu demo (issue #564): trong tab
 * Tất cả là các mục thu gọn Ghim / Gần đây / Đã lưu trữ (thanh
 * tab bốn tab hiện tại là của issue #606); khung chat có cột
 * thứ ba mở theo yêu cầu; nút Gửi vô hiệu khi nháp trống; nút
 * emoji chèn ký tự vào nháp.
 */
describe('Trang tin nhắn — dựng lại theo mẫu demo (issue #564)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('ghim qua menu đưa hội thoại vào mục Ghim, còn lại ở mục Gần đây', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetchM5(calls);
    renderMessages();

    expect(await screen.findByRole('button', { name: /Hội thoại A/ })).toBeInTheDocument();
    // Chưa có hội thoại ghim nên mục Ghim chưa hiện.
    expect(screen.queryByRole('button', { name: 'Ghim' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gần đây' })).toBeInTheDocument();

    await userEvent.click(screen.getByTestId(`conversation-actions-${M5_CONV_A}`));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Ghim cuộc trò chuyện' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ghim' })).toBeInTheDocument());
    // Mục Ghim đứng trước Gần đây nên A lên đầu danh sách.
    const listButtons = () => screen.getAllByRole('button', { name: /Hội thoại [AB]/ });
    await waitFor(() => expect(listButtons()[0]).toHaveTextContent('Hội thoại A'));
    expect(listButtons()[1]).toHaveTextContent('Hội thoại B');
  });

  it('thanh tab hiện số đếm trong ngoặc đơn trên toàn bộ tập của từng tab nhưng tên truy cập vẫn đúng nhãn', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    expect(await screen.findByRole('button', { name: /Bạn Một/ })).toBeInTheDocument();
    // Tab Tất cả đếm mọi hội thoại: hai 1–1 + một nhóm = 3 (một
    // hội thoại chưa đọc); danh sách nhóm phẳng có 4 mục (lớp,
    // khoá, nhóm con, nhóm tự do); chưa có dữ kiện yêu thích
    // nào nên tab Yêu thích đếm 0.
    expect(screen.getByRole('tab', { name: 'Tất cả' })).toHaveTextContent('(3)');
    expect(screen.getByRole('tab', { name: 'Chưa đọc' })).toHaveTextContent('(1)');
    expect(screen.getByRole('tab', { name: 'Nhóm' })).toHaveTextContent('(4)');
    expect(screen.getByRole('tab', { name: 'Yêu thích' })).toHaveTextContent('(0)');
  });

  it('nút Gửi vô hiệu khi nháp trống và mở khi có ký tự', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Bạn Một/ }));
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của bạn một')).toBeInTheDocument();

    const sendButton = screen.getByRole('button', { name: 'Gửi' });
    expect(sendButton).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Nội dung tin nhắn'), 'xin chào');
    expect(sendButton).toBeEnabled();
  });

  it('bấm emoji trong popover chèn ký tự đó vào cuối nháp', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Bạn Một/ }));
    await screen.findByLabelText('Tin nhắn');
    const input = screen.getByLabelText('Nội dung tin nhắn') as HTMLTextAreaElement;
    await userEvent.type(input, 'chào');
    await userEvent.click(screen.getByRole('button', { name: 'Chèn biểu tượng cảm xúc' }));
    await userEvent.click(await screen.findByRole('button', { name: '👍' }));
    expect(input.value).toBe('chào👍');
  });
  it('bấm emoji trên nháp trống vẫn phát tín hiệu đang nhập cho đúng hội thoại', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Bạn Một/ }));
    await screen.findByLabelText('Tin nhắn');
    const input = screen.getByLabelText('Nội dung tin nhắn') as HTMLTextAreaElement;
    expect(input.value).toBe('');
    // Cô lập cú click emoji: xoá mọi lần gọi typing từ các test trước
    // trong cùng file (mock socket dùng chung), để cú click này là tác
    // nhân duy nhất có thể phát tín hiệu — assert sau click mà không
    // xoá mock sẽ xanh ngay cả khi chưa sửa.
    realtime.handle.typing.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'Chèn biểu tượng cảm xúc' }));
    await userEvent.click(await screen.findByRole('button', { name: '👍' }));
    expect(input.value).toBe('👍');
    expect(realtime.handle.typing).toHaveBeenCalledWith(T3_DM_A);
  });

  it('bấm avatar header của chat 1–1 mở panel đối tác ở cột thứ ba; nút Đóng đóng panel', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Bạn Một/ }));
    await screen.findByLabelText('Tin nhắn');
    expect(screen.queryByTestId('partner-panel')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Thông tin cuộc trò chuyện' }));
    const panel = await screen.findByTestId('partner-panel');
    expect(panel).toHaveTextContent('Bạn Một');
    // Test này không phát sự kiện hiện diện nào của đối tác:
    // trạng thái CHƯA BIẾT — panel không được khẳng định
    // "Ngoại tuyến" (luật ba trạng thái hiện diện, vòng sửa 3
    // của PR #576: chưa biết khác hẳn đã xác nhận ngoại tuyến).
    expect(panel).not.toHaveTextContent('Ngoại tuyến');
    expect(screen.getByTestId('info-aside')).toContainElement(panel);

    await userEvent.click(screen.getByRole('button', { name: 'Đóng' }));
    expect(screen.queryByTestId('partner-panel')).not.toBeInTheDocument();
  });

  it('bấm avatar header của chat nhóm mở panel thành viên ở cột thứ ba', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    await openT4InfoPanel(`member-panel-row-${OTHER_ID}`);
    expect(within(screen.getByTestId('info-aside')).getByTestId('member-panel')).toBeInTheDocument();
  });
});

const NAMELESS_DM_ID = '01900000-0000-7000-8000-0000000000f1';

/**
 * Stub fetch cho vòng sửa hẹp PR #576: MỘT hội thoại 1–1 mà
 * backend KHÔNG đặt tên (`name: null` — đúng dữ kiện thật của
 * hội thoại 1–1) kèm `memberProfiles` để client tra được tên
 * từng thành viên. Các fixture cũ đặt sẵn tên cho hội thoại 1–1
 * nên không bao giờ đi qua đường tiêu đề dự phòng — stub này
 * khoá đúng đường đó.
 */
function stubNamelessDmFetch(calls: RecordedCall[]) {
  const profiles = {
    [ME_ID]: { userId: ME_ID, displayName: 'Tôi Đây', username: 'me' },
    [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Một', username: 'otheruser' },
  };
  const summary = {
    id: NAMELESS_DM_ID, type: 1, name: null, members: [ME_ID, OTHER_ID], memberProfiles: profiles,
    unread: 0, lastReadSeq: 1, lastMessageSeq: 1, lastMessage: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations' && method === 'GET') return respond([summary]);
      if (url === '/api/v1/messages/conversations?archived=true') return respond([]);
      if (url === '/api/v1/messages/group-tree')
        return respond({ classes: [], coursesOutsideClasses: [], freeGroups: [], canCreateFreeGroup: false });
      if (url === `/api/v1/messages/conversations/${NAMELESS_DM_ID}`)
        return respond({ ...summary, messages: [], hasMoreBefore: false, memberReadMarkers: [] });
      if (url === `/api/v1/messages/conversations/${NAMELESS_DM_ID}/read`) return respond({});
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 0, notifications: 0 });
      if (url === '/api/v1/messages/contacts') return respond({ contacts: [OTHER_ID], profiles });
      if (url === '/api/v1/messages/contacts/requests') return respond({ incoming: [], outgoing: [], profiles: {} });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [], profiles: {} });
      if (url === '/api/v1/messages/courses') return respond({ courses: [] });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/**
 * Vòng sửa hẹp PR #576 sau nghiệm thu preview: hai hành vi trình
 * bày của hội thoại 1–1 không có tên — tiêu đề hiện tên đối tác
 * (thay nhãn dự phòng liệt kê mọi thành viên) và trạng thái
 * hiện diện theo BA trạng thái: đã có sự kiện xác nhận trực
 * tuyến / đã có sự kiện xác nhận ngoại tuyến / chưa biết (chưa
 * có sự kiện nào — client không nhận ảnh chụp hiện diện ban
 * đầu từ máy chủ) thì không hiện dòng trạng thái.
 */
describe('Trang tin nhắn — vòng sửa hẹp PR #576 (tiêu đề 1–1 và dòng phụ trạng thái)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('hội thoại 1–1 không có tên thì hàng danh sách và đầu khung hiện tên đối tác, không hiện nhãn liệt kê mọi thành viên', async () => {
    const calls: RecordedCall[] = [];
    stubNamelessDmFetch(calls);
    renderMessages();

    const rowButton = await screen.findByRole('button', { name: /Bạn Một/ });
    expect(within(rowButton).getByText('Bạn Một')).toBeInTheDocument();
    expect(screen.queryByText(/Hội thoại với người dùng/)).not.toBeInTheDocument();

    await userEvent.click(rowButton);
    await screen.findByLabelText('Tin nhắn');
    const infoButton = await screen.findByRole('button', { name: 'Thông tin cuộc trò chuyện' });
    const header = infoButton.parentElement as HTMLElement;
    expect(within(header).getByText('Bạn Một')).toBeInTheDocument();
    expect(screen.queryByText(/Hội thoại với người dùng/)).not.toBeInTheDocument();
  });

  it('trạng thái hiện diện 1–1 theo ba trạng thái: chưa có sự kiện thì đầu khung và panel không hiện dòng trạng thái, sự kiện ngoại tuyến hiện "Ngoại tuyến" ở cả hai bề mặt, chuyển trực tuyến đổi sang "Trực tuyến"', async () => {
    const calls: RecordedCall[] = [];
    stubNamelessDmFetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Bạn Một/ }));
    await screen.findByLabelText('Tin nhắn');
    const infoButton = await screen.findByRole('button', { name: 'Thông tin cuộc trò chuyện' });
    const header = infoButton.parentElement as HTMLElement;
    // (a) Chưa có sự kiện hiện diện nào của đối tác: trạng thái
    // CHƯA BIẾT — đầu khung không hiện dòng trạng thái nào.
    // Khẳng định này ĐỎ trên code vòng sửa 2 (vòng 2 gộp
    // chưa-biết thành "Ngoại tuyến" ngay khi mở hội thoại).
    expect(within(header).queryByText('Ngoại tuyến')).not.toBeInTheDocument();
    expect(within(header).queryByText('Trực tuyến')).not.toBeInTheDocument();

    // (b) Sự kiện xác nhận ngoại tuyến: đầu khung hiện "Ngoại tuyến".
    act(() => {
      realtime.handlers?.onPresence({ userId: OTHER_ID, online: false } as never);
    });
    expect(await within(header).findByText('Ngoại tuyến')).toBeInTheDocument();

    // Panel thông tin dùng cùng luật ba trạng thái: mở panel
    // sau sự kiện ngoại tuyến thì panel cũng hiện "Ngoại tuyến".
    await userEvent.click(infoButton);
    const panel = await screen.findByTestId('partner-panel');
    expect(within(panel).getByText('Ngoại tuyến')).toBeInTheDocument();

    // (c) Chuyển ngoại tuyến → trực tuyến: cả đầu khung lẫn
    // panel đổi sang "Trực tuyến", hết "Ngoại tuyến".
    act(() => {
      realtime.handlers?.onPresence({ userId: OTHER_ID, online: true } as never);
    });
    expect(await within(header).findByText('Trực tuyến')).toBeInTheDocument();
    expect(within(header).queryByText('Ngoại tuyến')).not.toBeInTheDocument();
    expect(await within(panel).findByText('Trực tuyến')).toBeInTheDocument();
    expect(within(panel).queryByText('Ngoại tuyến')).not.toBeInTheDocument();
  });
});

/**
 * Issue #591 — đợt UI dựng lại trang chat giống hệt demo:
 * các ca dưới đây kiểm chứng từng hạng mục trình bày mới
 * (vị trí dòng Đã xem, khung xương lúc tải lần đầu, lưới
 * emoji, chữ viết tắt avatar nhóm chỉ gồm chữ cái, xem trước
 * tin cuối ở dòng nhóm, panel hồ sơ đối tác, tab Yêu thích
 * chỉ là hình dạng).
 */
const SEEN_MINE_ID = '01900000-0000-7000-8000-000000000591';
const SEEN_PEER_ID = '01900000-0000-7000-8000-000000000592';
const KT_GROUP_ID = '01900000-0000-7000-8000-000000000593';
const KT_GROUP_MUTED_EMPTY_ID = '01900000-0000-7000-8000-000000000595';

/** Stub cho các ca #591: 1–1 có mốc đã xem của đối tác dừng ở seq 1, nhóm tự do tên bắt đầu bằng ký tự đặc biệt. */
function stub591Fetch(calls: RecordedCall[], gateList?: Promise<void>) {
  // Trạng thái tắt tiếng của hội thoại 1–1 do "server" của stub
  // giữ: PATCH .../state ghi lại để các lần nạp lại danh sách
  // (invalidate sau đột biến) vẫn thấy trạng thái mới.
  const serverState = { mutedDm: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations' && method === 'GET') {
        if (gateList) await gateList;
        return respond([
          {
            id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID],
            unread: 1, lastReadSeq: 0, lastMessageSeq: 2, muted: serverState.mutedDm,
            lastMessage: { id: SEEN_PEER_ID, conversationId: CONV_ID, userIdFrom: OTHER_ID, subject: '', fullMessage: 'tin mới của bạn học', createdAt: '2026-01-01T00:05:00.000Z', seq: 2, clientMessageId: null },
            memberProfiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } },
          },
          {
            id: KT_GROUP_ID, type: 2, name: '[KT] Nhóm kiểm chứng', members: [ME_ID, OTHER_ID],
            unread: 0, lastReadSeq: 1, lastMessageSeq: 1, muted: true,
            lastMessage: { id: '01900000-0000-7000-8000-000000000594', conversationId: KT_GROUP_ID, userIdFrom: OTHER_ID, subject: '', fullMessage: 'nội dung tin nhóm cuối', createdAt: '2026-01-01T00:03:00.000Z', seq: 1, clientMessageId: null },
            memberProfiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } },
          },
          {
            id: KT_GROUP_MUTED_EMPTY_ID, type: 2, name: 'Nhóm tắt tiếng chưa có tin', members: [ME_ID, OTHER_ID],
            unread: 0, lastReadSeq: 0, lastMessageSeq: 0, muted: true,
            lastMessage: null,
            memberProfiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } },
          },
        ]);
      }
      if (url === '/api/v1/messages/group-tree')
        return respond({
          classes: [],
          coursesOutsideClasses: [],
          freeGroups: [
            { id: KT_GROUP_ID, name: '[KT] Nhóm kiểm chứng', myRole: 'staff', conversationId: KT_GROUP_ID, unread: 0 },
            { id: KT_GROUP_MUTED_EMPTY_ID, name: 'Nhóm tắt tiếng chưa có tin', myRole: 'staff', conversationId: KT_GROUP_MUTED_EMPTY_ID, unread: 0 },
          ],
          canCreateFreeGroup: false,
        });
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 1, notifications: 0 });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [] });
      if (url === `/api/v1/messages/conversations/${CONV_ID}`)
        return respond({
          id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID], muted: serverState.mutedDm,
          messages: [
            { id: SEEN_MINE_ID, conversationId: CONV_ID, userIdFrom: ME_ID, subject: '', fullMessage: 'tin của tôi đã được xem', createdAt: '2026-01-01T00:04:00.000Z', seq: 1, clientMessageId: null },
            { id: SEEN_PEER_ID, conversationId: CONV_ID, userIdFrom: OTHER_ID, subject: '', fullMessage: 'tin mới của bạn học', createdAt: '2026-01-01T00:05:00.000Z', seq: 2, clientMessageId: null },
          ],
          hasMoreBefore: false,
          memberReadMarkers: [
            { userId: ME_ID, lastReadSeq: 2 },
            { userId: OTHER_ID, lastReadSeq: 1 },
          ],
          memberProfiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } },
        });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/read`) return respond({ marked: 2, lastReadSeq: 2 });
      // Chi tiết + mốc đọc của nhóm kiểm chứng: chỉ ca
      // deep-link hai id (A-BS5) mở tới nhóm này qua
      // deep-link; các ca khác không gọi hai đường này.
      if (url === `/api/v1/messages/conversations/${KT_GROUP_ID}`)
        return respond({
          id: KT_GROUP_ID, type: 2, name: '[KT] Nhóm kiểm chứng', members: [ME_ID, OTHER_ID], muted: true,
          messages: [
            { id: '01900000-0000-7000-8000-000000000594', conversationId: KT_GROUP_ID, userIdFrom: OTHER_ID, subject: '', fullMessage: 'nội dung tin nhóm cuối', createdAt: '2026-01-01T00:03:00.000Z', seq: 1, clientMessageId: null },
          ],
          hasMoreBefore: false,
          memberReadMarkers: [
            { userId: ME_ID, lastReadSeq: 1 },
            { userId: OTHER_ID, lastReadSeq: 1 },
          ],
          memberProfiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } },
        });
      if (url === `/api/v1/messages/conversations/${KT_GROUP_ID}/read`) return respond({ marked: 0, lastReadSeq: 1 });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/state` && method === 'PATCH') {
        const patch = (init?.body ? JSON.parse(String(init.body)) : {}) as { muted?: boolean };
        if (typeof patch.muted === 'boolean') serverState.mutedDm = patch.muted;
        return respond({ conversationId: CONV_ID, pinnedAt: null, archivedAt: null, muted: serverState.mutedDm });
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Trang tin nhắn — đợt dựng UI giống demo (issue #591)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('không còn dòng Đã xem riêng trong luồng: trạng thái đã xem chỉ thể hiện bằng dấu tích đủ đậm trong bong bóng của tin đã được xem', async () => {
    const calls: RecordedCall[] = [];
    stub591Fetch(calls);
    renderMessages();

    // Hàng 1–1 với Bạn Học: truy vấn phải kèm đoạn xem trước
    // tin cuối của chính nó vì ở tab Tất cả (ngữ nghĩa hợp của
    // PR #607) hàng nhóm "[KT] Nhóm kiểm chứng" cũng mang tên
    // "Bạn Học" trong xem trước (tiền tố tên người gửi của hàng
    // nhóm) — chỉ lọc theo tên đối tác là khớp cả hai hàng.
    await userEvent.click(await screen.findByRole('button', { name: /Bạn Học.*tin mới của bạn học/ }));
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của tôi đã được xem')).toBeInTheDocument();
    // Bản demo không có dòng trạng thái đã xem riêng dưới tin
    // (issue #608): phần tử seen-status không tồn tại ở bất kỳ
    // vị trí nào trong luồng dù đối tác đã xem tới seq 1.
    expect(within(thread).queryByTestId('seen-status')).not.toBeInTheDocument();
    const mineRow = within(thread).getByText('tin của tôi đã được xem').closest('[data-slot="message"]')!;
    const peerRow = within(thread).getByText('tin mới của bạn học').closest('[data-slot="message"]')!;
    // Bong bóng tin của tôi mang nhãn đã xem đi kèm dấu tích
    // (văn bản sr-only trong dòng giờ của bong bóng); bong bóng
    // của đối tác không mang nhãn đó.
    expect(within(mineRow as HTMLElement).getByText('Đã xem')).toBeInTheDocument();
    expect(within(peerRow as HTMLElement).queryByText('Đã xem')).not.toBeInTheDocument();
    // Tin đó vẫn có giờ riêng trong bong bóng như mọi tin khác.
    expect(within(thread).getByTestId(`message-time-${SEEN_MINE_ID}`)).toBeInTheDocument();
  });

  it('lúc danh sách đang tải lần đầu hiện khung xương đúng hình dạng trang và không hiện trạng thái rỗng giả', async () => {
    const calls: RecordedCall[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stub591Fetch(calls, gate);
    renderMessages();

    expect(await screen.findByTestId('conversations-loading')).toBeInTheDocument();
    expect(screen.queryByText('Chưa có cuộc trò chuyện nào.')).not.toBeInTheDocument();
    release();
    expect(await screen.findByRole('button', { name: /Bạn Học.*tin mới của bạn học/ })).toBeInTheDocument();
    expect(screen.queryByTestId('conversations-loading')).not.toBeInTheDocument();
  });

  /**
   * Stub fetch cho ba ca hồi quy lỗi tải lần đầu (vòng sửa 2
   * PR #593): mỗi ca chọn riêng endpoint nào lỗi 500 — danh
   * sách lỗi, dữ kiện nhóm lỗi, hoặc cả hai về rỗng thành công.
   * Các endpoint còn lại của trang trả dữ kiện tối thiểu để
   * trang dựng được (phiên, hồ sơ, số chưa đọc, danh bạ, khoá
   * rỗng). Lưu ý: QueryClient của app thử lại lỗi 500 tối đa
   * 2 lần nên trạng thái lỗi chỉ chốt sau vài giây — các ca
   * dùng findByText với timeout dài thay vì timeout mặc định.
   */
  function stubLoadErrorFetch(opts: { conversations: 'error' | 'empty' | 'one'; groupTree: 'error' | 'empty' }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const respond = (payload: unknown, status = 200) =>
          new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond(PROFILE);
        if (url === '/api/v1/messages/conversations' && method === 'GET') {
          if (opts.conversations === 'error') return respond({ title: 'Lỗi tải' }, 500);
          if (opts.conversations === 'empty') return respond([]);
          return respond([
            {
              id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID],
              unread: 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null,
              memberProfiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } },
            },
          ]);
        }
        if (url === '/api/v1/messages/group-tree') {
          if (opts.groupTree === 'error') return respond({ title: 'Lỗi tải' }, 500);
          return respond({ classes: [], coursesOutsideClasses: [], freeGroups: [], canCreateFreeGroup: false });
        }
        if (url === '/api/v1/messages/courses') return respond({ courses: [] });
        if (url === '/api/v1/messages/unread-count') return respond({ conversations: 0, notifications: 0 });
        if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [] });
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  }

  it('lỗi tải lần đầu ở danh sách: chỉ banner lỗi hiện, câu rỗng không hiện', async () => {
    stubLoadErrorFetch({ conversations: 'error', groupTree: 'empty' });
    renderMessages();

    // Banner lỗi chốt sau các lần thử lại của QueryClient.
    await screen.findByText('Không tải được cuộc hội thoại', {}, { timeout: 10000 });
    expect(screen.queryByText('Chưa có cuộc trò chuyện nào.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('conversations-loading')).not.toBeInTheDocument();
  });

  it('lỗi tải lần đầu ở dữ kiện nhóm: tab Nhóm hiện thông báo lỗi thay cho câu rỗng', async () => {
    stubLoadErrorFetch({ conversations: 'one', groupTree: 'error' });
    renderMessages();

    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    await screen.findByText('Không tải được cây nhóm', {}, { timeout: 10000 });
    expect(screen.queryByText('Bạn chưa thuộc lớp, khoá hay nhóm nào.')).not.toBeInTheDocument();
  });

  it('tải thành công trả về rỗng: cả hai câu rỗng vẫn hiện (chống sửa quá tay)', async () => {
    stubLoadErrorFetch({ conversations: 'empty', groupTree: 'empty' });
    renderMessages();

    expect(await screen.findByText('Chưa có cuộc trò chuyện nào.')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    expect(await screen.findByText('Bạn chưa thuộc lớp, khoá hay nhóm nào.')).toBeInTheDocument();
  });

  it('bộ chọn emoji ở ô soạn là lưới 20 biểu tượng như demo và tab Yêu thích là tab thật chỉ có trạng thái rỗng', async () => {
    const calls: RecordedCall[] = [];
    stub591Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Bạn Học.*tin mới của bạn học/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Chèn biểu tượng cảm xúc' }));
    const popover = await screen.findByTestId('emoji-picker-popover');
    expect(within(popover).getAllByRole('button')).toHaveLength(20);
    await userEvent.keyboard('{Escape}');

    // Tab Yêu thích là một tab thật trong thanh tab (không còn
    // là chip vô hiệu): bấm được, và vì hệ chưa có dữ kiện yêu
    // thích nên nội dung của tab chỉ là trạng thái rỗng — hội
    // thoại đã ghim không bị dùng thay cho yêu thích.
    const favouritesTab = screen.getByRole('tab', { name: 'Yêu thích' });
    expect(favouritesTab).toBeEnabled();
    await userEvent.click(favouritesTab);
    expect(await screen.findByText('Chưa có hội thoại yêu thích nào.')).toBeInTheDocument();
  });

  it('avatar nhóm chỉ gồm chữ cái đầu của các từ chữ trong tên, bỏ ký tự đặc biệt ở đầu tên', async () => {
    const calls: RecordedCall[] = [];
    stub591Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    const groupRow = await screen.findByRole('button', { name: /Nhóm kiểm chứng/ });
    // Tên "[KT] Nhóm kiểm chứng": các từ chữ là KT / Nhóm /
    // kiểm / chứng → chữ viết tắt trong avatar là "KC", ký tự
    // đặc biệt ở đầu tên không lọt vào avatar như lỗi "N[".
    const fallback = groupRow.querySelector('[data-slot="avatar-fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback!.textContent).toBe('KC');
  });

  it('dòng nhóm ở tab Nhóm hiện xem trước tin cuối kèm tên người gửi và biểu tượng đã tắt tiếng', async () => {
    const calls: RecordedCall[] = [];
    stub591Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    const groupRow = await screen.findByRole('button', { name: /Nhóm kiểm chứng/ });
    expect(within(groupRow).getByText(/Bạn Học: nội dung tin nhóm cuối/)).toBeInTheDocument();
    expect(within(groupRow).getByTestId(`conversation-muted-${KT_GROUP_ID}`)).toBeInTheDocument();
  });

  it('dòng nhóm đã tắt tiếng mà chưa có tin cuối nào vẫn hiện biểu tượng tắt tiếng', async () => {
    const calls: RecordedCall[] = [];
    stub591Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    const groupRow = await screen.findByRole('button', { name: /Nhóm tắt tiếng chưa có tin/ });
    expect(within(groupRow).getByTestId(`conversation-muted-${KT_GROUP_MUTED_EMPTY_ID}`)).toBeInTheDocument();
  });

  it('panel thông tin 1–1 theo hình dạng demo: danh sách hành động dọc đầy đủ, trường chưa có dữ kiện thì không dựng hàng, hành động Tắt tiếng là thật', async () => {
    const calls: RecordedCall[] = [];
    stub591Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Bạn Học.*tin mới của bạn học/ }));
    // Mở panel bằng nút avatar ở đầu khung.
    await userEvent.click(await screen.findByLabelText('Thông tin cuộc trò chuyện'));
    const panel = await screen.findByTestId('partner-panel');
    // Danh sách hành động của demo hiện đủ theo thứ tự của nó:
    // Tắt tiếng, Ghim, Thêm vào yêu thích, Xoá lịch sử trò
    // chuyện, Chặn — và nút Xoá nằm ở đáy panel.
    for (const label of ['Tắt tiếng', 'Ghim cuộc trò chuyện', 'Thêm vào yêu thích', 'Xoá lịch sử trò chuyện', 'Chặn liên lạc', 'Xoá']) {
      expect(within(panel).getByRole('button', { name: label })).toBeInTheDocument();
    }
    // Hai hành động sản phẩm chưa có chức năng thì ở trạng
    // thái vô hiệu (hình dạng thuần theo luật điểm chưa quyết).
    expect(within(panel).getByRole('button', { name: 'Thêm vào yêu thích' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Xoá lịch sử trò chuyện' })).toBeDisabled();
    // Khối tệp đã chia sẻ theo đúng hành vi của demo
    // (issue #608, điểm G9): khối chỉ hiện khi hội thoại có
    // tệp đã chia sẻ; nguồn dữ kiện hiện tại rỗng nên khối
    // không dựng trong panel.
    expect(within(panel).queryByText('Tệp đã chia sẻ')).not.toBeInTheDocument();
    // Các trường hồ sơ backend chưa có dữ kiện thì KHÔNG dựng
    // hàng nào và không còn dấu gạch ngang chờ như trước
    // (issue #608 — đúng luật hiển thị của demo).
    for (const label of ['Giới thiệu', 'Email', 'Số điện thoại', 'Website', 'Công ty', 'Quốc gia', 'Múi giờ', 'Địa điểm', 'Trạng thái sẵn sàng', 'Thẻ']) {
      expect(within(panel).queryByText(label)).not.toBeInTheDocument();
    }
    expect(within(panel).queryByText('—')).not.toBeInTheDocument();
    // Hành động Tắt tiếng trong panel là hành động thật: bấm
    // xong chính nút đó đổi nhãn thành Bật tiếng.
    await userEvent.click(within(panel).getByRole('button', { name: 'Tắt tiếng' }));
    expect(await within(panel).findByRole('button', { name: 'Bật tiếng' })).toBeInTheDocument();
  });

  it('vào tab Nhóm khi đang mở chat 1–1 thì khung về trạng thái chưa chọn như demo, không tự giữ hội thoại cũ', async () => {
    const calls: RecordedCall[] = [];
    stub591Fetch(calls);
    renderMessages();

    // Mở hàng 1–1 qua mốc giờ của chính hội thoại đó: ở
    // danh sách hợp nhất, hàng nhóm cũng mang tên người gửi
    // "Bạn Học" trong dòng xem trước nên truy vấn nút theo
    // tên trơn sẽ trùng hai hàng.
    await userEvent.click(await screen.findByTestId(`conversation-last-time-${CONV_ID}`));
    expect(await screen.findByLabelText('Tin nhắn')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Nhóm' }));
    // Khung chat về trạng thái chưa chọn: hiện khối rỗng chọn
    // hội thoại của demo, luồng tin và ô soạn đều biến mất —
    // đúng hành vi không tự chọn của demo ở tab Nhóm (issue
    // #608, điểm A-BS5).
    expect(await screen.findByText('Chọn một cuộc hội thoại ở cột trái để đọc và trả lời.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Tin nhắn')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Nội dung tin nhắn')).not.toBeInTheDocument();
  });

  it('vùng cuộn tin nhắn: class hiệu dụng của vùng chứa sau khi gộp là gap-0 nên khoảng cách luồng tin chỉ do margin theo cụm của từng mục mang', async () => {
    const calls: RecordedCall[] = [];
    stub591Fetch(calls);
    renderMessages();

    // Mở hàng 1–1 qua mốc giờ của chính hội thoại đó: ở
    // danh sách hợp nhất, hàng nhóm cũng mang tên người gửi
    // "Bạn Học" trong dòng xem trước nên truy vấn nút theo
    // tên trơn sẽ trùng hai hàng.
    await userEvent.click(await screen.findByTestId(`conversation-last-time-${CONV_ID}`));
    const thread = await screen.findByLabelText('Tin nhắn');
    // jsdom không tính layout nên khoảng cách hiệu dụng
    // quan sát được qua class đã gộp của vùng chứa — ca
    // này ghim đúng cơ chế theo phán quyết điều phối trên
    // PR #610: MessageScrollerContent mang gap-8 (32px)
    // mặc định trong component, nơi dùng phải ghi đè
    // gap-0; nếu gap mặc định còn sót, khoảng cách cụm
    // tin bị cộng dồn thành 36px trong cụm / 48px giữa
    // cụm thay vì 4/16px của demo (issue #608, E1/E2).
    const content = thread.querySelector('[data-slot="message-scroller-content"]');
    expect(content).not.toBeNull();
    const tokens = (content as HTMLElement).className.split(/\s+/);
    expect(tokens).toContain('gap-0');
    expect(tokens.filter((token) => token.startsWith('gap-') && token !== 'gap-0')).toEqual([]);
  });

  it('tải lại trang với tab Nhóm đã lưu và hội thoại 1–1 đã lưu thì không tự mở hội thoại cũ, khung ở trạng thái chưa chọn', async () => {
    const calls: RecordedCall[] = [];
    // Gieo đúng trạng thái đã lưu của lần dùng trước:
    // tab Nhóm + một hội thoại 1–1 đang mở dở (issue
    // #608, điểm A-BS5 — mệnh đề khôi phục khi tải trang).
    localStorage.setItem('lms.messages.tab', 'groups');
    localStorage.setItem('lms.messages.conversationId', CONV_ID);
    stub591Fetch(calls);
    renderMessages();

    // Tab Nhóm được khôi phục từ trạng thái đã lưu và
    // danh sách/cây nhóm đã nạp xong — mốc này bảo đảm
    // hiệu ứng khôi phục ngữ cảnh đã chạy qua.
    const groupsTab = await screen.findByRole('tab', { name: 'Nhóm' });
    expect(groupsTab).toHaveAttribute('data-active');
    expect(await screen.findByRole('button', { name: /Nhóm kiểm chứng/ })).toBeInTheDocument();
    // Hội thoại 1–1 đã lưu KHÔNG tự mở: khung ở trạng
    // thái chưa chọn như demo, không có luồng tin, và
    // trang không hề lấy chi tiết hay đánh dấu đã đọc
    // hội thoại đã lưu đó.
    expect(screen.getByText('Chọn một cuộc hội thoại ở cột trái để đọc và trả lời.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Tin nhắn')).not.toBeInTheDocument();
    expect(
      calls.some((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}` && c.method === 'GET'),
    ).toBe(false);
    expect(
      calls.some((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}/read`),
    ).toBe(false);
  });

  it('deep-link trỏ tới hội thoại khác với hội thoại đã lưu (tab Nhóm và hội thoại 1–1 đã lưu) thì deep-link vẫn được ưu tiên và mở đúng hội thoại của nó', async () => {
    const calls: RecordedCall[] = [];
    localStorage.setItem('lms.messages.tab', 'groups');
    localStorage.setItem('lms.messages.conversationId', CONV_ID);
    stub591Fetch(calls);
    renderMessages(`/messages?conversation=${KT_GROUP_ID}`);

    // Hai id PHẢI khác nhau thì ca mới phân biệt được
    // nguồn nào thắng: trạng thái đã lưu trỏ hội thoại
    // 1–1 CONV_ID, deep-link trỏ nhóm KT_GROUP_ID. Nếu
    // khôi phục ngữ cảnh đã lưu thắng (hoặc deep-link bị
    // bỏ qua), hội thoại 1–1 sẽ mở thay nhóm và các khẳng
    // định dưới đây đỏ — ca chỉ xanh khi deep-link thắng
    // thật (issue #608, điểm A-BS5; phán quyết điều phối
    // vòng sửa 2 trên PR #610 yêu cầu hai id khác nhau,
    // bản trước dùng cùng một id cho cả hai nguồn nên
    // không chứng minh được quyền ưu tiên).
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('nội dung tin nhóm cuối')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/messages/conversations/${KT_GROUP_ID}/read` && c.method === 'POST'),
      ).toBe(true),
    );
    // Hội thoại đã lưu KHÔNG mở: trang không lấy chi
    // tiết, không đánh dấu đã đọc cho nó và tin của nó
    // không hiện trong luồng đang mở.
    expect(
      calls.some((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}` && c.method === 'GET'),
    ).toBe(false);
    expect(
      calls.some((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}/read`),
    ).toBe(false);
    expect(within(thread).queryByText('tin mới của bạn học')).not.toBeInTheDocument();
  });

  it('di chuột lên vùng nút Gọi thoại và Gọi video đang vô hiệu thì tooltip hiện đúng nhãn của từng nút như demo', async () => {
    const calls: RecordedCall[] = [];
    stub591Fetch(calls);
    renderMessages();

    // Mở hàng 1–1 qua mốc giờ của chính hội thoại đó: ở
    // danh sách hợp nhất, hàng nhóm cũng mang tên người gửi
    // "Bạn Học" trong dòng xem trước nên truy vấn nút theo
    // tên trơn sẽ trùng hai hàng.
    await userEvent.click(await screen.findByTestId(`conversation-last-time-${CONV_ID}`));
    await screen.findByLabelText('Tin nhắn');

    // Hai nút gọi là hình dạng thuần ở trạng thái vô
    // hiệu (issue #608, điểm D7): nút giữ disabled,
    // nhưng vùng trigger bọc quanh nút nhận được hover
    // nên tooltip phải hiện đúng nhãn khi di chuột.
    // Gắn trigger thẳng lên nút vô hiệu thì hover
    // không tới được trigger vì class gốc của Button
    // mang disabled:pointer-events-none — ca này di
    // chuột thật lên vùng trigger (hover + một chuyển
    // động chuột như tay người dùng thật; cơ chế hover
    // của Base UI mở tooltip sau khi chuột vào vùng và
    // dừng đủ thời gian nghỉ) và chờ nhãn tooltip hiện
    // trong popup của tooltip (phán quyết điều phối
    // vòng sửa 2 trên PR #610).
    const callButton = screen.getByRole('button', { name: 'Gọi thoại' });
    expect(callButton).toBeDisabled();
    const callTrigger = callButton.closest('[data-slot="tooltip-trigger"]');
    expect(callTrigger).not.toBeNull();
    await userEvent.hover(callTrigger as HTMLElement);
    fireEvent.mouseMove(callTrigger as HTMLElement);
    const callTooltip = await screen.findByText('Gọi thoại', {}, { timeout: 3000 });
    expect(callTooltip.closest('[data-slot="tooltip-content"]')).not.toBeNull();
    await userEvent.unhover(callTrigger as HTMLElement);

    const videoButton = screen.getByRole('button', { name: 'Gọi video' });
    expect(videoButton).toBeDisabled();
    const videoTrigger = videoButton.closest('[data-slot="tooltip-trigger"]');
    expect(videoTrigger).not.toBeNull();
    await userEvent.hover(videoTrigger as HTMLElement);
    fireEvent.mouseMove(videoTrigger as HTMLElement);
    const videoTooltip = await screen.findByText('Gọi video', {}, { timeout: 3000 });
    expect(videoTooltip.closest('[data-slot="tooltip-content"]')).not.toBeNull();
  });

  it('hộp thoại mời là hộp thoại ở giữa màn hình và khối liên kết mời chỉ là hình dạng vô hiệu', async () => {
    const calls: RecordedCall[] = [];
    stub591Fetch(calls);
    renderMessages();

    const dialog = await openNewMessageSheet();
    expect(dialog.className).toContain('sm:max-w-md');
    const inviteInput = within(dialog).getByPlaceholderText('Liên kết mời sẽ hiện ở đây');
    expect(inviteInput).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Sao chép' })).toBeDisabled();
  });
});

/**
 * Vòng sửa sau nghiệm thu trình duyệt PR #610 (phán quyết điều
 * phối 6546169639, trên bằng chứng nghiệm thu 6546152871): bốn
 * điểm hỏng ở lượt nghiệm thu đầu — (1) panel thành viên không
 * hiện chữ trạng thái trực tuyến dù presence đã biết qua sự
 * kiện socket; (2) bong bóng thiếu cơ chế trả lời của demo
 * (nhấn đúp / chạm hai lần / Enter–Space trên bong bóng); (3)
 * cây nhóm ở tab Nhóm bày hàng khoá cùng lề với hàng lớp,
 * không thấy quan hệ lồng nhau; (4) tab Nhóm giữ huy hiệu chưa
 * đọc cũ sau khi hội thoại lớp/khoá đã được đọc. Các ca dưới
 * khoá đúng bốn hành vi đó.
 */
function stubFix610TreeReadFetch(calls: RecordedCall[]) {
  const classMessage = {
    id: '01900000-0000-7000-8000-0000000000d9', conversationId: T3_CLASS_CONV, userIdFrom: OTHER_ID,
    subject: '', fullMessage: 'thông báo lớp mới nhất', createdAt: '2026-01-01T00:05:00.000Z', seq: 5, clientMessageId: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations' && method === 'GET')
        return respond([
          {
            id: T3_CLASS_CONV, type: 2, name: 'Lớp 10A1', itemType: 'class', itemId: T3_CLASS_ID,
            members: [ME_ID, OTHER_ID], unread: 3, lastReadSeq: 2, lastMessageSeq: 5, lastMessage: classMessage,
            memberProfiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } },
          },
          {
            id: T3_COURSE_CONV, type: 2, name: 'Toán 10', itemType: 'course', itemId: T3_COURSE_ID,
            members: [ME_ID, OTHER_ID], unread: 0, lastReadSeq: 3, lastMessageSeq: 3, lastMessage: null,
            memberProfiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } },
          },
        ]);
      if (url === '/api/v1/messages/group-tree')
        return respond({
          classes: [{
            classId: T3_CLASS_ID, name: 'Lớp 10A1', myRole: 'teaching', conversationId: T3_CLASS_CONV, unread: 3, pinnedAt: null,
            courses: [{
              courseId: T3_COURSE_ID, name: 'Toán 10', myRole: 'teaching', conversationId: T3_COURSE_CONV, unread: 0, pinnedAt: null,
              groups: [],
            }],
          }],
          coursesOutsideClasses: [],
          freeGroups: [],
          canCreateFreeGroup: false,
        });
      if (url === `/api/v1/messages/conversations/${T3_CLASS_CONV}`)
        return respond({
          id: T3_CLASS_CONV, type: 2, name: 'Lớp 10A1', itemType: 'class', itemId: T3_CLASS_ID,
          members: [ME_ID, OTHER_ID], messages: [classMessage], hasMoreBefore: false,
          memberReadMarkers: [
            { userId: ME_ID, lastReadSeq: 2 },
            { userId: OTHER_ID, lastReadSeq: 5 },
          ],
          memberProfiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } },
        });
      if (url === `/api/v1/messages/conversations/${T3_COURSE_CONV}`)
        return respond({
          id: T3_COURSE_CONV, type: 2, name: 'Toán 10', itemType: 'course', itemId: T3_COURSE_ID,
          members: [ME_ID, OTHER_ID], messages: [], hasMoreBefore: false, memberReadMarkers: [],
          memberProfiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } },
        });
      if (url === `/api/v1/messages/conversations/${T3_CLASS_CONV}/read`) return respond({ marked: 3, lastReadSeq: 5 });
      if (/^\/api\/v1\/messages\/conversations\/[^/]+\/read$/.test(url)) return respond({ marked: 0, lastReadSeq: 0 });
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 1, notifications: 0 });
      if (url === '/api/v1/messages/contacts')
        return respond({ contacts: [OTHER_ID], profiles: { [OTHER_ID]: { userId: OTHER_ID, displayName: 'Bạn Học', username: 'otheruser' } } });
      if (url === '/api/v1/messages/contacts/requests') return respond({ incoming: [], outgoing: [], profiles: {} });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [], profiles: {} });
      if (url === '/api/v1/messages/courses') return respond({ courses: [] });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Trang tin nhắn — vòng sửa sau nghiệm thu PR #610', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('nhấn đúp vào bong bóng thì bắt đầu trả lời đúng tin đó như nút Trả lời; nhấn đơn không làm gì', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM3(calls, [M3_ORIG, M3_REPLY]);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const bubble = await screen.findByTestId(`message-bubble-${M3_ORIG.id}`);

    // Nhấn đơn: không chip trả lời — khớp demo (nhấn đơn không
    // đổi chế độ nào).
    fireEvent.click(bubble);
    expect(screen.queryByTestId('reply-chip')).not.toBeInTheDocument();

    // Nhấn đúp: chip trả lời của ĐÚNG tin gốc hiện ở ô soạn.
    fireEvent.doubleClick(bubble);
    const chip = await screen.findByTestId('reply-chip');
    expect(chip).toHaveTextContent('Đang trả lời Bạn Học');
    expect(chip).toHaveTextContent('Câu gốc để trả lời');
  });

  it('Enter và Space trên bong bóng đang focus cũng bắt đầu trả lời tin đó', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM3(calls, [M3_ORIG, M3_REPLY]);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const bubble = await screen.findByTestId(`message-bubble-${M3_ORIG.id}`);

    bubble.focus();
    fireEvent.keyDown(bubble, { key: 'Enter' });
    expect(await screen.findByTestId('reply-chip')).toHaveTextContent('Câu gốc để trả lời');

    await userEvent.click(screen.getByRole('button', { name: 'Huỷ trả lời' }));
    expect(screen.queryByTestId('reply-chip')).not.toBeInTheDocument();

    bubble.focus();
    fireEvent.keyDown(bubble, { key: ' ' });
    expect(await screen.findByTestId('reply-chip')).toHaveTextContent('Câu gốc để trả lời');
  });

  it('chạm hai lần liên tiếp trên cùng một bong bóng cũng bắt đầu trả lời tin đó', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM3(calls, [M3_ORIG, M3_REPLY]);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const bubble = await screen.findByTestId(`message-bubble-${M3_ORIG.id}`);

    // Một lần chạm đơn chưa đủ thành thao tác trả lời.
    fireEvent.touchEnd(bubble, { changedTouches: [{ clientX: 120, clientY: 200 }] });
    expect(screen.queryByTestId('reply-chip')).not.toBeInTheDocument();

    fireEvent.touchEnd(bubble, { changedTouches: [{ clientX: 122, clientY: 201 }] });
    expect(await screen.findByTestId('reply-chip')).toHaveTextContent('Câu gốc để trả lời');
  });

  it('tab Nhóm: hàng khoá thụt trái một cấp dưới hàng lớp, hàng nhóm con thụt thêm một cấp dưới hàng khoá', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    const classRow = await screen.findByRole('button', { name: /Lớp 10A1/ });
    const courseRow = await screen.findByRole('button', { name: /Toán 10/ });
    const groupRow = await screen.findByRole('button', { name: /Nhóm 1/ });

    // Đệm trái là hình dạng đọc được bằng mắt của quan hệ lồng:
    // lớp ở lề gốc, khoá thụt vào, nhóm con thụt sâu hơn nữa.
    const classPad = parseFloat(classRow.style.paddingLeft);
    const coursePad = parseFloat(courseRow.style.paddingLeft);
    const groupPad = parseFloat(groupRow.style.paddingLeft);
    expect(coursePad).toBeGreaterThan(classPad);
    expect(groupPad).toBeGreaterThan(coursePad);
  });

  it('đọc hội thoại lớp xong thì huy hiệu chưa đọc của hàng lớp ở tab Nhóm cũng về 0 cùng nhịp với tab Tất cả', async () => {
    const calls: RecordedCall[] = [];
    stubFix610TreeReadFetch(calls);
    renderMessages();

    // Trước khi đọc: hàng lớp ở tab Tất cả mang huy hiệu 3.
    const allRow = await screen.findByRole('button', { name: /Lớp 10A1/ });
    expect(within(allRow).getByText('3')).toBeInTheDocument();

    // Mở hội thoại lớp — trang đánh dấu đã đọc ở server.
    await userEvent.click(allRow);
    await screen.findByText('thông báo lớp mới nhất');
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url === `/api/v1/messages/conversations/${T3_CLASS_CONV}/read`)).toBe(true);
    });
    // Tab Tất cả xoá huy hiệu ngay (đường vá danh sách sẵn có).
    await waitFor(() => {
      expect(within(allRow).queryByText('3')).not.toBeInTheDocument();
    });

    // Sang tab Nhóm: hàng lớp trên cây cũng không còn huy hiệu
    // 3 — trước vòng sửa cây giữ nguyên số cũ ở bước này.
    await userEvent.click(screen.getByRole('tab', { name: 'Nhóm' }));
    const treeRow = await screen.findByRole('button', { name: /Lớp 10A1/ });
    expect(within(treeRow).queryByText('3')).not.toBeInTheDocument();
    expect(within(treeRow).queryByText('(3 chưa đọc)')).not.toBeInTheDocument();
  });

  it('panel thành viên: thành viên được sự kiện hiện diện xác nhận trực tuyến thì dòng hiện chữ Trực tuyến cạnh chấm xanh; chưa có sự kiện thì không hiện', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    await openT4InfoPanel(`member-panel-row-${OTHER_ID}`);
    const row = screen.getByTestId(`member-panel-row-${OTHER_ID}`);

    // Chưa có sự kiện hiện diện nào của học sinh: trạng thái
    // CHƯA BIẾT — dòng không khẳng định trực tuyến.
    expect(within(row).queryByText('Trực tuyến')).not.toBeInTheDocument();

    act(() => {
      realtime.handlers?.onPresence({ userId: OTHER_ID, online: true } as never);
    });

    // Đã xác nhận trực tuyến: dòng hiện chữ "Trực tuyến" (chấm
    // xanh trên avatar có cùng điều kiện — khẳng định ở chữ).
    expect(await within(row).findByText('Trực tuyến')).toBeInTheDocument();
  });

  it('panel thành viên: người đã trực tuyến từ TRƯỚC lúc tải trang — trạng thái chỉ đến qua ảnh chụp lúc nối, không có sự kiện thay đổi nào — vẫn hiện chữ Trực tuyến ở dòng thành viên', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    await openT4InfoPanel(`member-panel-row-${OTHER_ID}`);
    const row = screen.getByTestId(`member-panel-row-${OTHER_ID}`);
    expect(within(row).queryByText('Trực tuyến')).not.toBeInTheDocument();

    // Chỉ ảnh chụp lúc nối mang trạng thái (đây là ca đã hỏng ở
    // nghiệm thu: presence.changed không bao giờ phát cho người
    // đã trực tuyến sẵn, panel không hiện gì cả).
    act(() => {
      realtime.handlers?.onPresenceSnapshot({ onlineUserIds: [OTHER_ID] } as never);
    });

    expect(await within(row).findByText('Trực tuyến')).toBeInTheDocument();
  });

  it('đầu khung 1–1: ảnh chụp lúc nối hiện "Trực tuyến" cho đối tác đã trực tuyến từ trước; ảnh chụp rỗng đến sau không xoá trạng thái đã biết, sự kiện trực tiếp vẫn thắng ảnh chụp', async () => {
    const calls: RecordedCall[] = [];
    stubNamelessDmFetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Bạn Một/ }));
    await screen.findByLabelText('Tin nhắn');
    const infoButton = await screen.findByRole('button', { name: 'Thông tin cuộc trò chuyện' });
    const header = infoButton.parentElement as HTMLElement;
    expect(within(header).queryByText('Trực tuyến')).not.toBeInTheDocument();

    // Đối tác trực tuyến từ trước lúc tải trang: chỉ ảnh chụp
    // lúc nối mang trạng thái này tới trang.
    act(() => {
      realtime.handlers?.onPresenceSnapshot({ onlineUserIds: [OTHER_ID] } as never);
    });
    expect(await within(header).findByText('Trực tuyến')).toBeInTheDocument();

    // Ảnh chụp rỗng (ví dụ lần nối lại không liệt kê ai) không
    // được xoá trạng thái đã biết — ảnh chụp chỉ bổ sung.
    act(() => {
      realtime.handlers?.onPresenceSnapshot({ onlineUserIds: [] } as never);
    });
    expect(within(header).getByText('Trực tuyến')).toBeInTheDocument();

    // Sự kiện trực tiếp đến sau vẫn là nguồn thắng: đối tác ngắt
    // nối thì đầu khung đổi sang "Ngoại tuyến".
    act(() => {
      realtime.handlers?.onPresence({ userId: OTHER_ID, online: false } as never);
    });
    expect(await within(header).findByText('Ngoại tuyến')).toBeInTheDocument();
    expect(within(header).queryByText('Trực tuyến')).not.toBeInTheDocument();
  });
});

/**
 * Giai đoạn 2 của vòng sửa PR #610: các hành vi của bản demo đã
 * trích được từ JS của demo ở đợt rà soát hành vi nhưng vòng dựng
 * trước chưa nối — ô tìm khớp cả nội dung tin cuối (T-01), cặp
 * định dạng soạn–hiển thị đậm/liên kết (T-09/T-14/T-15), emoji
 * chèn tại con trỏ, hàng liên lạc trong panel đối tác thành liên
 * kết (T-17), và sheet hồ sơ của chính người xem mở từ avatar
 * (T-18/T-19/T-20: online/offline nối presence thật qua nối
 * socket, away/busy và nút Lưu là hình dạng vô hiệu có chủ đích —
 * hai ngoại lệ có tên trong thân PR).
 */
describe('Trang tin nhắn — giai đoạn 2 vòng sửa PR #610 (hành vi demo còn thiếu)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    realtime.handlers = null;
    profileOverride.value = null;
  });

  it('ô tìm danh sách khớp cả nội dung tin cuối: từ khoá chỉ có trong tin cuối vẫn giữ hội thoại, từ không khớp ở cả tên lẫn tin cuối thì ẩn', async () => {
    const calls: RecordedCall[] = [];
    const lastMsg = {
      id: 's2-last', conversationId: CONV_A, userIdFrom: OTHER_ID, fullMessage: 'Nhớ mã ZULU-123 nhé',
      createdAt: '2026-01-01T10:00:00.000Z', seq: 5, clientMessageId: null,
      replyToMessageId: null, replyTo: null,
    };
    stubFetchM3(calls, [lastMsg]);
    renderMessages();

    expect(await screen.findByRole('button', { name: /Hội thoại A/ })).toBeInTheDocument();
    const filter = screen.getByLabelText('Tìm cuộc trò chuyện');
    await userEvent.type(filter, 'zulu-123');
    // Tên hiển thị "Hội thoại A" không chứa từ khoá — hội thoại
    // còn ở lại CHỈ nhờ nội dung tin cuối (trước giai đoạn này
    // nó biến mất khỏi danh sách).
    expect(screen.getByRole('button', { name: /Hội thoại A/ })).toBeInTheDocument();

    await userEvent.clear(filter);
    await userEvent.type(filter, 'không đâu có');
    expect(screen.queryByRole('button', { name: /Hội thoại A/ })).not.toBeInTheDocument();
  });

  it('bong bóng hiển thị **đậm** thành chữ đậm và [nhãn](url) thành liên kết mở tab mới; sơ đồ nguy hiểm và HTML thô trong nội dung tin không thành phần tử', async () => {
    const calls: RecordedCall[] = [];
    const rich = {
      id: 's2-rich', conversationId: CONV_A, userIdFrom: OTHER_ID,
      fullMessage: 'Đoạn **rất quan trọng** và [Tài liệu](https://example.com/tl) ở đây',
      createdAt: '2026-01-01T10:00:00.000Z', seq: 5, clientMessageId: null,
      replyToMessageId: null, replyTo: null,
    };
    const evil = {
      id: 's2-evil', conversationId: CONV_A, userIdFrom: OTHER_ID,
      fullMessage: 'Thử [bấm](javascript:alert) và <b>thẻ lạ</b>',
      createdAt: '2026-01-01T10:01:00.000Z', seq: 6, clientMessageId: null,
      replyToMessageId: null, replyTo: null,
    };
    stubFetchM3(calls, [rich, evil]);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const richBubble = await screen.findByTestId('message-bubble-s2-rich');
    const strong = richBubble.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong).toHaveTextContent('rất quan trọng');
    expect(richBubble).not.toHaveTextContent('**');
    const link = within(richBubble).getByRole('link', { name: 'Tài liệu' });
    expect(link).toHaveAttribute('href', 'https://example.com/tl');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');

    // An toàn hiển thị: url sơ đồ javascript: không thành liên
    // kết và HTML thô do người dùng nhập không thành phần tử —
    // nội dung chỉ dựng qua text node/cây React.
    const evilBubble = await screen.findByTestId('message-bubble-s2-evil');
    expect(evilBubble.querySelector('a')).toBeNull();
    expect(evilBubble.querySelector('b')).toBeNull();
    expect(evilBubble).toHaveTextContent('<b>thẻ lạ</b>');
  });

  it('nút Bold bọc vùng chọn bằng ** và khôi phục vùng chọn phủ đúng đoạn đã bọc; bấm lại trên đoạn đã bọc thì bỏ bọc', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM3(calls, [M3_ORIG]);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const composer = (await screen.findByLabelText('Nội dung tin nhắn')) as HTMLTextAreaElement;
    await userEvent.type(composer, 'hello world');
    composer.setSelectionRange(6, 11);
    await userEvent.click(screen.getByRole('button', { name: 'In đậm' }));
    expect(composer.value).toBe('hello **world**');
    // Vùng chọn sau thao tác phủ đúng đoạn kết quả như neo của
    // bản demo (khôi phục sau khi React vẽ lại nháp mới).
    await waitFor(() => {
      expect(composer.selectionStart).toBe(6);
      expect(composer.selectionEnd).toBe(15);
    });

    composer.setSelectionRange(6, 15);
    await userEvent.click(screen.getByRole('button', { name: 'In đậm' }));
    expect(composer.value).toBe('hello world');
  });

  it('nút Insert link hỏi URL, tự thêm https:// khi thiếu sơ đồ và bọc vùng chọn thành [vùng chọn](url)', async () => {
    const calls: RecordedCall[] = [];
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('example.com/tai-lieu');
    stubFetchM3(calls, [M3_ORIG]);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const composer = (await screen.findByLabelText('Nội dung tin nhắn')) as HTMLTextAreaElement;
    await userEvent.type(composer, 'xem cái này');
    composer.setSelectionRange(4, 11);
    await userEvent.click(screen.getByRole('button', { name: 'Chèn liên kết' }));
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(composer.value).toBe('xem [cái này](https://example.com/tai-lieu)');
  });

  it('chọn emoji chèn TẠI vị trí con trỏ trong ô soạn và con trỏ nằm ngay sau emoji, không nối cuối nháp', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM3(calls, [M3_ORIG]);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const composer = (await screen.findByLabelText('Nội dung tin nhắn')) as HTMLTextAreaElement;
    await userEvent.type(composer, 'ab');
    composer.focus();
    composer.setSelectionRange(1, 1);
    await userEvent.click(screen.getByRole('button', { name: 'Chèn biểu tượng cảm xúc' }));
    const popover = await screen.findByTestId('emoji-picker-popover');
    await userEvent.click(within(popover).getByRole('button', { name: '😀' }));
    expect(composer.value).toBe('a😀b');
    // Con trỏ ngay sau emoji vừa chèn (vị trí 1 + độ dài
    // surrogate pair 2 = 3), không phải cuối nháp như cách nối
    // cuối trước đây.
    await waitFor(() => expect(composer.selectionStart).toBe(3));
  });

  it('panel hồ sơ đối tác: hàng email/điện thoại/website thành liên kết mailto:/tel: (bỏ khoảng trắng)/mở tab mới khi trường có giá trị', async () => {
    profileOverride.value = {
      email: 'ban@example.com',
      phone: '+84 912 345 678',
      website: 'https://ban.example.com',
    };
    const calls: RecordedCall[] = [];
    stubNamelessDmFetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Bạn Một/ }));
    await screen.findByLabelText('Tin nhắn');
    await userEvent.click(await screen.findByRole('button', { name: 'Thông tin cuộc trò chuyện' }));
    const panel = await screen.findByTestId('partner-panel');
    const mail = within(panel).getByRole('link', { name: 'ban@example.com' });
    expect(mail).toHaveAttribute('href', 'mailto:ban@example.com');
    const tel = within(panel).getByRole('link', { name: '+84 912 345 678' });
    expect(tel).toHaveAttribute('href', 'tel:+84912345678');
    const web = within(panel).getByRole('link', { name: 'https://ban.example.com' });
    expect(web).toHaveAttribute('href', 'https://ban.example.com');
    expect(web).toHaveAttribute('target', '_blank');
    expect(web.getAttribute('rel')).toContain('noopener');
  });

  it('avatar của chính người xem là nút mở sheet hồ sơ của mình: đủ các trường theo demo, Email mang giá trị thật của phiên, nút Lưu vô hiệu, away/busy vô hiệu', async () => {
    const calls: RecordedCall[] = [];
    stubNamelessDmFetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: 'Hồ sơ của tôi' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('URL ảnh đại diện')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Giới thiệu')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Email')).toHaveValue('me@example.com');
    expect(within(dialog).getByLabelText('Số điện thoại')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Công ty')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Quốc gia')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Website')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Địa điểm')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Múi giờ')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Trạng thái sẵn sàng')).toBeInTheDocument();
    // Hai ngoại lệ có tên: nút lưu vô hiệu (đường sửa hồ sơ
    // thuộc khu vực tài khoản) và hai mức away/busy vô hiệu
    // (chưa có dữ kiện presence tương ứng).
    expect(within(dialog).getByRole('button', { name: 'Lưu thay đổi' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /Vắng mặt/ })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /Đang bận/ })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /Trực tuyến/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /Ngoại tuyến/ })).toBeEnabled();
  });

  it('chọn Ngoại tuyến trong sheet hồ sơ của mình thì socket realtime bị ngắt — presence thật tắt; chọn lại Trực tuyến thì trang nối lại', async () => {
    const calls: RecordedCall[] = [];
    stubNamelessDmFetch(calls);
    renderMessages();

    await screen.findByRole('button', { name: /Bạn Một/ });
    const connectsBefore = realtime.connects;
    realtime.handle.disconnect.mockClear();

    await userEvent.click(await screen.findByRole('button', { name: 'Hồ sơ của tôi' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /Ngoại tuyến/ }));
    // Ngắt socket = server gỡ presence của người xem: trạng
    // thái ngoại tuyến là THẬT, không chỉ là hình dạng chọn.
    await waitFor(() => expect(realtime.handle.disconnect).toHaveBeenCalled());

    await userEvent.click(within(dialog).getByRole('button', { name: /Trực tuyến/ }));
    await waitFor(() => expect(realtime.connects).toBeGreaterThan(connectsBefore));
  });
});
