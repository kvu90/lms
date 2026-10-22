import { describe, expect, it } from 'vitest';
import { aggregateRoleResults, CAP_ALLOW, CAP_INHERIT, CAP_PREVENT, CAP_PROHIBIT, evaluateSingleRole } from './permission';

/**
 * Pure truth-table for the Moodle capability algorithm.
 * Oracle: lib/tests/accesslib_test.php::test_permission_evaluation (MOODLE_503_STABLE)
 * plus the constants/semantics of lib/accesslib.php — leaf→root per role,
 * PROHIBIT absolute, multi-role aggregation.
 */
describe('PermissionEvaluator domain (Moodle accesslib semantics)', () => {
  const pts = (...permissions: number[]) => permissions.map((permission, i) => ({ contextId: i + 1, permission }));

  it('no overrides at all evaluates to INHERIT (deny)', () => {
    expect(evaluateSingleRole([])).toBe(CAP_INHERIT);
    expect(aggregateRoleResults([CAP_INHERIT])).toBe(false);
  });
  it('nearest override wins within a role: ALLOW at leaf beats PREVENT at parent', () => {
    expect(evaluateSingleRole(pts(CAP_ALLOW, CAP_PREVENT))).toBe(CAP_ALLOW);
  });
  it('PREVENT at leaf beats ALLOW at root within a role', () => {
    expect(evaluateSingleRole(pts(CAP_PREVENT, CAP_ALLOW))).toBe(CAP_PREVENT);
  });
  it('PROHIBIT at the root beats ALLOW at the leaf (absolute)', () => {
    expect(evaluateSingleRole(pts(CAP_ALLOW, CAP_INHERIT, CAP_PROHIBIT))).toBe(CAP_PROHIBIT);
  });
  it('PROHIBIT at the leaf is absolute too', () => {
    expect(evaluateSingleRole(pts(CAP_PROHIBIT, CAP_ALLOW))).toBe(CAP_PROHIBIT);
  });
  it('INHERIT points are skipped while walking up', () => {
    expect(evaluateSingleRole(pts(CAP_INHERIT, CAP_INHERIT, CAP_ALLOW))).toBe(CAP_ALLOW);
  });
  it('multi-role: one ALLOW and no PROHIBIT is allowed', () => {
    expect(aggregateRoleResults([CAP_PREVENT, CAP_ALLOW])).toBe(true);
    expect(aggregateRoleResults([CAP_INHERIT, CAP_ALLOW])).toBe(true);
  });
  it('multi-role: any PROHIBIT denies everything', () => {
    expect(aggregateRoleResults([CAP_ALLOW, CAP_PROHIBIT])).toBe(false);
  });
  it('multi-role: PREVENT + INHERIT only is denied', () => {
    expect(aggregateRoleResults([CAP_PREVENT, CAP_INHERIT])).toBe(false);
    expect(aggregateRoleResults([])).toBe(false);
  });
});
