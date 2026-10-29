/**
 * Hằng và kiểu của phía client hợp đồng file câu hỏi thuộc
 * feature question-editor. Tách từ module phẳng
 * `src/lib/question-files.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500): hằng/kiểu nằm ở tầng types/, lời
 * gọi API thuần ở tầng api/, hàm thuần ở tầng utils/, hook hiển
 * thị ở tầng queries/.
 *
 * Bối cảnh hợp đồng (issue #248, lát QE-2): ảnh nhúng trong nội
 * dung câu hỏi được lưu bằng ĐỊNH DANH BỀN
 * (`/api/v1/files/<id>/content`) trong tài liệu rich text; URL
 * hiển thị thật (URL ký, hạn 300 giây) do server phát ở bề mặt
 * đọc.
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
