import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  addTemplateCohort, addTemplateCompetency, createCompetency, createCompetencyFramework,
  createLearningPlanTemplate, createPlansFromTemplate, fetchCompetencyFrameworks, fetchCompetencyTemplates,
  fetchFrameworkCompetencies, fetchFrameworkExport, fetchLearningPlanDetail, fetchUserCompetencies,
  fetchUserLearningPlans, fetchUserOptions, importCompetencyFramework, planReviewAction, requestCompetencyReview,
  requestPlanReview, usercompReviewAction,
} from '../api/learning-plan';
import type { PlanReviewActionName, UsercompReviewActionName } from '../types/learning-plan';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu TanStack Query của trang kế hoạch học tập (F-01 của rà
 * soát #133), thay cho vòng fetch thủ công bằng `useEffect` + `apiJson`
 * trước đây. Module gồm hai phần:
 *
 *   - Phần NGƯỜI HỌC: danh sách kế hoạch của chính người dùng và chi
 *     tiết một kế hoạch.
 *   - Phần QUẢN TRỊ NĂNG LỰC (component `competency-admin.tsx`), được
 *     chuyển về khuôn TanStack ở lượt riêng sau cùng của F-01: danh
 *     sách framework/template, cây năng lực của framework đang chọn,
 *     danh sách người dùng cho ô chọn duyệt, hàng đợi duyệt và mọi
 *     thao tác ghi của khu quản trị.
 *
 * Hai hành vi giữ nguyên từ bản thủ công ở phần người học:
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
 * để nạp trước đúng khoá. Khu quản trị là component con của trang,
 * chỉ render khi người dùng có quyền quản trị, cũng không có bề mặt
 * loader riêng.
 *
 * Tầng này bọc các hàm gọi API thuần ở `../api/learning-plan` (tách
 * khỏi module phẳng `src/lib/learning-plan-data.ts` khi tổ chức
 * lại apps/web theo mô hình features/, issue #500).
 */

/** Tuỳ chọn truy vấn danh sách kế hoạch của một người dùng (GET /competencies/plans/user/:userId). */
export function userLearningPlansQueryOptions(userId: string) {
  return queryOptions({
    queryKey: queryKeys.userLearningPlans(userId),
    queryFn: () => fetchUserLearningPlans(userId),
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
    queryFn: () => fetchLearningPlanDetail(planId),
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
    mutationFn: ({ planId }: { planId: string; userId: string }) => requestPlanReview(planId),
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
      requestCompetencyReview(vars.usercompId, vars.description),
    onSuccess: (_data, vars) =>
      void client.invalidateQueries({ queryKey: queryKeys.learningPlanDetail(vars.planId) }),
  });
}

/* ------------------------------------------------------------------ */
/* Phần QUẢN TRỊ NĂNG LỰC (component `competency-admin.tsx`)           */
/* ------------------------------------------------------------------ */

/** Tuỳ chọn truy vấn danh sách framework năng lực (GET /competencies/frameworks). */
export function competencyFrameworksQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.competencyFrameworks,
    queryFn: () => fetchCompetencyFrameworks(),
  });
}

/** Hook đọc danh sách framework cho khu quản trị. */
export function useCompetencyFrameworks() {
  return useQuery(competencyFrameworksQueryOptions());
}

/** Tuỳ chọn truy vấn danh sách mẫu kế hoạch học tập (GET /competencies/templates). */
export function competencyTemplatesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.competencyTemplates,
    queryFn: () => fetchCompetencyTemplates(),
  });
}

/** Hook đọc danh sách mẫu kế hoạch cho khu quản trị. */
export function useCompetencyTemplates() {
  return useQuery(competencyTemplatesQueryOptions());
}

/** Tuỳ chọn truy vấn cây năng lực của một framework (GET /competencies/frameworks/:id/competencies). */
export function frameworkCompetenciesQueryOptions(frameworkId: string) {
  return queryOptions({
    queryKey: queryKeys.frameworkCompetencies(frameworkId),
    queryFn: () => fetchFrameworkCompetencies(frameworkId),
  });
}

/**
 * Hook đọc cây năng lực của framework đang chọn: chưa chọn framework
 * thì không gọi API; đổi framework thì giữ cây của framework trước
 * trong lúc tải cây mới (`keepPreviousData`) — đúng hành vi bản thủ
 * công, vốn chỉ thay danh sách khi lần tải xong nên tải lỗi thì cây
 * cũ vẫn ở lại trên màn hình.
 */
export function useFrameworkCompetencies(selectedFrameworkId: string) {
  return useQuery({
    ...frameworkCompetenciesQueryOptions(selectedFrameworkId),
    enabled: selectedFrameworkId !== '',
    placeholderData: keepPreviousData,
  });
}

/**
 * Tuỳ chọn truy vấn tài liệu xuất của một framework (GET
 * /competencies/frameworks/:id/export), dành cho component lấy qua
 * `fetchQuery` khi quản trị bấm xuất. `staleTime: 0`: file tải xuống
 * phải là ảnh chụp mới nhất từ máy chủ tại thời điểm bấm, không dùng
 * lại bản đã cache từ lần xuất trước.
 */
export function frameworkExportQueryOptions(frameworkId: string) {
  return queryOptions({
    queryKey: queryKeys.frameworkExport(frameworkId),
    queryFn: () => fetchFrameworkExport(frameworkId),
    staleTime: 0,
  });
}

/**
 * Tuỳ chọn truy vấn danh sách người dùng rút gọn cho ô chọn của hàng
 * đợi duyệt (GET /users?page=1&pageSize=50): chuẩn hoá về mảng người
 * dùng ngay trong tầng gọi API như bản thủ công.
 */
export function userOptionsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.userOptions,
    queryFn: () => fetchUserOptions(),
  });
}

/**
 * Hook đọc danh sách người dùng cho ô chọn của hàng đợi duyệt; gọi
 * không được thì dữ liệu rỗng và component vẫn cho nhập tay id người
 * dùng như bản thủ công.
 */
export function useUserOptions() {
  return useQuery(userOptionsQueryOptions());
}

/** Tuỳ chọn truy vấn năng lực của một người dùng (GET /competencies/usercomp/user/:userId) — nửa còn lại của hàng đợi duyệt. */
export function userCompetenciesQueryOptions(userId: string) {
  return queryOptions({
    queryKey: queryKeys.userCompetencies(userId),
    queryFn: () => fetchUserCompetencies(userId),
  });
}

/**
 * Hook đọc kế hoạch của người dùng đang xét trong hàng đợi duyệt:
 * chưa bấm tải (id null) thì không gọi API và không có dữ liệu; đổi
 * người dùng thì giữ hàng đợi trước trong lúc tải hàng đợi mới như
 * bản thủ công (chỉ thay khi lần tải xong).
 */
export function useReviewQueuePlans(queueUserId: string | null) {
  return useQuery({
    ...userLearningPlansQueryOptions(queueUserId ?? ''),
    enabled: queueUserId !== null,
    placeholderData: keepPreviousData,
  });
}

/** Hook đọc năng lực của người dùng đang xét trong hàng đợi duyệt — cặp với `useReviewQueuePlans`. */
export function useReviewQueueUsercomps(queueUserId: string | null) {
  return useQuery({
    ...userCompetenciesQueryOptions(queueUserId ?? ''),
    enabled: queueUserId !== null,
    placeholderData: keepPreviousData,
  });
}

/**
 * Làm mới cả hai danh sách khung quản trị (framework + template) —
 * tương đương lời gọi nạp lại cả hai của bản thủ công sau khi tạo
 * framework, nhập framework hoặc tạo template.
 */
function invalidateAdminLists(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.competencyFrameworks }),
    client.invalidateQueries({ queryKey: queryKeys.competencyTemplates }),
  ]);
}

/** Làm mới cả hai danh sách của hàng đợi duyệt (kế hoạch + năng lực) của một người dùng sau thao tác duyệt. */
function invalidateReviewQueue(client: QueryClient, userId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.userLearningPlans(userId) }),
    client.invalidateQueries({ queryKey: queryKeys.userCompetencies(userId) }),
  ]);
}

/**
 * Đột biến tạo framework (POST /competencies/frameworks) với thân đã
 * đóng gói đúng `createCompetencyFrameworkSchema` ở component; thành
 * công thì làm mới cả hai danh sách khung quản trị.
 */
export function useCreateCompetencyFramework() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      shortName: string;
      idNumber?: string;
      description?: string;
      scale: { values: string[]; proficient: number[] };
      visible?: boolean;
    }) => createCompetencyFramework(body),
    onSuccess: () => void invalidateAdminLists(client),
  });
}

/**
 * Đột biến nhập framework từ tài liệu JSON đã xuất (POST
 * /competencies/frameworks/import): backend kiểm chứng toàn vẹn tài
 * liệu bằng `frameworkExportSchema` và tạo framework MỚI (mọi id đều
 * mới); lỗi toàn vẹn ném `ApiError` mang `detail` nguyên văn để
 * component hiện cho quản trị. Thành công thì làm mới hai danh sách.
 */
export function useImportCompetencyFramework() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (doc: unknown) => importCompetencyFramework(doc),
    onSuccess: () => void invalidateAdminLists(client),
  });
}

/**
 * Đột biến thêm năng lực vào framework (POST
 * /competencies/frameworks/:id/competencies) với thân đã đóng gói
 * đúng `createCompetencySchema`; thành công thì làm mới cây năng lực
 * của đúng framework đó.
 */
export function useCreateCompetency() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      frameworkId: string;
      body: { shortName: string; idNumber?: string; description?: string; parentId?: string };
    }) => createCompetency(vars.frameworkId, vars.body),
    onSuccess: (_data, vars) =>
      void client.invalidateQueries({ queryKey: queryKeys.frameworkCompetencies(vars.frameworkId) }),
  });
}

/**
 * Đột biến tạo mẫu kế hoạch (POST /competencies/templates) với thân đã
 * đóng gói đúng `createLearningPlanTemplateSchema`; trả về mẫu vừa
 * tạo để component chọn sẵn nó, đồng thời làm mới hai danh sách khung
 * quản trị như bản thủ công.
 */
export function useCreateLearningPlanTemplate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { shortName: string; description?: string; dueDate?: string }) =>
      createLearningPlanTemplate(body),
    onSuccess: () => void invalidateAdminLists(client),
  });
}

/**
 * Đột biến gắn một năng lực vào mẫu kế hoạch (POST
 * /competencies/templates/:id/competencies với `{ competencyId }`).
 * Bản thủ công không nạp lại bề mặt nào sau thao tác này nên đột biến
 * không invalidate khoá nào.
 */
export function useAddTemplateCompetency() {
  return useMutation({
    mutationFn: (vars: { templateId: string; competencyId: string }) =>
      addTemplateCompetency(vars.templateId, vars.competencyId),
  });
}

/**
 * Đột biến gắn một cohort vào mẫu kế hoạch (POST
 * /competencies/templates/:id/cohorts với `{ cohortId }`) — như thao
 * tác gắn năng lực, bản thủ công không nạp lại bề mặt nào sau đó.
 */
export function useAddTemplateCohort() {
  return useMutation({
    mutationFn: (vars: { templateId: string; cohortId: string }) =>
      addTemplateCohort(vars.templateId, vars.cohortId),
  });
}

/**
 * Đột biến sinh kế hoạch cho mọi thành viên của các cohort đã gắn
 * vào mẫu (POST /competencies/templates/:id/create-plans, không thân)
 * — trả về số kế hoạch đã tạo để component hiện thông báo.
 */
export function useCreatePlansFromTemplate() {
  return useMutation({
    mutationFn: (vars: { templateId: string }) => createPlansFromTemplate(vars.templateId),
  });
}

/**
 * Đột biến thao tác duyệt trên một kế hoạch (POST
 * /competencies/plans/:id/<hành động>, không thân); thành công thì
 * làm mới cả hai danh sách của hàng đợi duyệt cho người dùng trong
 * biến `userId` (id đang nhập ở ô hàng đợi, như bản thủ công nạp lại
 * hàng đợi theo đúng id đó).
 */
export function usePlanReviewAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { planId: string; action: PlanReviewActionName; userId: string }) =>
      planReviewAction(vars.planId, vars.action),
    onSuccess: (_data, vars) => void invalidateReviewQueue(client, vars.userId),
  });
}

/**
 * Đột biến thao tác duyệt trên một năng lực của người dùng (POST
 * /competencies/usercomp/:id/<hành động>, không thân); thành công thì
 * làm mới hàng đợi duyệt như thao tác duyệt trên kế hoạch.
 */
export function useUsercompReviewAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { usercompId: string; action: UsercompReviewActionName; userId: string }) =>
      usercompReviewAction(vars.usercompId, vars.action),
    onSuccess: (_data, vars) => void invalidateReviewQueue(client, vars.userId),
  });
}
