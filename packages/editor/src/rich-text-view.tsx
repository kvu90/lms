import { renderToReactElement } from '@tiptap/static-renderer/pm/react';
import { Fragment, type ReactNode } from 'react';
import type { RichTextBlockNode, RichTextDocument } from '@lms/contracts';
import { plainTextExtensions } from './extensions.js';
import { renderMathHtml } from './math.js';

/**
 * Thuộc tính của {@link RichTextView}.
 */
export interface RichTextViewProps {
  /** Tài liệu rich text cần hiển thị; `null` hoặc rỗng thì không hiển thị gì. */
  value: RichTextDocument | null;
}

/**
 * Một block có nội dung để hiển thị hay không: paragraph cần chữ hoặc một
 * công thức; blockMath cần mã LaTeX; ảnh tự nó đã là nội dung; danh sách
 * cần ít nhất một mục có nội dung.
 *
 * @param block - Block cần kiểm tra.
 * @returns `true` nếu block có nội dung hiển thị.
 */
function blockHasContent(block: RichTextBlockNode): boolean {
  switch (block.type) {
    case 'paragraph':
      return (block.content ?? []).some((node) =>
        node.type === 'text' ? node.text.trim() !== '' : node.attrs.latex.trim() !== '',
      );
    case 'blockMath':
      return block.attrs.latex.trim() !== '';
    case 'image':
      return true;
    case 'bulletList':
      return block.content.some((item) => item.content.some(blockHasContent));
    case 'statementList':
      return block.content.some((statement) => statement.content.some(blockHasContent));
  }
}

/**
 * Kiểm tra tài liệu có nội dung nào để hiển thị hay không.
 *
 * @param value - Tài liệu cần kiểm tra.
 * @returns `true` nếu tài liệu rỗng và không nên render gì.
 */
function isEmptyDocument(value: RichTextDocument): boolean {
  return !value.content.some(blockHasContent);
}

/**
 * Render một tài liệu KHÔNG chứa `statementList` bằng static renderer
 * của Tiptap theo bộ extension của hợp đồng; hai node công thức được
 * ánh xạ thủ công sang KaTeX (xem {@link RichTextView}).
 *
 * @param value - Tài liệu thuần cần render.
 * @returns React element của tài liệu.
 */
function renderPlainDocument(value: RichTextDocument): ReactNode {
  return renderToReactElement({
    extensions: plainTextExtensions,
    content: value,
    options: {
      nodeMapping: {
        inlineMath: ({ node }) => {
          const latex = typeof node.attrs.latex === 'string' ? node.attrs.latex : '';
          return (
            <span
              data-type="inline-math"
              data-latex={latex}
              dangerouslySetInnerHTML={{ __html: renderMathHtml(latex, false) }}
            />
          );
        },
        blockMath: ({ node }) => {
          const latex = typeof node.attrs.latex === 'string' ? node.attrs.latex : '';
          return (
            <div
              data-type="block-math"
              data-latex={latex}
              dangerouslySetInnerHTML={{ __html: renderMathHtml(latex, true) }}
            />
          );
        },
      },
    },
  });
}

/**
 * Hiển thị chỉ-đọc một tài liệu rich text mà không tạo instance trình soạn
 * thảo: dùng static renderer của Tiptap (`renderToReactElement` từ
 * `@tiptap/static-renderer/pm/react`) theo đúng bộ extension của hợp đồng.
 *
 * Riêng hai node công thức được ánh xạ thủ công: static renderer mặc định
 * chỉ cho ra thẻ chứa `data-latex` mà không có hình công thức, nên ở đây
 * render thẳng bằng KaTeX (`trust: false`, một công thức lỗi không làm
 * sập cả trang). Ảnh và danh sách đi qua `renderHTML` của extension.
 *
 * Tài liệu thân câu đúng/sai chùm (TF-A) mang node `statementList` —
 * node này KHÔNG thuộc bộ extension hiển thị thuần, nên tài liệu được
 * tách tại các `statementList`: các block thường render bằng static
 * renderer như trên, mỗi danh sách mệnh đề render thành một `<ol>` mà
 * từng mệnh đề là một {@link RichTextView} đệ quy trên nội dung của
 * chính mệnh đề đó (hiển thị đủ thân câu + 4 mệnh đề cho bề mặt xem
 * tĩnh chung; bề mặt làm bài/xem lại có trình bày riêng theo mệnh đề).
 *
 * @param props - Thuộc tính: tài liệu cần hiển thị.
 * @returns React element của tài liệu, hoặc `null` khi tài liệu rỗng.
 */
export function RichTextView({ value }: RichTextViewProps): ReactNode {
  if (!value || isEmptyDocument(value)) {
    return null;
  }
  if (!value.content.some((block) => block.type === 'statementList')) {
    return renderPlainDocument(value);
  }
  const segments: ReactNode[] = [];
  let buffer: RichTextBlockNode[] = [];
  const flush = (key: string) => {
    if (buffer.length > 0) {
      const blocks = buffer;
      buffer = [];
      segments.push(
        <Fragment key={key}>{renderPlainDocument({ type: 'doc', content: blocks })}</Fragment>,
      );
    }
  };
  value.content.forEach((block, index) => {
    if (block.type !== 'statementList') {
      buffer.push(block);
      return;
    }
    flush(`stem-${index}`);
    segments.push(
      <ol key={`statements-${index}`} className="lms-statement-list">
        {block.content.map((statement) => (
          <li key={statement.attrs.id} data-statement={statement.attrs.id}>
            <RichTextView value={{ type: 'doc', content: statement.content }} />
          </li>
        ))}
      </ol>,
    );
  });
  flush('tail');
  return <>{segments}</>;
}
