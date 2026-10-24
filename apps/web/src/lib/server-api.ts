/**
 * Điểm chạm phía SERVER của các loader (SSR, Giai đoạn 3 của issue #7).
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
