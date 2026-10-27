/**
 * Chữ ký nội dung chuẩn hoá của ma trận đề và nhận diện va chạm của
 * ràng buộc duy nhất theo chữ ký (lát schema chống trùng, issue #233).
 *
 * Vai trò của module: giữ MỘT định nghĩa duy nhất cho thuật toán chữ
 * ký nội dung — trước đây thuật toán chỉ sống dạng method riêng của
 * `QuizService` phục vụ đối chiếu chống trùng của đường nhập file.
 * Từ lát này, chữ ký còn được GHI XUỐNG DB (cột
 * `exam_matrices.content_signature`) tại mọi đường tạo/sửa ma trận và
 * được lấp cho dữ liệu cũ bằng entry
 * `backfill-matrix-content-signature`, nên thuật toán phải là một
 * hàm thuần dùng chung: đổi thuật toán ở đây là đổi đồng thời ở tầng
 * đối chiếu trong code, ở cột đã ghi và ở script lấp dữ liệu — ba nơi
 * lệch nhau là chống trùng hỏng lặng lẽ.
 *
 * Bất biến của thuật toán (giữ nguyên từ đường nhập file): hai nội
 * dung cho cùng một chữ ký là TRÙNG TOÀN BỘ theo nghĩa nghiệp vụ —
 * cùng tên, môn, chương trình, bộ mức, tổng điểm, ghi chú phạm vi,
 * tập đơn vị kiến thức phạm vi và toàn bộ ô; thứ tự của tập phạm vi
 * và của các ô không tham gia chữ ký; các giá trị điểm làm tròn 4
 * chữ số thập phân như đường phân tích file.
 */

/** Tên ràng buộc duy nhất theo cặp (bank đích, chữ ký nội dung) trên `exam_matrices` — khai trong schema của package db-schema. */
export const MATRIX_CONTENT_SIGNATURE_UNIQUE_CONSTRAINT = 'exam_matrices_bank_content_signature_unique';

/** Một ô ma trận ở dạng tối thiểu tham gia chữ ký nội dung (khớp hình dạng ô của đường nhập và của bản ghi đã lưu). */
export interface MatrixContentSignatureCell {
  curriculumNodeId: string;
  cognitiveLevel: string;
  qtype: string;
  questionCount: number;
  cellScore: number;
}

/** Đầu vào tính chữ ký: phần đầu của ma trận (dự thảo nhập hoặc bản ghi đã lưu) kèm toàn bộ ô của nó. */
export interface MatrixContentSignatureInput {
  name: string;
  subjectId: string;
  curriculumId: string;
  levelSet: string;
  totalScore: number;
  scopeNote: string | null;
  scopeNodeIds: string[] | null;
  cells: MatrixContentSignatureCell[];
}

/**
 * Tính chữ ký nội dung chuẩn hoá của một ma trận.
 *
 * Flow: làm tròn tổng điểm và điểm từng ô về 4 chữ số thập phân (như
 * đường phân tích file của lát nhập) → sắp xếp tập đơn vị kiến thức
 * phạm vi và mảng ô đã kết chuỗi "ĐVK|mức|dạng|số câu|điểm ô" → kết
 * chuỗi JSON theo thứ tự trường cố định. Hàm thuần, không đọc DB:
 * người gọi tự nạp ô.
 *
 * @param input - Phần đầu ma trận + toàn bộ ô của nó.
 * @returns Chuỗi JSON là chữ ký; hai ma trận trùng toàn bộ về nội
 *   dung cho cùng một chuỗi.
 */
export function matrixContentSignature(input: MatrixContentSignatureInput): string {
  const norm = (n: number) => Math.round(n * 10000) / 10000;
  return JSON.stringify({
    name: input.name, subjectId: input.subjectId, curriculumId: input.curriculumId,
    levelSet: input.levelSet, totalScore: norm(input.totalScore), scopeNote: input.scopeNote,
    scopeNodeIds: [...(input.scopeNodeIds ?? [])].sort(),
    cells: input.cells
      .map((c) => [c.curriculumNodeId, c.cognitiveLevel, c.qtype, c.questionCount, norm(c.cellScore)].join('|'))
      .sort(),
  });
}

/**
 * Lỗi có phải va chạm ĐÚNG ràng buộc duy nhất (bank đích, chữ ký nội
 * dung) của `exam_matrices` hay không.
 *
 * PostgreSQL báo lỗi vi phạm unique bằng mã 23505; lỗi Drizzle có thể
 * bọc lỗi gốc qua `cause` nên phải duyệt cả chuỗi cause (cùng mẫu các
 * service khác trong repo). Mã 23505 chưa đủ để kết luận: chỉ khi
 * tên ràng buộc xuất hiện trong `constraint` hoặc trong thông điệp
 * của lỗi gốc mới là va chạm của ràng buộc chữ ký — các vi phạm
 * unique khác (ví dụ khoá duy nhất của ô ma trận) phải giữ nguyên
 * hành vi lỗi cũ, không được nuốt thành "trùng nội dung".
 *
 * @param err - Lỗi bắt được từ thao tác ghi ma trận.
 * @returns true khi lỗi là va chạm của ràng buộc chữ ký nội dung.
 */
export function isMatrixContentSignatureConflict(err: unknown): boolean {
  let e: unknown = err;
  while (e !== null && typeof e === 'object') {
    const candidate = e as { code?: unknown; constraint?: unknown; message?: unknown };
    if (candidate.code === '23505'
      && (candidate.constraint === MATRIX_CONTENT_SIGNATURE_UNIQUE_CONSTRAINT
        || (typeof candidate.message === 'string' && candidate.message.includes(MATRIX_CONTENT_SIGNATURE_UNIQUE_CONSTRAINT)))) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
