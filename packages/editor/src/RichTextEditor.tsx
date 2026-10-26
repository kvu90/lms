import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { RichTextDocument } from '@lms/contracts';
import { plainTextExtensions } from './extensions.js';
import { MathEditorPanel, type MathNodeKind } from './MathEditorPanel.js';
import { validateMathLatex } from './math.js';

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
 * Kết quả bề mặt chứa trả về cho editor khi người soạn chọn một ảnh: chỉ
 * gồm những gì node `image` của hợp đồng cần — `src` là định danh bền mà
 * bề mặt chứa đã phân giải qua module files (ví dụ kết quả của
 * `uploadQuestionImage` phía web), `alt` là chữ thay thế. Editor không tự
 * gọi API files và không tự mở trình chọn tệp: toàn bộ đường tải lên nằm
 * ở bề mặt chứa.
 */
export interface RichTextImagePick {
  /** Định danh bền của ảnh để lưu vào `attrs.src` của node `image`. */
  src: string;
  /** Chữ thay thế của ảnh; bỏ trống khi bề mặt chứa không cung cấp. */
  alt?: string | null;
}

/**
 * Trạng thái của panel soạn công thức đang mở: nội dung đang soạn, lỗi
 * cú pháp của lần xác nhận bị chặn gần nhất, và node đích khi panel đang
 * sửa một công thức có sẵn (`targetPos`/`targetKind`); panel chèn mới
 * thì hai trường đích đều `null`.
 */
interface MathPanelState {
  latex: string;
  kind: MathNodeKind;
  error?: string;
  targetPos: number | null;
  targetKind: MathNodeKind | null;
}

/** Một tệp trong sự kiện dán/kéo-thả có phải ảnh hay không. */
function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

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
  /**
   * Đường chèn ảnh do bề mặt chứa cung cấp. Editor gọi callback này khi
   * người soạn bấm nút chèn ảnh (không kèm tệp) và khi người soạn dán
   * hoặc kéo-thả tệp ảnh vào vùng soạn (kèm đúng tệp đó); bề mặt chứa xử
   * lý chọn/tải ảnh rồi trả về {@link RichTextImagePick} để editor chèn
   * node `image`, hoặc `null` để huỷ. Không truyền callback này thì editor
   * không hiện nút ảnh và bỏ qua ảnh dán/kéo-thả — editor tự nó không có
   * đường tải ảnh nào.
   */
  onRequestImage?: (
    file?: File,
  ) => Promise<RichTextImagePick | null> | RichTextImagePick | null;
}

/**
 * Trình soạn thảo rich text dùng chung cho mọi nơi cần nhập nội dung giàu
 * trong LMS, dựng trên Tiptap với bộ extension của hợp đồng
 * ({@link plainTextExtensions}).
 *
 * Thanh công cụ gồm: năm nút bật/tắt mark (đậm, nghiêng, gạch ngang, mã
 * nội tuyến, gạch chân), nút danh sách không thứ tự, nút công thức mở
 * panel LaTeX (xem trước trực tiếp, chặn xác nhận khi LaTeX sai cú pháp),
 * và — khi bề mặt chứa truyền `onRequestImage` — nút ảnh. Nhấp đúp vào
 * một công thức đã chèn mở lại panel để sửa đúng công thức đó (đổi được
 * cả dạng trong dòng/tách dòng, xoá được tại panel). Dán hoặc kéo-thả
 * tệp ảnh cũng đi qua `onRequestImage` như nút ảnh.
 *
 * Khi `value` do cha quản lý thay đổi từ bên ngoài, nội dung được đồng bộ
 * vào editor — chỉ ghi lại khi thật khác nội dung hiện tại để tránh vòng
 * lặp con trỏ với sự kiện `onChange`.
 *
 * @param props - Thuộc tính của trình soạn thảo.
 * @returns Phần tử trình soạn thảo kèm thanh công cụ.
 */
export function RichTextEditor({
  value,
  onChange,
  editable = true,
  ariaLabel,
  onRequestImage,
}: RichTextEditorProps) {
  const [mathPanel, setMathPanel] = useState<MathPanelState | null>(null);
  const onRequestImageRef = useRef(onRequestImage);
  onRequestImageRef.current = onRequestImage;

  /**
   * Mở panel sửa công thức cho node công thức tại một vị trí trong tài
   * liệu của view cho trước; vị trí không trỏ vào node công thức thì
   * không làm gì.
   *
   * @param view - View của editor tại thời điểm tương tác.
   * @param pos - Vị trí bắt đầu của node cần sửa.
   * @returns `true` nếu đã mở panel.
   */
  function openMathPanelAt(view: EditorView, pos: number): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (!node || (node.type.name !== 'inlineMath' && node.type.name !== 'blockMath')) {
      return false;
    }
    const kind = node.type.name as MathNodeKind;
    setMathPanel({
      latex: typeof node.attrs.latex === 'string' ? node.attrs.latex : '',
      kind,
      targetPos: pos,
      targetKind: kind,
    });
    return true;
  }

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
      handleDOMEvents: {
        dblclick: (view, event) => {
          if (!view.editable) {
            return false;
          }
          const target = event.target as HTMLElement | null;
          const mathElement = target?.closest?.(
            '[data-type="inline-math"], [data-type="block-math"]',
          );
          if (!mathElement) {
            return false;
          }
          return openMathPanelAt(view, view.posAtDOM(mathElement, 0));
        },
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(isImageFile);
        if (files.length === 0 || !onRequestImageRef.current) {
          return false;
        }
        event.preventDefault();
        void insertImagesFromHost(files);
        return true;
      },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile);
        if (files.length === 0 || !onRequestImageRef.current) {
          return false;
        }
        event.preventDefault();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (coords) {
          try {
            editor.commands.setTextSelection(coords.pos);
          } catch {
            // Vị trí thả không đặt được con trỏ: chèn tại vị trí hiện tại.
          }
        }
        void insertImagesFromHost(files);
        return true;
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      onChange?.(currentEditor.getJSON() as unknown as RichTextDocument);
    },
  });

  const toolbarState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      bold: currentEditor.isActive('bold'),
      italic: currentEditor.isActive('italic'),
      strike: currentEditor.isActive('strike'),
      code: currentEditor.isActive('code'),
      underline: currentEditor.isActive('underline'),
      bulletList: currentEditor.isActive('bulletList'),
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

  /** Bật/tắt danh sách không thứ tự cho đoạn hiện tại. */
  function toggleBulletList(): void {
    editor.chain().focus().toggleBulletList().run();
  }

  /**
   * Xin bề mặt chứa một ảnh cho từng tệp (hoặc một lần không kèm tệp khi
   * bấm nút) và chèn node `image` với định danh bền nó trả về; bề mặt
   * chứa trả `null` thì bỏ qua, không chèn gì.
   *
   * @param files - Các tệp ảnh từ dán/kéo-thả; mảng rỗng nghĩa là bấm nút.
   */
  async function insertImagesFromHost(files: readonly File[]): Promise<void> {
    const requestImage = onRequestImageRef.current;
    if (!requestImage) {
      return;
    }
    const picks: RichTextImagePick[] = [];
    if (files.length === 0) {
      const pick = await requestImage();
      if (pick?.src) {
        picks.push(pick);
      }
    } else {
      for (const file of files) {
        const pick = await requestImage(file);
        if (pick?.src) {
          picks.push(pick);
        }
      }
    }
    if (picks.length === 0) {
      return;
    }
    const chain = editor.chain().focus();
    for (const pick of picks) {
      chain.setImage({ src: pick.src, alt: pick.alt ?? undefined });
    }
    chain.run();
  }

  /**
   * Mở panel công thức: đang chọn đúng một node công thức thì sửa node
   * đó, còn lại là chèn công thức mới tại con trỏ.
   */
  function openMathPanel(): void {
    const { selection } = editor.state;
    if (
      selection instanceof NodeSelection &&
      (selection.node.type.name === 'inlineMath' || selection.node.type.name === 'blockMath')
    ) {
      openMathPanelAt(editor.view, selection.from);
      return;
    }
    setMathPanel({ latex: '', kind: 'inlineMath', targetPos: null, targetKind: null });
  }

  /**
   * Xác nhận panel công thức: LaTeX sai cú pháp thì CHẶN, giữ panel mở
   * và hiện lỗi tại panel — tài liệu không đổi. Hợp lệ thì áp vào tài
   * liệu theo đúng trường hợp: chèn mới, sửa tại chỗ cùng dạng, hoặc đổi
   * dạng trong dòng ↔ tách dòng (xoá node cũ, chèn node mới ở vị trí
   * tương đương: công thức tách dòng nằm ngay sau đoạn chứa công thức
   * cũ; công thức trong dòng nằm trong một đoạn mới tại chỗ block cũ).
   */
  function confirmMathPanel(): void {
    if (!mathPanel) {
      return;
    }
    const validationError = validateMathLatex(mathPanel.latex);
    if (validationError) {
      setMathPanel({ ...mathPanel, error: validationError });
      return;
    }
    const { latex, kind, targetPos, targetKind } = mathPanel;
    if (targetPos === null) {
      if (kind === 'inlineMath') {
        editor.chain().focus().insertInlineMath({ latex }).run();
      } else {
        editor.chain().focus().insertBlockMath({ latex }).run();
      }
    } else if (targetKind === kind) {
      if (kind === 'inlineMath') {
        editor.chain().focus().updateInlineMath({ latex, pos: targetPos }).run();
      } else {
        editor.chain().focus().updateBlockMath({ latex, pos: targetPos }).run();
      }
    } else if (targetKind === 'inlineMath') {
      editor.chain().focus().deleteInlineMath({ pos: targetPos }).run();
      const $pos = editor.state.doc.resolve(targetPos);
      const afterParagraph = $pos.after($pos.depth);
      editor.chain().focus().insertBlockMath({ latex, pos: afterParagraph }).run();
    } else {
      editor.chain().focus().deleteBlockMath({ pos: targetPos }).run();
      editor
        .chain()
        .focus()
        .insertContentAt(targetPos, {
          type: 'paragraph',
          content: [{ type: 'inlineMath', attrs: { latex } }],
        })
        .run();
    }
    setMathPanel(null);
  }

  /** Xoá công thức đang sửa tại panel và đóng panel. */
  function deleteMathTarget(): void {
    if (!mathPanel || mathPanel.targetPos === null || !mathPanel.targetKind) {
      return;
    }
    if (mathPanel.targetKind === 'inlineMath') {
      editor.chain().focus().deleteInlineMath({ pos: mathPanel.targetPos }).run();
    } else {
      editor.chain().focus().deleteBlockMath({ pos: mathPanel.targetPos }).run();
    }
    setMathPanel(null);
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
              aria-pressed={toolbarState[mark]}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggleMark(mark)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            title="Danh sách không thứ tự"
            aria-label="Danh sách không thứ tự"
            aria-pressed={toolbarState.bulletList}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleBulletList}
          >
            &bull;
          </button>
          <button
            type="button"
            title="Chèn công thức"
            aria-label="Chèn công thức"
            onMouseDown={(event) => event.preventDefault()}
            onClick={openMathPanel}
          >
            &Sigma;
          </button>
          {onRequestImage ? (
            <button
              type="button"
              title="Chèn ảnh"
              aria-label="Chèn ảnh"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void insertImagesFromHost([])}
            >
              &#128247;
            </button>
          ) : null}
        </div>
      ) : null}
      {editable && mathPanel ? (
        <MathEditorPanel
          latex={mathPanel.latex}
          kind={mathPanel.kind}
          error={mathPanel.error}
          onLatexChange={(latex) =>
            setMathPanel((current) =>
              current ? { ...current, latex, error: undefined } : current,
            )
          }
          onKindChange={(kind) =>
            setMathPanel((current) => (current ? { ...current, kind } : current))
          }
          onConfirm={confirmMathPanel}
          onCancel={() => setMathPanel(null)}
          onDelete={mathPanel.targetPos !== null ? deleteMathTarget : undefined}
        />
      ) : null}
      <EditorContent editor={editor} />
    </div>
  );
}
