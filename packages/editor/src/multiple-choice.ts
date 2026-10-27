import { Extension, mergeAttributes, Node, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { RichTextDocument } from '@lms/contracts';
import { plainTextExtensions } from './extensions.js';

/**
 * Tài liệu THỐNG NHẤT phía soạn của câu trắc nghiệm (multichoice) —
 * port theo mô hình editor giaokhoa (quyết 12:04 ngày 26/10/2026,
 * điều chỉnh bởi quyết 12:12 cùng ngày).
 *
 * Flow tổng thể của module này:
 *
 * 1. Giáo viên soạn thân câu và cả bốn lựa chọn trong MỘT tài liệu
 *    Tiptap duy nhất: các block nội dung của thân câu, chốt đuôi bằng
 *    đúng một node `choiceList` chứa đúng {@link MULTIPLE_CHOICE_COUNT}
 *    node `choice` (mỗi `choice` mang `attrs.id` ổn định trong vòng
 *    soạn). Đáp án đúng KHÔNG nằm trong tài liệu: nó là metadata có cấu
 *    trúc ở ngoài — id của choice đúng (`correctChoiceId`), do
 *    `MultipleChoiceEditor` giữ qua radio widget cạnh từng choice.
 * 2. Khi nạp một câu có sẵn, {@link composeMultipleChoiceDocument} lắp
 *    view của API (thân câu + các dòng answers) thành tài liệu thống
 *    nhất (id của choice = id của dòng answers tương ứng).
 * 3. Khi lưu, {@link splitMultipleChoiceDocument} tách tài liệu thống
 *    nhất về đúng hình dạng hợp đồng: phần thân câu (tài liệu rich
 *    text KHÔNG còn node choice) đem vào `questionText`, từng choice
 *    theo đúng thứ tự trong tài liệu thành một dòng answers
 *    (`text` = tài liệu của choice, `correct` = id khớp
 *    `correctChoiceId`). Guidance/lời giải KHÔNG đi qua module này —
 *    chúng là trường soạn riêng ở form và payload gắn ở tầng trang
 *    vào `answer_key` theo hợp đồng.
 *
 * Bất biến quan trọng: tài liệu thống nhất CHỈ sống phía soạn. Node
 * `choice`/`choiceList` không bao giờ xuất hiện trong nội dung đã lưu
 * (thân câu lưu trữ luôn là tài liệu hợp đồng thuần), nên phía xem
 * tĩnh (`RichTextView`) không cần — và không được — render chúng;
 * cột xem trước của trang soạn render từ dạng đã tách.
 */

/** Tên node danh sách lựa chọn trong tài liệu thống nhất (khớp giaokhoa). */
export const CHOICE_LIST_NODE_TYPE = 'choiceList';

/** Tên node một lựa chọn trong tài liệu thống nhất (khớp giaokhoa). */
export const CHOICE_NODE_TYPE = 'choice';

/**
 * Số lựa chọn của một câu trắc nghiệm soạn mới: khoá đúng 4 như
 * giaokhoa và như luật hợp đồng phía API (điểm quyết D-3 ngày
 * 26/10/2026 — đề thi chuẩn Việt Nam có 4 lựa chọn).
 */
export const MULTIPLE_CHOICE_COUNT = 4;

/**
 * Một lựa chọn trong tài liệu thống nhất: node `choice` với `attrs.id`
 * là định danh ổn định trong vòng soạn và `content` là các block rich
 * text của nội dung lựa chọn (cùng lát block với hợp đồng).
 */
export interface MultipleChoiceChoiceJson {
  type: typeof CHOICE_NODE_TYPE;
  attrs: { id: string };
  content?: JSONContent[];
}

/**
 * Tài liệu thống nhất phía soạn của câu trắc nghiệm: một `doc` mà
 * phần tử cuối là đúng một `choiceList` chứa các {@link
 * MultipleChoiceChoiceJson}; mọi phần tử trước nó là block nội dung
 * của thân câu (cùng lát block với `RichTextDocument` của hợp đồng).
 */
export interface MultipleChoiceDocumentJson {
  type: 'doc';
  content: JSONContent[];
}

/**
 * Sinh định danh cho một choice mới. Dùng `crypto.randomUUID` của nền
 * tảng; môi trường thiếu API đó (jsdom cũ) thì rơi về bộ đếm + thời
 * gian — id chỉ cần duy nhất trong vòng soạn, không phải định danh
 * bền xuyên phiên bản (bất biến R-2 của hồ sơ port).
 *
 * @returns Chuỗi định danh mới cho choice.
 */
let fallbackIdCounter = 0;
export function newChoiceId(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  fallbackIdCounter += 1;
  return `choice-${Date.now().toString(36)}-${fallbackIdCounter}`;
}

/** Một paragraph rỗng — block đệm chuẩn của tài liệu soạn. */
const emptyParagraph = (): JSONContent => ({ type: 'paragraph' });

/**
 * Node gốc của tài liệu thống nhất: thay node `doc` mặc định của
 * Tiptap bằng biến thể bắt buộc tài liệu kết thúc bằng đúng một
 * `choiceList` (`block+ choiceList`) — lựa chọn không thể bị xoá khỏi
 * tài liệu hay chèn nội dung sau danh sách lựa chọn.
 */
export const MultipleChoiceDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: `block+ ${CHOICE_LIST_NODE_TYPE}`,
});

/**
 * Node danh sách lựa chọn: chứa đúng {@link MULTIPLE_CHOICE_COUNT}
 * `choice`, `isolating` để thao tác soạn (xoá/gộp đoạn) không phá vỡ
 * biên của danh sách.
 */
export const ChoiceList = Node.create({
  name: CHOICE_LIST_NODE_TYPE,
  content: `${CHOICE_NODE_TYPE}{${MULTIPLE_CHOICE_COUNT}}`,
  isolating: true,
  parseHTML: () => [{ tag: 'ol[data-choice-list]' }],
  renderHTML: () => ['ol', { 'data-choice-list': '', class: 'lms-choice-list' }, 0],
});

/**
 * Node một lựa chọn: nội dung là các block rich text (`block+`),
 * `defining` để định dạng không rò qua biên lựa chọn. `draggable` bật
 * kéo-thả đổi thứ tự bằng cơ chế kéo node của ProseMirror: người soạn
 * kéo một lựa chọn đang được chọn (node selection) tới vị trí mới
 * trong cùng danh sách; thứ tự trong tài liệu sau khi thả là thứ tự
 * đáp án khi tách lúc lưu. Thuộc tính `id` do {@link ChoiceUniqueId}
 * bảo đảm luôn có.
 */
export const Choice = Node.create({
  name: CHOICE_NODE_TYPE,
  content: 'block+',
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      id: { default: null },
    };
  },
  parseHTML: () => [{ tag: 'li[data-choice]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'li',
    mergeAttributes(HTMLAttributes, { 'data-choice': '', class: 'lms-choice' }),
    0,
  ],
});

/**
 * Plugin bảo đảm mọi node `choice` trong tài liệu luôn có `attrs.id`:
 * sau mỗi transaction, choice nào thiếu id (vừa được tạo khi người
 * soạn tách/gộp đoạn, hoặc tài liệu nạp vào chưa có) được gán một id
 * mới bằng `setNodeMarkup` trong một transaction nối tiếp.
 *
 * Đây là bản thay thế gọn cho `@tiptap/extension-unique-id` của
 * giaokhoa — package đó không có trong workspace của hệ mình, và nhu
 * cầu ở đây hẹp hơn (chỉ node `choice`). Id phải nằm TRONG tài liệu
 * (không giữ ở state ngoài) vì kéo-thả đổi thứ tự và tách/gộp đoạn
 * đều đi qua tài liệu: đáp án đúng (`correctChoiceId`) trỏ theo id
 * này nên lựa chọn đúng đi theo nội dung của nó qua mọi thao tác.
 */
export const ChoiceUniqueId = Extension.create({
  name: 'choiceUniqueId',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('choiceUniqueId'),
        appendTransaction: (_transactions, _oldState, newState) => {
          const missing: { pos: number; nodeSize: number }[] = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name === CHOICE_NODE_TYPE && typeof node.attrs.id !== 'string') {
              missing.push({ pos, nodeSize: node.nodeSize });
            }
            return true;
          });
          if (missing.length === 0) {
            return null;
          }
          const tr = newState.tr;
          // Gán id từ cuối tài liệu ngược về đầu để vị trí đã ghi
          // không bị lệch bởi các lần setNodeMarkup trước đó (dù
          // setNodeMarkup không đổi kích thước node, thứ tự ngược
          // giữ cho vòng lặp an toàn tuyệt đối).
          for (const { pos } of [...missing].reverse()) {
            const node = tr.doc.nodeAt(pos);
            if (node && node.type.name === CHOICE_NODE_TYPE) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: newChoiceId() });
            }
          }
          return tr;
        },
      }),
    ];
  },
});

/**
 * Bộ extension của editor trắc nghiệm thống nhất: toàn bộ lát soạn
 * của hợp đồng ({@link plainTextExtensions} — mark, danh sách, công
 * thức, ảnh, hoàn tác) TRỪ node `doc` mặc định, cộng node `doc` bắt
 * buộc chốt đuôi bằng danh sách lựa chọn, hai node lựa chọn và plugin
 * định danh choice.
 */
export const multipleChoiceExtensions = [
  ...plainTextExtensions.filter((extension) => extension.name !== 'doc'),
  MultipleChoiceDocument,
  ChoiceList,
  Choice,
  ChoiceUniqueId,
];

/**
 * Tách tài liệu thống nhất thành phần thân câu và danh sách lựa chọn
 * (mẫu `splitMultipleChoiceDocument` của giaokhoa).
 *
 * @param content - Tài liệu thống nhất phía soạn.
 * @returns `question` là tài liệu thân câu (đã bỏ node `choiceList`,
 *   sẵn sàng ép về `RichTextDocument` của hợp đồng) và `choices` là
 *   các node choice theo đúng thứ tự trong tài liệu — thứ tự này là
 *   thứ tự đáp án (`sortOrder`) khi lưu. Tài liệu không có
 *   `choiceList` thì `choices` rỗng và `question` là chính tài liệu.
 */
export function splitMultipleChoiceDocument(content: MultipleChoiceDocumentJson): {
  question: JSONContent;
  choices: MultipleChoiceChoiceJson[];
} {
  const nodes = content.content ?? [];
  const choiceListIndex = nodes.findIndex((node) => node.type === CHOICE_LIST_NODE_TYPE);
  if (choiceListIndex < 0) {
    return { question: content, choices: [] };
  }
  const choiceList = nodes[choiceListIndex];
  return {
    question: { ...content, content: nodes.filter((_, index) => index !== choiceListIndex) },
    choices: (choiceList?.content ?? []).filter(
      (choice): choice is MultipleChoiceChoiceJson => choice.type === CHOICE_NODE_TYPE,
    ),
  };
}

/**
 * Dựng một choice từ nội dung block cho trước.
 *
 * @param id - Định danh của choice (id dòng answers khi nạp câu có
 *   sẵn; id mới khi soạn thêm).
 * @param blocks - Các block rich text của nội dung lựa chọn; rỗng thì
 *   đệm một paragraph rỗng để choice luôn mở soạn được.
 * @returns Node choice hoàn chỉnh cho tài liệu thống nhất.
 */
function choiceFromBlocks(id: string, blocks: readonly JSONContent[] | undefined): MultipleChoiceChoiceJson {
  return {
    type: CHOICE_NODE_TYPE,
    attrs: { id },
    content: blocks && blocks.length > 0 ? [...blocks] : [emptyParagraph()],
  };
}

/**
 * Tài liệu thống nhất rỗng cho một câu trắc nghiệm mới: một paragraph
 * thân câu + danh sách đúng {@link MULTIPLE_CHOICE_COUNT} lựa chọn
 * rỗng, mỗi lựa chọn có id mới.
 *
 * @returns Tài liệu thống nhất rỗng (chưa có đáp án đúng).
 */
export function createEmptyMultipleChoiceDocument(): MultipleChoiceDocumentJson {
  return {
    type: 'doc',
    content: [
      emptyParagraph(),
      {
        type: CHOICE_LIST_NODE_TYPE,
        content: Array.from({ length: MULTIPLE_CHOICE_COUNT }, () =>
          choiceFromBlocks(newChoiceId(), undefined),
        ),
      },
    ],
  };
}

/**
 * Lắp view của một câu trắc nghiệm có sẵn thành tài liệu thống nhất
 * phía soạn (chiều ngược của {@link splitMultipleChoiceDocument}):
 * thân câu giữ nguyên tài liệu, từng dòng answers theo `sortOrder`
 * thành một choice mang `attrs.id` = id của dòng answers đó (định
 * danh xuyên vòng soạn: phản hồi theo lựa chọn và đáp án đúng đều bám
 * theo id này).
 *
 * Luật chuẩn hoá số lựa chọn về đúng {@link MULTIPLE_CHOICE_COUNT}
 * (hợp đồng phía API đã khoá đúng 4 nên đây chỉ là lưới an toàn cho
 * dữ liệu lạ): thiếu thì đệm lựa chọn rỗng có id mới; thừa thì giữ
 * các lựa chọn đầu theo thứ tự.
 *
 * @param questionText - Tài liệu thân câu của phiên bản (rỗng/`null`
 *   thì đệm một paragraph rỗng).
 * @param answers - Các dòng answers của phiên bản: `id`, tài liệu nội
 *   dung đáp án và thứ tự.
 * @returns Tài liệu thống nhất sẵn sàng nạp vào editor.
 */
export function composeMultipleChoiceDocument(
  questionText: RichTextDocument | null | undefined,
  answers: readonly { id: string; answer: RichTextDocument; sortOrder: number }[],
): MultipleChoiceDocumentJson {
  const sorted = [...answers].sort((a, b) => a.sortOrder - b.sortOrder);
  const choices = sorted
    .slice(0, MULTIPLE_CHOICE_COUNT)
    .map((answer) => choiceFromBlocks(answer.id, answer.answer.content));
  while (choices.length < MULTIPLE_CHOICE_COUNT) {
    choices.push(choiceFromBlocks(newChoiceId(), undefined));
  }
  const questionBlocks = questionText?.content ?? [];
  return {
    type: 'doc',
    content: [
      ...(questionBlocks.length > 0 ? (questionBlocks as JSONContent[]) : [emptyParagraph()]),
      { type: CHOICE_LIST_NODE_TYPE, content: choices },
    ],
  };
}

/**
 * Một tài liệu thống nhất đã sẵn sàng để lưu hay chưa, theo đúng
 * luật hợp đồng phía API: thân câu có nội dung, đủ
 * {@link MULTIPLE_CHOICE_COUNT} lựa chọn đều có nội dung, và đã chọn
 * đúng một đáp án đúng thuộc danh sách lựa chọn. Dùng để bề mặt chứa
 * quyết định trạng thái nút lưu/cảnh báo tại chỗ; cổng cứng vẫn là
 * kiểm tra ở contracts + tầng nghiệp vụ phía API.
 *
 * @param content - Tài liệu thống nhất cần kiểm.
 * @param correctChoiceId - Id của lựa chọn đúng đã chọn (chưa chọn
 *   thì `undefined`).
 * @returns `true` khi tài liệu đủ điều kiện lưu thành câu sẵn sàng.
 */
export function isCompleteMultipleChoice(
  content: MultipleChoiceDocumentJson,
  correctChoiceId: string | undefined,
): boolean {
  if (!correctChoiceId) {
    return false;
  }
  const { question, choices } = splitMultipleChoiceDocument(content);
  if (choices.length !== MULTIPLE_CHOICE_COUNT) {
    return false;
  }
  // Một node có nội dung thật khi có chữ khác rỗng ở bất kỳ mức nào,
  // hoặc tự nó là node phi văn bản mang nội dung (ảnh, công thức).
  const hasText = (node: JSONContent): boolean => {
    if (typeof node.text === 'string' && node.text.trim() !== '') {
      return true;
    }
    if (node.type === 'image' || node.type === 'inlineMath' || node.type === 'blockMath') {
      return true;
    }
    return (node.content ?? []).some(hasText);
  };
  if (!(question.content ?? []).some(hasText)) {
    return false;
  }
  if (!choices.some((choice) => choice.attrs.id === correctChoiceId)) {
    return false;
  }
  return choices.every((choice) => (choice.content ?? []).some(hasText));
}
