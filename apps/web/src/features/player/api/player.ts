import { apiJson } from '#lib/api';
import type { PlayerView } from '../types/player';

/**
 * Tầng gọi API thuần của trang học/player thuộc feature player:
 * chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay React
 * Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions, hook và đột biến. Tách từ module dữ liệu phẳng
 * `src/lib/player-data.ts` khi tổ chức lại apps/web theo mô hình
 * features/ (issue #500).
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
 * Đọc dữ liệu player (GET /courses/:id/player/:cmId); lỗi tải →
 * null, trang hiển thị lỗi tải như trước thay vì ném ra error
 * boundary.
 *
 * @param courseId - Định danh khoá.
 * @param cmId - Định danh module đang học.
 * @returns Dữ liệu player hoặc null khi lỗi tải.
 */
export function fetchPlayerView(courseId: string, cmId: string) {
  return probe<PlayerView>(`/api/v1/courses/${courseId}/player/${cmId}`);
}

/**
 * "Đánh dấu đã học" cho mục hoàn thành thủ công: trước hết probe
 * completion của chính người dùng để lấy userId (endpoint manual
 * đòi userId trong thân), rồi POST completion/manual với
 * complete=true — đúng hai bước của bản thủ công.
 *
 * @param courseId - Định danh khoá.
 * @param cmId - Định danh module.
 * @throws Error 'no user' khi không lấy được userId từ completion.
 */
export async function markPlayerModuleLearned(
  courseId: string | undefined,
  cmId: string | undefined,
) {
  const mine = await probe<{ course: { userId: string } }>(
    `/api/v1/courses/${courseId}/completion/me`,
  );
  const userId = mine?.course.userId;
  if (!userId) throw new Error('no user');
  await apiJson(`/api/v1/courses/${courseId}/modules/${cmId}/completion/manual`, {
    method: 'POST',
    body: JSON.stringify({ userId, complete: true }),
  });
}
