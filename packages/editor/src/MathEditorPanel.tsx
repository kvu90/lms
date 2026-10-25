import { useMemo } from 'react';
import { renderMathHtml } from './math.js';

/** Loại node công thức mà panel đang soạn: trong dòng hoặc tách dòng. */
export type MathNodeKind = 'inlineMath' | 'blockMath';

/**
 * Thuộc tính của {@link MathEditorPanel}.
 */
export interface MathEditorPanelProps {
  /** Mã LaTeX hiện tại trong ô nhập. */
  latex: string;
  /** Loại công thức đang soạn (trong dòng / tách dòng). */
  kind: MathNodeKind;
  /** Thông báo lỗi cú pháp sau lần xác nhận bị chặn; không có thì panel đang sạch. */
  error?: string;
  /** Được gọi mỗi khi mã LaTeX thay đổi. */
  onLatexChange: (latex: string) => void;
  /** Được gọi khi người soạn đổi loại công thức. */
  onKindChange: (kind: MathNodeKind) => void;
  /** Xác nhận: phía chứa kiểm tra cú pháp trước khi áp vào tài liệu. */
  onConfirm: () => void;
  /** Huỷ bỏ, đóng panel mà không đổi tài liệu. */
  onCancel: () => void;
  /** Xoá công thức đang sửa; chỉ truyền khi panel đang sửa một công thức có sẵn. */
  onDelete?: () => void;
}

/**
 * Panel soạn một công thức LaTeX: ô nhập mã, nút gạt tách dòng, và vùng
 * xem trước render trực tiếp bằng KaTeX theo từng thay đổi. Enter trong ô
 * nhập là xác nhận, Escape là huỷ. Việc kiểm tra cú pháp và áp vào tài
 * liệu nằm ở phía chứa ({@link RichTextEditor}) — panel chỉ trình bày.
 *
 * @param props - Thuộc tính của panel.
 * @returns Phần tử panel soạn công thức.
 */
export function MathEditorPanel({
  latex,
  kind,
  error,
  onLatexChange,
  onKindChange,
  onConfirm,
  onCancel,
  onDelete,
}: MathEditorPanelProps) {
  const previewHtml = useMemo(
    () => (latex.trim() ? renderMathHtml(latex, kind === 'blockMath') : ''),
    [latex, kind],
  );

  return (
    <section
      className="lms-math-panel"
      aria-label="Soạn công thức LaTeX"
      data-testid="math-panel"
    >
      <div className="lms-math-panel__header">
        <div>
          <div className="lms-math-panel__title">Công thức LaTeX</div>
          <div className="lms-math-panel__hint">Nhập LaTeX, ví dụ: x^2 + y^2 = z^2</div>
        </div>
        <button type="button" onClick={onConfirm}>
          Xong
        </button>
      </div>
      <button
        type="button"
        aria-pressed={kind === 'blockMath'}
        className="lms-math-panel__toggle"
        onClick={() => onKindChange(kind === 'blockMath' ? 'inlineMath' : 'blockMath')}
      >
        Tách dòng
      </button>
      <input
        autoFocus
        aria-label="Mã LaTeX"
        aria-invalid={error ? true : undefined}
        value={latex}
        onChange={(event) => onLatexChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onCancel();
          }
          if (event.key === 'Enter') {
            onConfirm();
          }
        }}
      />
      {error ? (
        <p className="lms-math-panel__error" role="alert">
          {error}
        </p>
      ) : null}
      {previewHtml ? (
        <div
          className="lms-math-panel__preview"
          aria-label="Xem trước công thức"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      ) : null}
      <div className="lms-math-panel__footer">
        <button type="button" onClick={onCancel}>
          Huỷ
        </button>
        {onDelete ? (
          <button type="button" onClick={onDelete}>
            Xoá công thức
          </button>
        ) : null}
      </div>
    </section>
  );
}
