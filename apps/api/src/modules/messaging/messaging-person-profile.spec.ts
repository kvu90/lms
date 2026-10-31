import { describe, expect, it, vi } from 'vitest';
import { MessagingContactsService } from './messaging-contacts.service';

/**
 * Endpoint hồ sơ người phục vụ panel chat 1–1 (issue #592):
 * trả định danh + tên hiển thị + tên đăng nhập + email từ dữ
 * kiện người dùng thật, chỉ trong cổng hẹp: chính chủ, hoặc chung
 * hội thoại 1–1 không bị chặn với đối tác, hoặc người xem có
 * capability xem định danh. Chung nhóm/lớp/khoá nhưng không chung
 * 1–1 và không có capability thì nhận 404 — cổng cũ "chung
 * conversation nhìn thấy được" lộ email qua đồng bộ lười nên đã
 * bị thu hẹp. Người lạ không chung gì, và đối tác của hội thoại
 * 1–1 đang chặn, đều nhận 404 như đối tác không tồn tại (không rò
 * sự tồn tại).
 */
describe('MessagingContactsService.getPersonProfile — cổng hồ sơ hẹp và dữ kiện thật', () => {
  const VIEWER_ID = 'viewer-1';
  const PARTNER_ID = 'partner-1';
  const STRANGER_ID = 'stranger-1';

  function build(sharesDirect: (viewerId: string, targetId: string) => boolean, canView = false) {
    const repo = {
      sharesDirectConversation: vi.fn(async (viewerId: string, targetId: string) => sharesDirect(viewerId, targetId)),
    };
    const users = {
      getUser: vi.fn(async (id: string) => ({
        id, username: 'teacher1', firstName: 'Lan Anh', lastName: 'Nguyễn', email: 'teacher1@example.com',
      })),
      canViewUserIdentity: vi.fn(async () => canView),
    };
    const service = new MessagingContactsService(repo as never, users as never, {} as never, {} as never);
    return { service, repo, users };
  }

  it('đối tác chung hội thoại 1–1 thì trả đủ bốn trường thật từ bảng người dùng', async () => {
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

  it('chung nhóm nhưng không chung 1–1 và không có capability thì nhận 404 và không tra bảng người dùng', async () => {
    const { service, users } = build(() => false, false);

    let error: unknown;
    try {
      await service.getPersonProfile(VIEWER_ID, PARTNER_ID);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect((error as { getResponse: () => unknown }).getResponse()).toMatchObject({
      code: 'messaging.person_profile_not_found',
    });
    expect(users.getUser).not.toHaveBeenCalled();
  });

  it('người xem có capability xem định danh thì được xem dù không chung 1–1', async () => {
    const { service } = build(() => false, true);

    const profile = await service.getPersonProfile(VIEWER_ID, PARTNER_ID);

    expect(profile.userId).toBe(PARTNER_ID);
    expect(profile.email).toBe('teacher1@example.com');
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

  it('chính chủ xem hồ sơ của mình luôn được phép mà không cần cổng chung hội thoại hay capability', async () => {
    const { service, repo, users } = build(() => false);

    const profile = await service.getPersonProfile(VIEWER_ID, VIEWER_ID);

    expect(profile.userId).toBe(VIEWER_ID);
    expect(repo.sharesDirectConversation).not.toHaveBeenCalled();
    expect(users.canViewUserIdentity).not.toHaveBeenCalled();
  });
});
