import type { Course, CourseContent, EnrolInstance } from '@lms/contracts';

/**
 * Kiểu dữ liệu của trang khoá học thuộc feature courses. Tách từ
 * module dữ liệu phẳng `src/lib/course-data.ts` khi tổ chức lại
 * apps/web theo mô hình features/ (issue #500): kiểu nằm ở tầng
 * types/, lời gọi API thuần ở tầng api/, tuỳ chọn truy vấn và hook
 * ở tầng queries/.
 */

/** Ghi danh của chính người dùng trong khoá (GET /courses/:id/enrolments/me). */
export interface MyEnrolmentView {
  courseId: string;
  userId: string;
  enrolled: boolean;
  active: boolean;
}

/**
 * Thanh toán của chính người dùng (GET /payments/me — PaymentRow ở tầng
 * API). Trang chỉ cần các trường để lọc theo `itemId` (chính là enrol
 * instance id của payment phí ghi danh) và hiển thị trạng thái thật.
 */
export interface MyPaymentView {
  id: string;
  userId: string;
  amount: number;
  currency: string;
  status: string;
  component: string;
  itemId: string | null;
}

/** Một dòng tiến độ hoạt động trong GET /courses/:id/completion/me. */
export interface CompletionActivityView {
  cmId: string;
  state: number;
  viewed: boolean;
}

/**
 * Shape thật của GET /courses/:id/completion/me (completion.controller):
 * `{ activities, course }` — activities là trạng thái từng cm của chính
 * người xem, course là bản ghi hoàn thành khoá (mang userId của người xem,
 * dùng làm userId khi đánh dấu thủ công lúc chưa có enrolments/me).
 */
export interface MyCompletionView {
  activities: CompletionActivityView[];
  course: { id: string; userId: string; course: string; status: string; timeCompleted: string | null };
}

/** Tiến độ học của tôi trong khoá (GET /courses/:id/progress/me — K2). */
export interface MyProgressView {
  percent: number | null;
  completed: number;
  total: number;
  sections: {
    sectionId: string; percent: number | null; completed: number; total: number;
    items: { cmId: string; completion: number; done: boolean }[];
  }[];
  resume: { cmId: string; reason: string } | null;
}

/** Mốc "lớp đã học tới đây" theo từng lớp (GET /courses/:id/progress/class-markers — K2). */
export interface ClassMarkersView {
  markers: { groupId: string | null; groupName: string; markerCmId: string | null }[];
}

/** Gói dữ liệu trang khoá học (trừ thanh toán của tôi — query riêng). */
export interface CoursePageData {
  course: Course | null;
  instances: EnrolInstance[];
  enrolment: MyEnrolmentView | null;
  content: CourseContent | null;
  completion: MyCompletionView | null;
  progress: MyProgressView | null;
  classMarkers: ClassMarkersView | null;
}
