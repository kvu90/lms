/**
 * Các trường soạn rich text của form câu hỏi (tách cấu trúc từ
 * `pages/question-editor.tsx` theo đợt A của issue #223): đường
 * chèn ảnh dùng chung (`useQuestionImageHandler`), trường rich
 * text thường (`RichField`), trường tài liệu thống nhất trắc
 * nghiệm (`McDocumentField`) và đúng/sai (`TfDocumentField`), kèm
 * hàm nhãn đánh số phương án (`numberingLabel`) mà cột xem trước
 * dùng. Các trường chỉ nhận dữ liệu và callback qua props, không
 * tự gọi API ngoài đường tải ảnh của lát files.
 */
import { useCallback, useState } from 'react';
import {
  MultipleChoiceEditor,
  RichTextEditor,
  TrueFalseEditor,
  type MultipleChoiceDocumentJson,
  type RichTextImagePick,
  type TrueFalseDocumentJson,
} from '@lms/editor';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { useTranslation } from 'react-i18next';
import {
  QUESTION_IMAGE_ACCEPT,
  QuestionImageError,
  uploadQuestionImage,
  type QuestionFileArea,
} from '../../lib/question-files';
import { emptyDoc, type Doc } from './form-model';

// ---------------------------------------------------------------------------
// Trường soạn rich text kèm chèn ảnh
// ---------------------------------------------------------------------------

/**
 * Mở trình chọn tệp để xin MỘT tệp ảnh cho callback `onRequestImage` khi
 * người soạn bấm nút ảnh trong toolbar của editor (trường hợp callback
 * được gọi KHÔNG kèm tệp). Input được tạo tạm, gắn vào cuối body trong
 * lúc chọn rồi tự gỡ bỏ; người soạn huỷ chọn thì trả `null`.
 */
function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = QUESTION_IMAGE_ACCEPT;
    input.style.display = 'none';
    const settle = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => settle(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => settle(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Đường chèn ảnh dùng chung của mọi trường soạn trong form câu hỏi
 * (giao diện chốt ở comment 6405254997 trên issue #248, bàn giao QE-1
 * ở comment 6406028273): editor gọi kèm tệp khi người soạn dán/kéo-thả
 * ảnh — tải thẳng tệp đó; gọi không kèm tệp khi bấm nút ảnh — mở
 * trình chọn tệp trước. Chưa có context của bank đích hoặc tải ảnh
 * lỗi thì trả `null` (editor không chèn gì) và lỗi được giữ ở
 * `imageError` để trường soạn hiện ngay dưới trường.
 *
 * @param contextId - Context của bank đích; chưa có thì đường ảnh tắt.
 * @param fileArea - Khu vực file của trường soạn (metadata phân loại).
 * @param itemId - Id câu hỏi đang sửa (định danh mục của file).
 * @returns Handler xin ảnh cho editor + thông báo lỗi tải ảnh hiện tại.
 */
function useQuestionImageHandler(
  contextId: string | undefined,
  fileArea: QuestionFileArea,
  itemId: string | undefined,
): {
  handleRequestImage: (file?: File) => Promise<RichTextImagePick | null>;
  imageError: string | null;
} {
  const { t } = useTranslation('app');
  const [imageError, setImageError] = useState<string | null>(null);
  const handleRequestImage = useCallback(
    async (file?: File): Promise<RichTextImagePick | null> => {
      if (!contextId) return null;
      const chosen = file ?? (await pickImageFile());
      if (!chosen) return null;
      try {
        const result = await uploadQuestionImage(chosen, { contextId, fileArea, itemId });
        setImageError(null);
        return { src: result.src, alt: result.alt };
      } catch (err) {
        if (err instanceof QuestionImageError && err.code === 'file.image_too_large') {
          setImageError(t('questionImageTooLarge'));
        } else if (err instanceof QuestionImageError && err.code === 'file.not_image') {
          setImageError(t('questionImageNotImage'));
        } else {
          setImageError(t('questionImageFailed'));
        }
        return null;
      }
    },
    [contextId, fileArea, itemId, t],
  );
  return { handleRequestImage, imageError };
}

/**
 * Một trường nội dung rich text của form câu hỏi. Chèn ảnh chỉ còn MỘT
 * đường qua chính editor (lát E3 #248, theo mô hình một-toolbar của
 * giaokhoa): nút ảnh trên toolbar của editor đang active, dán và
 * kéo-thả vào vùng soạn — cả ba đều gọi callback `onRequestImage`,
 * tải qua `uploadQuestionImage` của lát files và editor tự chèn
 * node `image` tại con trỏ bằng định danh bền mà callback trả về. Hàng
 * chọn ảnh riêng bọc ngoài từng trường (QuestionImagePicker) đã bỏ —
 * trước lát này mỗi trường mang một hàng như vậy, lặp 10 lần trên form.
 */
export function RichField({
  label,
  value,
  onChange,
  fileArea,
  contextId,
  itemId,
  size = 'compact',
}: {
  label: string;
  value: Doc | undefined;
  onChange: (doc: Doc) => void;
  fileArea: QuestionFileArea;
  contextId?: string;
  itemId?: string;
  /** Cỡ vùng soạn của editor: trường thân câu là `default`, còn lại `compact`. */
  size?: 'default' | 'compact';
}) {
  const doc = value ?? emptyDoc();
  const { handleRequestImage, imageError } = useQuestionImageHandler(contextId, fileArea, itemId);

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <RichTextEditor
        value={doc}
        onChange={onChange}
        ariaLabel={label}
        size={size}
        onRequestImage={contextId ? handleRequestImage : undefined}
      />
      {imageError ? <p className="mt-1 text-sm text-red-600">{imageError}</p> : null}
    </Field>
  );
}

/**
 * Trường soạn trắc nghiệm trên tài liệu thống nhất: thân câu + bốn
 * lựa chọn trong MỘT editor (`MultipleChoiceEditor` của @lms/editor),
 * radio đáp án đúng gắn tại từng lựa chọn. Đường chèn ảnh dùng chung
 * một handler cho cả tài liệu — khu vực file ghi là `questiontext`
 * vì vị trí con trỏ (thân câu hay trong lựa chọn) không lộ ra qua
 * callback ảnh của editor; khu vực chỉ là metadata phân loại của bản
 * ghi file, ảnh vẫn tải/hiển thị theo định danh bền như mọi trường
 * khác.
 */
export function McDocumentField({
  label,
  value,
  correctChoiceId,
  onChange,
  onCorrectChoiceChange,
  contextId,
  itemId,
}: {
  label: string;
  value: MultipleChoiceDocumentJson;
  correctChoiceId: string | undefined;
  onChange: (doc: MultipleChoiceDocumentJson) => void;
  onCorrectChoiceChange: (choiceId: string) => void;
  contextId?: string;
  itemId?: string;
}) {
  const { handleRequestImage, imageError } = useQuestionImageHandler(contextId, 'questiontext', itemId);

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <MultipleChoiceEditor
        value={value}
        onChange={onChange}
        correctChoiceId={correctChoiceId}
        onCorrectChoiceChange={onCorrectChoiceChange}
        ariaLabel={label}
        onRequestImage={contextId ? handleRequestImage : undefined}
      />
      {imageError ? <p className="mt-1 text-sm text-red-600">{imageError}</p> : null}
    </Field>
  );
}

/**
 * Trường soạn Đúng/Sai trên tài liệu thống nhất TF-A: thân chung +
 * đúng 4 mệnh đề trong MỘT editor (`TrueFalseEditor` của @lms/editor),
 * cặp radio Đ/S gắn tại từng mệnh đề để chọn đáp án của mệnh đề đó
 * (đáp án sống ngoài tài liệu qua `answers`/`onAnswerChange`). Đường
 * chèn ảnh dùng chung một handler cho cả tài liệu như trường MC.
 */
export function TfDocumentField({
  label,
  value,
  answers,
  onChange,
  onAnswerChange,
  contextId,
  itemId,
}: {
  label: string;
  value: TrueFalseDocumentJson;
  answers: Record<string, boolean | undefined>;
  onChange: (doc: TrueFalseDocumentJson) => void;
  onAnswerChange: (statementId: string, value: boolean) => void;
  contextId?: string;
  itemId?: string;
}) {
  const { handleRequestImage, imageError } = useQuestionImageHandler(contextId, 'questiontext', itemId);

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <TrueFalseEditor
        value={value}
        onChange={onChange}
        answers={answers}
        onAnswerChange={onAnswerChange}
        ariaLabel={label}
        onRequestImage={contextId ? handleRequestImage : undefined}
      />
      {imageError ? <p className="mt-1 text-sm text-red-600">{imageError}</p> : null}
    </Field>
  );
}

/** Nhãn thứ tự của một phương án theo kiểu đánh số giáo viên đã chọn. */
export function numberingLabel(numbering: string, index: number): string {
  switch (numbering) {
    case 'ABC':
      return `${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[index] ?? index + 1}.`;
    case '123':
      return `${index + 1}.`;
    case 'iii':
      return `${['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'][index] ?? index + 1}.`;
    case 'IIII':
      return `${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][index] ?? index + 1}.`;
    case 'none':
      return '';
    default:
      return `${'abcdefghijklmnopqrstuvwxyz'[index] ?? index + 1}.`;
  }
}
