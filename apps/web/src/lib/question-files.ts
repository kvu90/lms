import { useQuery } from '@tanstack/react-query';
import { apiFetch, apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Nối editor câu hỏi với module files của hệ (issue #248, lát QE-2):
 * ảnh nhúng trong nội dung câu hỏi được lưu bằng ĐỊNH DANH BỀN
 * (`/api/v1/files/<id>/content`) trong tài liệu rich text; URL hiển thị
 * thật (URL ký, hạn 300 giây) do server phát ở bề mặt đọc. File này là
 * phía client của hợp đồng đó: tải ảnh lên, đổi định danh sang URL ký
 * khi cần hiển thị ngoài luồng phục vụ của server.
 */

export const QUESTION_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const QUESTION_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export type QuestionFileArea = 'questiontext' | 'generalfeedback' | 'answer' | 'feedback' | 'stimulus' | 'guidance';

/** Kết quả tải ảnh — chính là thứ callback `onRequestImage` của editor QE-1 chờ nhận. */
export interface QuestionImageUploadResult {
  fileId: string;
  /** Định danh bền để chèn vào attrs.src của node image trong tài liệu. */
  src: string;
  alt: string;
  fileName: string;
  mimeType: string;
}

export class QuestionImageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'QuestionImageError';
    this.code = code;
  }
}

const QUESTION_FILE_SRC_PATTERN = /^\/api\/v1\/files\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/content$/;

/** Trích fileId từ định danh bền; null khi src không thuộc hệ files của câu hỏi. */
export function questionFileIdFromSrc(src: string): string | null {
  return QUESTION_FILE_SRC_PATTERN.exec(src)?.[1] ?? null;
}

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

/**
 * Hook hiển thị cho src lưu trong tài liệu: src không phải định danh bền
 * của hệ (URL ngoài, URL ký server đã phát sẵn) thì dùng nguyên; định danh
 * bền thì đổi sang URL ký và làm mới trước khi hết hạn (hạn ký 300 giây,
 * staleTime 240 giây).
 */
export function useResolvedFileSrc(src: string | undefined): string | undefined {
  const fileId = src ? questionFileIdFromSrc(src) : null;
  const query = useQuery({
    queryKey: queryKeys.questionFileSrc(fileId),
    queryFn: () => resolveFileDisplayUrl(fileId as string),
    enabled: fileId !== null,
    staleTime: 240_000,
  });
  if (!src || fileId === null) return src;
  return query.data ?? src;
}
