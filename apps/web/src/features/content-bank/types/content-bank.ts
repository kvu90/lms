import type { ContentBankContent } from '@lms/contracts';

/**
 * Kiểu và hằng của Kho học liệu thuộc feature content-bank
 * (CB-1, issue #69). Tách từ module phẳng `src/lib/content-bank.ts`
 * khi tổ chức lại apps/web theo mô hình features/ (issue #500):
 * kiểu/hằng nằm ở tầng types/, lời gọi API thuần ở tầng api/,
 * hàm thuần ở tầng utils/, tuỳ chọn truy vấn và đột biến ở tầng
 * queries/ (từ `content-bank-data.ts`).
 * Học liệu là `ContentBankContent` của contracts (đã gồm metadata
 * chương trình, scope và trạng thái duyệt); trang kho và màn tạo/sửa
 * dùng chung các kiểu này.
 */

export type LibraryItem = ContentBankContent;

export interface LibrarySpace {
  scope: string;
  spaceId: string | null;
  name: string;
  canReview: boolean;
}

/** Loại học liệu: đúng 5 nhóm Điều 7 TT 09/2021 (CB1-B2). */
export const RESOURCE_TYPES = ['multimedia_lecture', 'lab_guide', 'simulation', 'question_set', 'reference'] as const;
export const REVIEW_STATUSES = ['draft', 'pending', 'approved', 'rejected'] as const;
export const LEVELS = ['primary', 'lower_secondary', 'upper_secondary', 'multi'] as const;
export const SOURCE_KINDS = ['self', 'cited', 'derived'] as const;
export const TARGET_AUDIENCES = ['students', 'teachers', 'both'] as const;
export const LESSON_POSITIONS = ['opening', 'new_knowledge', 'practice', 'application'] as const;

export interface ReviewChecklist {
  contentAccurate: boolean;
  sourceClear: boolean;
  pedagogyAesthetics: boolean;
  mobileReady: boolean;
}

export interface LibraryFilters {
  scope?: string;
  spaceId?: string | null;
  subjectId?: string;
  grade?: number;
  level?: string;
  resourceType?: string;
  reviewStatus?: string;
}

export interface LibraryItemInput {
  name: string;
  resourceType?: string;
  scope?: string;
  spaceId?: string | null;
  subjectId?: string | null;
  grade?: number | null;
  level?: string | null;
  curriculumNodeId?: string | null;
  outcomeIds?: string[] | null;
  questionCategoryId?: string | null;
  externalUrl?: string | null;
  description?: string | null;
  keywords?: string[] | null;
  targetAudience?: string | null;
  lessonPosition?: string | null;
  techFormat?: string | null;
  durationSeconds?: number | null;
  language?: string | null;
  originalAuthor?: string | null;
  sourceKind?: string | null;
  sourceCitation?: string | null;
  license?: string | null;
  derivedFromId?: string | null;
}

/** Một danh mục câu hỏi cho bộ chọn tham chiếu của học liệu loại bộ câu hỏi (GET /questions/categories?contextId=). */
export interface QuestionCategoryView {
  id: string;
  name: string;
}

/** Một node chương trình đã phẳng hoá kèm YCCĐ của toàn bộ cây con (phục vụ bộ chọn node ở màn tạo/sửa). */
export interface FlatNode {
  id: string;
  title: string;
  kind: string;
  depth: number;
  outcomeIds: string[];
  outcomes: { id: string; content: string }[];
}
