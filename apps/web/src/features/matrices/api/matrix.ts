import type { ExamMatrixView, MatrixImportPreview } from '@lms/contracts';
import { apiFetch, apiJson } from '#lib/api';
import type {
  AvailabilityLite,
  BankLite,
  CurriculumLite,
  MatrixLite,
  MatrixSpecificationLite,
  MatrixTreeNode,
  SubjectLite,
} from '../types/matrix';

/**
 * Tầng gọi API thuần của màn ma trận thuộc feature matrices: chỉ
 * chứa các hàm gọi HTTP và các luồng tải file qua API, không phụ
 * thuộc React hay React Query. Tầng `queries/` của feature bọc
 * các hàm này thành queryOptions, hook và đột biến. Tách từ
 * module dữ liệu phẳng `src/lib/matrix-data.ts` khi tổ chức lại
 * apps/web theo mô hình features/ (issue #500).
 */

/** Tải một endpoint độc lập: lỗi thì trả null (giữ nhịp probe thủ công trước đây). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Đọc danh sách bank ma trận của người dùng (GET /question-banks?kind=matrix).
 *
 * @returns Danh sách bank ma trận.
 */
export function fetchMatrixBanks() {
  return apiJson<BankLite[]>('/api/v1/question-banks?kind=matrix');
}

/**
 * Đọc danh sách môn học chương trình (GET /curriculum/subjects).
 * Kèm `forCourseId` thì API mở nhánh `course:update` tại chính
 * khoá đó cho giáo viên không có `curriculum:view` tại context hệ
 * thống (điểm nghẽn D-3 của issue #233).
 *
 * @param forCourseId - Định danh khoá mở nhánh quyền (khi có).
 * @returns Danh sách môn.
 */
export function fetchCurriculumSubjects(forCourseId?: string) {
  const frame = forCourseId ? `?forCourseId=${forCourseId}` : '';
  return apiJson<SubjectLite[]>(`/api/v1/curriculum/subjects${frame}`);
}

/**
 * Đọc các chương trình của một môn (GET /curriculum/curricula?subjectId=),
 * kèm `forCourseId` như danh sách môn (cùng nhánh quyền theo khoá).
 *
 * @param subjectId - Định danh môn.
 * @param forCourseId - Định danh khoá mở nhánh quyền (khi có).
 * @returns Danh sách chương trình.
 */
export function fetchCurriculaBySubject(subjectId: string, forCourseId?: string) {
  const frame = forCourseId ? `&forCourseId=${forCourseId}` : '';
  return apiJson<CurriculumLite[]>(`/api/v1/curriculum/curricula?subjectId=${subjectId}${frame}`);
}

/**
 * Đọc chi tiết ma trận (GET /exam-matrices/:id).
 *
 * @param matrixId - Định danh ma trận.
 * @returns Chi tiết ma trận.
 */
export function fetchMatrixDetail(matrixId: string) {
  return apiJson<MatrixLite>(`/api/v1/exam-matrices/${matrixId}`);
}

/**
 * Đọc cây chương trình của một chương trình (GET /curriculum/curricula/:id/tree, probe).
 *
 * @param curriculumId - Định danh chương trình.
 * @returns Cây chương trình hoặc null khi lỗi tải.
 */
export function fetchCurriculumTree(curriculumId: string) {
  return probe<MatrixTreeNode[]>(`/api/v1/curriculum/curricula/${curriculumId}/tree`);
}

/**
 * Đọc khả dụng kho câu theo ô (GET /exam-matrices/:id/availability, probe).
 *
 * @param matrixId - Định danh ma trận.
 * @returns Khả dụng hoặc null khi lỗi tải.
 */
export function fetchMatrixAvailability(matrixId: string) {
  return probe<AvailabilityLite>(`/api/v1/exam-matrices/${matrixId}/availability`);
}

/**
 * Đọc bản đặc tả SUY RA của ma trận (GET /exam-matrices/:id/specification).
 *
 * @param matrixId - Định danh ma trận.
 * @returns View model bản đặc tả.
 */
export function fetchMatrixSpecification(matrixId: string) {
  return apiJson<MatrixSpecificationLite>(`/api/v1/exam-matrices/${matrixId}/specification`);
}

/**
 * Xuất bản đặc tả ra file (xlsx/docx) và tải về máy người dùng.
 *
 * Flow các bước: (1) gọi endpoint export sẵn có của API bằng
 * `apiFetch` (giữ nguyên Response để đọc header); (2) HTTP không ok
 * thì ném lỗi ngay — bề mặt gọi bắt lỗi và báo theo khuôn chung,
 * không tải file rác; (3) đọc blob, trích tên file từ header
 * `Content-Disposition` để giữ ĐÚNG tên server trả (dạng
 * `ban-dac-ta-<8 ký tự đầu của id ma trận>.<đuôi>`), header thiếu/sai
 * dạng mới rơi xuống tên dự phòng dựng cùng quy ước đó; (4) tạo URL
 * đối tượng tạm + thẻ neo ẩn để kích hoạt tải xuống của trình duyệt,
 * xong thu hồi URL ngay để không rò bộ nhớ.
 *
 * Side-effect: phát một request GET và kích hoạt một lượt tải file
 * của trình duyệt; không đổi trạng thái nào phía server/client.
 *
 * @param matrixId - Id của ma trận cần xuất bản đặc tả.
 * @param format - Định dạng file: 'xlsx' (Excel) hoặc 'docx' (Word).
 * @returns Promise hoàn tất sau khi lượt tải đã được kích hoạt.
 */
export async function downloadMatrixSpecification(matrixId: string, format: 'xlsx' | 'docx'): Promise<void> {
  const res = await apiFetch(`/api/v1/exam-matrices/${matrixId}/specification/export?format=${format}`);
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  // Tên file ưu tiên lấy nguyên từ header của server (nguồn sự thật về
  // tên bản xuất); chỉ khi header vắng/sai dạng mới tự dựng tên dự
  // phòng theo cùng quy ước để lượt tải vẫn chạy được.
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `ban-dac-ta-${matrixId.slice(0, 8)}.${format}`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Tạo ma trận mới trong bank ma trận cá nhân (POST /exam-matrices).
 *
 * @param body - Thân tạo ma trận.
 * @returns Ma trận vừa tạo.
 */
export function createMatrix(body: {
  name: string;
  subjectId: string;
  curriculumId: string;
  bankId: string;
  levelSet: 'three' | 'four';
  totalScore: number;
  isTemplate: boolean;
  status: string;
}) {
  return apiJson<MatrixLite>('/api/v1/exam-matrices', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Lưu thông tin chung của ma trận (PATCH /exam-matrices/:id).
 *
 * @param matrixId - Định danh ma trận.
 * @param body - Thân sửa.
 * @returns Đáp ứng của API.
 */
export function updateMatrix(
  matrixId: string,
  body: { name: string; status: string; isTemplate: boolean; totalScore: number; levelSet?: 'three' | 'four' },
) {
  return apiJson(`/api/v1/exam-matrices/${matrixId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/**
 * Thêm một ô vào ma trận (POST /exam-matrices/:id/cells).
 *
 * @param matrixId - Định danh ma trận.
 * @param body - Thân ô.
 * @returns Đáp ứng của API.
 */
export function addMatrixCell(
  matrixId: string,
  body: {
    curriculumNodeId: string;
    cognitiveLevel: string;
    qtype: string;
    questionCount: number;
    cellScore: number;
  },
) {
  return apiJson(`/api/v1/exam-matrices/${matrixId}/cells`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Xoá một ô khỏi ma trận (DELETE /exam-matrices/:id/cells/:cellId).
 *
 * @param matrixId - Định danh ma trận.
 * @param cellId - Định danh ô.
 * @returns Đáp ứng của API.
 */
export function deleteMatrixCell(matrixId: string, cellId: string) {
  return apiJson(`/api/v1/exam-matrices/${matrixId}/cells/${cellId}`, { method: 'DELETE' });
}

/**
 * Nhập ma trận từ file (lát I-3, issue #233) — ba thao tác web dùng,
 * đều đi qua API đã có của I-1/I-2, web không tự tính lại luật nào:
 *
 * Flow: (1) `downloadMatrixImportTemplate` tải workbook mẫu do server
 * sinh cho đúng (môn, chương trình, bộ mức) — giáo viên điền số vào
 * file này; (2) `previewMatrixImport` gửi file lên bước xem trước
 * (server parse + kiểm lỗi định vị + cảnh báo + khả dụng, KHÔNG ghi
 * DB); (3) `commitMatrixImport` gửi lại CHÍNH file đó lên bước ghi —
 * server parse lại từ đầu rồi mới ghi nguyên tử (lát I-2), nên web
 * không được gửi kèm kết quả xem trước như bằng chứng hợp lệ.
 * File là nguồn sự thật duy nhất ở cả hai bước sau.
 */

/**
 * Tải workbook mẫu nhập ma trận cho một (môn, chương trình, bộ mức).
 *
 * Flow: gọi endpoint template bằng `apiFetch` (giữ Response để đọc
 * header) → HTTP không ok thì ném lỗi ngay, không tải file rác →
 * đọc blob, giữ đúng tên file server trả trong Content-Disposition
 * (rơi xuống tên dự phòng cùng quy ước khi header vắng) → kích hoạt
 * tải xuống bằng thẻ neo ẩn rồi thu hồi URL tạm.
 *
 * Side-effect: phát một request GET và kích hoạt một lượt tải file;
 * không đổi trạng thái nào phía server/client.
 *
 * @param input - Môn + chương trình đã chọn; `includeAdvanced` tick
 *   thì mẫu có thêm cột Vận dụng cao (levelSet=four), không tick thì
 *   mẫu chỉ 3 mức CV 7991 (levelSet=three).
 * @returns Promise hoàn tất sau khi lượt tải đã được kích hoạt.
 */
export async function downloadMatrixImportTemplate(input: {
  subjectId: string;
  curriculumId: string;
  includeAdvanced: boolean;
}): Promise<void> {
  const params = new URLSearchParams({
    subjectId: input.subjectId,
    curriculumId: input.curriculumId,
    levelSet: input.includeAdvanced ? 'four' : 'three',
  });
  const res = await apiFetch(`/api/v1/exam-matrices/template?${params.toString()}`);
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename =
    /filename="([^"]+)"/.exec(disposition)?.[1] ?? `mau-ma-tran-${input.subjectId.slice(0, 8)}.xlsx`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Xem trước file nhập ma trận (bước 3 của wizard I-3).
 *
 * Gửi file trong multipart trường `file` (để trình duyệt tự đặt
 * Content-Type kèm boundary — ép JSON sẽ hỏng tải lên). Server luôn
 * trả 200 kể cả khi file sai khuôn: lỗi nằm trong payload
 * (`valid=false` + `errors[]` định vị theo sheet/dòng/cột), web hiển
 * thị bảng lỗi đó và khoá nút xác nhận — không tự kết luận hợp lệ
 * từ status HTTP.
 *
 * @param file - File .xlsx giáo viên đã điền (đúng file mẫu hệ sinh).
 * @returns Kết quả xem trước `MatrixImportPreview` của contracts.
 */
export async function previewMatrixImport(file: File): Promise<MatrixImportPreview> {
  const form = new FormData();
  form.append('file', file);
  return apiJson<MatrixImportPreview>('/api/v1/exam-matrices/import/preview', { method: 'POST', body: form });
}

/**
 * Ghi ma trận từ file đã xem trước (bước 4 của wizard I-3).
 *
 * Gửi lại CHÍNH file đã xem trước (không gửi kèm kết quả xem trước):
 * server parse lại từ đầu tại thời điểm ghi — file bị sửa tay sau
 * xem trước mà vi phạm luật thì server từ chối 422
 * `quiz.matrix_import_invalid` kèm `matrixImportIssues` định vị và
 * KHÔNG ghi một phần; gửi lại cùng nội dung thì server trả ma trận
 * đã có thay vì tạo bản thứ hai (chống ghi trùng của I-2).
 *
 * @param file - Cùng file .xlsx đã qua bước xem trước.
 * @returns View ma trận đã ghi (hoặc bản đã có khi trùng nội dung).
 * @throws ApiError 422 kèm `problem.matrixImportIssues` khi file
 *   không còn hợp lệ tại thời điểm ghi; 403 khi thiếu quyền tại môn.
 */
export async function commitMatrixImport(file: File): Promise<ExamMatrixView> {
  const form = new FormData();
  form.append('file', file);
  return apiJson<ExamMatrixView>('/api/v1/exam-matrices/import', { method: 'POST', body: form });
}
