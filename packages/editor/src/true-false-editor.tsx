import { useId, useMemo, useRef } from 'react';
import { Decoration, Extension, type WidgetDecoration } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { RichTextDocument } from '@lms/contracts';
import { RichTextEditor } from './rich-text-editor.js';
import type { RichTextImagePick } from './rich-text-editor.js';
import {
  STATEMENT_LIST_NODE_TYPE,
  STATEMENT_NODE_TYPE,
  trueFalseExtensions,
  type TrueFalseDocumentJson,
} from './true-false.js';

/**
 * Editor soạn câu đúng/sai chùm (TF-A) trên tài liệu thân câu đầy đủ
 * (port từ `TrueFalseEditor` của giaokhoa — xem module `true-false.ts`
 * để rõ flow tổng thể của mô hình).
 *
 * Component này là một lớp bọc quanh {@link RichTextEditor}: thay bộ
 * extension hợp đồng bằng {@link trueFalseExtensions} (thân câu +
 * danh sách mệnh đề trong cùng một tài liệu — cũng là chính tài liệu
 * lưu trữ) và cộng extension decoration vẽ CẶP radio Đúng/Sai vào
 * từng node `statement`.
 *
 * Đáp án sống NGOÀI tài liệu (prop `answers` dạng bản đồ
 * `statementId → boolean` + `onAnswerChange`): radio chỉ là widget
 * trang trí trỏ theo id của statement; nghiêm cấm đưa thông tin
 * đúng/sai vào nội dung tài liệu của mệnh đề. Vì đáp án bám theo id
 * nên nó đi theo đúng mệnh đề qua mọi thao tác sửa nội dung.
 */

/**
 * Điều khiển radio đáp án mà decoration đọc tại thời điểm vẽ widget:
 * giữ trong một ref để widget luôn thấy giá trị mới nhất mà không
 * phải dựng lại extension khi prop đổi.
 */
interface StatementAnswerControl {
  /** Tiền tố tên nhóm radio (duy nhất cho mỗi instance editor trên trang); tên nhóm đầy đủ gắn thêm id của từng mệnh đề. */
  groupPrefix: string;
  /** Bản đồ đáp án hiện tại theo id mệnh đề; mệnh đề chưa chọn thì vắng mặt trong bản đồ. */
  answers: Readonly<Record<string, boolean | undefined>>;
  /** Báo ra ngoài khi người soạn chọn Đúng/Sai cho một mệnh đề. */
  onAnswerChange: (statementId: string, value: boolean) => void;
}

/**
 * Các id mệnh đề theo thứ tự trong tài liệu hiện tại của editor.
 *
 * @param doc - Tài liệu ProseMirror hiện tại.
 * @returns Mảng id của các node statement thuộc `statementList` chốt đuôi.
 */
function getStatementIds(doc: ProseMirrorNode): string[] {
  const statementList = doc.lastChild;
  if (statementList?.type.name !== STATEMENT_LIST_NODE_TYPE) {
    return [];
  }
  const ids: string[] = [];
  statementList.forEach((statement) => {
    if (statement.type.name === STATEMENT_NODE_TYPE && typeof statement.attrs.id === 'string') {
      ids.push(statement.attrs.id);
    }
  });
  return ids;
}

/** Hai danh sách id có giống hệt nhau (cả phần tử lẫn thứ tự) không. */
function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Dựng extension decoration vẽ cặp radio Đúng/Sai cho từng mệnh đề
 * (port từ giaokhoa).
 *
 * Decoration chỉ dựng lại khi TẬP id mệnh đề thay đổi (mệnh đề mới
 * sinh id, mệnh đề bị xoá, thứ tự đổi) — đáp án hiện tại được đọc từ
 * `controlRef` tại lúc tạo widget nên không cần dựng lại khi đáp án
 * đổi: bản thân các radio trong cùng một nhóm (mỗi mệnh đề một nhóm
 * riêng) tự loại trừ nhau theo hành vi gốc của trình duyệt khi người
 * soạn bấm chọn.
 *
 * @param controlRef - Ref giữ điều khiển radio mới nhất.
 * @returns Extension Tiptap mang decoration radio Đ/S.
 */
function createStatementAnswerDecoration(controlRef: { current: StatementAnswerControl }) {
  return Extension.create({
    name: 'statementAnswerDecoration',

    addDecorations() {
      return {
        shouldUpdate: ({ oldState, newState }) =>
          !sameIds(getStatementIds(oldState.doc), getStatementIds(newState.doc)),
        create: ({ state }) => {
          const widgets: WidgetDecoration[] = [];

          state.doc.descendants((node, pos) => {
            if (node.type.name !== STATEMENT_NODE_TYPE) {
              return;
            }
            const statementId = node.attrs.id;
            if (typeof statementId !== 'string') {
              return;
            }
            widgets.push(
              Decoration.Widget(
                pos + 1,
                () => {
                  const wrapper = document.createElement('span');
                  wrapper.className = 'lms-statement__answer';

                  const buildOption = (value: boolean, label: string, ariaLabel: string) => {
                    const option = document.createElement('label');
                    option.className = 'lms-statement__answer-option';

                    const input = document.createElement('input');
                    input.type = 'radio';
                    input.name = `${controlRef.current.groupPrefix}:${statementId}`;
                    input.className = 'lms-statement__answer-input';
                    input.setAttribute('aria-label', ariaLabel);
                    input.checked = controlRef.current.answers[statementId] === value;
                    input.addEventListener('change', () => {
                      if (input.checked) {
                        controlRef.current.onAnswerChange(statementId, value);
                      }
                    });

                    const text = document.createElement('span');
                    text.textContent = label;

                    option.append(input, text);
                    return option;
                  };

                  wrapper.append(
                    buildOption(true, 'Đúng', 'Đánh dấu mệnh đề là Đúng'),
                    buildOption(false, 'Sai', 'Đánh dấu mệnh đề là Sai'),
                  );
                  return wrapper;
                },
                {
                  key: `statement-answer-${statementId}`,
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
 * Thuộc tính của {@link TrueFalseEditor}.
 */
export interface TrueFalseEditorProps {
  /** Tài liệu đúng/sai hiện tại do bề mặt chứa quản lý. */
  value: TrueFalseDocumentJson;
  /** Được gọi mỗi khi tài liệu thay đổi. */
  onChange: (document: TrueFalseDocumentJson) => void;
  /** Bản đồ đáp án Đúng/Sai theo id mệnh đề; mệnh đề chưa chọn thì vắng mặt. */
  answers: Readonly<Record<string, boolean | undefined>>;
  /** Được gọi khi người soạn chọn Đúng/Sai cho một mệnh đề. */
  onAnswerChange: (statementId: string, value: boolean) => void;
  /** Nhãn truy cập (aria-label) đặt trên vùng nhập liệu. */
  ariaLabel?: string;
  /**
   * Đường chèn ảnh do bề mặt chứa cung cấp — cùng giao ước với
   * {@link RichTextEditor}.
   */
  onRequestImage?: (
    file?: File,
  ) => Promise<RichTextImagePick | null> | RichTextImagePick | null;
}

/**
 * Trình soạn thảo câu đúng/sai chùm: thân câu và bốn mệnh đề trong
 * một tài liệu, cặp radio Đúng/Sai gắn tại từng mệnh đề.
 *
 * @param props - Thuộc tính: tài liệu + bản đồ đáp án theo mệnh đề.
 * @returns Phần tử editor đúng/sai.
 */
export function TrueFalseEditor({
  value,
  onChange,
  answers,
  onAnswerChange,
  ariaLabel,
  onRequestImage,
}: TrueFalseEditorProps) {
  const groupPrefix = useId();
  const controlRef = useRef<StatementAnswerControl>({
    groupPrefix,
    answers,
    onAnswerChange,
  });
  controlRef.current.groupPrefix = groupPrefix;
  controlRef.current.answers = answers;
  controlRef.current.onAnswerChange = onAnswerChange;

  const extensions = useMemo(
    () => [...trueFalseExtensions, createStatementAnswerDecoration(controlRef)],
    [],
  );

  return (
    <RichTextEditor
      // Tài liệu đúng/sai mang node statement/statementList của hợp
      // đồng; vỏ editor chỉ vận hành trên JSON — ép kiểu tại biên này
      // là có chủ đích như ở MultipleChoiceEditor.
      value={value as unknown as RichTextDocument}
      onChange={(document) => onChange(document as unknown as TrueFalseDocumentJson)}
      extensions={extensions}
      ariaLabel={ariaLabel}
      onRequestImage={onRequestImage}
    />
  );
}
