import type { RichTextBlockNode, RichTextDocument } from '@lms/contracts';

/**
 * Các node block nguyên tử mà sau chúng người soạn không gõ tiếp được
 * nếu không có một paragraph tiếp nối: công thức tách dòng và ảnh.
 * Khớp tập block mà phím Enter của `extensions.ts` đã xử lý
 * (`blockMath`/`image`); bảng thuộc lát E5 nên chưa nằm trong tập này.
 */
const CONTINUATION_BLOCK_TYPES: ReadonlySet<string> = new Set(['blockMath', 'image']);

/** Một node có phải paragraph rỗng (không nội dung con) hay không. */
function isEmptyParagraph(node: RichTextBlockNode | undefined): boolean {
  return node?.type === 'paragraph' && (node.content === undefined || node.content.length === 0);
}

/**
 * Đảm bảo tài liệu KẾT THÚC bằng một paragraph để người soạn viết tiếp
 * được khi node cuối là một block nguyên tử (công thức tách dòng/ảnh):
 * tài liệu đã kết thúc bằng paragraph (rỗng hay có chữ) thì giữ nguyên,
 * còn lại thì thêm đúng một paragraph rỗng vào cuối. Áp lúc tạo editor
 * và lúc đồng bộ nội dung từ bên ngoài — theo đúng
 * `ensureTerminalContinuations` của editor giaokhoa.
 *
 * @param document - Tài liệu cần chuẩn hoá.
 * @returns Tài liệu đã bảo đảm có paragraph chốt đuôi (cùng tham chiếu
 *   khi không cần đổi gì).
 */
export function ensureTerminalContinuation(document: RichTextDocument): RichTextDocument {
  const content = document.content ?? [];
  const last = content[content.length - 1];
  if (!last || last.type === 'paragraph' || !CONTINUATION_BLOCK_TYPES.has(last.type)) {
    return document;
  }
  return { ...document, content: [...content, { type: 'paragraph' }] };
}

/**
 * Dạng tài liệu ĐEM LƯU của một tài liệu trong editor: bỏ các paragraph
 * rỗng tiếp nối nằm ở cuối tài liệu ngay sau một block nguyên tử — đó
 * là paragraph kỹ thuật do {@link ensureTerminalContinuation} và phím
 * Enter sinh ra để người soạn viết tiếp, không phải nội dung người soạn
 * chủ ý để lại (theo đúng `contentForSave` của editor giaokhoa). Mọi
 * paragraph rỗng còn lại (đứng sau đoạn văn thường, hoặc đã có chữ) đều
 * được giữ nguyên. Tài liệu bị rút tới rỗng thì trả về một paragraph
 * rỗng duy nhất — hình dạng tài liệu rỗng của hợp đồng.
 *
 * @param document - Tài liệu thô do editor sinh ra (`getJSON()`).
 * @returns Tài liệu đã vệ sinh, sẵn sàng phát qua `onChange`/đem lưu.
 */
export function contentForSave(document: RichTextDocument): RichTextDocument {
  const content = [...(document.content ?? [])];
  while (
    content.length > 1 &&
    isEmptyParagraph(content[content.length - 1]) &&
    CONTINUATION_BLOCK_TYPES.has(content[content.length - 2]?.type ?? '')
  ) {
    content.pop();
  }
  if (content.length === 0) {
    content.push({ type: 'paragraph' });
  }
  return { ...document, content };
}
