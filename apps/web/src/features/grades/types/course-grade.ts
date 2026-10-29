/**
 * Kiểu dữ liệu riêng của trang bảng điểm thuộc feature grades.
 * Tách từ module dữ liệu phẳng `src/lib/course-grade-data.ts` khi
 * tổ chức lại apps/web theo mô hình features/ (issue #500): kiểu
 * nằm ở tầng types/, lời gọi API thuần ở tầng api/, tuỳ chọn truy
 * vấn và đột biến ở tầng queries/. Kiểu gói điểm dùng chung
 * `CourseGradeData` đi cùng fetcher dùng chung ở
 * `src/hooks/use-courses-grade-data.ts`.
 */

/**
 * Một dòng lịch sử thay đổi điểm như API trả về (bảng
 * `grade_grades_history` phía grades service): `action` 1 = tạo mới,
 * 2 = cập nhật, 3 = xoá theo quy ước của Moodle.
 */
export interface GradeHistoryView {
  id: string;
  action: number;
  itemId: string;
  userId: string;
  rawGrade: number | null;
  finalGrade: number | null;
  source: string | null;
  updatedAt: string;
  loggedUser: string | null;
}
