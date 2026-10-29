import type { Course, CourseContent, CourseGroup, CourseGrouping, GradeItem } from '@lms/contracts';

/**
 * Kiểu dữ liệu của trang xây dựng khoá học thuộc feature
 * course-builder. Tách từ module dữ liệu phẳng
 * `src/lib/course-builder-data.ts` khi tổ chức lại apps/web theo
 * mô hình features/ (issue #500): kiểu nằm ở tầng types/, lời gọi
 * API thuần ở tầng api/, tuỳ chọn truy vấn và đột biến ở tầng
 * queries/.
 */

/** Hình dạng GET /courses/:id/completion/criteria mà trang builder tiêu thụ. */
export interface BuilderCriteriaView {
  method: number;
  criteria: { id: string; criteriaType: string; moduleInstance: string | null; date: string | null }[];
}

/** Gói dữ liệu trang builder: thông tin khoá, nội dung, các mục điểm, tiêu chí hoàn thành, nhóm và grouping. */
export interface CourseBuilderData {
  course: Course | null;
  content: CourseContent | null;
  gradeItems: GradeItem[];
  criteria: BuilderCriteriaView | null;
  groups: CourseGroup[];
  groupings: CourseGrouping[];
}

/** Thân ghi dùng chung của builder: trang tự dựng đúng hình dạng API của từng thao tác. */
export type BuilderBody = Record<string, unknown>;
