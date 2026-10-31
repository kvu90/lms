import { describe, expect, it, vi } from 'vitest';
import { MessagingContactsService } from './messaging-contacts.service';

/**
 * Endpoint hồ sơ người phục vụ panel chat 1–1 (issue #592):
 * trả định danh + tên hiển thị + tên đăng nhập + email từ dữ
 * kiện người dùng thật, chỉ khi người xem chung ít nhất một
 * conversation nhìn thấy được với đối tác. Người lạ không chung
 * hội thoại nào, và đối tác của hội thoại 1–1 đang chặn, đều
 * nhận 404 như đối tác không tồn tại (không rò sự tồn tại).
 */
describe('MessagingContactsService.getPersonProfile — cổng chung hội thoại và dữ kiện thật', () => {
  const VIEWER_ID = 'viewer-1';
  const PARTNER_ID = 'partner-1';
  const STRANGER_ID = 'stranger-1';

  function build(shares: (viewerId: string, targetId: string) => boolean) {
    const repo = {
      sharesConversation: vi.fn(async (viewerId: string, targetId: string) => shares(viewerId, targetId)),
    };
    const users = {
      getUser: vi.fn(async (id: string) => ({
        id, username: 'teacher1', firstName: 'Lan Anh', lastName: 'Nguyễn', email: 'teacher1@example.com',
      })),
    };
    const service = new MessagingContactsService(repo as never, users as never, {} as never, {} as never);
    return { service, repo, users };
  }

  it('đối tác chung hội thoại thì trả đủ bốn trường thật từ bảng người dùng', async () => {
    const { service, users } = build(() => true);

    const profile = await service.getPersonProfile(VIEWER_ID, PARTNER_ID);

    expect(profile).toEqual({
      userId: PARTNER_ID,
      displayName: 'Lan Anh Nguyễn',
      username: 'teacher1',
      email: 'teacher1@example.com',
    });
    expect(users.getUser).toHaveBeenCalledWith(PARTNER_ID);
  });

  it('người lạ không chung hội thoại nào thì nhận 404 và không tra bảng người dùng', async () => {
    const { service, users } = build((viewerId, targetId) => targetId !== STRANGER_ID);

    let error: unknown;
    try {
      await service.getPersonProfile(VIEWER_ID, STRANGER_ID);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect((error as { getResponse: () => unknown }).getResponse()).toMatchObject({
      code: 'messaging.person_profile_not_found',
    });
    expect(users.getUser).not.toHaveBeenCalled();
  });

  it('chính chủ xem hồ sơ của mình luôn được phép mà không cần cổng chung hội thoại', async () => {
    const { service, repo } = build(() => false);

    const profile = await service.getPersonProfile(VIEWER_ID, VIEWER_ID);

    expect(profile.userId).toBe(VIEWER_ID);
    expect(repo.sharesConversation).not.toHaveBeenCalled();
  });
});
