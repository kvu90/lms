import type { Course, CourseContent, EnrolInstance } from '@lms/contracts';
import { apiJson } from '#lib/api';
import type {
  ClassMarkersView,
  CoursePageData,
  MyCompletionView,
  MyEnrolmentView,
  MyPaymentView,
  MyProgressView,
} from '../types/course';

/**
 * Tầng gọi API thuần của trang khoá học thuộc feature courses: chỉ
 * chứa các hàm gọi HTTP và gói tải tổng hợp của trang, không phụ
 * thuộc React hay React Query. Tầng `queries/` của feature bọc các
 * hàm này thành queryOptions, hook và đột biến. Tách từ module dữ
 * liệu phẳng `src/lib/course-data.ts` khi tổ chức lại apps/web theo
 * mô hình features/ (issue #500).
 */

/** Tải một endpoint phụ một cách độc lập: lỗi thì trả null thay vì sập cả trang. */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Tải gói dữ liệu trang khoá học đúng nhịp thủ công trước đây: thông
 * tin khoá, instance, ghi danh của tôi tải độc lập (endpoint nào lỗi
 * cũng không chặn các endpoint còn lại); nội dung chỉ có khi người xem
 * thật sự truy cập được khoá, tiến độ hoàn thành chỉ tải khi đã có nội
 * dung (endpoint completion/me cũng qua cổng truy cập khoá phía server).
 *
 * @param courseId - Định danh khoá.
 * @returns Gói dữ liệu trang khoá học.
 */
export async function fetchCoursePage(courseId: string): Promise<CoursePageData> {
  const [course, instances, enrolment, content] = await Promise.all([
    probe<Course>(`/api/v1/courses/${courseId}`),
    probe<EnrolInstance[]>(`/api/v1/courses/${courseId}/enrol/instances`),
    probe<MyEnrolmentView>(`/api/v1/courses/${courseId}/enrolments/me`),
    probe<CourseContent>(`/api/v1/courses/${courseId}/content`),
  ]);
  let completion: MyCompletionView | null = null;
  let progress: MyProgressView | null = null;
  let classMarkers: ClassMarkersView | null = null;
  if (content) {
    [completion, progress, classMarkers] = await Promise.all([
      probe<MyCompletionView>(`/api/v1/courses/${courseId}/completion/me`),
      probe<MyProgressView>(`/api/v1/courses/${courseId}/progress/me`),
      probe<ClassMarkersView>(`/api/v1/courses/${courseId}/progress/class-markers`),
    ]);
  }
  return {
    course,
    instances: instances ?? [],
    enrolment,
    content,
    completion,
    progress,
    classMarkers,
  };
}

/**
 * Đọc thanh toán của chính người dùng (GET /payments/me); lỗi → null
 * (tầng queries hạ cấp thành danh sách rỗng).
 *
 * @returns Danh sách thanh toán hoặc null khi lỗi tải.
 */
export function fetchMyPayments() {
  return probe<MyPaymentView[]>('/api/v1/payments/me');
}

/**
 * Tự ghi danh qua instance self (POST /courses/:id/enrol/instances/:instanceId/self-enrol).
 *
 * @param courseId - Định danh khoá.
 * @param instanceId - Định danh instance ghi danh.
 * @returns Đáp ứng của API.
 */
export function selfEnrolCourse(courseId: string | undefined, instanceId: string) {
  return apiJson(`/api/v1/courses/${courseId}/enrol/instances/${instanceId}/self-enrol`, {
    method: 'POST',
  });
}

/**
 * Tạo payment cho instance fee (POST /payments/fee/:instanceId).
 *
 * @param instanceId - Định danh instance ghi danh.
 * @returns Đáp ứng của API.
 */
export function createFeePayment(instanceId: string) {
  return apiJson(`/api/v1/payments/fee/${instanceId}`, { method: 'POST' });
}

/**
 * Đánh dấu hoàn thành thủ công cho một module
 * (POST /courses/:id/modules/:cmId/completion/manual).
 *
 * @param courseId - Định danh khoá.
 * @param vars - Module, người dùng và trạng thái hoàn thành muốn đặt.
 * @returns Đáp ứng của API.
 */
export function setManualCompletion(
  courseId: string | undefined,
  vars: { cmId: string; userId: string; complete: boolean },
) {
  return apiJson(`/api/v1/courses/${courseId}/modules/${vars.cmId}/completion/manual`, {
    method: 'POST',
    body: JSON.stringify({ userId: vars.userId, complete: vars.complete }),
  });
}
