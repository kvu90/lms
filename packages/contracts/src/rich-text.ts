import { z } from 'zod';

/**
 * Rich text contracts — tài liệu Tiptap JSON là định dạng nội dung giàu duy
 * nhất giữa api và web (đề câu hỏi, đáp án, feedback, ngữ liệu...).
 *
 * Lát hiện tại gồm: `doc` chứa các node block (`paragraph`, `bulletList`,
 * `blockMath`, `image`); paragraph chứa các node inline (`text`,
 * `inlineMath`) với các mark cơ bản (bold, italic, strike, code, underline);
 * `bulletList` chứa `listItem`, mỗi `listItem` chứa các node block (đệ quy
 * cho danh sách lồng nhau). Công thức toán lưu bằng node `inlineMath` /
 * `blockMath` mang `attrs.latex` là mã LaTeX — LaTeX là nguồn sự thật,
 * bản render chỉ là phái sinh. Mọi node/mark ngoài lát này (heading, table,
 * orderedList...) đều bị schema TỪ CHỐI ở biên — muốn mở rộng phải nới
 * schema ở đây trước, không tự chế shape ở tầng nghiệp vụ hay giao diện.
 */

/** Một mark định dạng chữ cơ bản trên một đoạn text (Tiptap mark). */
export const richTextMarkSchema = z.strictObject({
  type: z.enum(['bold', 'italic', 'strike', 'code', 'underline']),
});
/** Mark định dạng chữ cơ bản của rich text. */
export type RichTextMark = z.infer<typeof richTextMarkSchema>;

/** Một node text của Tiptap: chuỗi ký tự thuần kèm marks tuỳ chọn. */
export const richTextTextNodeSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
  marks: z.array(richTextMarkSchema).optional(),
});
/** Node text trong tài liệu rich text. */
export type RichTextTextNode = z.infer<typeof richTextTextNodeSchema>;

/** Thuộc tính của một node công thức: mã LaTeX là nội dung duy nhất. */
export const richTextMathAttrsSchema = z.strictObject({
  latex: z.string(),
});
/** Thuộc tính của node công thức rich text. */
export type RichTextMathAttrs = z.infer<typeof richTextMathAttrsSchema>;

/** Một công thức nằm trong dòng văn bản (node inline của Tiptap Mathematics). */
export const richTextInlineMathNodeSchema = z.strictObject({
  type: z.literal('inlineMath'),
  attrs: richTextMathAttrsSchema,
});
/** Node công thức trong dòng trong tài liệu rich text. */
export type RichTextInlineMathNode = z.infer<typeof richTextInlineMathNodeSchema>;

/** Một công thức đứng riêng một dòng (node block của Tiptap Mathematics). */
export const richTextBlockMathNodeSchema = z.strictObject({
  type: z.literal('blockMath'),
  attrs: richTextMathAttrsSchema,
});
/** Node công thức tách dòng trong tài liệu rich text. */
export type RichTextBlockMathNode = z.infer<typeof richTextBlockMathNodeSchema>;

/** Mọi node có thể nằm trong một paragraph: chữ thuần hoặc công thức trong dòng. */
export const richTextInlineNodeSchema = z.union([
  richTextTextNodeSchema,
  richTextInlineMathNodeSchema,
]);
/** Node inline trong tài liệu rich text. */
export type RichTextInlineNode = z.infer<typeof richTextInlineNodeSchema>;

/**
 * Một node paragraph của Tiptap: chứa các node inline; paragraph rỗng có
 * thể không mang `content` (đúng dạng Tiptap sinh ra) hoặc mang mảng rỗng.
 */
export const richTextParagraphNodeSchema = z.strictObject({
  type: z.literal('paragraph'),
  content: z.array(richTextInlineNodeSchema).optional(),
});
/** Node paragraph trong tài liệu rich text. */
export type RichTextParagraphNode = z.infer<typeof richTextParagraphNodeSchema>;

/**
 * Một node ảnh của Tiptap: `src` là URL/định danh mà bề mặt chứa đã phân
 * giải qua module files của hệ (editor không tự gọi API files); `alt` và
 * `title` có thể `null` đúng như Tiptap sinh ra.
 */
export const richTextImageNodeSchema = z.strictObject({
  type: z.literal('image'),
  attrs: z.strictObject({
    src: z.string().min(1),
    alt: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
  }),
});
/** Node ảnh trong tài liệu rich text. */
export type RichTextImageNode = z.infer<typeof richTextImageNodeSchema>;

/** Một mục của danh sách không thứ tự: chứa các node block (đệ quy). */
export interface RichTextListItemNode {
  type: 'listItem';
  /** Các block trong mục: paragraph đầu và các block tiếp nối (kể cả danh sách con). */
  content: RichTextBlockNode[];
}

/** Một danh sách không thứ tự: chứa ít nhất một mục. */
export interface RichTextBulletListNode {
  type: 'bulletList';
  /** Các mục của danh sách. */
  content: RichTextListItemNode[];
}

/** Mọi node block có thể nằm trực tiếp trong `doc` hoặc trong một `listItem`. */
export type RichTextBlockNode =
  | RichTextParagraphNode
  | RichTextBulletListNode
  | RichTextBlockMathNode
  | RichTextImageNode;

/** Schema của một mục danh sách; đệ quy qua {@link richTextBlockNodeSchema}. */
export const richTextListItemNodeSchema: z.ZodType<RichTextListItemNode> = z.lazy(() =>
  z.strictObject({
    type: z.literal('listItem'),
    content: z.array(richTextBlockNodeSchema).min(1),
  }),
);

/** Schema của một danh sách không thứ tự. */
export const richTextBulletListNodeSchema: z.ZodType<RichTextBulletListNode> =
  z.strictObject({
    type: z.literal('bulletList'),
    content: z.array(richTextListItemNodeSchema).min(1),
  });

/** Schema của mọi node block trong lát rich text hiện tại. */
export const richTextBlockNodeSchema: z.ZodType<RichTextBlockNode> = z.union([
  richTextParagraphNodeSchema,
  richTextBulletListNodeSchema,
  richTextBlockMathNodeSchema,
  richTextImageNodeSchema,
]);

/** Một tài liệu rich text hoàn chỉnh: node gốc `doc` chứa ít nhất một block. */
export const richTextDocumentSchema = z.strictObject({
  type: z.literal('doc'),
  content: z.array(richTextBlockNodeSchema).min(1),
});
/** Tài liệu rich text (Tiptap JSON) đã chuẩn hoá — dạng duy nhất ở view/trả ra. */
export type RichTextDocument = z.infer<typeof richTextDocumentSchema>;

/**
 * Đầu vào rich text ở biên tạo/sửa: nhận chuỗi thuần (tầng nghiệp vụ chuẩn
 * hoá thành tài liệu một paragraph) hoặc một tài liệu Tiptap đã đúng lát.
 */
export const richTextInputSchema = z.union([z.string(), richTextDocumentSchema]);
/** Đầu vào rich text: chuỗi thuần hoặc tài liệu Tiptap. */
export type RichTextInput = z.infer<typeof richTextInputSchema>;

/** Tài liệu rich text rỗng chuẩn: một `doc` chứa đúng một paragraph rỗng. */
export const emptyRichTextDocument: RichTextDocument = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

/**
 * Chuẩn hoá đầu vào rich text thành tài liệu Tiptap.
 *
 * Chuỗi rỗng cho ra tài liệu rỗng chuẩn (một paragraph rỗng); chuỗi thường
 * cho ra một paragraph chứa một text node; tài liệu truyền vào được parse
 * lại qua schema để đảm bảo an toàn ở biên (node ngoài lát bị từ chối).
 */
export function toRichTextDocument(input: string | RichTextDocument): RichTextDocument {
  if (typeof input === 'string') {
    if (input === '') {
      return { type: 'doc', content: [{ type: 'paragraph' }] };
    }
    return {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: input }] }],
    };
  }
  return richTextDocumentSchema.parse(input);
}

/**
 * Trích phần chữ của một block cho bản text thuần: paragraph cho chữ của
 * các node inline (công thức trong dòng đóng góp mã LaTeX của nó, đúng vị
 * trí trong câu); blockMath cho mã LaTeX; ảnh cho chữ thay thế `alt` (rỗng
 * khi không có); danh sách cho chữ của từng mục, các mục cách nhau bằng
 * xuống dòng.
 */
function extractBlockPlainText(block: RichTextBlockNode): string {
  switch (block.type) {
    case 'paragraph':
      return (block.content ?? [])
        .map((node) => (node.type === 'text' ? node.text : node.attrs.latex))
        .join('');
    case 'blockMath':
      return block.attrs.latex;
    case 'image':
      return block.attrs.alt ?? '';
    case 'bulletList':
      return block.content
        .map((item) => item.content.map(extractBlockPlainText).join('\n'))
        .join('\n');
  }
}

/**
 * Trích văn bản thuần từ một tài liệu rich text: nối chữ của từng block,
 * các block cách nhau bằng ký tự xuống dòng; paragraph rỗng cho ra một
 * dòng rỗng. Đây là bản text canonical dùng cho tìm kiếm, kiểm tra rỗng
 * và neo danh tính nội dung — công thức đóng góp mã LaTeX của nó nên nội
 * dung có công thức không bao giờ trích ra rỗng hay mất phần công thức.
 */
export function extractRichTextPlainText(doc: RichTextDocument): string {
  return doc.content.map(extractBlockPlainText).join('\n');
}
