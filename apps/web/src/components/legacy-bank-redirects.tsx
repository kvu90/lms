import { Navigate, useLocation, useParams } from 'react-router';

/**
 * Lớp tương thích đường dẫn CŨ của cụm ngân hàng và họ Kho học liệu
 * (chuẩn đường dẫn, issue #221 — mục 3.5 của hồ sơ chuẩn): URL cũ
 * được chuyển hướng THAY THẾ (replace) sang path mới tương ứng ngay
 * khi khớp, để bookmark/liên kết đã chia sẻ của giáo viên không gãy.
 * Các query thuộc diện F2 (lọc/prefill) ngoài bank/section được giữ
 * nguyên khi chuyển. Lớp tương thích giữ tối thiểu 2 chu kỳ phát
 * hành rồi gỡ ở lát R6 của hồ sơ.
 */

/**
 * Ánh xạ URL cũ `/questions?bank=...&section=...` sang path mới.
 * Trả null khi URL không mang tham số bank hợp lệ (không phải link
 * cũ — trang render bình thường).
 */
export function legacyQuestionsTarget(search: string): string | null {
  const params = new URLSearchParams(search);
  const bank = params.get('bank');
  if (!bank) return null;
  const section = params.get('section');
  let target: string | null = null;
  if (bank === 'my-questions') {
    target = section === 'stimuli' ? '/questions/stimuli' : '/questions';
  } else if (bank === 'my-papers') {
    target = '/exams';
  } else if (bank === 'my-matrices') {
    target = '/matrices';
  } else if (bank === 'system') {
    target =
      section === 'papers'
        ? '/system-bank/exams'
        : section === 'matrices'
          ? '/system-bank/matrices'
          : '/system-bank/questions';
  }
  if (!target) return null;
  params.delete('bank');
  params.delete('section');
  const rest = params.toString();
  return rest ? `${target}?${rest}` : target;
}

/** `/system-bank` (gốc) → trang Câu hỏi hệ thống. */
export function SystemBankIndexRedirect() {
  return <Navigate to="/system-bank/questions" replace />;
}

/** Path cũ `/questions/matrices/new` → `/matrices/new`. */
export function LegacyMatrixNewRedirect() {
  return <Navigate to="/matrices/new" replace />;
}

/** Path cũ `/questions/matrices/:matrixId/edit` → `/matrices/:matrixId/edit`. */
export function LegacyMatrixEditRedirect() {
  const { matrixId } = useParams();
  return <Navigate to={`/matrices/${matrixId}/edit`} replace />;
}

/**
 * Nhóm tương thích cho cây Đề CŨ `/exam-papers*`: tên tài nguyên đã
 * chốt là "exams" (Lão gia chốt tối 25/10/2026 — bỏ hậu tố "papers")
 * nên cả cây cũ chuyển hướng thay thế sang cây `/exams*`, giữ nguyên
 * phần query (prefill F2 như ?bank= khi tạo đề).
 */
export function LegacyExamPapersRedirect() {
  const location = useLocation();
  return <Navigate to={`/exams${location.search}`} replace />;
}

/** Path cũ `/exam-papers/new` → `/exams/new`. */
export function LegacyExamPaperNewRedirect() {
  const location = useLocation();
  return <Navigate to={`/exams/new${location.search}`} replace />;
}

/** Path cũ `/exam-papers/:paperId/edit` → `/exams/:paperId/edit`. */
export function LegacyExamPaperEditRedirect() {
  const { paperId } = useParams();
  const location = useLocation();
  return <Navigate to={`/exams/${paperId}/edit${location.search}`} replace />;
}

/** Path cũ `/system-bank/papers` → `/system-bank/exams`. */
export function LegacySystemBankPapersRedirect() {
  return <Navigate to="/system-bank/exams" replace />;
}

/**
 * Nhóm tương thích cho họ Kho học liệu CŨ viết dính `/contentbank*`
 * (chuẩn đường dẫn #221, lát R3): tên tài nguyên viết tách là
 * "content-bank" nên cả ba path cũ chuyển hướng thay thế sang cây
 * `/content-bank*`, giữ nguyên phần query (trạng thái lọc nội bộ
 * của trang danh sách) như khuôn cây Đề ở trên.
 */
export function LegacyContentBankRedirect() {
  const location = useLocation();
  return <Navigate to={`/content-bank${location.search}`} replace />;
}

/** Path cũ `/contentbank/new` → `/content-bank/new`. */
export function LegacyContentBankNewRedirect() {
  const location = useLocation();
  return <Navigate to={`/content-bank/new${location.search}`} replace />;
}

/** Path cũ `/contentbank/:id/edit` → `/content-bank/:id/edit`. */
export function LegacyContentBankEditRedirect() {
  const { id } = useParams();
  const location = useLocation();
  return <Navigate to={`/content-bank/${id}/edit${location.search}`} replace />;
}
