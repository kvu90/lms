/**
 * Khối đáp án theo loại câu hỏi của form soạn (tách cấu trúc từ
 * `pages/question-editor.tsx` theo đợt A của issue #223): bốn
 * fieldset theo loại (trắc nghiệm, đúng/sai, trả lời ngắn, tự
 * luận) và hai trường chung cuối form (hướng dẫn, phản hồi
 * chung). Khối chỉ trình bày và vá trạng thái form qua
 * `patchForm` được truyền xuống; mọi logic đóng gói payload nằm
 * ở `form-model.ts`.
 *
 * @param props.form - Trạng thái form hiện tại.
 * @param props.patchForm - Hàm vá một phần trạng thái form của trang.
 * @param props.contextId - Context của bank đích cho đường chèn ảnh.
 * @param props.itemId - Id câu hỏi đang sửa (định danh mục của file ảnh).
 * @param props.moveItem - Hàm đổi vị trí một phần tử trong mảng (trang giữ).
 */
import { splitMultipleChoiceDocument } from '@lms/editor';
import { Button } from '@lms/ui/components/button';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { useTranslation } from 'react-i18next';
import type { QuestionEditorFormState } from './form-model';
import { McDocumentField, RichField, TfDocumentField } from './rich-fields';

interface AnswersSectionProps {
  form: QuestionEditorFormState;
  patchForm: (patch: Partial<QuestionEditorFormState>) => void;
  contextId: string | undefined;
  itemId: string | undefined;
  moveItem: <T>(items: T[], index: number, delta: number) => T[];
}

export function AnswersSection({ form, patchForm, contextId, itemId, moveItem }: AnswersSectionProps) {
  const { t } = useTranslation('app');
  // Các lựa chọn hiện tại của tài liệu thống nhất (theo thứ tự soạn)
  // — chỉ để dựng hàng phản hồi theo lựa chọn ở dưới editor.
  const mcSplit = form.qtype === 'multichoice' ? splitMultipleChoiceDocument(form.mcDocument) : null;

  return (
    <>
      {form.qtype === 'multichoice' && (
        <fieldset className="space-y-3">
          <legend className="sr-only">{t('choices')}</legend>
          {/* Soạn thống nhất kiểu giaokhoa: thân câu + 4
                        lựa chọn trong một tài liệu; chọn đáp án
                        đúng bằng radio tại từng lựa chọn trong
                        chính editor; kéo-thả trong editor để đổi
                        thứ tự lựa chọn. */}
          <McDocumentField
            label={t('questionText')}
            value={form.mcDocument}
            correctChoiceId={form.mcCorrectChoiceId}
            onChange={(mcDocument) => patchForm({ mcDocument })}
            onCorrectChoiceChange={(mcCorrectChoiceId) => patchForm({ mcCorrectChoiceId })}
            contextId={contextId}
            itemId={itemId}
          />
          <p className="text-sm text-muted-foreground">{t('mcAuthoringHint')}</p>
          {/* Phản hồi theo lựa chọn là metadata của dòng
                        đáp án nên soạn ở các trường riêng bám theo
                        id choice (đi theo lựa chọn khi kéo-thả đổi
                        thứ tự), không nằm trong tài liệu lựa chọn. */}
          {mcSplit?.choices.map((choice, index) => (
            <RichField
              key={choice.attrs.id}
              label={t('answerFeedback', { index: index + 1 })}
              value={form.mcChoiceFeedbacks[choice.attrs.id]}
              onChange={(feedback) =>
                patchForm({
                  mcChoiceFeedbacks: {
                    ...form.mcChoiceFeedbacks,
                    [choice.attrs.id]: feedback,
                  },
                })
              }
              fileArea="feedback"
              contextId={contextId}
              itemId={itemId}
            />
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="q-mc-shuffle"
                checked={form.mcShuffleAnswers}
                onCheckedChange={(checked) => patchForm({ mcShuffleAnswers: checked === true })}
              />
              <Label htmlFor="q-mc-shuffle">{t('shuffleAnswers')}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="q-mc-instruction"
                checked={form.mcShowStandardInstruction}
                onCheckedChange={(checked) => patchForm({ mcShowStandardInstruction: checked === true })}
              />
              <Label htmlFor="q-mc-instruction">{t('showStandardInstruction')}</Label>
            </div>
            <Field>
              <FieldLabel id="q-mc-numbering-label">{t('answerNumbering')}</FieldLabel>
              <Select
                items={{
                  abc: t('answerNumberingAbc'),
                  ABC: t('answerNumberingABC'),
                  '123': t('answerNumbering123'),
                  iii: t('answerNumberingIii'),
                  IIII: t('answerNumberingIIII'),
                  none: t('answerNumberingNone'),
                }}
                value={form.mcAnswerNumbering}
                onValueChange={(v) => patchForm({ mcAnswerNumbering: v ?? 'abc' })}
              >
                <SelectTrigger aria-labelledby="q-mc-numbering-label" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="abc">{t('answerNumberingAbc')}</SelectItem>
                  <SelectItem value="ABC">{t('answerNumberingABC')}</SelectItem>
                  <SelectItem value="123">{t('answerNumbering123')}</SelectItem>
                  <SelectItem value="iii">{t('answerNumberingIii')}</SelectItem>
                  <SelectItem value="IIII">{t('answerNumberingIIII')}</SelectItem>
                  <SelectItem value="none">{t('answerNumberingNone')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <RichField
            label={t('correctFeedback')}
            value={form.mcCorrectFeedback}
            onChange={(mcCorrectFeedback) => patchForm({ mcCorrectFeedback })}
            fileArea="feedback"
            contextId={contextId}
            itemId={itemId}
          />
          <RichField
            label={t('incorrectFeedback')}
            value={form.mcIncorrectFeedback}
            onChange={(mcIncorrectFeedback) => patchForm({ mcIncorrectFeedback })}
            fileArea="feedback"
            contextId={contextId}
            itemId={itemId}
          />
        </fieldset>
      )}

      {form.qtype === 'truefalse' && (
        <fieldset className="space-y-3">
          <legend className="sr-only">{t('tfStatementsHeading')}</legend>
          {/* Soạn thống nhất kiểu giaokhoa (TF-A): thân
                        chung + đúng 4 mệnh đề trong một tài liệu; đáp
                        án Đ/S của từng mệnh đề chọn bằng cặp radio
                        gắn tại mệnh đề trong chính editor. */}
          <TfDocumentField
            label={t('questionText')}
            value={form.tfDocument}
            answers={form.tfAnswers}
            onChange={(tfDocument) => patchForm({ tfDocument })}
            onAnswerChange={(statementId, value) =>
              patchForm({ tfAnswers: { ...form.tfAnswers, [statementId]: value } })
            }
            contextId={contextId}
            itemId={itemId}
          />
          <p className="text-sm text-muted-foreground">{t('tfAuthoringHint')}</p>
        </fieldset>
      )}

      {form.qtype === 'shortanswer' && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t('acceptedAnswers')}</legend>
          {form.saAnswers.map((answer, index) => (
            <div key={index} className="flex flex-wrap items-end gap-3 rounded-md border p-3">
              <Field className="min-w-48 flex-1">
                <FieldLabel htmlFor={`q-sa-answer-${index}`}>
                  {t('acceptedAnswerText', { index: index + 1 })}
                </FieldLabel>
                <Input
                  id={`q-sa-answer-${index}`}
                  value={answer.text}
                  onChange={(e) =>
                    patchForm({
                      saAnswers: form.saAnswers.map((a, i) => (i === index ? { ...a, text: e.target.value } : a)),
                    })
                  }
                />
              </Field>
              <div className="flex gap-1 pb-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={index === 0}
                  aria-label={t('questionMoveUp')}
                  onClick={() => patchForm({ saAnswers: moveItem(form.saAnswers, index, -1) })}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={index === form.saAnswers.length - 1}
                  aria-label={t('questionMoveDown')}
                  onClick={() => patchForm({ saAnswers: moveItem(form.saAnswers, index, 1) })}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={form.saAnswers.length <= 1}
                  onClick={() => patchForm({ saAnswers: form.saAnswers.filter((_, i) => i !== index) })}
                >
                  {t('removeAnswer', { index: index + 1 })}
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() => patchForm({ saAnswers: [...form.saAnswers, { text: '' }] })}
          >
            {t('addAnswer')}
          </Button>
          <div className="flex items-center gap-2">
            <Checkbox
              id="q-sa-usecase"
              checked={form.saUseCase}
              onCheckedChange={(checked) => patchForm({ saUseCase: checked === true })}
            />
            <Label htmlFor="q-sa-usecase">{t('caseSensitive')}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="q-sa-numeric"
              checked={form.saNumericAnswer}
              onCheckedChange={(checked) => patchForm({ saNumericAnswer: checked === true })}
            />
            <Label htmlFor="q-sa-numeric">{t('numericAnswer')}</Label>
          </div>
          {form.saNumericAnswer && (
            <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="q-sa-numeric-maxlength">{t('numericMaxLength')}</FieldLabel>
                <Input
                  id="q-sa-numeric-maxlength"
                  type="number"
                  min="1"
                  value={form.saNumericMaxLength}
                  onChange={(e) => patchForm({ saNumericMaxLength: e.target.value })}
                />
              </Field>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="q-sa-numeric-sign"
                  checked={form.saNumericAllowSign}
                  onCheckedChange={(checked) => patchForm({ saNumericAllowSign: checked === true })}
                />
                <Label htmlFor="q-sa-numeric-sign">{t('numericAllowSign')}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="q-sa-numeric-decimal"
                  checked={form.saNumericAllowDecimal}
                  onCheckedChange={(checked) => patchForm({ saNumericAllowDecimal: checked === true })}
                />
                <Label htmlFor="q-sa-numeric-decimal">{t('numericAllowDecimal')}</Label>
              </div>
            </div>
          )}
        </fieldset>
      )}

      {form.qtype === 'essay' && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t('questionOptions')}</legend>
          <Field>
            <FieldLabel id="q-essay-format-label">{t('responseFormat')}</FieldLabel>
            <Select
              items={{ editor: t('responseFormatEditor'), plain: t('responseFormatPlain') }}
              value={form.essayResponseFormat}
              onValueChange={(v) => patchForm({ essayResponseFormat: v ?? 'editor' })}
            >
              <SelectTrigger aria-labelledby="q-essay-format-label" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="editor">{t('responseFormatEditor')}</SelectItem>
                <SelectItem value="plain">{t('responseFormatPlain')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox
              id="q-essay-required"
              checked={form.essayResponseRequired}
              onCheckedChange={(checked) => patchForm({ essayResponseRequired: checked === true })}
            />
            <Label htmlFor="q-essay-required">{t('responseRequired')}</Label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="q-essay-lines">{t('responseFieldLines')}</FieldLabel>
              <Input
                id="q-essay-lines"
                type="number"
                min="1"
                value={form.essayResponseFieldLines}
                onChange={(e) => patchForm({ essayResponseFieldLines: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="q-essay-minwords">{t('minWordLimit')}</FieldLabel>
              <Input
                id="q-essay-minwords"
                type="number"
                min="0"
                value={form.essayMinWords}
                onChange={(e) => patchForm({ essayMinWords: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="q-essay-maxwords">{t('maxWordLimit')}</FieldLabel>
              <Input
                id="q-essay-maxwords"
                type="number"
                min="0"
                value={form.essayMaxWords}
                onChange={(e) => patchForm({ essayMaxWords: e.target.value })}
              />
            </Field>
          </div>
          <RichField
            label={t('graderInfo')}
            value={form.essayGraderInfo}
            onChange={(essayGraderInfo) => patchForm({ essayGraderInfo })}
            fileArea="guidance"
            contextId={contextId}
            itemId={itemId}
          />
          <RichField
            label={t('responseTemplate')}
            value={form.essayResponseTemplate}
            onChange={(essayResponseTemplate) => patchForm({ essayResponseTemplate })}
            fileArea="guidance"
            contextId={contextId}
            itemId={itemId}
          />
          {/* Lời giải mẫu thuộc phía đáp án (answer_key)
                        như guidance — học sinh chỉ thấy ở màn xem
                        lại sau khi nộp; khác graderInfo ở trên là
                        thông tin riêng cho người chấm. */}
          <RichField
            label={t('modelAnswer')}
            value={form.essaySolution}
            onChange={(essaySolution) => patchForm({ essaySolution })}
            fileArea="guidance"
            contextId={contextId}
            itemId={itemId}
          />
        </fieldset>
      )}

      {/* Hướng dẫn (guidance) có ở MỌI loại câu: gợi ý
                    cách làm hiện kèm câu hỏi khi học sinh làm bài
                    (điểm quyết D-4) — khác phản hồi chung/lời giải
                    là phần chỉ hiện sau khi nộp. Khi lưu nó đi ở
                    phía đáp án, không nằm trong thân câu. */}
      <div className="space-y-1">
        <RichField
          label={t('guidance')}
          value={form.guidance}
          onChange={(guidance) => patchForm({ guidance })}
          fileArea="guidance"
          contextId={contextId}
          itemId={itemId}
        />
        <p className="text-sm text-muted-foreground">{t('guidanceHint')}</p>
      </div>

      <RichField
        label={t('generalFeedback')}
        value={form.generalFeedback}
        onChange={(generalFeedback) => patchForm({ generalFeedback })}
        fileArea="generalfeedback"
        contextId={contextId}
        itemId={itemId}
      />
    </>
  );
}
