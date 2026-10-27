/**
 * Khối thông tin chung của form soạn câu hỏi (tách cấu trúc từ
 * `pages/question-editor.tsx` theo đợt A của issue #223): chọn
 * danh mục đích (chỉ khi tạo mới), chọn loại câu hỏi, chọn ngữ
 * liệu đính kèm và trường thân câu cho các loại soạn trên trường
 * rich text thường (trả lời ngắn, tự luận). Khối chỉ trình bày và
 * chuyển thao tác qua props; trạng thái form và các handler đổi
 * danh mục/đổi loại do trang giữ.
 *
 * @param props.form - Trạng thái form hiện tại.
 * @param props.patchForm - Hàm vá một phần trạng thái form của trang.
 * @param props.categories - Danh sách danh mục câu hỏi đã nạp.
 * @param props.categoryId - Danh mục đích đang chọn.
 * @param props.editing - Đang sửa câu có sẵn (khoá chọn loại, ẩn chọn danh mục).
 * @param props.stimuli - Ngữ liệu của danh mục đích.
 * @param props.contextId - Context của bank đích cho đường chèn ảnh.
 * @param props.itemId - Id câu hỏi đang sửa (định danh mục của file ảnh).
 * @param props.onCategoryChange - Handler đổi danh mục đích của trang.
 * @param props.onQtypeChange - Handler đổi loại câu hỏi của trang.
 */
import type { QuestionCategory, StimulusView } from '@lms/contracts';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { useTranslation } from 'react-i18next';
import { QTYPES, QTYPE_LABEL_KEYS, plainText } from '../../pages/questions';
import type { QuestionEditorFormState } from './form-model';
import { RichField } from './rich-fields';

interface GeneralSectionProps {
  form: QuestionEditorFormState;
  patchForm: (patch: Partial<QuestionEditorFormState>) => void;
  categories: QuestionCategory[];
  categoryId: string;
  editing: boolean;
  stimuli: StimulusView[];
  contextId: string | undefined;
  itemId: string | undefined;
  onCategoryChange: (value: string | null) => void;
  onQtypeChange: (value: string | null) => void;
}

export function GeneralSection({
  form,
  patchForm,
  categories,
  categoryId,
  editing,
  stimuli,
  contextId,
  itemId,
  onCategoryChange,
  onQtypeChange,
}: GeneralSectionProps) {
  const { t } = useTranslation('app');

  return (
    <>
      {!editing && (
        <Field>
          <FieldLabel id="q-category-label">{t('category')}</FieldLabel>
          <Select
            items={Object.fromEntries(categories.map((c) => [c.id, c.name]))}
            value={categoryId}
            onValueChange={onCategoryChange}
          >
            <SelectTrigger aria-labelledby="q-category-label" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <Field>
        <FieldLabel id="q-type-label">{t('questionType')}</FieldLabel>
        <Select
          items={Object.fromEntries(QTYPES.map((qtype) => [qtype, t(QTYPE_LABEL_KEYS[qtype])]))}
          value={form.qtype}
          disabled={editing}
          onValueChange={onQtypeChange}
        >
          <SelectTrigger aria-labelledby="q-type-label" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {QTYPES.map((qtype) => (
              <SelectItem key={qtype} value={qtype}>
                {t(QTYPE_LABEL_KEYS[qtype])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel id="q-stimulus-label">{t('attachedStimulus')}</FieldLabel>
        <Select
          items={Object.fromEntries([
            ['none', t('noStimulus')],
            ...stimuli.map((s) => [s.id, plainText(s.content).slice(0, 80)] as [string, string]),
          ])}
          value={form.stimulusId === '' ? 'none' : form.stimulusId}
          onValueChange={(v) => patchForm({ stimulusId: v === 'none' || v === null ? '' : v })}
        >
          <SelectTrigger aria-labelledby="q-stimulus-label" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t('noStimulus')}</SelectItem>
            {stimuli.map((stimulus) => (
              <SelectItem key={stimulus.id} value={stimulus.id}>
                {plainText(stimulus.content).slice(0, 80)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {form.qtype !== 'truefalse' && form.qtype !== 'multichoice' && (
        <RichField
          label={t('questionText')}
          value={form.questionText}
          onChange={(questionText) => patchForm({ questionText })}
          size="default"
          fileArea="questiontext"
          contextId={contextId}
          itemId={itemId}
        />
      )}
    </>
  );
}
