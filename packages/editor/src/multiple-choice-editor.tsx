import { useId, useMemo, useRef } from 'react';
import { Decoration, Extension, type WidgetDecoration } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { RichTextDocument } from '@lms/contracts';
import { RichTextEditor } from './rich-text-editor.js';
import type { RichTextImagePick } from './rich-text-editor.js';
import {
  CHOICE_LIST_NODE_TYPE,
  CHOICE_NODE_TYPE,
  multipleChoiceExtensions,
  type MultipleChoiceDocumentJson,
} from './multiple-choice.js';

/**
 * Editor soạn câu trắc nghiệm trên TÀI LIỆU THỐNG NHẤT (port từ
 * `MultipleChoiceEditor` của giaokhoa — xem module
 * `multiple-choice.ts` để rõ flow tổng thể của mô hình).
 *
 * Component này là một lớp bọc quanh {@link RichTextEditor}: thay bộ
 * extension hợp đồng bằng {@link multipleChoiceExtensions} (thân câu
 * + danh sách lựa chọn trong cùng một tài liệu) và cộng extension
 * decoration vẽ radio "Đặt làm đáp án đúng" vào từng node `choice`.
 * Vỏ dùng chung lo phần còn lại: một toolbar cho editor đang active,
 * panel công thức, đường chèn ảnh, đồng bộ nội dung hai chiều.
 *
 * Đáp án đúng sống NGOÀI tài liệu (prop `correctChoiceId` +
 * `onCorrectChoiceChange`): radio chỉ là widget trang trí trỏ theo id
 * của choice; nghiêm cấm đưa thông tin đúng/sai vào nội dung tài liệu
 * của lựa chọn (không gõ chữ/công thức đánh dấu đáp án vào choice).
 * Thứ tự lựa chọn đổi bằng kéo-thả node choice trong tài liệu (xem
 * node `Choice`), và vì đáp án đúng bám theo id nên nó đi theo đúng
 * lựa chọn qua mọi lần đổi thứ tự.
 */

/**
 * Điều khiển radio đáp án đúng mà decoration đọc tại thời điểm vẽ
 * widget: giữ trong một ref để widget luôn thấy giá trị mới nhất mà
 * không phải dựng lại extension khi prop đổi.
 */
interface CorrectChoiceControl {
  /** Tên nhóm radio (duy nhất cho mỗi instance editor trên trang). */
  groupName: string;
  /** Id của choice đang là đáp án đúng; chưa chọn thì `undefined`. */
  correctChoiceId?: string;
  /** Báo ra ngoài khi người soạn chọn một choice làm đáp án đúng. */
  onCorrectChoiceChange: (choiceId: string) => void;
}

/**
 * Các id choice theo thứ tự trong tài liệu hiện tại của editor.
 *
 * @param doc - Tài liệu ProseMirror hiện tại.
 * @returns Mảng id của các node choice thuộc `choiceList` chốt đuôi.
 */
function getChoiceIds(doc: ProseMirrorNode): string[] {
  const choiceList = doc.lastChild;
  if (choiceList?.type.name !== CHOICE_LIST_NODE_TYPE) {
    return [];
  }
  const ids: string[] = [];
  choiceList.forEach((choice) => {
    if (choice.type.name === CHOICE_NODE_TYPE && typeof choice.attrs.id === 'string') {
      ids.push(choice.attrs.id);
    }
  });
  return ids;
}

/** Hai danh sách id có giống hệt nhau (cả phần tử lẫn thứ tự) không. */
function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Dựng extension decoration vẽ radio đáp án đúng (port từ giaokhoa).
 *
 * Decoration chỉ dựng lại khi TẬP id choice thay đổi (choice mới sinh
 * id, choice bị xoá, thứ tự đổi) — lựa chọn hiện tại được đọc từ
 * `controlRef` tại lúc tạo widget nên không cần dựng lại khi đáp án
 * đúng đổi: bản thân các radio trong cùng một nhóm tự loại trừ nhau
 * theo hành vi gốc của trình duyệt khi người soạn bấm chọn.
 *
 * @param controlRef - Ref giữ điều khiển radio mới nhất.
 * @returns Extension Tiptap mang decoration radio.
 */
function createCorrectChoiceDecoration(controlRef: { current: CorrectChoiceControl }) {
  return Extension.create({
    name: 'correctChoiceDecoration',

    addDecorations() {
      return {
        shouldUpdate: ({ oldState, newState }) =>
          !sameIds(getChoiceIds(oldState.doc), getChoiceIds(newState.doc)),
        create: ({ state }) => {
          const widgets: WidgetDecoration[] = [];

          state.doc.descendants((node, pos) => {
            if (node.type.name !== CHOICE_NODE_TYPE) {
              return;
            }
            const choiceId = node.attrs.id;
            if (typeof choiceId !== 'string') {
              return;
            }
            widgets.push(
              Decoration.Widget(
                pos + 1,
                () => {
                  const wrapper = document.createElement('span');
                  wrapper.className = 'lms-choice__correct';

                  const input = document.createElement('input');
                  input.type = 'radio';
                  input.name = controlRef.current.groupName;
                  input.className = 'lms-choice__correct-input';
                  input.setAttribute('aria-label', 'Đặt làm đáp án đúng');
                  input.checked = controlRef.current.correctChoiceId === choiceId;
                  input.addEventListener('change', () => {
                    if (input.checked) {
                      controlRef.current.onCorrectChoiceChange(choiceId);
                    }
                  });

                  wrapper.append(input);
                  return wrapper;
                },
                {
                  key: `correct-choice-${choiceId}`,
                  side: -1,
                  ignoreSelection: true,
                  stopEvent: () => true,
                },
              ),
            );
          });

          return widgets;
        },
      };
    },
  });
}

/**
 * Thuộc tính của {@link MultipleChoiceEditor}.
 */
export interface MultipleChoiceEditorProps {
  /** Tài liệu thống nhất hiện tại do bề mặt chứa quản lý. */
  value: MultipleChoiceDocumentJson;
  /** Được gọi mỗi khi tài liệu thay đổi (đã ở dạng đem-lưu của vỏ editor). */
  onChange: (document: MultipleChoiceDocumentJson) => void;
  /** Id của choice là đáp án đúng; chưa chọn thì `undefined`. */
  correctChoiceId?: string;
  /** Được gọi khi người soạn chọn một choice làm đáp án đúng. */
  onCorrectChoiceChange: (choiceId: string) => void;
  /** Nhãn truy cập (aria-label) đặt trên vùng nhập liệu. */
  ariaLabel?: string;
  /**
   * Đường chèn ảnh do bề mặt chứa cung cấp — cùng giao ước với
   * {@link RichTextEditor}: editor gọi kèm tệp khi dán/kéo-thả ảnh,
   * không kèm tệp khi bấm nút ảnh; bề mặt chứa trả định danh bền để
   * chèn hoặc `null` để huỷ.
   */
  onRequestImage?: (
    file?: File,
  ) => Promise<RichTextImagePick | null> | RichTextImagePick | null;
}

/**
 * Trình soạn thảo câu trắc nghiệm thống nhất: thân câu và bốn lựa
 * chọn trong một tài liệu, radio đáp án đúng gắn tại từng lựa chọn,
 * kéo-thả đổi thứ tự lựa chọn trong danh sách.
 *
 * @param props - Thuộc tính: tài liệu thống nhất + điều khiển đáp án đúng.
 * @returns Phần tử editor trắc nghiệm.
 */
export function MultipleChoiceEditor({
  value,
  onChange,
  correctChoiceId,
  onCorrectChoiceChange,
  ariaLabel,
  onRequestImage,
}: MultipleChoiceEditorProps) {
  const groupName = useId();
  const controlRef = useRef<CorrectChoiceControl>({
    groupName,
    correctChoiceId,
    onCorrectChoiceChange,
  });
  controlRef.current.groupName = groupName;
  controlRef.current.correctChoiceId = correctChoiceId;
  controlRef.current.onCorrectChoiceChange = onCorrectChoiceChange;

  const extensions = useMemo(
    () => [...multipleChoiceExtensions, createCorrectChoiceDecoration(controlRef)],
    [],
  );

  return (
    <RichTextEditor
      // Tài liệu thống nhất KHÔNG phải tài liệu hợp đồng (mang node
      // choice/choiceList chỉ sống phía soạn) — ép kiểu tại biên này
      // là có chủ đích và được module multiple-choice.ts mô tả: vỏ
      // editor chỉ vận hành trên JSON, hình dạng hợp đồng được khôi
      // phục bằng splitMultipleChoiceDocument trước khi lưu.
      value={value as unknown as RichTextDocument}
      onChange={(document) => onChange(document as unknown as MultipleChoiceDocumentJson)}
      extensions={extensions}
      ariaLabel={ariaLabel}
      onRequestImage={onRequestImage}
    />
  );
}
