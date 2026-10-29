import { Navigate, useLocation, useParams } from 'react-router';

/**
 * Nhóm tương thích cho họ Kho học liệu CŨ viết dính `/contentbank*`
 * (chuẩn đường dẫn #221, lát R3): tên tài nguyên viết tách là
 * "content-bank" nên cả ba path cũ chuyển hướng thay thế sang cây
 * `/content-bank*`, giữ nguyên phần query (trạng thái lọc nội bộ
 * của trang danh sách) như khuôn cây Đề ở trên. Tách khỏi file
 * chuyển hướng của cụm ngân hàng khi tổ chức lại apps/web theo
 * mô hình features/ (issue #500).
 */

/** Path cũ `/contentbank` → `/content-bank`. */
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
