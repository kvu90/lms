/**
 * Kiểu dữ liệu của màn soạn đề thuộc feature exams. Tách từ
 * module dữ liệu phẳng `src/lib/exam-paper-data.ts` khi tổ chức
 * lại apps/web theo mô hình features/ (issue #500): kiểu nằm ở
 * tầng types/, lời gọi API thuần ở tầng api/, tuỳ chọn truy vấn
 * và đột biến ở tầng queries/.
 */

/** Một slot của đề như API exam-papers trả về (đã ghim version câu). */
export interface PaperSlotView {
  position: number;
  section: string;
  questionId: string;
  questionName: string | null;
  qtype: string | null;
  pinnedVersionNumber: number | null;
  /** Số version ready mới nhất của câu trong ngân hàng (null khi chưa có bản ready). */
  latestReadyVersionNumber: number | null;
  /** Huy hiệu "có bản ready mới" (issue #254): slot đang ghim version cũ hơn bản ready mới nhất của câu. */
  hasNewerVersion: boolean;
  maxMark: number;
  clusterId: string | null;
  /** Ô ma trận nguồn (EB-2) — có ở đề sinh từ ma trận; neo swap-cùng-ô. */
  matrixCellId: string | null;
}

/** Một lần GHIM của đề vào một khoá + các mã đề của lần ghim (GET /exams/:id/pins). */
export interface PinViewLite {
  id: string;
  courseId: string;
  courseName: string;
  versionNumber: number;
  name: string | null;
  variantCount: number;
  variantCodes: string[];
  createdAt: string;
}

/** Chi tiết một đề (GET /exam-papers/:id). */
export interface PaperView {
  paper: {
    id: string;
    bankId: string;
    kind: string;
    status: string;
    latestVersion: number;
    derivedFromPaperId: string | null;
  };
  version: {
    id: string;
    version: number;
    name: string;
    subjectId: string | null;
    grade: number | null;
    examKind: string | null;
    totalScore: number;
    durationMinutes: number | null;
    matrixId: string | null;
    matrixVersion: number | null;
  };
  slots: PaperSlotView[];
  /**
   * Cờ quyền của người xem tại bank của đề (API trả cùng bộ
   * `ExamCapabilitiesView` với phía ngân hàng): `edit` — được sửa
   * chính đề này; `deploy` — được ghim đề vào khoá (cổng
   * `exam:deploy` tại bank), là căn cứ hiện form ghim trong màn sửa.
   */
  capabilities: { edit: boolean; deploy: boolean };
}

/** Một dòng kết quả khám phá ngân hàng câu hỏi (GET /questions/discovery) như màn soạn đề tiêu thụ. */
export interface DiscoveryItemLite {
  questionId: string;
  name: string;
  qtype: string;
  bankName: string;
}

/** Thân tạo đề mới trong một bank đề (POST /exams/banks/:bankId/exams). */
export interface CreateExamPaperBody {
  name: string;
  examKind: string | null;
  grade: number | null;
  durationMinutes: number | null;
  totalScore: number;
  slots: { questionId: string; maxMark: number; section?: string }[];
}

/** Thân sửa metadata của đề (PATCH /exams/:id) — server tạo paper version mới. */
export interface UpdateExamPaperMetaBody {
  name: string;
  examKind: string | null;
  grade: number | null;
  durationMinutes: number | null;
  totalScore: number;
}
