/** Các hằng số quyền capability của Moodle (lib/accesslib.php). */
export const CAP_INHERIT = 0;
export const CAP_ALLOW = 1;
export const CAP_PREVENT = -1;
export const CAP_PROHIBIT = -1000;

export interface RoleOverridePoint {
  contextId: string;
  permission: number;
}

/**
 * Đánh giá quyền thuần kiểu Moodle cho MỘT role (ngữ nghĩa accesslib):
 * đi từ context lá lên tới gốc; override gần nhất mà không phải INHERIT sẽ
 * thắng — NGOẠI TRỪ một PROHIBIT ở BẤT KỲ tổ tiên nào là tuyệt đối và không thể bị
 * gỡ bỏ bởi một override gần lá hơn.
 * `pointsLeafToRoot` phải được sắp theo thứ tự lá → gốc.
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

/** Tổng hợp nhiều role: được phép khi và chỉ khi có ít nhất một role ALLOW và không role nào PROHIBIT. */
export function aggregateRoleResults(roleResults: number[]): boolean {
  if (roleResults.some((r) => r === CAP_PROHIBIT)) return false;
  return roleResults.some((r) => r === CAP_ALLOW);
}
