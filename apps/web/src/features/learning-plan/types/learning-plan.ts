/**
 * Kiểu riêng của tầng dữ liệu kế hoạch học tập thuộc feature
 * learning-plan (các kiểu hiển thị chính nằm ở `types/types.ts`,
 * dời từ `components/learning-plan/types.ts`). Tách từ module
 * phẳng `src/lib/learning-plan-data.ts` khi tổ chức lại apps/web
 * theo mô hình features/ (issue #500).
 */

/** Hành động duyệt trên một kế hoạch (quy tắc hiện nút theo trạng thái nằm ở component). */
export type PlanReviewActionName = 'start-review' | 'approve' | 'unapprove' | 'complete';
/** Hành động duyệt trên một năng lực của người dùng (quy tắc hiện nút theo trạng thái nằm ở component). */
export type UsercompReviewActionName = 'start-review' | 'approve' | 'reject';
