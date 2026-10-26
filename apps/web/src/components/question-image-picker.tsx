import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  QUESTION_IMAGE_ACCEPT, QuestionImageError, uploadQuestionImage,
  type QuestionFileArea, type QuestionImageUploadResult,
} from '../lib/question-files';

/**
 * Bộ chọn ảnh dùng chung cho editor câu hỏi (issue #248, lát QE-2): nút
 * chọn ảnh + vùng kéo thả bọc nội dung con. Bề mặt chứa (màn nhập câu của
 * QE-3) truyền `contextId` của bank đích và nhận kết quả qua `onPick` —
 * chính là callback mà editor QE-1 chờ (`onRequestImage`): bề mặt chứa
 * nối `onPick` vào editor để chèn node image với `src` định danh bền.
 * Component này không tự chèn vào tài liệu và không biết editor.
 */
export function QuestionImagePicker({
  contextId,
  fileArea,
  itemId,
  onPick,
  disabled,
  children,
}: {
  contextId: string;
  fileArea?: QuestionFileArea;
  itemId?: string;
  onPick: (result: QuestionImageUploadResult) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation('app');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const result = await uploadQuestionImage(file, { contextId, fileArea, itemId });
      onPick(result);
    } catch (err) {
      if (err instanceof QuestionImageError && err.code === 'file.image_too_large') setError(t('questionImageTooLarge'));
      else if (err instanceof QuestionImageError && err.code === 'file.not_image') setError(t('questionImageNotImage'));
      else setError(t('questionImageFailed'));
    } finally {
      setBusy(false);
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void handleFile(event.dataTransfer.files?.[0]);
  }

  return (
    <div
      className={dragging ? 'rounded-md outline-2 outline-dashed outline-sky-500' : undefined}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? t('questionImageUploading') : t('questionImagePick')}
        </button>
        <span className="text-xs text-slate-500">{t('questionImageDropHint')}</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={QUESTION_IMAGE_ACCEPT}
        className="hidden"
        onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ''; }}
      />
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
      {children}
    </div>
  );
}
