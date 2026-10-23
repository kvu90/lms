import type { Extensions } from '@tiptap/core';
import Bold from '@tiptap/extension-bold';
import Code from '@tiptap/extension-code';
import Document from '@tiptap/extension-document';
import Italic from '@tiptap/extension-italic';
import Paragraph from '@tiptap/extension-paragraph';
import Strike from '@tiptap/extension-strike';
import Text from '@tiptap/extension-text';
import Underline from '@tiptap/extension-underline';

/**
 * Bộ extension Tiptap cho lát văn bản thuần của rich text: node `doc`,
 * `paragraph`, `text` và các mark định dạng chữ cơ bản (`bold`, `italic`,
 * `strike`, `code`, `underline`).
 *
 * Bộ này là nguồn sự thật duy nhất về hình dạng tài liệu mà trình soạn thảo
 * ({@link RichTextEditor}) và trình hiển thị chỉ-đọc ({@link RichTextView})
 * cùng chấp nhận — khớp với `richTextDocumentSchema` của `@lms/contracts`.
 * Các node cần tài nguyên ngoài (ảnh, bảng, công thức...) không thuộc lát
 * này nên không được đăng ký ở đây.
 */
export const plainTextExtensions: Extensions = [
  Document,
  Paragraph,
  Text,
  Bold,
  Italic,
  Strike,
  Code,
  Underline,
];
