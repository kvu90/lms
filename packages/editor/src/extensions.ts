import type { Editor, Extensions } from '@tiptap/core';
import Bold from '@tiptap/extension-bold';
import Code from '@tiptap/extension-code';
import Document from '@tiptap/extension-document';
import Image from '@tiptap/extension-image';
import Italic from '@tiptap/extension-italic';
import { BulletList, ListItem } from '@tiptap/extension-list';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import Paragraph from '@tiptap/extension-paragraph';
import Strike from '@tiptap/extension-strike';
import Text from '@tiptap/extension-text';
import Underline from '@tiptap/extension-underline';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import './math.js';

/**
 * Đảm bảo có một paragraph để viết tiếp ngay sau block đang được chọn
 * (công thức tách dòng, ảnh): nếu block tiếp theo đã là một paragraph
 * trống thì chỉ chuyển con trỏ vào đó; chưa có thì chèn một paragraph
 * trống mới. Dùng cho phím Enter khi một block nguyên tử đang được chọn —
 * mặc định ProseMirror không tạo được dòng mới từ vị trí đó.
 *
 * @param editor - Trình soạn thảo hiện tại.
 * @param nodeName - Tên node block đang xét (`blockMath` hoặc `image`).
 * @returns `true` nếu đã xử lý (có paragraph tiếp nối và con trỏ đã vào đó).
 */
function ensureContinuationParagraph(editor: Editor, nodeName: string): boolean {
  const { selection, doc, schema } = editor.state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== nodeName) {
    return false;
  }
  const paragraphType = schema.nodes.paragraph;
  if (!paragraphType) {
    return false;
  }
  const pos = selection.from;
  const afterPos = pos + selection.node.nodeSize;
  const $pos = doc.resolve(pos);
  const index = $pos.index();
  const nextNode = $pos.parent.maybeChild(index + 1);
  if (nextNode?.type === paragraphType && nextNode.content.size === 0) {
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(doc, afterPos + 1)).scrollIntoView(),
    );
    return true;
  }
  if (!$pos.parent.canReplaceWith(index + 1, index + 1, paragraphType)) {
    return false;
  }
  const paragraph = paragraphType.createAndFill();
  if (!paragraph) {
    return false;
  }
  const transaction = editor.state.tr.insert(afterPos, paragraph);
  transaction.setSelection(TextSelection.create(transaction.doc, afterPos + 1));
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

/** BlockMath có thêm phím Enter để xuống dòng viết tiếp sau công thức. */
const ContinuableBlockMath = BlockMath.extend({
  addKeyboardShortcuts() {
    return {
      Enter: () => ensureContinuationParagraph(this.editor, 'blockMath'),
    };
  },
});

/**
 * Image có thêm phím Enter để xuống dòng viết tiếp sau ảnh, và tập thuộc
 * tính bị thu đúng về hợp đồng contracts (`src`/`alt`/`title`):
 * extension gốc còn khai `width`/`height` — để chúng lọt vào tài liệu
 * thì `richTextImageNodeSchema` (strictObject) sẽ từ chối tài liệu ở
 * biên API, nên ở đây khai lại đúng ba thuộc tính của hợp đồng.
 */
const ContinuableImage = Image.extend({
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    };
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => ensureContinuationParagraph(this.editor, 'image'),
    };
  },
});

/**
 * Bộ extension Tiptap của hợp đồng rich text: node `doc`, `paragraph`,
 * `text`, các mark định dạng chữ cơ bản (`bold`, `italic`, `strike`,
 * `code`, `underline`), danh sách không thứ tự (`bulletList`/`listItem`),
 * công thức toán (`inlineMath`/`blockMath` của extension Mathematics,
 * render bằng KaTeX) và ảnh (`image`).
 *
 * Bộ này là nguồn sự thật duy nhất về hình dạng tài liệu mà trình soạn
 * thảo ({@link RichTextEditor}) và trình hiển thị chỉ-đọc
 * ({@link RichTextView}) cùng chấp nhận — khớp với
 * `richTextDocumentSchema` của `@lms/contracts`. Thêm node/mark mới là
 * thay đổi hợp đồng nội dung: phải nới schema ở contracts trong cùng feat
 * và có đường render tương ứng ở phía xem.
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
  BulletList,
  ListItem,
  InlineMath.configure({
    katexOptions: { displayMode: false, throwOnError: false },
  }),
  ContinuableBlockMath.configure({
    katexOptions: { displayMode: true, throwOnError: false },
  }),
  ContinuableImage.configure({ allowBase64: false }),
];
