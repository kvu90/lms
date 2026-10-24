import { apiJson } from '#lib/api';

/**
 * Kiểu + lời gọi API dùng chung cho chương trình GDPT 2018 (K0a):
 * trang quản trị chương trình, khối chọn khung khi tạo khoá và panel
 * nạp khung trong quản trị khoá cùng đọc một hình dạng cây.
 * Chương trình quốc gia neo ở context hệ thống (contextLevel 10) —
 * cùng cách khối Chương trình trong editor câu hỏi đang đọc.
 */

export interface CurriculumSubject {
  id: string;
  contextId: string;
  name: string;
  slug: string;
  position: number;
}

export interface Curriculum {
  id: string;
  subjectId: string;
  grade: number;
}

export interface CurriculumOutcome {
  id: string;
  content: string;
  position: number;
  sourceKind: string;
  sourceRef: string | null;
  derivedFromId: string | null;
}

export interface CurriculumTreeNode {
  id: string;
  curriculumId: string;
  parentId: string | null;
  title: string;
  kind: string;
  position: number;
  durationPeriods: number | null;
  durationPercent: number | null;
  outcomes: CurriculumOutcome[];
  children: CurriculumTreeNode[];
}

export interface CurriculumTree {
  curriculum: Curriculum;
  subject: CurriculumSubject;
  nodes: CurriculumTreeNode[];
}

/** Id của context hệ thống (nơi neo cây chương trình quốc gia). */
export async function fetchSystemContextId(): Promise<string | null> {
  const contexts = await apiJson<{ id: string; contextLevel: number }[]>('/api/v1/access/contexts');
  return contexts.find((c) => c.contextLevel === 10)?.id ?? null;
}

/**
 * Môn học trong context hệ thống. Kèm `forCourseId` (bề mặt chọn khung
 * trong quản trị khoá): API còn chấp nhận nhánh course:update tại chính
 * khoá đó cho giáo viên cấp khoá không có curriculum:view hệ thống.
 */
export async function fetchSubjects(contextId: string, forCourseId?: string): Promise<CurriculumSubject[]> {
  const frame = forCourseId ? `&forCourseId=${forCourseId}` : '';
  return apiJson<CurriculumSubject[]>(`/api/v1/curriculum/subjects?contextId=${contextId}${frame}`);
}

/** Các chương trình (theo khối) của một môn. */
export async function fetchCurricula(subjectId: string, forCourseId?: string): Promise<Curriculum[]> {
  const frame = forCourseId ? `&forCourseId=${forCourseId}` : '';
  return apiJson<Curriculum[]>(`/api/v1/curriculum/curricula?subjectId=${subjectId}${frame}`);
}

/** Cây nội dung trọn vẹn của một chương trình. */
export async function fetchTree(curriculumId: string, forCourseId?: string): Promise<CurriculumTree> {
  const frame = forCourseId ? `?forCourseId=${forCourseId}` : '';
  return apiJson<CurriculumTree>(`/api/v1/curriculum/curricula/${curriculumId}/tree${frame}`);
}

/** Một đơn vị khung chọn được khi nạp khung vào khoá: node không phải `lesson` + số YCCĐ trong subtree. */
export interface FrameUnit {
  nodeId: string;
  title: string;
  kind: string;
  depth: number;
  outcomeCount: number;
}

function countOutcomes(node: CurriculumTreeNode): number {
  return node.outcomes.length + node.children.reduce((n, c) => n + countOutcomes(c), 0);
}

/** Làm phẳng cây thành danh sách đơn vị khung theo thứ tự duyệt cây (cha trước con). */
export function flattenFrameUnits(nodes: CurriculumTreeNode[], depth = 0, out: FrameUnit[] = []): FrameUnit[] {
  for (const node of nodes) {
    if (node.kind !== 'lesson') {
      out.push({ nodeId: node.id, title: node.title, kind: node.kind, depth, outcomeCount: countOutcomes(node) });
    }
    flattenFrameUnits(node.children, depth + 1, out);
  }
  return out;
}

/**
 * Đơn vị khung của cặp (môn, khối): không có chương trình cho khối đó
 * thì trả curriculumId null + danh sách rỗng (khoá vẫn tạo/nạp bình
 * thường, chỉ là chưa có khung để chọn).
 */
export async function fetchFrameUnitsFor(
  subjectId: string,
  grade: number,
  forCourseId?: string,
): Promise<{ curriculumId: string | null; units: FrameUnit[] }> {
  const curricula = await fetchCurricula(subjectId, forCourseId);
  const curriculum = curricula.find((c) => c.grade === grade);
  if (!curriculum) return { curriculumId: null, units: [] };
  const tree = await fetchTree(curriculum.id, forCourseId);
  return { curriculumId: curriculum.id, units: flattenFrameUnits(tree.nodes) };
}
