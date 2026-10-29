import { apiFetch, apiJson } from '#lib/api';
import {
  QUESTION_IMAGE_MAX_BYTES,
  QuestionImageError,
  type QuestionFileArea,
  type QuestionImageUploadResult,
} from '../types/question-files';

/**
 * Tầng gọi API thuần của phía client hợp đồng file câu hỏi thuộc
 * feature question-editor: chỉ chứa các hàm gọi HTTP, không phụ
 * thuộc React hay React Query. Tách từ module phẳng
 * `src/lib/question-files.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 */

interface UploadResponseBody { id: string; src: string; fileName: string; mimeType: string }
interface ErrorBody { code?: string; message?: string }

/**
 * Tải MỘT ảnh vào context của bank chứa câu. Kiểm tra trần dung lượng và
 * họ ảnh ở client chỉ để báo lỗi sớm — server kiểm lại bằng magic bytes
 * và là phía quyết định cuối cùng.
 */
export async function uploadQuestionImage(
  file: File,
  opts: { contextId: string; fileArea?: QuestionFileArea; itemId?: string },
): Promise<QuestionImageUploadResult> {
  if (file.size > QUESTION_IMAGE_MAX_BYTES) {
    throw new QuestionImageError('file.image_too_large', 'Ảnh vượt quá 8 MB');
  }
  if (!file.type.startsWith('image/')) {
    throw new QuestionImageError('file.not_image', 'Tệp được chọn không phải là ảnh');
  }
  const form = new FormData();
  form.append('file', file);
  form.append('contextId', opts.contextId);
  form.append('fileArea', opts.fileArea ?? 'questiontext');
  if (opts.itemId) form.append('itemId', opts.itemId);
  const res = await apiFetch('/api/v1/files/question-image', { method: 'POST', body: form });
  const body = (await res.json().catch(() => null)) as (UploadResponseBody & ErrorBody) | null;
  if (!res.ok || !body?.id) {
    throw new QuestionImageError(body?.code ?? 'file.upload_failed', body?.message ?? 'Tải ảnh lên thất bại');
  }
  return { fileId: body.id, src: body.src, alt: file.name.replace(/\.[^.]+$/, ''), fileName: body.fileName, mimeType: body.mimeType };
}

/** Đổi một fileId thành URL ký còn hạn (cổng files:view tại context của file). */
export async function resolveFileDisplayUrl(fileId: string): Promise<string> {
  const { url } = await apiJson<{ url: string; expiresAt: number }>(`/api/v1/files/${fileId}/signed-url`, { method: 'POST' });
  return url;
}
