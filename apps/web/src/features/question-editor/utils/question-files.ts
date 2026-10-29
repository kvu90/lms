/**
 * Hàm thuần của phía client hợp đồng file câu hỏi thuộc feature
 * question-editor. Tách từ module phẳng `src/lib/question-files.ts`
 * khi tổ chức lại apps/web theo mô hình features/ (issue #500).
 */

const QUESTION_FILE_SRC_PATTERN = /^\/api\/v1\/files\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/content$/;

/** Trích fileId từ định danh bền; null khi src không thuộc hệ files của câu hỏi. */
export function questionFileIdFromSrc(src: string): string | null {
  return QUESTION_FILE_SRC_PATTERN.exec(src)?.[1] ?? null;
}
