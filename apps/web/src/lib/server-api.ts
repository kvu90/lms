/**
 * Điểm chạm phía SERVER của các loader (SSR, Giai đoạn 3–4 của issue #7).
 *
 * Loader chạy trong tiến trình SSR và gọi API qua địa chỉ nội bộ
 * (topology C: API ở cùng máy/dyno, địa chỉ mặc định 127.0.0.1:3000,
 * ghi đè bằng biến môi trường `LMS_API_INTERNAL_URL`) — KHÔNG vòng qua
 * URL công khai của chính app. Module này chỉ được loader import;
 * React Router tự loại loader khỏi bản build phía client nên mã này
 * không chạy trên trình duyệt.
 */
export function apiInternalBase(): string {
  return process.env.LMS_API_INTERNAL_URL ?? 'http://127.0.0.1:3000';
}

/** Gọi API nội bộ và parse JSON; mọi lỗi (mạng, status) đều trả null để loader suy biến mềm thay vì làm sập trang. */
export async function fetchApiJson(path: string, headers?: Record<string, string>): Promise<unknown> {
  try {
    const res = await fetch(`${apiInternalBase()}${path}`, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Cơ chế loader dữ liệu theo danh tính cookie (Giai đoạn 4): chuyển
 * NGUYÊN header Cookie của chính request đang phục vụ sang API nội bộ —
 * loader của một route chỉ bao giờ lấy được dữ liệu mà đúng cookie đó
 * được phép thấy, không có đường nào lấy dữ liệu của người khác. Không
 * có cookie thì không gọi API và trả null (trang suy biến về hành vi tải
 * phía client như trước). Endpoint dữ liệu hiện hành gác bằng Bearer
 * JWT (token ở localStorage, server không đọc được) nên với phiên
 * cookie `lms_session`, helper này tới được các endpoint phiên; khi
 * Giai đoạn 2 bật phiên Better Auth (cookie được guard dịch thành
 * danh tính cho mọi endpoint), cùng helper này tự lấy được dữ liệu
 * trang thật phía server mà không phải sửa thêm.
 */
export async function fetchApiJsonForRequest(request: Request, path: string): Promise<unknown> {
  const cookie = request.headers.get('Cookie') ?? '';
  if (!cookie) return null;
  return fetchApiJson(path, { Cookie: cookie });
}
