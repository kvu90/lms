import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  addMatrixCell,
  createMatrix,
  deleteMatrixCell,
  fetchCurriculaBySubject,
  fetchCurriculumSubjects,
  fetchCurriculumTree,
  fetchMatrixAvailability,
  fetchMatrixBanks,
  fetchMatrixDetail,
  fetchMatrixSpecification,
  updateMatrix,
} from '../api/matrix';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu màn ma trận (tạo/sửa) trong ngân hàng ma trận (F-01
 * đợt 1, rà soát #133): options dùng chung cho hook của trang và
 * clientLoader của route module (prefetch cùng khoá).
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá truy vấn
 * riêng của matrices nằm ở `keys.ts` cùng tầng này, riêng các
 * khoá `curriculumSubjects`, `curriculumTree`, `bankMatrices` là
 * khoá dùng chung ở factory tập trung.
 *
 * Phần bản đặc tả (SPEC-1, issue #233): đặc tả là bảng SUY RA ở phía
 * API từ các ô của ma trận — module này chỉ ĐỌC view model đặc tả
 * (`useMatrixSpecification`, tải lười khi giáo viên mở mục đặc tả ở
 * trang sửa) và XUẤT file (`downloadMatrixSpecification` ở tầng
 * api); không có đường ghi/sửa đặc tả nào ở phía client.
 */

export function matrixBanksQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.questionBanksByKind('matrix'),
    queryFn: () => fetchMatrixBanks(),
  });
}

/** Danh sách bank ma trận của người dùng; chỉ tải khi `enabled` (đã rõ quyền). */
export function useMatrixBanks(enabled: boolean) {
  return useQuery({ ...matrixBanksQueryOptions(), enabled });
}

/**
 * Tuỳ chọn truy vấn danh sách môn học chương trình. Kèm `forCourseId`
 * thì API mở nhánh `course:update` tại chính khoá đó cho giáo viên
 * không có `curriculum:view` tại context hệ thống (điểm nghẽn D-3 của
 * issue #233: giáo viên chỉ có quyền tại khoá mình dạy). Khoá truy vấn
 * mang theo `forCourseId` để kết quả theo khoá không lẫn với kết quả
 * không kèm khoá; vắng khoá thì giữ nguyên khoá cũ để các lời gọi
 * không kèm khoá (prefetch của route, trang danh sách câu hỏi) dùng
 * chung cache như trước.
 */
export function curriculumSubjectsQueryOptions(forCourseId?: string) {
  return queryOptions({
    queryKey: forCourseId ? [...sharedQueryKeys.curriculumSubjects, forCourseId] : sharedQueryKeys.curriculumSubjects,
    queryFn: () => fetchCurriculumSubjects(forCourseId),
  });
}

/** Danh sách môn học chương trình; chỉ tải khi `enabled`. Lỗi tải nổi lên query để trang hiện trạng thái lỗi thay vì danh sách rỗng im lặng. */
export function useCurriculumSubjects(enabled: boolean, forCourseId?: string) {
  return useQuery({ ...curriculumSubjectsQueryOptions(forCourseId), enabled });
}

/** Tuỳ chọn truy vấn các chương trình của một môn, kèm `forCourseId` như danh sách môn (cùng nhánh quyền theo khoá). */
export function curriculaBySubjectQueryOptions(subjectId: string, forCourseId?: string) {
  return queryOptions({
    queryKey: forCourseId ? [...queryKeys.curriculaBySubject(subjectId), forCourseId] : queryKeys.curriculaBySubject(subjectId),
    queryFn: () => fetchCurriculaBySubject(subjectId, forCourseId),
  });
}

/** Các chương trình của môn đang chọn; chưa chọn môn thì query tắt. */
export function useCurriculaBySubject(subjectId: string, forCourseId?: string) {
  return useQuery({
    ...curriculaBySubjectQueryOptions(subjectId, forCourseId),
    enabled: !!subjectId,
  });
}

export function matrixDetailQueryOptions(matrixId: string) {
  return queryOptions({
    queryKey: queryKeys.matrixDetail(matrixId),
    queryFn: () => fetchMatrixDetail(matrixId),
  });
}

/** Chi tiết ma trận; chỉ tải khi `enabled` và có `matrixId`. */
export function useMatrixDetail(matrixId: string | undefined, enabled: boolean) {
  return useQuery({
    ...matrixDetailQueryOptions(matrixId ?? ''),
    enabled: enabled && !!matrixId,
  });
}

export function curriculumTreeQueryOptions(curriculumId: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.curriculumTree(curriculumId),
    queryFn: async () => (await fetchCurriculumTree(curriculumId)) ?? [],
  });
}

/** Cây chương trình của ma trận đang sửa (để lấy danh sách ĐVK cho bộ chọn ô); lỗi tải → cây rỗng như trước. */
export function useCurriculumTree(curriculumId: string | undefined, enabled: boolean) {
  return useQuery({
    ...curriculumTreeQueryOptions(curriculumId ?? ''),
    enabled: enabled && !!curriculumId,
  });
}

export function matrixAvailabilityQueryOptions(matrixId: string) {
  return queryOptions({
    queryKey: queryKeys.matrixAvailability(matrixId),
    queryFn: () => fetchMatrixAvailability(matrixId),
  });
}

/** Khả dụng kho câu theo ô; lỗi tải → null như trước. */
export function useMatrixAvailability(matrixId: string | undefined, enabled: boolean) {
  return useQuery({
    ...matrixAvailabilityQueryOptions(matrixId ?? ''),
    enabled: enabled && !!matrixId,
  });
}

/**
 * Options truy vấn bản đặc tả của một ma trận — dùng chung cho hook
 * của trang sửa ma trận (clientLoader không prefetch khoá này vì đặc
 * tả chỉ tải lười khi giáo viên mở mục đặc tả).
 *
 * @param matrixId - Id của ma trận cần lấy bản đặc tả.
 * @returns Query options với khoá `queryKeys.matrixSpecification` và
 * hàm tải gọi `GET /exam-matrices/:id/specification`.
 */
export function matrixSpecificationQueryOptions(matrixId: string) {
  return queryOptions({
    queryKey: queryKeys.matrixSpecification(matrixId),
    queryFn: () => fetchMatrixSpecification(matrixId),
  });
}

/**
 * Hook đọc bản đặc tả SUY RA của ma trận đang sửa.
 *
 * Flow: trang bật `enabled` khi giáo viên bấm "Xem bản đặc tả" →
 * TanStack Query mới phát request (trước đó không tốn lượt tải) →
 * kết quả cache theo ma trận; các mutation đổi ô invalidate khoá
 * này nên đặc tả đang mở tự nạp lại sau khi thêm/xoá ô.
 *
 * @param matrixId - Id của ma trận; undefined khi trang chưa nạp xong.
 * @param enabled - Cờ bật/tắt tải từ trang (quyền đã rõ + đã mở mục).
 * @returns Kết quả truy vấn TanStack chứa view model đặc tả.
 */
export function useMatrixSpecification(matrixId: string | undefined, enabled: boolean) {
  return useQuery({
    ...matrixSpecificationQueryOptions(matrixId ?? ''),
    enabled: enabled && !!matrixId,
  });
}

/**
 * Tạo ma trận mới trong bank ma trận cá nhân (màn tạo ma trận): xong
 * thì invalidate danh sách ma trận của bank đó — trang đích sau khi
 * điều hướng về (/matrices) phải thấy ngay ma trận vừa tạo, không hiện
 * danh sách cũ trong cache.
 */
export function useCreateMatrix() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      subjectId: string;
      curriculumId: string;
      bankId: string;
      levelSet: 'three' | 'four';
      totalScore: number;
      isTemplate: boolean;
      status: string;
    }) => createMatrix(body),
    onSuccess: (_data, body) => {
      void queryClient.invalidateQueries({ queryKey: sharedQueryKeys.bankMatrices(body.bankId) });
    },
  });
}

/**
 * Lưu thông tin chung của ma trận: xong thì invalidate chi tiết để trang nạp bản mới (thay loadMatrix thủ công).
 * `levelSet` là trường tuỳ chọn do checkbox Vận dụng cao ở màn sửa điều khiển (I-3, issue #233): tick = 'four',
 * không tick = 'three'. Server tự chặn hạ xuống 'three' khi còn ô Vận dụng cao (400 `quiz.matrix_level_in_use`) nên
 * web không cần tự kiểm tập ô trước khi gửi.
 */
export function useUpdateMatrix() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      matrixId: string;
      body: { name: string; status: string; isTemplate: boolean; totalScore: number; levelSet?: 'three' | 'four' };
    }) => updateMatrix(vars.matrixId, vars.body),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixDetail(vars.matrixId) });
      // Tên/tổng điểm của ma trận cũng nằm trong view model đặc tả —
      // lưu thông tin chung xong thì đặc tả đang mở phải nạp lại theo.
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixSpecification(vars.matrixId) });
    },
  });
}

/** Thêm một ô vào ma trận: xong thì invalidate chi tiết như trên. */
export function useAddMatrixCell() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      matrixId: string;
      body: {
        curriculumNodeId: string;
        cognitiveLevel: string;
        qtype: string;
        questionCount: number;
        cellScore: number;
      };
    }) => addMatrixCell(vars.matrixId, vars.body),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixDetail(vars.matrixId) });
      // Đặc tả là bảng SUY RA từ các ô: ô đổi thì đặc tả phải nạp lại.
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixSpecification(vars.matrixId) });
    },
  });
}

/** Xoá một ô khỏi ma trận: xong thì invalidate chi tiết như trên. */
export function useDeleteMatrixCell() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { matrixId: string; cellId: string }) =>
      deleteMatrixCell(vars.matrixId, vars.cellId),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixDetail(vars.matrixId) });
      // Như thêm ô: đặc tả suy ra từ tập ô nên xoá ô cũng phải nạp lại.
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixSpecification(vars.matrixId) });
    },
  });
}
