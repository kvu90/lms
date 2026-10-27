import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiJson } from './api';
import { queryKeys } from './query-keys';
import type { PlanDetail, PlanView } from '../components/learning-plan/types';

/**
 * Tầng dữ liệu TanStack Query cho phần NGƯỜI HỌC của trang kế hoạch
 * học tập (F-01 của rà soát #133): danh sách kế hoạch của chính người
 * dùng và chi tiết một kế hoạch, thay cho vòng fetch thủ công bằng
 * `useEffect` + `apiJson` trước đây. Khu quản trị competency
 * (`components/learning-plan/competency-admin.tsx`) là bề mặt riêng,
 * không thuộc module này.
 *
 * Hai hành vi giữ nguyên từ bản thủ công:
 *   - Chi tiết kế hoạch chỉ tải khi người dùng bấm xem một kế hoạch;
 *     trong lúc tải chi tiết của kế hoạch mới, chi tiết đang mở vẫn ở
 *     lại trên màn hình (`keepPreviousData`) như bản thủ công chỉ thay
 *     dữ liệu khi lần tải xong.
 *   - Gửi yêu cầu duyệt (cả kế hoạch hoặc một năng lực) xong thì bề
 *     mặt liên quan nạp lại ngay: danh sách kế hoạch qua invalidate
 *     khoá của người dùng, chi tiết qua invalidate khoá chi tiết.
 *
 * Trang này không gắn `clientLoader`: khoá danh sách neo theo id của
 * người dùng trong phiên, loader của route không có ngữ cảnh phiên đó
 * để nạp trước đúng khoá.
 */

/** Tuỳ chọn truy vấn danh sách kế hoạch của một người dùng (GET /competencies/plans/user/:userId). */
export function userLearningPlansQueryOptions(userId: string) {
  return queryOptions({
    queryKey: queryKeys.userLearningPlans(userId),
    queryFn: () => apiJson<PlanView[]>(`/api/v1/competencies/plans/user/${userId}`),
  });
}

/** Hook đọc danh sách kế hoạch của người đang đăng nhập; chưa rõ phiên thì chưa gọi API. */
export function useUserLearningPlans(userId: string | undefined) {
  return useQuery({
    ...userLearningPlansQueryOptions(userId ?? ''),
    enabled: userId !== undefined,
  });
}

/** Tuỳ chọn truy vấn chi tiết một kế hoạch (GET /competencies/plans/:id). */
export function learningPlanDetailQueryOptions(planId: string) {
  return queryOptions({
    queryKey: queryKeys.learningPlanDetail(planId),
    queryFn: () => apiJson<PlanDetail>(`/api/v1/competencies/plans/${planId}`),
  });
}

/**
 * Hook đọc chi tiết của kế hoạch đang được chọn xem: chưa chọn thì
 * không gọi API; đổi kế hoạch thì giữ chi tiết trước trong lúc tải.
 */
export function useLearningPlanDetail(selectedPlanId: string | null) {
  return useQuery({
    ...learningPlanDetailQueryOptions(selectedPlanId ?? ''),
    enabled: selectedPlanId !== null,
    placeholderData: keepPreviousData,
  });
}

/**
 * Đột biến yêu cầu duyệt cả kế hoạch (POST
 * /competencies/plans/:id/request-review) — hành động khởi đầu quy
 * trình của người review; thành công thì làm mới danh sách kế hoạch
 * của người dùng để trạng thái mới hiện ngay.
 */
export function useRequestPlanReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ planId }: { planId: string; userId: string }) =>
      apiJson(`/api/v1/competencies/plans/${planId}/request-review`, { method: 'POST', body: '{}' }),
    onSuccess: (_data, vars) =>
      void client.invalidateQueries({ queryKey: queryKeys.userLearningPlans(vars.userId) }),
  });
}

/**
 * Đột biến gửi một năng lực đi duyệt qua bằng chứng (POST
 * /competencies/usercomp/:id/evidence với action 'evidence' +
 * sendForReview) — thành công thì làm mới chi tiết kế hoạch đang mở
 * để trạng thái duyệt của năng lực hiện ngay.
 */
export function useRequestCompetencyReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { usercompId: string; planId: string; description: string }) =>
      apiJson(`/api/v1/competencies/usercomp/${vars.usercompId}/evidence`, {
        method: 'POST',
        body: JSON.stringify({ action: 'evidence', description: vars.description, sendForReview: true }),
      }),
    onSuccess: (_data, vars) =>
      void client.invalidateQueries({ queryKey: queryKeys.learningPlanDetail(vars.planId) }),
  });
}
