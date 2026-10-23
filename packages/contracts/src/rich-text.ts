import { z } from 'zod';

/**
 * Rich text contracts — tài liệu Tiptap JSON là định dạng nội dung giàu duy
 * nhất giữa api và web (đề câu hỏi, đáp án, feedback, ngữ liệu...).
 *
 * Lát hiện tại CHỈ gồm văn bản thuần: `doc` → `paragraph` → `text` với các
 * mark cơ bản (bold, italic, strike, code, underline). Mọi node/mark ngoài
 * lát này (image, heading, list, table, mathematics...) đều bị schema TỪ
 * CHỐI ở biên — muốn mở rộng phải nới schema ở đây trước, không tự chế
 * shape ở tầng nghiệp vụ hay giao diện.
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

/**
 * Một node paragraph của Tiptap: chứa các text node; paragraph rỗng có thể
 * không mang `content` (đúng dạng Tiptap sinh ra) hoặc mang mảng rỗng.
 */
export const richTextParagraphNodeSchema = z.strictObject({
  type: z.literal('paragraph'),
  content: z.array(richTextTextNodeSchema).optional(),
});
/** Node paragraph trong tài liệu rich text. */
export type RichTextParagraphNode = z.infer<typeof richTextParagraphNodeSchema>;

/** Một tài liệu rich text hoàn chỉnh: node gốc `doc` chứa ít nhất một paragraph. */
export const richTextDocumentSchema = z.strictObject({
  type: z.literal('doc'),
  content: z.array(richTextParagraphNodeSchema).min(1),
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
 * Trích văn bản thuần từ một tài liệu rich text: nối text trong từng
 * paragraph, các paragraph cách nhau bằng ký tự xuống dòng; paragraph rỗng
 * cho ra một dòng rỗng.
 */
export function extractRichTextPlainText(doc: RichTextDocument): string {
  return doc.content
    .map((paragraph) => (paragraph.content ?? []).map((node) => node.text).join(''))
    .join('\n');
}
