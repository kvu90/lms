import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '#lib/auth';
import { createQueryClient } from '#lib/query-client';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { MessagesPage } from './messages';

/**
 * Kênh realtime được mock ở đúng biên lib `#lib/messaging-socket`:
 * test cũ (chặn liên lạc, hợp đồng tạo conversation) không cần socket
 * thật; test realtime bên dưới điều khiển handlers mà trang đăng ký
 * để giả lập sự kiện server đẩy xuống.
 */
const realtime = vi.hoisted(() => ({
  handlers: null as null | Record<string, (payload: never) => void>,
  handle: {
    sync: vi.fn(async () => ({})),
    joinConversation: vi.fn(),
    typing: vi.fn(),
    disconnect: vi.fn(),
  },
}));
vi.mock('#lib/messaging-socket', () => ({
  connectMessagingRealtime: (handlers: Record<string, (payload: never) => void>) => {
    realtime.handlers = handlers;
    return realtime.handle;
  },
}));

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
 * Mở một hội thoại nhóm từ cây của tab Nhóm (lát MSG-T3): chuyển sang
 * tab Nhóm rồi bấm dòng của nhóm trong cây — đúng đường người dùng đi
 * từ khi hội thoại nhóm rời khỏi danh sách phẳng.
 */
async function openGroupFromTree(name: RegExp) {
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

describe('Messages page — block and unblock contacts', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('blocks the conversation partner via POST contacts/:userId/block and unblocks via DELETE', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderMessages();

    const convButton = await screen.findByRole('button', { name: new RegExp(OTHER_ID) });
    await userEvent.click(convButton);

    // Nút chặn ở header chat 1–1 mang kèm TÊN người đối thoại
    // (quyết 23:16 ngày 26/10/2026 — sửa bug nút chặn không tên).
    await userEvent.click(await screen.findByRole('button', { name: /^Chặn liên lạc / }));
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
    // Trong cuộc trò chuyện, nút chặn đã thay bằng trạng thái đã chặn + bỏ chặn.
    expect(screen.queryByRole('button', { name: /^Chặn liên lạc / })).not.toBeInTheDocument();

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

describe('Messages page — optimistic send and realtime updates', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('sends with a clientMessageId and dedupes the socket echo of its own message', async () => {
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    await openGroupFromTree(/Nhóm một/);
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

  it('appends a realtime message from the peer and updates unread from conversation.updated', async () => {
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    await openGroupFromTree(/Nhóm một/);
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

  it('ignores a stale conversation.updated with an older seq than the applied one', async () => {
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    // Từ lát MSG-T3, số chưa đọc của nhóm hiện trên nút của cây ở
    // tab Nhóm — chuyển sang tab đó trước khi quan sát huy hiệu.
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

  it('accepts an incoming contact request and sends a new request from the course roster', async () => {
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

  it('soft-deletes my own message (peer message has no delete button) and reports the conversation', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await openGroupFromTree(/Nhóm lớp/);
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

    // Báo cáo cuộc trò chuyện qua đúng endpoint và có xác nhận hiển thị.
    await userEvent.click(screen.getByRole('button', { name: 'Báo cáo cuộc trò chuyện' }));
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

  it('opens the conversation named by ?conversation= when it is in the loaded list', async () => {
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

  it('fetches by id and opens the conversation when it is not in the loaded list', async () => {
    const calls: RecordedCall[] = [];
    stubDeepLinkFetch(calls);
    renderMessages(`/messages?conversation=${CONV3_ID}`);

    // Conversation không có trong danh sách đã nạp: trang lấy chi
    // tiết thẳng theo id, chèn nó vào danh sách và mở ra. Từ lát
    // MSG-T3, hội thoại nhóm không còn hiện ở tab Trò chuyện nên
    // khẳng định "có mặt trong danh sách" cũ được thay bằng khẳng
    // định khung phải đã mở đúng hội thoại (phần GET + đánh dấu đã
    // đọc ở dưới giữ nguyên).
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin mở bằng deep-link')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nhóm deep-link/ })).not.toBeInTheDocument();
    expect(
      calls.some((c) => c.url === `/api/v1/messages/conversations/${CONV3_ID}` && c.method === 'GET'),
    ).toBe(true);
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/messages/conversations/${CONV3_ID}/read` && c.method === 'POST'),
      ).toBe(true),
    );
  });

  it('ignores an unknown ?conversation= id and keeps the page as-is', async () => {
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

describe('Messages page — create conversation contract', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('posts memberIds when starting a conversation from a course roster contact and opens it with the designated user as a member', async () => {
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
    // nút chặn dành cho thành viên đó xuất hiện trong khung trò chuyện.
    expect(await screen.findByRole('button', { name: /^Chặn liên lạc / })).toBeInTheDocument();
  });

  it('shows a direct Message button on roster rows flagged canDirectMessage (teacher → enrolled student, no friending first)', async () => {
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
    expect(await screen.findByRole('button', { name: /^Chặn liên lạc / })).toBeInTheDocument();
  });
});

describe('Messages page — vòng đời tin nhắn theo vai (thu hồi + invalidate)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('shows the recall button only for my recent message, recalls via POST, and keeps the recalled line after conversation.invalidate', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await openGroupFromTree(/Nhóm lớp/);
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

  it('hiện thời gian tương đối của tin cuối và đẩy conversation có tin mới lên đầu khi nhận conversation.updated', async () => {
    // Ghim đồng hồ cho riêng ca này về một mốc cố định lấy tại đầu
    // ca: nhãn tương đối tính từ Date.now() ở CẢ hai phía — stub dựng
    // mốc tin cuối bằng isoMinutesAgo (Date.now lúc dựng stub) còn
    // relativeTime đọc Date.now lúc hiển thị — hai lần đọc đồng hồ
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
    // Mốc thời gian tương đối của tin cuối: A 2 giờ trước, B 30 phút trước.
    expect(screen.getByTestId(`conversation-last-time-${CONV_A}`)).toHaveTextContent('2 giờ trước');
    expect(screen.getByTestId(`conversation-last-time-${CONV_B}`)).toHaveTextContent('30 phút trước');

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

  it('hiện bộ đếm và chặn gửi ở client khi nháp vượt trần 10.000 ký tự', async () => {
    const calls: RecordedCall[] = [];
    stubFetchM1(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Hội thoại A/ }));
    const composer = (await screen.findByLabelText('Nội dung tin nhắn')) as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: 'a'.repeat(10001) } });
    expect(screen.getByTestId('message-char-count')).toHaveTextContent('10001/10000');

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

    // Tab Trò chuyện: ô tìm lọc các hội thoại 1–1 theo tên hiển thị.
    // ('Lớp Toán 10A1' là hội thoại nhóm — từ lát MSG-T3 nó chỉ còn
    // ở cây của tab Nhóm, được kiểm ở phần sau của ca này.)
    expect(await screen.findByRole('button', { name: /Hội thoại A/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Lớp Toán 10A1/ })).not.toBeInTheDocument();

    const filter = screen.getByLabelText('Tìm cuộc trò chuyện');
    await userEvent.type(filter, 'toán');
    expect(screen.queryByRole('button', { name: /Hội thoại A/ })).not.toBeInTheDocument();
    expect(await screen.findByText('Không có cuộc trò chuyện nào khớp.')).toBeInTheDocument();

    await userEvent.clear(filter);
    await userEvent.type(filter, 'không tồn tại đâu');
    expect(await screen.findByText('Không có cuộc trò chuyện nào khớp.')).toBeInTheDocument();

    await userEvent.clear(filter);
    expect(await screen.findByRole('button', { name: /Hội thoại A/ })).toBeInTheDocument();

    // Tab Nhóm có ô tìm riêng lọc cây theo tên.
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
    await userEvent.click(screen.getByRole('button', { name: 'Tìm trong cuộc trò chuyện' }));

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
    await userEvent.click(screen.getByRole('button', { name: 'Tìm trong cuộc trò chuyện' }));

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
    await userEvent.click(screen.getByRole('button', { name: 'Tìm trong cuộc trò chuyện' }));

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

    // Mở tab Đã lưu trữ (issue #256): trang xin đúng đường ?archived=true và thấy B ở đó.
    await userEvent.click(screen.getByRole('tab', { name: 'Đã lưu trữ' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'GET' && c.url === '/api/v1/messages/conversations?archived=true')).toBe(true);
    });
    expect(await screen.findByRole('button', { name: /Hội thoại B/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Hội thoại A/ })).not.toBeInTheDocument();

    // Bỏ lưu trữ B ngay trong mục đã lưu → B rời mục; quay lại danh sách chính thì B có mặt.
    await userEvent.click(screen.getByTestId(`conversation-actions-${M5_CONV_B}`));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Bỏ lưu trữ' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Hội thoại B/ })).not.toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('tab', { name: 'Trò chuyện' }));
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
 * con theo vai DẠY. `studentView` đổi mọi vai của cây thành HỌC và
 * bỏ nút tạo nhóm khỏi tầm tay học sinh.
 */
function stubMsgT3Fetch(calls: RecordedCall[], opts: { studentView?: boolean } = {}) {
  const role = opts.studentView ? 'learning' : 'teaching';
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
          { id: T3_GROUP_CONV, type: 2, name: 'Nhóm Riêng', members: [ME_ID, OTHER_ID], unread: 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null },
        ]);
      if (url === '/api/v1/messages/group-tree')
        return respond({
          classes: [{
            classId: T3_CLASS_ID, name: 'Lớp 10A1', myRole: role, conversationId: T3_CLASS_CONV, unread: 1,
            courses: [{
              courseId: T3_COURSE_ID, name: 'Toán 10', myRole: role, conversationId: T3_COURSE_CONV, unread: 1,
              groups: [{ groupId: '01900000-0000-7000-8000-0000000000c3', name: 'Nhóm 1', myRole: role, conversationId: null, unread: 0 }],
            }],
          }],
          coursesOutsideClasses: [],
          freeGroups: opts.studentView
            ? []
            : [{ id: T3_GROUP_CONV, name: 'Nhóm Riêng', myRole: 'staff', conversationId: T3_GROUP_CONV, unread: 0 }],
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
 * Lát MSG-T3 (chuỗi cấu trúc nhắn tin của issue #33, tiếp nối bề mặt
 * #256): khung trái có ba tab Trò chuyện / Nhóm / Đã lưu trữ — Trò
 * chuyện CHỈ chứa hội thoại 1–1, hội thoại nhóm sống ở cây của tab
 * Nhóm, Danh bạ hạ thành sheet "Tin nhắn mới". Các ca dưới khoá đúng
 * các quyết định đó: đổi cấu trúc tab là các ca này phải đỏ.
 */
describe('Messages page — MSG-T3: phân tab, cây nhóm, sheet Tin nhắn mới', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('khung trái có ba tab Trò chuyện / Nhóm / Đã lưu trữ, không còn tab Danh bạ; tab Đã lưu trữ nạp danh sách riêng', async () => {
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    expect(await screen.findByRole('tab', { name: 'Trò chuyện' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Nhóm' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Đã lưu trữ' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Danh bạ' })).not.toBeInTheDocument();

    // Mở tab Đã lưu trữ: trang xin đúng đường ?archived=true; stub
    // không có mục nào nên hiện trạng thái rỗng của mục đã lưu.
    await userEvent.click(screen.getByRole('tab', { name: 'Đã lưu trữ' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'GET' && c.url === '/api/v1/messages/conversations?archived=true')).toBe(true);
    });
    expect(await screen.findByText('Chưa có cuộc trò chuyện nào được lưu trữ.')).toBeInTheDocument();
  });

  it('tab Trò chuyện chỉ chứa hội thoại 1–1; chip Chưa đọc lọc trong các hội thoại 1–1', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    expect(await screen.findByRole('button', { name: /Bạn Một/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bạn Hai/ })).toBeInTheDocument();
    // Hội thoại nhóm KHÔNG còn ở danh sách Trò chuyện.
    expect(screen.queryByRole('button', { name: /Nhóm Riêng/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Chưa đọc' }));
    expect(screen.getByRole('button', { name: /Bạn Một/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bạn Hai/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Tất cả' }));
    expect(screen.getByRole('button', { name: /Bạn Một/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bạn Hai/ })).toBeInTheDocument();
  });

  it('tab Nhóm hiện cây Lớp → Khoá → Nhóm con theo vai; bấm dòng khoá và dòng lớp mở ngay chat qua ensure', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    // Huy hiệu của tab Nhóm là tổng chưa đọc của cây (lớp: 1).
    expect(screen.getByRole('tab', { name: 'Nhóm' })).toHaveTextContent('1');
    // Tên truy cập của dòng cây gồm chữ viết tắt avatar + tên nút +
    // nhãn vai/số chưa đọc; nút chevron của chính dòng đó mang tên
    // "Mở rộng: <tên>"/"Thu gọn: <tên>" nên các truy vấn ở ca này
    // dùng mẫu loại trừ hai tiền tố chevron để không bắt nhầm nó.
    const classRow = await screen.findByRole('button', { name: /^(?!(Mở rộng|Thu gọn):).*Lớp 10A1/ });
    expect(classRow).toHaveTextContent('Đang dạy');

    // Mở nút lớp: khoá con hiện ra; mở tiếp nút khoá thì nhóm con
    // của khoá hiện ra — cây đủ ba tầng Lớp → Khoá → Nhóm con.
    await userEvent.click(within(classRow.parentElement as HTMLElement).getByRole('button', { name: /Mở rộng/ }));
    const courseRow = await screen.findByRole('button', { name: /^(?!(Mở rộng|Thu gọn):).*Toán 10/ });
    await userEvent.click(within(courseRow.parentElement as HTMLElement).getByRole('button', { name: /Mở rộng/ }));
    expect(await screen.findByRole('button', { name: /Nhóm 1/ })).toBeInTheDocument();
    // Nhóm tự do nằm ở mục riêng của cây.
    expect(screen.getByRole('button', { name: /Nhóm Riêng/ })).toBeInTheDocument();

    // Bấm dòng khoá: ensure conversation của khoá rồi mở khung phải.
    await userEvent.click(screen.getByRole('button', { name: /^(?!(Mở rộng|Thu gọn):).*Toán 10/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'GET' && c.url === `/api/v1/messages/courses/${T3_COURSE_ID}/conversation`)).toBe(true),
    );
    expect(await screen.findByLabelText('Tin nhắn')).toBeInTheDocument();

    // Bấm dòng lớp: ensure conversation của lớp rồi mở khung phải.
    await userEvent.click(screen.getByRole('button', { name: /^(?!(Mở rộng|Thu gọn):).*Lớp 10A1/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'GET' && c.url === `/api/v1/messages/classes/${T3_CLASS_ID}/conversation`)).toBe(true),
    );
  });

  it('giáo viên tạo được nhóm tự do từ sheet Tạo nhóm; học sinh không thấy nút tạo nhóm', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT3Fetch(calls);
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
    const studentCalls: RecordedCall[] = [];
    stubMsgT3Fetch(studentCalls, { studentView: true });
    renderMessages();
    await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
    expect(await screen.findByRole('button', { name: /^(?!(Mở rộng|Thu gọn):).*Lớp 10A1/ })).toBeInTheDocument();
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

    await openGroupFromTree(/Nhóm một/);
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

    await openGroupFromTree(/Nhóm một/);
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
    // Server xác nhận xong: vẫn đúng một tin, nút Gửi mở lại.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Gửi' })).not.toBeDisabled());
    expect(within(thread).getAllByText('tin chống trùng')).toHaveLength(1);
    expect(sendPosts(calls)).toHaveLength(1);
  });

  it('bản nháp mới sau khi gửi thành công mang khoá mới — hai tin liên tiếp không bị gộp oan', async () => {
    const calls: RecordedCall[] = [];
    const { releaseSend } = stubDupSendFetch(calls);
    releaseSend();
    renderMessages();

    await openGroupFromTree(/Nhóm một/);
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

/** Mở chat cấp khoá Toán 10 từ cây của tab Nhóm (đường ensure) và chờ khung chat hiện. */
async function openT4CourseChat() {
  await userEvent.click(await screen.findByRole('tab', { name: 'Nhóm' }));
  await userEvent.click(await screen.findByRole('button', { name: /^(?!(Mở rộng|Thu gọn):).*Toán 10/ }));
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

    // Thông tin nhóm: loại Khoá học + công tắc Tắt chat (canManage).
    expect(screen.getByText('Khoá học')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tắt chat' })).toBeInTheDocument();
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

    await openGroupFromTree(/Nhóm ôn tập/);
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
describe('Messages page — dọn gọn trình bày (avatar neo đầu dòng + menu không xuống dòng)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    realtime.handlers = null;
  });

  /** Mọi avatar trong khung chat: neo đầu dòng (self-start), hết hack translate theo footer và hết neo đáy. */
  function expectAvatarsAnchoredToMessageTop(thread: HTMLElement) {
    const avatars = thread.querySelectorAll('[data-slot="message-avatar"]');
    expect(avatars.length).toBeGreaterThan(0);
    for (const avatar of avatars) {
      expect(avatar.className).toContain('self-start');
      expect(avatar.className).not.toContain('self-end');
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

  it('avatar neo đầu dòng tin cho cả tin của mình và tin người khác', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await openGroupFromTree(/Nhóm lớp/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của tôi sẽ xoá')).toBeInTheDocument();
    expect(await within(thread).findByText('tin của bạn học')).toBeInTheDocument();
    expectAvatarsAnchoredToMessageTop(thread);
  });

  it('menu quan hệ mở từ avatar trên dòng tin: bề rộng tử tế, mọi mục một dòng', async () => {
    const calls: RecordedCall[] = [];
    stubMsgT4Fetch(calls);
    renderMessages();

    await openT4CourseChat();
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('em chào cô')).toBeInTheDocument();
    expectAvatarsAnchoredToMessageTop(thread);

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

    await openGroupFromTree(/Nhóm lớp/);
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

  it('dòng thời gian chỉ hiện ở tin cuối: thread hai tin chỉ còn đúng một footer, nằm ở tin cuối', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await openGroupFromTree(/Nhóm lớp/);
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của bạn học')).toBeInTheDocument();

    const footers = thread.querySelectorAll('[data-slot="message-footer"]');
    expect(footers).toHaveLength(1);
    expect(footers[0]!.textContent).toContain(new Date('2026-01-01T00:01:00.000Z').toLocaleString());
    const lastRow = within(thread).getByText('tin của bạn học').closest('[data-slot="message"]')!;
    expect(lastRow.querySelector('[data-slot="message-footer"]')).not.toBeNull();
    const firstRow = within(thread).getByText('tin của tôi sẽ xoá').closest('[data-slot="message"]')!;
    expect(firstRow.querySelector('[data-slot="message-footer"]')).toBeNull();
  });

  it('header chat nhóm không còn nút Chặn/Bỏ chặn nào', async () => {
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await openGroupFromTree(/Nhóm lớp/);
    expect(await screen.findByLabelText('Tin nhắn')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Chặn liên lạc/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Bỏ chặn/ })).not.toBeInTheDocument();
  });

  it('header chat 1–1 có đúng một nút Chặn kèm tên người đối thoại', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderMessages();

    const convButton = await screen.findByRole('button', { name: new RegExp(OTHER_ID) });
    await userEvent.click(convButton);

    const blockButtons = await screen.findAllByRole('button', { name: /^Chặn liên lạc / });
    expect(blockButtons).toHaveLength(1);
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
 * Stub fetch cho hai ca hồi quy của vòng sửa PR #530: chi tiết nhóm
 * một có trạng thái (tin gửi thành công nằm trong chi tiết cho tới
 * khi bị gỡ — giả lập tin đã bị xoá cứng phía server), và đáp ứng
 * POST gửi tin có thể bị GIỮ LẠI để test chèn sự kiện socket xác
 * nhận đến trước đáp ứng REST.
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
    await openGroupFromTree(/Nhóm một/);
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

    await openGroupFromTree(/Nhóm một/);
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

    // Đáp ứng REST về sau đó: lượt gửi hoàn tất (nút Gửi hết bị khoá), tin không nhân đôi.
    await act(async () => {
      controls.releaseSend();
    });
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
