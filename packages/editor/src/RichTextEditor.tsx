import { useEffect } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { RichTextDocument } from '@lms/contracts';
import { plainTextExtensions } from './extensions.js';

/**
 * Tài liệu rỗng dùng khi chưa có nội dung: một `doc` chứa đúng một
 * paragraph rỗng — khớp `emptyRichTextDocument` của `@lms/contracts`.
 */
const EMPTY_DOCUMENT: RichTextDocument = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

/** Tên các mark mà thanh công cụ của trình soạn thảo bật/tắt được. */
type ToolbarMark = 'bold' | 'italic' | 'strike' | 'code' | 'underline';

/** Mô tả một nút trên thanh công cụ: mark nó điều khiển và nhãn hiển thị. */
const TOOLBAR_MARKS: readonly { mark: ToolbarMark; label: string; title: string }[] = [
  { mark: 'bold', label: 'B', title: 'Chữ đậm' },
  { mark: 'italic', label: 'I', title: 'Chữ nghiêng' },
  { mark: 'strike', label: 'S', title: 'Gạch ngang chữ' },
  { mark: 'code', label: '<>', title: 'Mã nội tuyến' },
  { mark: 'underline', label: 'U', title: 'Gạch chân' },
];

/**
 * Thuộc tính của {@link RichTextEditor}.
 */
export interface RichTextEditorProps {
  /**
   * Tài liệu hiện tại do component cha quản lý. Bỏ trống (`undefined`) thì
   * trình soạn thảo tự quản nội dung, bắt đầu từ một tài liệu rỗng; truyền
   * `null` thì nội dung được hiểu là tài liệu rỗng.
   */
  value?: RichTextDocument | null;
  /**
   * Được gọi mỗi khi nội dung thay đổi, với tài liệu JSON mới nhất do
   * Tiptap sinh ra (đã ép về kiểu {@link RichTextDocument}).
   */
  onChange?: (document: RichTextDocument) => void;
  /** Cho phép sửa nội dung hay chỉ hiển thị; mặc định là cho phép sửa. */
  editable?: boolean;
  /** Nhãn truy cập (aria-label) đặt trên vùng nhập liệu. */
  ariaLabel?: string;
}

/**
 * Trình soạn thảo rich text dùng chung cho mọi nơi cần nhập nội dung giàu
 * trong LMS, dựng trên Tiptap với bộ extension lát văn bản thuần
 * ({@link plainTextExtensions}).
 *
 * Component hiển thị một thanh công cụ tối thiểu với năm nút bật/tắt mark
 * (đậm, nghiêng, gạch ngang, mã nội tuyến, gạch chân). Khi `value` do cha
 * quản lý thay đổi từ bên ngoài, nội dung được đồng bộ vào editor — chỉ
 * ghi lại khi thật khác nội dung hiện tại để tránh vòng lặp con trỏ với
 * sự kiện `onChange`.
 *
 * @param props - Thuộc tính của trình soạn thảo.
 * @returns Phần tử trình soạn thảo kèm thanh công cụ.
 */
export function RichTextEditor({
  value,
  onChange,
  editable = true,
  ariaLabel,
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: plainTextExtensions,
    content: value ?? EMPTY_DOCUMENT,
    editable,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      onChange?.(currentEditor.getJSON() as unknown as RichTextDocument);
    },
  });

  const activeMarks = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      bold: currentEditor.isActive('bold'),
      italic: currentEditor.isActive('italic'),
      strike: currentEditor.isActive('strike'),
      code: currentEditor.isActive('code'),
      underline: currentEditor.isActive('underline'),
    }),
  });

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (value === undefined) {
      return;
    }
    const nextDocument = value ?? EMPTY_DOCUMENT;
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(nextDocument)) {
      editor.commands.setContent(nextDocument, { emitUpdate: false });
    }
  }, [editor, value]);

  /**
   * Bật/tắt một mark trên vùng chọn hiện tại rồi trả focus về vùng nhập.
   *
   * @param mark - Mark cần bật/tắt.
   */
  function toggleMark(mark: ToolbarMark): void {
    const chain = editor.chain().focus();
    switch (mark) {
      case 'bold':
        chain.toggleBold().run();
        break;
      case 'italic':
        chain.toggleItalic().run();
        break;
      case 'strike':
        chain.toggleStrike().run();
        break;
      case 'code':
        chain.toggleCode().run();
        break;
      case 'underline':
        chain.toggleUnderline().run();
        break;
    }
  }

  return (
    <div className="lms-rich-text-editor">
      {editable ? (
        <div className="lms-rich-text-editor__toolbar" role="toolbar">
          {TOOLBAR_MARKS.map(({ mark, label, title }) => (
            <button
              key={mark}
              type="button"
              title={title}
              aria-label={title}
              aria-pressed={activeMarks[mark]}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggleMark(mark)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <EditorContent editor={editor} />
    </div>
  );
}
