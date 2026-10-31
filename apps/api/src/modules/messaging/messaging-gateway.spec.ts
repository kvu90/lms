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
 *
 * Cùng file: ảnh chụp presence lúc nối — sau khi ghi presence của
 * người nối, gateway xin tầng realtime danh sách người đang trực
 * tuyến trong quan hệ hội thoại chung và phát `presence.snapshot`
 * cho CHÍNH socket vừa nối, để người đã trực tuyến từ trước (không
 * phát sinh sự kiện thay đổi nào) vẫn được người nối học được.
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
      listOnlineCoMemberIds: vi.fn(async () => ['user-a']),
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
    return { gateway, repo, client, realtime, joinedRooms };
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

  it('phát ảnh chụp presence cho chính socket vừa nối, sau khi đã ghi presence của người nối', async () => {
    const { gateway, client, realtime } = build();

    await gateway.handleConnection(client as never);

    // Ảnh chụp lấy từ tầng realtime theo đúng người vừa nối và phát
    // đúng một lần, chỉ tới socket này (client.emit, không qua room).
    expect(realtime.listOnlineCoMemberIds).toHaveBeenCalledTimes(1);
    expect(realtime.listOnlineCoMemberIds).toHaveBeenCalledWith(USER_ID);
    expect(client.emit).toHaveBeenCalledTimes(1);
    expect(client.emit).toHaveBeenCalledWith('presence.snapshot', { onlineUserIds: ['user-a'] });
    // Thứ tự: ghi presence của người nối TRƯỚC, đọc ảnh chụp SAU.
    expect(realtime.markConnected.mock.invocationCallOrder[0]!)
      .toBeLessThan(realtime.listOnlineCoMemberIds.mock.invocationCallOrder[0]!);
  });
});
