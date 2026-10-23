import { renderToReactElement } from '@tiptap/static-renderer/pm/react';
import type { ReactNode } from 'react';
import type { RichTextDocument } from '@lms/contracts';
import { plainTextExtensions } from './extensions.js';

/**
 * Thuộc tính của {@link RichTextView}.
 */
export interface RichTextViewProps {
  /** Tài liệu rich text cần hiển thị; `null` hoặc rỗng thì không hiển thị gì. */
  value: RichTextDocument | null;
}

/**
 * Kiểm tra tài liệu có nội dung chữ nào để hiển thị hay không: tài liệu
 * `null`, không có paragraph, hoặc mọi paragraph đều không chứa text node
 * có ký tự thì coi là rỗng.
 *
 * @param value - Tài liệu cần kiểm tra.
 * @returns `true` nếu tài liệu rỗng và không nên render gì.
 */
function isEmptyDocument(value: RichTextDocument): boolean {
  if (!value.content.length) {
    return true;
  }
  return value.content.every(
    (paragraph) =>
      !paragraph.content?.length ||
      paragraph.content.every((node) => node.text.trim() === ''),
  );
}

/**
 * Hiển thị chỉ-đọc một tài liệu rich text mà không tạo instance trình soạn
 * thảo: dùng static renderer của Tiptap (`renderToReactElement` từ
 * `@tiptap/static-renderer/pm/react`) để biến tài liệu JSON thành React
 * element theo đúng bộ extension của lát văn bản thuần.
 *
 * @param props - Thuộc tính: tài liệu cần hiển thị.
 * @returns React element của tài liệu, hoặc `null` khi tài liệu rỗng.
 */
export function RichTextView({ value }: RichTextViewProps): ReactNode {
  if (!value || isEmptyDocument(value)) {
    return null;
  }
  return renderToReactElement({
    extensions: plainTextExtensions,
    content: value,
  });
}
