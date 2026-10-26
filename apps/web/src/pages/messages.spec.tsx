import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

    await userEvent.click(await screen.findByRole('button', { name: 'Chặn liên lạc' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/contacts/${OTHER_ID}/block` && c.method === 'POST')).toBe(
        true,
      ),
    );

    // Danh sách đã chặn nằm ở tab Danh bạ của khung trái (issue #256).
    await userEvent.click(screen.getByRole('tab', { name: 'Danh bạ' }));
    const blockedRow = await screen.findByTestId(`blocked-${OTHER_ID}`);
    expect(blockedRow).toHaveTextContent(OTHER_ID);
    expect(await screen.findByText('Đã chặn liên hệ này.')).toBeInTheDocument();
    // Trong cuộc trò chuyện, nút chặn đã thay bằng trạng thái đã chặn + bỏ chặn.
    expect(screen.queryByRole('button', { name: 'Chặn liên lạc' })).not.toBeInTheDocument();

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

    await userEvent.click(await screen.findByRole('button', { name: /Nhóm một/ }));
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

    await userEvent.click(await screen.findByRole('button', { name: /Nhóm một/ }));
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

    // Sự kiện mới (seq 2) áp bình thường: huy hiệu 5, xem trước là tin seq 2.
    act(() => {
      realtime.handlers?.onConversationUpdated(updatedPayload(2, 'tin mới nhất nhóm hai', 5));
    });
    expect(await screen.findByRole('button', { name: /Nhóm hai.*5 chưa đọc/ })).toBeInTheDocument();
    expect(await screen.findByText('tin mới nhất nhóm hai')).toBeInTheDocument();

    // Sự kiện cũ hơn (seq 1) đến muộn: bị bỏ qua — huy hiệu không nhảy
    // lùi lên 9 theo số của thời điểm cũ, xem trước giữ nguyên tin seq 2.
    act(() => {
      realtime.handlers?.onConversationUpdated(updatedPayload(1, 'tin cũ nhóm hai', 9));
    });
    expect(screen.getByRole('button', { name: /Nhóm hai.*5 chưa đọc/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nhóm hai.*9 chưa đọc/ })).not.toBeInTheDocument();
    expect(screen.getByText('tin mới nhất nhóm hai')).toBeInTheDocument();
    expect(screen.queryByText('tin cũ nhóm hai')).not.toBeInTheDocument();
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
      if (url === `/api/v1/messages/messages/${ownMessage.id}` && method === 'DELETE') {
        ownMessage.deletedAt = '2026-01-01T00:03:00.000Z';
        ownMessage.deletedBy = ME_ID;
        return respond(ownMessage);
      }
      if (url === `/api/v1/messages/messages/${ownMessage.id}/recall` && method === 'POST') {
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

    // Yêu cầu đang chờ hiện ở tab Danh bạ (issue #256) — bằng TÊN
    // người gửi, không phải UUID; chấp nhận qua đúng endpoint.
    await userEvent.click(await screen.findByRole('tab', { name: 'Danh bạ' }));
    const incomingRow = await screen.findByTestId(`incoming-request-${OTHER_ID}`);
    expect(incomingRow).toHaveTextContent('Bạn Học');
    expect(incomingRow).not.toHaveTextContent(OTHER_ID);
    await userEvent.click(within(incomingRow).getByRole('button', { name: 'Chấp nhận' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/contacts/requests/${OTHER_ID}/accept` && c.method === 'POST')).toBe(true),
    );
    // Quan hệ hình thành: liên hệ xuất hiện trong danh bạ đã duyệt (hiện tên), hàng chờ sạch.
    const contactRow = await screen.findByTestId(`contact-${OTHER_ID}`);
    expect(contactRow).toHaveTextContent('Bạn Học');
    expect(screen.queryByTestId(`incoming-request-${OTHER_ID}`)).not.toBeInTheDocument();

    // Tìm bạn theo KHOÁ (không còn tìm theo tên, không còn form nhập
    // ID): mở khoá của mình → dòng roster hiện tên + username → bấm
    // Kết bạn → POST contacts/:userId, trạng thái chờ duyệt hiện ra
    // bằng tên người nhận.
    await userEvent.click(await screen.findByRole('button', { name: 'Khoá học mẫu' }));
    const resultRow = await screen.findByTestId(`roster-member-${THIRD_ID}`);
    expect(resultRow).toHaveTextContent('Người Thứ Ba');
    expect(resultRow).toHaveTextContent('@thirduser');
    await userEvent.click(within(resultRow).getByRole('button', { name: 'Kết bạn' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/contacts/${THIRD_ID}` && c.method === 'POST')).toBe(true),
    );
    expect(await screen.findByText('Đã gửi yêu cầu kết bạn — chờ phía kia chấp nhận.')).toBeInTheDocument();
    expect(await screen.findByText(/Người Thứ Ba \(đang chờ duyệt\)/)).toBeInTheDocument();
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

    await userEvent.click(await screen.findByRole('button', { name: /Nhóm lớp/ }));
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
      expect(calls.some((c) => c.url.startsWith('/api/v1/messages/messages/') && c.method === 'DELETE')).toBe(true),
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
    // tiết thẳng theo id, chèn nó vào danh sách và mở ra.
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
    // của mình (tìm theo tên và form nhập ID đều đã bỏ) — roster nằm ở
    // tab Danh bạ của khung trái (issue #256).
    await userEvent.click(await screen.findByRole('tab', { name: 'Danh bạ' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Khoá học mẫu' }));
    const resultRow = await screen.findByTestId(`roster-member-${OTHER_ID}`);
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
    expect(await screen.findByRole('button', { name: 'Chặn liên lạc' })).toBeInTheDocument();
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

    await userEvent.click(await screen.findByRole('tab', { name: 'Danh bạ' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Khoá học mẫu' }));
    const directRow = await screen.findByTestId(`roster-member-${OTHER_ID}`);
    const plainRow = await screen.findByTestId(`roster-member-${THIRD_ID}`);
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
    expect(await screen.findByRole('button', { name: 'Chặn liên lạc' })).toBeInTheDocument();
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

    await userEvent.click(await screen.findByRole('button', { name: /Nhóm lớp/ }));
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của tôi sẽ xoá')).toBeInTheDocument();

    // Chỉ tin của mình (mới gửi, trong cửa sổ 15 phút) có mục Thu hồi
    // trong menu ⋯; tin của bạn học không có menu nào.
    const moreButtons = screen.getAllByRole('button', { name: 'Thao tác khác' });
    expect(moreButtons).toHaveLength(1);
    await userEvent.click(moreButtons[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Thu hồi' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/messages/01900000-0000-7000-8000-0000000000d5/recall` && c.method === 'POST')).toBe(true),
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

    expect(await screen.findByRole('button', { name: /Hội thoại A/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Lớp Toán 10A1/ })).toBeInTheDocument();

    const filter = screen.getByLabelText('Tìm cuộc trò chuyện');
    await userEvent.type(filter, 'toán');
    expect(screen.queryByRole('button', { name: /Hội thoại A/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lớp Toán 10A1/ })).toBeInTheDocument();

    await userEvent.clear(filter);
    await userEvent.type(filter, 'không tồn tại đâu');
    expect(await screen.findByText('Không có cuộc trò chuyện nào khớp.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Lớp Toán 10A1/ })).not.toBeInTheDocument();

    await userEvent.clear(filter);
    expect(await screen.findByRole('button', { name: /Hội thoại A/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lớp Toán 10A1/ })).toBeInTheDocument();
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

/**
 * Issue #256 — bề mặt nhắn tin theo chuẩn app nhắn tin: khung trái có
 * ba tab (Trò chuyện / Danh bạ / Đã lưu trữ), tab Trò chuyện có chip
 * lọc Tất cả / Chưa đọc / Nhóm, và khung chat có nút quay lại về danh
 * sách (mobile). Stub realtime: "Nhóm một" là nhóm có 1 chưa đọc,
 * "Nhóm hai" là nhóm đã đọc hết.
 */
describe('Messages page — #256: tab, chip lọc, quay lại', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('khung trái có đủ ba tab; tab Đã lưu trữ nạp danh sách riêng và hiện trạng thái rỗng', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    expect(await screen.findByRole('tab', { name: 'Trò chuyện' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Danh bạ' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Đã lưu trữ' })).toBeInTheDocument();

    // Mở tab Đã lưu trữ: trang xin đúng đường ?archived=true; stub
    // không có mục nào nên hiện trạng thái rỗng của mục đã lưu.
    await userEvent.click(screen.getByRole('tab', { name: 'Đã lưu trữ' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'GET' && c.url === '/api/v1/messages/conversations?archived=true')).toBe(true);
    });
    expect(await screen.findByText('Chưa có cuộc trò chuyện nào được lưu trữ.')).toBeInTheDocument();
    // Danh sách trò chuyện không còn hiện khi đang ở tab Đã lưu trữ.
    expect(screen.queryByRole('button', { name: /Nhóm một/ })).not.toBeInTheDocument();
  });

  it('chip Chưa đọc chỉ giữ hội thoại còn chưa đọc; chip Nhóm giữ hội thoại nhóm; Tất cả trả lại đủ', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    expect(await screen.findByRole('button', { name: /Nhóm một/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nhóm hai/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Chưa đọc' }));
    expect(screen.getByRole('button', { name: /Nhóm một/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nhóm hai/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Nhóm' }));
    expect(screen.getByRole('button', { name: /Nhóm một/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nhóm hai/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Tất cả' }));
    expect(screen.getByRole('button', { name: /Nhóm một/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nhóm hai/ })).toBeInTheDocument();
  });

  it('mở hội thoại rồi bấm quay lại thì khung phải về trạng thái chưa chọn', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Nhóm một/ }));
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();
    expect(screen.queryByText('Chọn một cuộc hội thoại ở cột trái để đọc và trả lời.')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Quay lại danh sách trò chuyện' }));
    expect(await screen.findByText('Chọn một cuộc hội thoại ở cột trái để đọc và trả lời.')).toBeInTheDocument();
  });
});
