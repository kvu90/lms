/** Moodle capability permission constants (lib/accesslib.php). */
export const CAP_INHERIT = 0;
export const CAP_ALLOW = 1;
export const CAP_PREVENT = -1;
export const CAP_PROHIBIT = -1000;

export interface RoleOverridePoint {
  contextId: number;
  permission: number;
}

/**
 * Pure Moodle permission evaluation for ONE role (accesslib semantics):
 * walk from the leaf context up to the root; the nearest non-INHERIT override
 * wins — EXCEPT that a PROHIBIT at ANY ancestor is absolute and cannot be
 * removed by an override closer to the leaf.
 * `pointsLeafToRoot` must be ordered leaf → root.
 */
export function evaluateSingleRole(pointsLeafToRoot: RoleOverridePoint[]): number {
  let result = CAP_INHERIT;
  for (const point of pointsLeafToRoot) {
    if (point.permission === CAP_PROHIBIT) return CAP_PROHIBIT;
    if (result === CAP_INHERIT && point.permission !== CAP_INHERIT) {
      result = point.permission;
    }
  }
  return result;
}

/** Multi-role aggregation: allowed iff at least one role ALLOWs and no role PROHIBITs. */
export function aggregateRoleResults(roleResults: number[]): boolean {
  if (roleResults.some((r) => r === CAP_PROHIBIT)) return false;
  return roleResults.some((r) => r === CAP_ALLOW);
}
