// Hình dạng dữ liệu của cụm Kế hoạch học tập (trang + khu quản trị competency).

export interface PlanView {
  id: string;
  name: string;
  status: number;
  templateId: string | null;
}
export interface PlanDetail {
  plan: PlanView;
  competencies: {
    competency: { id: string; shortName: string };
    usercomp: { id: string; grade: number | null; proficiency: boolean | null; status: number } | null;
  }[];
  reviews: { action: string; createdAt: string }[];
}

/**
 * Framework như API trả về (bản ghi `competency_framework`): thang đánh giá
 * nằm trong `scaleConfiguration` dạng `{ values, proficient }` — cùng hình
 * dạng `competencyScaleSchema` mà DTO tạo framework nhận ở trường `scale`.
 */
export interface FrameworkView {
  id: string;
  shortName: string;
  idNumber?: string;
  description?: string;
  scaleConfiguration?: { values?: string[]; proficient?: number[] } | null;
  visible?: boolean;
}
/** Competency như API trả về (bản ghi `competency`): cây qua `parentId`/`depth`/`path`. */
export interface CompetencyView {
  id: string;
  shortName: string;
  idNumber?: string;
  description?: string;
  parentId?: string | null;
  depth?: number;
}
/** Template như API trả về (bản ghi `competency_template`). */
export interface TemplateView {
  id: string;
  shortName: string;
  description?: string;
  dueDate?: string | null;
}
/** User competency như API trả về (bản ghi `competency_user_comp`): `status` là trạng thái duyệt 0/1/2. */
export interface UsercompView {
  id: string;
  userId: string;
  competencyId: string;
  status: number;
  grade: number | null;
  proficiency: boolean | null;
}
/** Người dùng trong danh sách chọn của hàng đợi duyệt (GET /users trả `{ users, total, ... }`). */
export interface UserOption {
  id: string;
  username: string;
}

/** Thụt lề theo độ sâu cây năng lực: bảng class tĩnh theo từng cấp (mỗi cấp 16px), tránh style nội tuyến. */
export const COMPETENCY_INDENT = ['pl-0', 'pl-4', 'pl-8', 'pl-12', 'pl-16', 'pl-20'];
