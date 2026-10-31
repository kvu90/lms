import { describe, expect, it, vi } from 'vitest';
import { MessagingMembershipSyncService } from './messaging-membership-sync.service';

/**
 * Đồng bộ lười thành viên conversation gắn cấu trúc — ngoại lệ
 * giữ lại quản trị hệ thống (issue #592): quản trị hệ thống là
 * thành viên của conversation gắn LỚP/KHOÁ thì không bị gỡ dù
 * không nằm trong tập đích roster/staff, để hàng hội thoại của
 * họ ở lại danh sách và mở được; thành viên thường đã rời cấu
 * trúc vẫn bị gỡ như cũ, và conversation gắn group không thuộc
 * ngoại lệ này (phạm vi issue #592 chỉ nói lớp/khoá).
 */
describe('MessagingMembershipSyncService.syncLinkedConversationMembers — giữ lại quản trị hệ thống ở conversation lớp/khoá', () => {
  const ADMIN_ID = 'admin-1';
  const TEACHER_ID = 'teacher-1';
  const STUDENT_ID = 'student-1';

  function build(isSiteAdmin: (id: string) => boolean) {
    const removed: string[] = [];
    const evicted: string[] = [];
    const repo = {
      listMembers: vi.fn(async () => [ADMIN_ID, TEACHER_ID]),
      addMember: vi.fn(async () => {}),
      removeMember: vi.fn(async (conversationId: string, userId: string) => {
        removed.push(userId);
      }),
    };
    const realtime = {
      evictUserFromConversation: vi.fn(async (userId: string) => {
        evicted.push(userId);
      }),
    };
    const evaluator = { isSiteAdmin: vi.fn(async (id: string) => isSiteAdmin(id)) };
    const service = new MessagingMembershipSyncService(repo as never, realtime as never, evaluator as never);
    return { service, repo, removed, evicted, evaluator };
  }

  const classConversation = {
    id: 'conv-class', type: 2, component: 'core_class', itemType: 'class', itemId: 'class-1',
  };
  const courseConversation = {
    id: 'conv-course', type: 2, component: 'core_course', itemType: 'course', itemId: 'course-1',
  };
  const groupConversation = {
    id: 'conv-group', type: 2, component: 'core_group', itemType: 'groups', itemId: 'group-1',
  };

  it('quản trị hệ thống không nằm trong tập đích lớp vẫn giữ membership và có mặt trong danh sách trả về', async () => {
    const { service, repo, removed } = build((id) => id === ADMIN_ID);

    const members = await service.syncLinkedConversationMembers(classConversation as never, [TEACHER_ID]);

    expect(removed).not.toContain(ADMIN_ID);
    expect(repo.removeMember).not.toHaveBeenCalledWith('conv-class', ADMIN_ID);
    expect(members).toContain(ADMIN_ID);
    expect(members).toContain(TEACHER_ID);
  });

  it('quản trị hệ thống không nằm trong tập đích khoá vẫn giữ membership', async () => {
    const { service, removed } = build((id) => id === ADMIN_ID);

    const members = await service.syncLinkedConversationMembers(courseConversation as never, [TEACHER_ID]);

    expect(removed).not.toContain(ADMIN_ID);
    expect(members).toContain(ADMIN_ID);
  });

  it('thành viên thường đã rời cấu trúc lớp vẫn bị gỡ khỏi conversation và bị đẩy khỏi room', async () => {
    const { service, removed, evicted } = build(() => false);

    const members = await service.syncLinkedConversationMembers(classConversation as never, [STUDENT_ID]);

    expect(removed).toContain(ADMIN_ID);
    expect(removed).toContain(TEACHER_ID);
    expect(evicted).toContain(ADMIN_ID);
    expect(evicted).toContain(TEACHER_ID);
    expect(members).toEqual([STUDENT_ID]);
  });

  it('quản trị hệ thống ở conversation gắn group KHÔNG thuộc ngoại lệ — vẫn bị gỡ như thành viên thường', async () => {
    const { service, removed } = build((id) => id === ADMIN_ID);

    const members = await service.syncLinkedConversationMembers(groupConversation as never, [TEACHER_ID]);

    expect(removed).toContain(ADMIN_ID);
    expect(members).not.toContain(ADMIN_ID);
  });
});
