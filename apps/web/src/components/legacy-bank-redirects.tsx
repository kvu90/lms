import { Navigate, useParams } from 'react-router';

/**
 * Lớp tương thích đường dẫn CŨ của cụm ngân hàng (chuẩn đường dẫn,
 * issue #221 — mục 3.5 của hồ sơ chuẩn): URL cũ được chuyển hướng
 * THAY THẾ (replace) sang path mới tương ứng ngay khi khớp, để
 * bookmark/liên kết đã chia sẻ của giáo viên không gãy. Các query
 * thuộc diện F2 (lọc/prefill) ngoài bank/section được giữ nguyên khi
 * chuyển. Lớp tương thích giữ tối thiểu 2 chu kỳ phát hành rồi gỡ ở
 * lát R6 của hồ sơ.
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
    target = '/exam-papers';
  } else if (bank === 'my-matrices') {
    target = '/matrices';
  } else if (bank === 'system') {
    target =
      section === 'papers'
        ? '/system-bank/papers'
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
