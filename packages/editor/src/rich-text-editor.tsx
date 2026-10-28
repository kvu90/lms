import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Extensions } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  Bold,
  Code,
  ImagePlus,
  Italic,
  List,
  Redo2,
  Sigma,
  Strikethrough,
  Underline,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { RichTextDocument } from '@lms/contracts';
import { plainTextExtensions } from './extensions.js';
import {
  contentForSave,
  ensureTerminalContinuation,
} from './document-continuation.js';
import { MathEditorPanel, type MathNodeKind } from './math-editor-panel.js';
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

/**
 * Mô tả một nút mark trên thanh công cụ: mark nó điều khiển, tiêu đề
 * (dùng cho cả `title` lẫn `aria-label`) và icon lucide hiển thị —
 * từ lát E1 toolbar dùng nút ICON như editor giaokhoa, thay cho các
 * nút chữ trần `B`/`I`/`S`/`<>`/`U` trước đây.
 */
const TOOLBAR_MARKS: readonly { mark: ToolbarMark; title: string; Icon: LucideIcon }[] = [
  { mark: 'bold', title: 'Chữ đậm', Icon: Bold },
  { mark: 'italic', title: 'Chữ nghiêng', Icon: Italic },
  { mark: 'strike', title: 'Gạch ngang chữ', Icon: Strikethrough },
  { mark: 'code', title: 'Mã nội tuyến', Icon: Code },
  { mark: 'underline', title: 'Gạch chân', Icon: Underline },
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
   * Cỡ vùng soạn: `default` là trường chính (chiều cao tối thiểu
   * ~20rem như editor giaokhoa), `compact` là trường phụ (phương án,
   * feedback... — chiều cao tối thiểu ~6rem như GuidanceEditor của
   * giaokhoa). Mặc định `default`.
   */
  size?: 'default' | 'compact';
  /**
   * Id của phần tử slot ở header trang mà toolbar của editor đang
   * active được portal vào (mặc định `editor-toolbar-slot`, theo đúng
   * cơ chế của editor giaokhoa). Trang không có slot này thì toolbar
   * neo sticky ngay trên editor đang active.
   */
  toolbarSlotId?: string;
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
  /**
   * Bộ extension Tiptap thay cho bộ hợp đồng mặc định
   * ({@link plainTextExtensions}). Chỉ các editor chuyên biệt dựng trên
   * vỏ này mới truyền (hiện có editor soạn trắc nghiệm
   * `MultipleChoiceEditor` với node `choice`/`choiceList` của tài liệu
   * thống nhất phía soạn). Khi truyền bộ riêng, `value`/`onChange` mang
   * tài liệu theo hình dạng của bộ đó — KHÔNG còn là tài liệu hợp đồng
   * `RichTextDocument`; hình dạng đó chỉ sống phía soạn và bề mặt chứa
   * phải tách về hợp đồng trước khi lưu (xem
   * `splitMultipleChoiceDocument`).
   */
  extensions?: Extensions;
}

/**
 * Trình soạn thảo rich text dùng chung cho mọi nơi cần nhập nội dung giàu
 * trong LMS, dựng trên Tiptap với bộ extension của hợp đồng
 * ({@link plainTextExtensions}). Editor chuyên biệt có thể thay bộ
 * extension qua prop `extensions` (xem TSDoc của prop đó) — vỏ này vẫn lo
 * toolbar/panel công thức/đường ảnh cho chúng.
 *
 * Thanh công cụ dùng nút icon lucide (lát E1): hoàn tác/làm lại (lát
 * E2, trạng thái disabled theo `can()`), năm nút bật/tắt mark (đậm,
 * nghiêng, gạch ngang, mã nội tuyến, gạch chân — trạng thái đang bật
 * hiển thị qua `aria-pressed` + CSS), nút danh sách không thứ tự, nút
 * công thức mở panel LaTeX dạng overlay nổi (xem trước trực tiếp, chặn
 * xác nhận khi LaTeX sai cú pháp), và — khi bề mặt chứa truyền
 * `onRequestImage` — nút ảnh. Nhấp đúp vào một công thức đã chèn mở lại
 * panel để sửa đúng công thức đó (đổi được cả dạng trong dòng/tách
 * dòng, xoá được tại panel). Dán hoặc kéo-thả tệp ảnh cũng đi qua
 * `onRequestImage` như nút ảnh.
 *
 * Mô hình một toolbar (lát E3, theo editor giaokhoa): toolbar CHỈ hiện
 * khi editor đang active (được focus) và được portal vào slot ở header
 * trang (`#editor-toolbar-slot`) nếu trang có slot — một trang nhiều
 * editor vẫn chỉ một toolbar cho editor đang focus; trang không có
 * slot thì toolbar neo sticky ngay trên editor. Tương tác ra ngoài
 * editor (kể cả ra ngoài panel công thức của nó) thì toolbar ẩn và
 * panel đóng. Nội dung phát qua `onChange` luôn ở dạng đem-lưu
 * ({@link contentForSave}: paragraph tiếp nối rỗng sau block nguyên tử
 * ở cuối tài liệu bị dọn), và tài liệu nạp vào luôn được bảo đảm có
 * paragraph tiếp nối khi kết thúc bằng block nguyên tử
 * ({@link ensureTerminalContinuation}).
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
  size = 'default',
  toolbarSlotId = 'editor-toolbar-slot',
  onRequestImage,
  extensions,
}: RichTextEditorProps) {
  const [mathPanel, setMathPanel] = useState<MathPanelState | null>(null);
  const [active, setActive] = useState(false);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const ownerId = useId();
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
    setActive(true);
    setMathPanel({
      latex: typeof node.attrs.latex === 'string' ? node.attrs.latex : '',
      kind,
      targetPos: pos,
      targetKind: kind,
    });
    return true;
  }

  const editor = useEditor({
    extensions: extensions ?? plainTextExtensions,
    content: ensureTerminalContinuation(value ?? EMPTY_DOCUMENT),
    editable,
    onFocus: () => {
      setActive(true);
    },
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
      onChange?.(contentForSave(currentEditor.getJSON() as unknown as RichTextDocument));
    },
  });

  const toolbarState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      bold: currentEditor?.isActive('bold') ?? false,
      italic: currentEditor?.isActive('italic') ?? false,
      strike: currentEditor?.isActive('strike') ?? false,
      code: currentEditor?.isActive('code') ?? false,
      underline: currentEditor?.isActive('underline') ?? false,
      bulletList: currentEditor?.isActive('bulletList') ?? false,
      canUndo: currentEditor?.can().chain().undo().run() ?? false,
      canRedo: currentEditor?.can().chain().redo().run() ?? false,
    }),
  }) ?? {
    bold: false,
    italic: false,
    strike: false,
    code: false,
    underline: false,
    bulletList: false,
    canUndo: false,
    canRedo: false,
  };

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (value === undefined) {
      return;
    }
    const nextDocument = value ?? EMPTY_DOCUMENT;
    // So ở dạng đem-lưu: editor có thể đang giữ paragraph tiếp nối kỹ
    // thuật mà `value` (đã qua contentForSave) không có — hai dạng đó
    // là MỘT nội dung, không được setContent lại (sẽ cướp con trỏ).
    const currentSaved = contentForSave(editor.getJSON() as unknown as RichTextDocument);
    if (JSON.stringify(currentSaved) !== JSON.stringify(contentForSave(nextDocument))) {
      editor.commands.setContent(ensureTerminalContinuation(nextDocument), {
        emitUpdate: false,
      });
    }
  }, [editor, value]);

  // Một toolbar cho editor đang active (lát E3, theo giaokhoa): khi
  // editor active, tìm slot ở header trang để portal toolbar vào;
  // tương tác (pointerdown/focusin) ra ngoài mọi phần tử mang
  // data-editor-owner của CHÍNH editor này (vùng soạn, toolbar, panel
  // công thức) thì tắt active + đóng panel.
  useEffect(() => {
    if (!active) {
      setHeaderTarget(null);
      return undefined;
    }
    setHeaderTarget(document.getElementById(toolbarSlotId));
    const belongsToEditor = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest('[data-editor-owner]')?.getAttribute('data-editor-owner') === ownerId;
    const deactivate = (event: Event) => {
      if (belongsToEditor(event.target)) {
        return;
      }
      setActive(false);
      setMathPanel(null);
    };
    document.addEventListener('pointerdown', deactivate, true);
    document.addEventListener('focusin', deactivate, true);
    return () => {
      document.removeEventListener('pointerdown', deactivate, true);
      document.removeEventListener('focusin', deactivate, true);
    };
  }, [active, ownerId, toolbarSlotId]);

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

  const toolbar =
    editable && active ? (
      <div
        className={
          headerTarget
            ? 'lms-editor-toolbar'
            : 'lms-editor-toolbar lms-editor-toolbar--sticky'
        }
        role="toolbar"
        aria-label="Công cụ chỉnh sửa"
        data-editor-owner={ownerId}
      >
        <button
          type="button"
          className="lms-editor-toolbar__button"
          title="Hoàn tác"
          aria-label="Hoàn tác"
          disabled={!toolbarState.canUndo}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Undo2 />
        </button>
        <button
          type="button"
          className="lms-editor-toolbar__button"
          title="Làm lại"
          aria-label="Làm lại"
          disabled={!toolbarState.canRedo}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.chain().focus().redo().run()}
        >
          <Redo2 />
        </button>
        <span className="lms-editor-toolbar__separator" aria-hidden="true" />
        {TOOLBAR_MARKS.map(({ mark, title, Icon }) => (
          <button
            key={mark}
            type="button"
            className="lms-editor-toolbar__button"
            title={title}
            aria-label={title}
            aria-pressed={toolbarState[mark]}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => toggleMark(mark)}
          >
            <Icon />
          </button>
        ))}
        <button
          type="button"
          className="lms-editor-toolbar__button"
          title="Danh sách không thứ tự"
          aria-label="Danh sách không thứ tự"
          aria-pressed={toolbarState.bulletList}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleBulletList}
        >
          <List />
        </button>
        <span className="lms-editor-toolbar__separator" aria-hidden="true" />
        <button
          type="button"
          className="lms-editor-toolbar__button"
          title="Chèn công thức"
          aria-label="Chèn công thức"
          onMouseDown={(event) => event.preventDefault()}
          onClick={openMathPanel}
        >
          <Sigma />
        </button>
        {onRequestImage ? (
          <button
            type="button"
            className="lms-editor-toolbar__button"
            title="Chèn ảnh"
            aria-label="Chèn ảnh"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void insertImagesFromHost([])}
          >
            <ImagePlus />
          </button>
        ) : null}
      </div>
    ) : null;

  return (
    <div
      className={
        size === 'compact'
          ? 'lms-rich-text-editor lms-rich-text-editor--compact'
          : 'lms-rich-text-editor'
      }
      data-editor-owner={ownerId}
    >
      {toolbar && headerTarget ? createPortal(toolbar, headerTarget) : toolbar}
      {editable && mathPanel ? (
        <MathEditorPanel
          latex={mathPanel.latex}
          kind={mathPanel.kind}
          error={mathPanel.error}
          ownerId={ownerId}
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
      <div className="lms-rich-text-editor__frame">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
