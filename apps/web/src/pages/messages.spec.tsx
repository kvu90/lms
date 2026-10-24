import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '#lib/auth';
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

/** Render trang tin nhắn trong AuthProvider như ứng dụng thật. */
function renderMessages() {
  const router = createMemoryRouter([{ path: '/messages', element: <MessagesPage /> }], {
    initialEntries: ['/messages'],
  });
  render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
}

describe('Messages page — block and unblock contacts', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('blocks the conversation partner via POST contacts/:userId/block and unblocks via DELETE', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
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
    localStorage.setItem('lms.accessToken', 'test-token');
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
    expect(await screen.findByText('xin chào lạc quan')).toBeInTheDocument();

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
    expect(screen.getAllByText('xin chào lạc quan')).toHaveLength(1);
  });

  it('appends a realtime message from the peer and updates unread from conversation.updated', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
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
    localStorage.setItem('lms.accessToken', 'test-token');
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
    createdAt: '2026-01-01T00:00:00.000Z',
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
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    // Yêu cầu đang chờ hiện trong panel danh bạ — bằng TÊN người gửi,
    // không phải UUID; chấp nhận qua đúng endpoint.
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
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubDomainFetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Nhóm lớp/ }));
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin của tôi sẽ xoá')).toBeInTheDocument();
    expect(await within(thread).findByText('tin của bạn học')).toBeInTheDocument();

    // Chỉ tin của mình có nút xoá (không canModerate): đúng một nút.
    const deleteButtons = screen.getAllByRole('button', { name: 'Xoá tin nhắn' });
    expect(deleteButtons).toHaveLength(1);
    await userEvent.click(deleteButtons[0]!);
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

describe('Messages page — create conversation contract', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('posts memberIds when starting a conversation from a course roster contact and opens it with the designated user as a member', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderMessages();

    // Bắt đầu cuộc trò chuyện từ dòng roster của một liên hệ trong khoá
    // của mình (tìm theo tên và form nhập ID đều đã bỏ).
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
});
