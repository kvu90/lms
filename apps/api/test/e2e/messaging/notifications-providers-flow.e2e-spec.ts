import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, http } from '../../support/identity-access-helpers';

/**
 * Bề mặt registry provider ở phía API: trang cài đặt
 * (GET /messages/preferences) chỉ liệt kê các provider đã nối dây
 * thật, mỗi provider mang phân loại 3 nhóm — không công tắc giả.
 *
 * Các ca kiểm chứng đường phát sự kiện → thông báo của mười loại sự
 * kiện nghiệp vụ (điểm mới, hoàn thành khoá, sắp hết hạn ghi danh,
 * tin nhắn mới, nhắc hạn, vòng đời bài tập/đề) từng nằm ở file này
 * đã chuyển sang tầng integration của worker cùng consumer thông
 * báo sự kiện (issue con #520 của #491):
 * `apps/worker/test/integration/notifications/notification-events-delivery.int-spec.ts`
 * giữ nguyên các khẳng định nghiệp vụ (nội dung không chứa điểm số,
 * gộp theo ngữ cảnh, số lượng chờ chấm cập nhật tại chỗ) trên đường
 * relay → hàng đợi → consumer ở worker.
 */
describe('Provider thông báo đã nối dây (N1, issue #49)', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  it('tuỳ chọn: mọi provider liệt kê đều đã nối dây và mang phân loại 3 nhóm — không còn toggle giả', async () => {
    // NB-7: danh sách tuỳ chọn theo loại là bề mặt của nhân sự — học
    // sinh chỉ nhận phần tối thiểu (spec riêng notifications-admin-policy).
    // Audience theo vai (issue #288): danh sách ĐẦY ĐỦ cả registry chỉ
    // còn ở bề mặt của site admin (context admin phủ mọi phía người
    // nhận); nhân sự thuần chỉ thấy phía của mình — phần lọc theo vai
    // có spec riêng (notifications-preferences-v2). Ca này kiểm tính
    // "không công tắc giả" trên toàn registry nên đọc bằng admin.
    const res = await http(app).get('/api/v1/messages/preferences').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    // Mô hình v2 (NB-2, issue #174): một dòng cho mỗi provider kèm
    // nhãn/mô tả từ registry — không còn trường channel/state.
    const rows = res.body as { provider: string; group: string; label: { vi: string; en: string }; description: { vi: string; en: string } }[];
    for (const row of rows) {
      expect(row.label.vi.length).toBeGreaterThan(0);
      expect(row.label.en.length).toBeGreaterThan(0);
      expect(row.description.vi.length).toBeGreaterThan(0);
      expect(row).not.toHaveProperty('state');
      expect(row).not.toHaveProperty('channel');
    }
    const groups = new Map<string, string>();
    for (const row of rows) groups.set(row.provider, row.group);
    // Tập provider hiện tại = đúng các provider đã nối dây (N1). Thêm
    // provider mới mà chưa nối dây sẽ làm test này đỏ — đó là chủ đích:
    // không để công tắc giả quay lại trang cài đặt.
    expect([...groups.keys()].sort()).toEqual([
      'activity_due_soon', 'admin_announcement', 'assignment_assigned', 'assignment_returned', 'assignment_submitted', 'badge_awarded',
      'calendar_reminder', 'competency_review_requested', 'contact_request',
      'conversation_reported', 'course_completed', 'enrol_expiry_warning', 'enrol_welcome',
      'grade_updated', 'guardian_digest', 'guardian_overdue_alert', 'message_new', 'quiz_attempt_finished',
      'quiz_available', 'report_scheduled',
    ]);
    // NB-2: admin_announcement là provider thông báo quản trị/an toàn
    // (loại bắt buộc thứ hai của P2), phát qua POST /notifications/send.
    expect(groups.get('admin_announcement')).toBe('system');
    expect(groups.get('grade_updated')).toBe('learning');
    expect(groups.get('course_completed')).toBe('learning');
    expect(groups.get('enrol_expiry_warning')).toBe('learning');
    expect(groups.get('enrol_welcome')).toBe('learning');
    expect(groups.get('activity_due_soon')).toBe('learning');
    // NB-1 (issue #174): năm provider vòng đời Bài tập/Quiz đã nối dây
    // qua consumer thông báo sự kiện — không phải công tắc giả.
    expect(groups.get('assignment_assigned')).toBe('learning');
    expect(groups.get('assignment_submitted')).toBe('learning');
    expect(groups.get('assignment_returned')).toBe('learning');
    expect(groups.get('quiz_available')).toBe('learning');
    expect(groups.get('quiz_attempt_finished')).toBe('learning');
    // PH-2 (issue #159): hai provider digest phụ huynh đã nối dây qua
    // nửa tiêu thụ phía worker (GuardianDigestHandlerService) — không
    // phải công tắc giả.
    expect(groups.get('guardian_digest')).toBe('learning');
    expect(groups.get('guardian_overdue_alert')).toBe('learning');
    expect(groups.get('message_new')).toBe('people');
    expect(groups.get('contact_request')).toBe('people');
    expect(groups.get('calendar_reminder')).toBe('system');
    expect(groups.get('report_scheduled')).toBe('system');
  });
});
