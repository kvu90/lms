import type { TenantMembership } from '@lms/contracts';

/**
 * Kiểu dữ liệu của bề mặt quản trị tenant thuộc feature admin.
 * Tách từ module dữ liệu phẳng `src/lib/tenant-admin-data.ts` khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): kiểu nằm ở
 * tầng types/, lời gọi API thuần ở tầng api/, tuỳ chọn truy vấn và
 * đột biến ở tầng queries/.
 */

/** Phần hồ sơ người dùng mà bề mặt tenant được phép tiêu thụ để ghép với membership. */
export interface TenantUserSummary {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email?: string;
  suspended: boolean;
  deleted: boolean;
}

/** Trạng thái membership có thể đặt qua API tenant. */
export type TenantMemberStatus = TenantMembership['status'];
