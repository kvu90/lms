import type { ClassStaffRole } from '@lms/contracts';

/**
 * Kiểu dữ liệu của feature classes: tái xuất các kiểu hợp đồng lớp
 * học từ `@lms/contracts` (nơi dùng của feature nhập kiểu từ đây
 * thay vì thẳng từ contracts để giữ một điểm neo kiểu cho miền
 * lớp), hằng thứ tự vai lớp và hình dạng payment gói lớp ở bề mặt
 * web. Tách từ module phẳng `src/lib/classes.ts` khi tổ chức lại
 * apps/web theo mô hình features/ (issue #500): kiểu và hằng nằm ở
 * tầng types/, toàn bộ hàm gọi API nằm ở tầng api/.
 */

export type {
  AddRosterStudentResult,
  ClassJoinPreview,
  ClassJoinRequest,
  ClassListItem,
  ClassOverview,
  ClassPublicView,
  ClassRosterImportReport,
  ClassRosterMember,
  ClassStaffRole,
  ClassStaffView,
  ClassSuspendedMember,
  ClassView,
  JoinClassResult,
  RosterStudentIdentity,
} from '@lms/contracts';

/** Ba vai lớp theo thứ tự hiển thị ở bề mặt phân quyền (giao bài / chấm bài / quản roster). */
export const CLASS_STAFF_ROLE_ORDER: ClassStaffRole[] = ['classassigner', 'classgrader', 'classrostermanager'];
/**
 * Hình dạng payment gói lớp ở bề mặt web (PaymentView của API): trang
 * mua gói cần trạng thái, mã thanh toán nhúng trong nội dung chuyển
 * khoản và chuỗi payload VietQR để tự render mã QR (cùng khuôn trang
 * khoá học với payment `enrol_fee`).
 */
export interface ClassFeePaymentView {
  id: string;
  amount: number;
  currency: string;
  status: string;
  component: string;
  itemId: string | null;
  paymentCode: string | null;
  vietqrPayload: string | null;
}
