import { describe, expect, it, vi } from 'vitest';
import { MessagingGateway } from './messaging.gateway';

/**
 * Gateway nhắn tin lúc socket nối (issue #33): danh sách chặn của
 * user là MỘT dữ kiện duy nhất, không đổi theo hội thoại — một lần
 * nối với nhiều hội thoại 1–1 chỉ được tải danh sách chặn tối đa
 * một lần, và tập room socket vào được không đổi so với khi tải lại
 * theo từng hội thoại:
 *
 * - Hội thoại 1–1 đang chặn (bất kỳ chiều nào): socket KHÔNG vào
 *   room của hội thoại đó.
 * - Hội thoại 1–1 không chặn và hội thoại nhóm: socket vào room
 *   như cũ; socket luôn vào room riêng của user.
 *
 * Trả danh sách chặn về tải lại theo từng hội thoại thì ca này đỏ
 * ở khẳng định số lượt gọi repository.
 */
describe('MessagingGateway.handleConnection — danh sách chặn tải một lần cho cả lần nối', () => {
  const USER_ID = 'user-1';
  const TENANT_ID = 'tenant-1';
  const BLOCKED_PEER = 'user-blocked';

  function build() {
    // Ba hội thoại 1–1 (một đang chặn) + một hội thoại nhóm.
    const conversations = [
      { id: 'conv-blocked', tenantId: TENANT_ID },
      { id: 'conv-open-a', tenantId: TENANT_ID },
      { id: 'conv-open-b', tenantId: TENANT_ID },
      { id: 'conv-group', tenantId: TENANT_ID },
    ];
    const peers: Record<string, string> = {
      'conv-blocked': BLOCKED_PEER,
      'conv-open-a': 'user-a',
      'conv-open-b': 'user-b',
    };
    const repo = {
      listConversationsForUser: vi.fn(async () => conversations),
      getConversation: vi.fn(async (id: string) => ({
        id,
        type: id === 'conv-group' ? 2 : 1,
        tenantId: TENANT_ID,
      })),
      listMembers: vi.fn(async (id: string) => [USER_ID, peers[id]!]),
      listBlockedCounterpartIds: vi.fn(async () => [BLOCKED_PEER]),
    };
    const auth = {
      authenticateHandshake: vi.fn(async () => ({ userId: USER_ID, username: 'user1', tenantId: TENANT_ID })),
    };
    const realtime = {
      markConnected: vi.fn(async () => {}),
      markDisconnected: vi.fn(async () => {}),
      listOnlineConversationCounterparts: vi.fn(async () => [] as string[]),
    };
    const gateway = new MessagingGateway(auth as never, repo as never, realtime as never);
    const joinedRooms: string[] = [];
    const client = {
      id: 'socket-1',
      data: {} as Record<string, unknown>,
      handshake: {},
      join: vi.fn(async (room: string) => {
        joinedRooms.push(room);
      }),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    return { gateway, repo, client, joinedRooms, realtime };
  }

  it('nhiều hội thoại 1–1 trong một lần nối: danh sách chặn chỉ tải đúng một lần, room bị chặn không được vào', async () => {
    const { gateway, repo, client, joinedRooms } = build();

    await gateway.handleConnection(client as never);

    expect(client.disconnect).not.toHaveBeenCalled();
    expect(repo.listBlockedCounterpartIds).toHaveBeenCalledTimes(1);
    expect(repo.listBlockedCounterpartIds).toHaveBeenCalledWith(USER_ID);
    // Room riêng của user + hai hội thoại 1–1 không chặn + hội thoại
    // nhóm; tuyệt đối không có room của hội thoại đang chặn.
    expect(joinedRooms).toHaveLength(4);
    expect(joinedRooms.some((room) => room.includes('conv-blocked'))).toBe(false);
    expect(joinedRooms.some((room) => room.includes('conv-open-a'))).toBe(true);
    expect(joinedRooms.some((room) => room.includes('conv-open-b'))).toBe(true);
    expect(joinedRooms.some((room) => room.includes('conv-group'))).toBe(true);
    expect(joinedRooms.some((room) => room.includes(`user:${USER_ID}`))).toBe(true);
  });
});

/**
 * Ảnh chụp hiện diện ban đầu (issue #592): ngay sau khi ghi
 * presence, gateway gửi cho CHÍNH socket vừa nối các sự kiện
 * `presence.changed` của từng đối tác đang trực tuyến mà tầng
 * realtime trả về — dùng lại đúng sự kiện và định dạng của luồng
 * thay đổi presence nên client không cần sửa. Gateway không tự
 * tính tập đối tác (tầng realtime giữ luật phạm vi/chặn) mà chỉ
 * phát đúng tập nhận được, về đúng socket vừa nối.
 */
describe('MessagingGateway.handleConnection — ảnh chụp hiện diện ban đầu cho socket vừa nối', () => {
  const USER_ID = 'user-1';
  const TENANT_ID = 'tenant-1';

  function build(online: string[]) {
    const repo = {
      listConversationsForUser: vi.fn(async () => [{ id: 'conv-1', tenantId: TENANT_ID }]),
      getConversation: vi.fn(async (id: string) => ({ id, type: 2, tenantId: TENANT_ID })),
      listMembers: vi.fn(async () => [USER_ID, 'user-a']),
      listBlockedCounterpartIds: vi.fn(async () => [] as string[]),
    };
    const auth = {
      authenticateHandshake: vi.fn(async () => ({ userId: USER_ID, username: 'user1', tenantId: TENANT_ID })),
    };
    const realtime = {
      markConnected: vi.fn(async () => {}),
      markDisconnected: vi.fn(async () => {}),
      listOnlineConversationCounterparts: vi.fn(async () => online),
    };
    const gateway = new MessagingGateway(auth as never, repo as never, realtime as never);
    const client = {
      id: 'socket-1',
      data: {} as Record<string, unknown>,
      handshake: {},
      join: vi.fn(async () => {}),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    return { gateway, client, realtime };
  }

  it('gửi đúng một sự kiện presence.changed online cho mỗi đối tác tầng realtime trả về, về chính socket vừa nối', async () => {
    const { gateway, client, realtime } = build(['user-a', 'user-b']);

    await gateway.handleConnection(client as never);

    expect(client.disconnect).not.toHaveBeenCalled();
    expect(realtime.listOnlineConversationCounterparts).toHaveBeenCalledWith(TENANT_ID, USER_ID);
    expect(client.emit).toHaveBeenCalledTimes(2);
    expect(client.emit).toHaveBeenCalledWith('presence.changed', { userId: 'user-a', online: true });
    expect(client.emit).toHaveBeenCalledWith('presence.changed', { userId: 'user-b', online: true });
  });

  it('không có đối tác trực tuyến thì không gửi sự kiện ảnh chụp nào', async () => {
    const { gateway, client } = build([]);

    await gateway.handleConnection(client as never);

    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.emit).not.toHaveBeenCalled();
  });
});
