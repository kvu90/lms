/**
 * Kiểu dữ liệu của màn ma trận thuộc feature matrices. Tách từ
 * module dữ liệu phẳng `src/lib/matrix-data.ts` khi tổ chức lại
 * apps/web theo mô hình features/ (issue #500): kiểu nằm ở tầng
 * types/, lời gọi API thuần ở tầng api/, tuỳ chọn truy vấn và
 * đột biến ở tầng queries/.
 */

export interface SubjectLite {
  id: string;
  name: string;
}
export interface CurriculumLite {
  id: string;
  subjectId: string;
  grade: number;
}
export interface BankLite {
  id: string;
  scope: string;
}
export interface CellLite {
  id: string;
  curriculumNodeId: string;
  cognitiveLevel: string;
  qtype: string;
  questionCount: number;
  cellScore: number;
}
export interface MatrixLite {
  id: string;
  name: string;
  subjectId: string;
  curriculumId: string;
  bankId: string | null;
  status: string;
  isTemplate: boolean;
  version: number;
  presetKind: string;
  levelSet: string;
  totalScore: number;
  cells: CellLite[];
}
export interface AvailabilityLite {
  sufficient: boolean;
  cells: { cellId: string; required: number; available: number; deficit: number }[];
}

/**
 * Một YCCĐ thuộc ĐVK trong bản đặc tả suy ra (cột "Yêu cầu cần đạt").
 *
 * Bất biến theo mô hình #249: YCCĐ nằm ở cấp NODE (ĐVK) chứ không nằm
 * trong ô — mọi ô của cùng một node dùng chung danh sách YCCĐ này.
 * `programContent` là nguyên văn chương trình (với YCCĐ derived là
 * nguyên văn của YCCĐ gốc), `derivedContent` là bản tách mức của tổ
 * chuyên môn (null khi YCCĐ không phải bản derived); khi hiển thị,
 * ưu tiên `programContent`, thiếu mới rơi xuống `content`.
 */
export interface SpecificationOutcomeLite {
  outcomeId: string;
  content: string;
  sourceKind: string;
  sourceRef: string | null;
  programContent: string | null;
  derivedContent: string | null;
  /**
   * Vị trí của dòng trong bản ghi chương trình và mã YCCĐ vị trí
   * `<recordId>.<position 2 số>` — cả hai do BACKEND tính (một nguồn
   * sự thật cho vị trí, issue #161); web chỉ hiển thị, không tự suy.
   * Với derived là vị trí/mã của dòng gốc; null khi node không thuộc
   * bản ghi dataset nào.
   */
  position: number | null;
  code: string | null;
}

/**
 * Một ô ma trận trong bản đặc tả suy ra.
 *
 * `slotNumbers`/`drawNote` chỉ có khi đặc tả được dựng theo một lần
 * ghim đề cụ thể (pinId); đặc tả theo ma trận thuần (bề mặt SPEC-1)
 * luôn nhận null ở hai trường này. `questionCount` của ô Đúng–Sai là
 * số CHÙM — khi trình bày phải nhân 4 như bản xuất (xem trang ma trận).
 */
export interface SpecificationCellLite {
  cellId: string;
  cognitiveLevel: string;
  qtype: string;
  questionCount: number;
  cellScore: number;
  minutes: number | null;
  slotNumbers: number[] | null;
  drawNote: string | null;
}

/**
 * View model bản đặc tả (SPEC-1, issue #233): bảng SUY RA từ các ô của
 * ma trận — ô neo ĐVK × mức × dạng; cột YCCĐ lấy từ các YCCĐ thuộc ĐVK
 * của ô (ô KHÔNG neo YCCĐ). Cùng hình dạng API dùng cho export xlsx/docx.
 */
export interface MatrixSpecificationLite {
  matrix: { id: string; name: string; totalScore: number; levelSet: string };
  subject: { id: string; name: string };
  curriculum: { id: string; grade: number };
  purpose: string;
  topics: {
    topicId: string | null;
    topicTitle: string;
    nodes: {
      nodeId: string;
      nodeTitle: string;
      outcomes: SpecificationOutcomeLite[];
      cells: SpecificationCellLite[];
    }[];
  }[];
  totals: { totalQuestions: number; totalScore: number };
}

/** Một nút cây chương trình (cùng hình dạng CurriculumTreeNode của trang câu hỏi). */
export interface MatrixTreeNode {
  id: string;
  title: string;
  outcomes: { id: string; content: string }[];
  children: MatrixTreeNode[];
}
