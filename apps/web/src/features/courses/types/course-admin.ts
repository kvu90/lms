/**
 * Kiểu dữ liệu của trang quản trị khoá học thuộc feature courses.
 * Tách từ module dữ liệu phẳng `src/lib/course-admin-data.ts` khi
 * tổ chức lại apps/web theo mô hình features/ (issue #500): kiểu
 * nằm ở tầng types/, lời gọi API thuần ở tầng api/, tuỳ chọn truy
 * vấn và đột biến ở tầng queries/.
 */

/** Một dòng thành viên (nhóm khoá hoặc cohort): userId + thời điểm thêm. */
export interface MemberRow {
  userId: string;
  timeAdded: string;
}

/** Hội thoại chat toàn lớp của khoá (GET ensure phía messaging). */
export interface CourseConversationView {
  id: string;
  enabled: boolean;
}
