import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Course, CourseContent, EnrolInstance } from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

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
 */
async function fetchCoursePage(courseId: string): Promise<CoursePageData> {
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
 * Tầng dữ liệu trang khoá học (F-01 đợt 1, rà soát #133): options dùng
 * chung cho hook của trang và clientLoader của route module.
 */
export function coursePageQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.coursePage(courseId),
    queryFn: () => fetchCoursePage(courseId),
  });
}

/** Đọc gói dữ liệu trang khoá học; `courseId` trống thì query tắt. */
export function useCoursePage(courseId: string | undefined) {
  return useQuery({
    ...coursePageQueryOptions(courseId ?? ''),
    enabled: !!courseId,
  });
}

/** Options cho thanh toán của chính người dùng (query riêng để payFee chỉ làm mới đúng phần này). */
export function myPaymentsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.myPayments,
    queryFn: () => probe<MyPaymentView[]>('/api/v1/payments/me'),
  });
}

/** Đọc thanh toán của chính người dùng; lỗi → danh sách rỗng. */
export function useMyPayments() {
  const query = useQuery(myPaymentsQueryOptions());
  return { ...query, payments: query.data ?? [] };
}

/** Tự ghi danh qua instance self: xong thì invalidate gói trang để nạp lại trạng thái/nội dung. */
export function useSelfEnrol(courseId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) =>
      apiJson(`/api/v1/courses/${courseId}/enrol/instances/${instanceId}/self-enrol`, { method: 'POST' }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.coursePage(courseId ?? '') }),
  });
}

/**
 * Tạo payment cho instance fee. Tuyệt đối không tự ghi danh ở đây: ghi
 * danh chỉ kích hoạt sau khi webhook xác nhận payment thành công. Thành
 * công thì invalidate query thanh toán của tôi để hiển thị trạng thái thật.
 */
export function usePayFee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => apiJson(`/api/v1/payments/fee/${instanceId}`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.myPayments }),
  });
}

/** Đánh dấu hoàn thành thủ công cho một module: xong thì invalidate gói trang (completion nằm trong gói). */
export function useToggleManualCompletion(courseId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { cmId: string; userId: string; complete: boolean }) =>
      apiJson(`/api/v1/courses/${courseId}/modules/${vars.cmId}/completion/manual`, {
        method: 'POST',
        body: JSON.stringify({ userId: vars.userId, complete: vars.complete }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.coursePage(courseId ?? '') }),
  });
}
