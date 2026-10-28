/**
 * Route module mỏng cho trang xem chương trình GDPT của giáo viên
 * (đường dẫn `/curriculum`, issue #233).
 *
 * Vai trò: file trang `pages/teacher-curriculum.tsx` chỉ xuất
 * component dưới tên riêng `TeacherCurriculumPage`, không có export
 * mặc định — mà framework React Router chỉ lấy component của route
 * từ export mặc định (hoặc export tên `Component`) của route module.
 * Vì vậy route trỏ thẳng vào file trang đã render trống hoàn toàn
 * trên trình duyệt thật: tiêu đề vẫn hiện vì `meta()` chạy độc lập
 * với component, khung shell vẫn hiện, nhưng outlet không gắn
 * component nào nên vùng nội dung trống và không có thông báo lỗi;
 * lỗi này không lộ qua spec vì spec gắn component trực tiếp, không
 * qua router. Wrapper này cấp export mặc định cho route, đồng thời
 * chuyển tiếp nguyên vẹn `ErrorBoundary` và `meta()` của trang để
 * tiêu đề và biên lỗi không đổi.
 */
export {
  TeacherCurriculumPage as default,
  ErrorBoundary,
  meta,
} from '../pages/teacher-curriculum';
