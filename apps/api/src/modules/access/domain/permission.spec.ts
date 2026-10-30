import { describe, expect, it } from 'vitest';
import { aggregateRoleResults, CAP_ALLOW, CAP_INHERIT, CAP_PREVENT, CAP_PROHIBIT, evaluateSingleRole } from './permission';

/**
 * Bảng chân trị thuần cho thuật toán capability của Moodle.
 * Oracle: lib/tests/accesslib_test.php::test_permission_evaluation (MOODLE_503_STABLE)
 * cùng các hằng số/ngữ nghĩa của lib/accesslib.php — lá→gốc theo từng role,
 * PROHIBIT là tuyệt đối, tổng hợp trên nhiều role.
 */
describe('Miền PermissionEvaluator (ngữ nghĩa accesslib của Moodle)', () => {
  const pts = (...permissions: number[]) => permissions.map((permission, i) => ({ contextId: `ctx-${i + 1}`, permission }));

  it('không có override nào thì đánh giá thành INHERIT (từ chối)', () => {
    expect(evaluateSingleRole([])).toBe(CAP_INHERIT);
    expect(aggregateRoleResults([CAP_INHERIT])).toBe(false);
  });
  it('override gần nhất thắng trong một vai trò: ALLOW ở lá thắng PREVENT ở cha', () => {
    expect(evaluateSingleRole(pts(CAP_ALLOW, CAP_PREVENT))).toBe(CAP_ALLOW);
  });
  it('PREVENT ở lá thắng ALLOW ở gốc trong một vai trò', () => {
    expect(evaluateSingleRole(pts(CAP_PREVENT, CAP_ALLOW))).toBe(CAP_PREVENT);
  });
  it('PROHIBIT ở gốc thắng ALLOW ở lá (tuyệt đối)', () => {
    expect(evaluateSingleRole(pts(CAP_ALLOW, CAP_INHERIT, CAP_PROHIBIT))).toBe(CAP_PROHIBIT);
  });
  it('PROHIBIT ở lá cũng tuyệt đối', () => {
    expect(evaluateSingleRole(pts(CAP_PROHIBIT, CAP_ALLOW))).toBe(CAP_PROHIBIT);
  });
  it('các điểm INHERIT bị bỏ qua khi đi lên', () => {
    expect(evaluateSingleRole(pts(CAP_INHERIT, CAP_INHERIT, CAP_ALLOW))).toBe(CAP_ALLOW);
  });
  it('đa vai trò: một ALLOW và không có PROHIBIT thì được phép', () => {
    expect(aggregateRoleResults([CAP_PREVENT, CAP_ALLOW])).toBe(true);
    expect(aggregateRoleResults([CAP_INHERIT, CAP_ALLOW])).toBe(true);
  });
  it('đa vai trò: bất kỳ PROHIBIT nào cũng từ chối tất cả', () => {
    expect(aggregateRoleResults([CAP_ALLOW, CAP_PROHIBIT])).toBe(false);
  });
  it('đa vai trò: chỉ có PREVENT + INHERIT thì bị từ chối', () => {
    expect(aggregateRoleResults([CAP_PREVENT, CAP_INHERIT])).toBe(false);
    expect(aggregateRoleResults([])).toBe(false);
  });
});
