import { apiJson } from '#lib/api';
import type { PlanReviewActionName, UsercompReviewActionName } from '../types/learning-plan';
import type {
  CompetencyView,
  FrameworkView,
  PlanDetail,
  PlanView,
  TemplateView,
  UserOption,
  UsercompView,
} from '../types/types';

/**
 * Tầng gọi API thuần của trang kế hoạch học tập thuộc feature
 * learning-plan: chỉ chứa các hàm gọi HTTP, không phụ thuộc
 * React hay React Query. Tầng `queries/` của feature bọc các
 * hàm này thành queryOptions và đột biến. Tách từ module phẳng
 * `src/lib/learning-plan-data.ts` khi tổ chức lại apps/web theo
 * mô hình features/ (issue #500).
 */

/**
 * Đọc danh sách kế hoạch của một người dùng (GET /competencies/plans/user/:userId).
 *
 * @param userId - Định danh người dùng.
 * @returns Danh sách kế hoạch.
 */
export function fetchUserLearningPlans(userId: string) {
  return apiJson<PlanView[]>(`/api/v1/competencies/plans/user/${userId}`);
}

/**
 * Đọc chi tiết một kế hoạch (GET /competencies/plans/:id).
 *
 * @param planId - Định danh kế hoạch.
 * @returns Chi tiết kế hoạch.
 */
export function fetchLearningPlanDetail(planId: string) {
  return apiJson<PlanDetail>(`/api/v1/competencies/plans/${planId}`);
}

/**
 * Yêu cầu duyệt cả kế hoạch (POST /competencies/plans/:id/request-review).
 *
 * @param planId - Định danh kế hoạch.
 * @returns Đáp ứng của API.
 */
export function requestPlanReview(planId: string) {
  return apiJson(`/api/v1/competencies/plans/${planId}/request-review`, { method: 'POST', body: '{}' });
}

/**
 * Gửi một năng lực đi duyệt qua bằng chứng (POST /competencies/usercomp/:id/evidence).
 *
 * @param usercompId - Định danh năng lực của người dùng.
 * @param description - Mô tả bằng chứng.
 * @returns Đáp ứng của API.
 */
export function requestCompetencyReview(usercompId: string, description: string) {
  return apiJson(`/api/v1/competencies/usercomp/${usercompId}/evidence`, {
    method: 'POST',
    body: JSON.stringify({ action: 'evidence', description, sendForReview: true }),
  });
}

/**
 * Đọc danh sách framework năng lực (GET /competencies/frameworks).
 *
 * @returns Danh sách framework.
 */
export function fetchCompetencyFrameworks() {
  return apiJson<FrameworkView[]>('/api/v1/competencies/frameworks');
}

/**
 * Đọc danh sách mẫu kế hoạch học tập (GET /competencies/templates).
 *
 * @returns Danh sách mẫu.
 */
export function fetchCompetencyTemplates() {
  return apiJson<TemplateView[]>('/api/v1/competencies/templates');
}

/**
 * Đọc cây năng lực của một framework (GET /competencies/frameworks/:id/competencies).
 *
 * @param frameworkId - Định danh framework.
 * @returns Cây năng lực.
 */
export function fetchFrameworkCompetencies(frameworkId: string) {
  return apiJson<CompetencyView[]>(`/api/v1/competencies/frameworks/${frameworkId}/competencies`);
}

/**
 * Đọc tài liệu xuất của một framework (GET /competencies/frameworks/:id/export).
 *
 * @param frameworkId - Định danh framework.
 * @returns Tài liệu xuất.
 */
export function fetchFrameworkExport(frameworkId: string) {
  return apiJson<unknown>(`/api/v1/competencies/frameworks/${frameworkId}/export`);
}

/**
 * Đọc danh sách người dùng rút gọn cho ô chọn của hàng đợi duyệt
 * (GET /users?page=1&pageSize=50): API trả hình dạng phân trang
 * `{ users, total, page, pageSize }` (hoặc mảng thuần) — chuẩn hoá
 * về mảng người dùng ngay tại đây như bản thủ công.
 *
 * @returns Danh sách người dùng rút gọn.
 */
export async function fetchUserOptions() {
  const res = await apiJson<{ users?: UserOption[] } | UserOption[]>('/api/v1/users?page=1&pageSize=50');
  return Array.isArray(res) ? res : (res.users ?? []);
}

/**
 * Đọc năng lực của một người dùng (GET /competencies/usercomp/user/:userId).
 *
 * @param userId - Định danh người dùng.
 * @returns Danh sách năng lực của người dùng.
 */
export function fetchUserCompetencies(userId: string) {
  return apiJson<UsercompView[]>(`/api/v1/competencies/usercomp/user/${userId}`);
}

/**
 * Tạo framework (POST /competencies/frameworks) với thân đã đóng gói đúng `createCompetencyFrameworkSchema` ở component.
 *
 * @param body - Thân tạo framework.
 * @returns Đáp ứng của API.
 */
export function createCompetencyFramework(body: {
  shortName: string;
  idNumber?: string;
  description?: string;
  scale: { values: string[]; proficient: number[] };
  visible?: boolean;
}) {
  return apiJson('/api/v1/competencies/frameworks', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Nhập framework từ tài liệu JSON đã xuất (POST /competencies/frameworks/import).
 *
 * @param doc - Tài liệu JSON.
 * @returns Framework mới tạo.
 */
export function importCompetencyFramework(doc: unknown) {
  return apiJson<FrameworkView>('/api/v1/competencies/frameworks/import', {
    method: 'POST',
    body: JSON.stringify(doc),
  });
}

/**
 * Thêm năng lực vào framework (POST /competencies/frameworks/:id/competencies).
 *
 * @param frameworkId - Định danh framework.
 * @param body - Thân tạo năng lực đúng `createCompetencySchema`.
 * @returns Đáp ứng của API.
 */
export function createCompetency(
  frameworkId: string,
  body: { shortName: string; idNumber?: string; description?: string; parentId?: string },
) {
  return apiJson(`/api/v1/competencies/frameworks/${frameworkId}/competencies`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Tạo mẫu kế hoạch (POST /competencies/templates) với thân đúng `createLearningPlanTemplateSchema`.
 *
 * @param body - Thân tạo mẫu.
 * @returns Mẫu vừa tạo.
 */
export function createLearningPlanTemplate(body: { shortName: string; description?: string; dueDate?: string }) {
  return apiJson<TemplateView>('/api/v1/competencies/templates', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Gắn một năng lực vào mẫu kế hoạch (POST /competencies/templates/:id/competencies với `{ competencyId }`).
 *
 * @param templateId - Định danh mẫu.
 * @param competencyId - Định danh năng lực.
 * @returns Đáp ứng của API.
 */
export function addTemplateCompetency(templateId: string, competencyId: string) {
  return apiJson(`/api/v1/competencies/templates/${templateId}/competencies`, {
    method: 'POST',
    body: JSON.stringify({ competencyId }),
  });
}

/**
 * Gắn một cohort vào mẫu kế hoạch (POST /competencies/templates/:id/cohorts với `{ cohortId }`).
 *
 * @param templateId - Định danh mẫu.
 * @param cohortId - Định danh cohort.
 * @returns Đáp ứng của API.
 */
export function addTemplateCohort(templateId: string, cohortId: string) {
  return apiJson(`/api/v1/competencies/templates/${templateId}/cohorts`, {
    method: 'POST',
    body: JSON.stringify({ cohortId }),
  });
}

/**
 * Sinh kế hoạch cho mọi thành viên của các cohort đã gắn vào mẫu (POST /competencies/templates/:id/create-plans, không thân).
 *
 * @param templateId - Định danh mẫu.
 * @returns Số kế hoạch đã tạo.
 */
export function createPlansFromTemplate(templateId: string) {
  return apiJson<{ created: number }>(`/api/v1/competencies/templates/${templateId}/create-plans`, {
    method: 'POST',
    body: '{}',
  });
}

/**
 * Thao tác duyệt trên một kế hoạch (POST /competencies/plans/:id/<hành động>, không thân).
 *
 * @param planId - Định danh kế hoạch.
 * @param action - Hành động duyệt.
 * @returns Đáp ứng của API.
 */
export function planReviewAction(planId: string, action: PlanReviewActionName) {
  return apiJson(`/api/v1/competencies/plans/${planId}/${action}`, { method: 'POST', body: '{}' });
}

/**
 * Thao tác duyệt trên một năng lực của người dùng (POST /competencies/usercomp/:id/<hành động>, không thân).
 *
 * @param usercompId - Định danh năng lực của người dùng.
 * @param action - Hành động duyệt.
 * @returns Đáp ứng của API.
 */
export function usercompReviewAction(usercompId: string, action: UsercompReviewActionName) {
  return apiJson(`/api/v1/competencies/usercomp/${usercompId}/${action}`, { method: 'POST', body: '{}' });
}
