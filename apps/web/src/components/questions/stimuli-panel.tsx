/**
 * Panel ngữ liệu của trang ngân hàng câu hỏi (thẻ #stimuli ở khu vực
 * ngữ liệu): danh sách ngữ liệu của danh mục đang chọn + form tạo/sửa
 * ngay trong thẻ. Dữ liệu danh sách do trang nạp rồi truyền xuống;
 * panel giữ state nội dung đang soạn + ngữ liệu đang sửa và tự gọi
 * các đột biến của lib/questions-data; làm mới danh sách qua invalidate
 * đúng khoá factory của danh mục đang chọn như khi còn trong trang.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { StimulusView } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Textarea } from '@lms/ui/components/textarea';

import { useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '#lib/query-keys';
import { useCreateStimulus, useDeleteStimulus, useUpdateStimulus } from '#lib/questions-data';
import { plainText } from './shared';

/** Props của panel ngữ liệu. */
export interface StimuliPanelProps {
  /** Các ngữ liệu của danh mục đang chọn (trang nạp bằng hook useCategoryStimuli). */
  stimuli: StimulusView[];
  /** Danh mục đang chọn (khoá làm mới + danh mục đích khi tạo ngữ liệu). */
  qCategory: string;
  /** Báo thông báo kết quả lên khung trang. */
  setMessage: (message: string | null) => void;
}

/**
 * Panel ngữ liệu.
 *
 * @param props - Dữ liệu và bộ báo thông báo của trang.
 * @returns Thẻ ngữ liệu: danh sách + form tạo/sửa.
 */
export function StimuliPanel({ stimuli, qCategory, setMessage }: StimuliPanelProps) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const updateStimulusMutation = useUpdateStimulus();
  const createStimulusMutation = useCreateStimulus();
  const deleteStimulusMutation = useDeleteStimulus();
  const [stimulusContent, setStimulusContent] = useState('');
  const [editingStimulus, setEditingStimulus] = useState<StimulusView | null>(null);

  const refreshCategoryStimuli = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.categoryStimuli(qCategory) });
  };

  async function submitStimulus(event: FormEvent) {
    event.preventDefault();
    if (editingStimulus) {
      try {
        await updateStimulusMutation.mutateAsync({ stimulusId: editingStimulus.id, content: stimulusContent });
        setEditingStimulus(null);
        setStimulusContent('');
        refreshCategoryStimuli();
      } catch {
        setMessage(t('stimulusSaveFailed'));
      }
      return;
    }
    try {
      await createStimulusMutation.mutateAsync({ categoryId: qCategory, content: stimulusContent });
      setStimulusContent('');
      refreshCategoryStimuli();
    } catch {
      setMessage(t('stimulusCreateFailed'));
    }
  }

  async function deleteStimulus(stimulus: StimulusView) {
    try {
      await deleteStimulusMutation.mutateAsync(stimulus.id);
      if (editingStimulus?.id === stimulus.id) {
        setEditingStimulus(null);
        setStimulusContent('');
      }
      refreshCategoryStimuli();
    } catch {
      setMessage(t('stimulusDeleteFailed'));
    }
  }

  return (
    <Card id="stimuli" className="scroll-mt-24">
      <CardHeader>
        <CardTitle>{t('stimuli')}</CardTitle>
        <CardDescription>{t('stimuliDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2">
          {stimuli.map((stimulus) => (
            <li key={stimulus.id} data-testid={`stimulus-row-${stimulus.id}`} className="flex items-start gap-2">
              <span className="flex-1 text-sm">{plainText(stimulus.content)}</span>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditingStimulus(stimulus);
                  setStimulusContent(plainText(stimulus.content));
                }}
              >
                {t('editStimulus')}
              </Button>
              <Button type="button" variant="outline" onClick={() => void deleteStimulus(stimulus)}>
                {t('deleteStimulus')}
              </Button>
            </li>
          ))}
        </ul>
        <form onSubmit={(e) => void submitStimulus(e)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="stimulus-content">
                {editingStimulus ? t('stimulusContent') : t('newStimulus')}
              </FieldLabel>
              <Textarea
                id="stimulus-content"
                rows={4}
                value={stimulusContent}
                onChange={(e) => setStimulusContent(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit">{editingStimulus ? t('saveStimulus') : t('createStimulus')}</Button>
              {editingStimulus && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEditingStimulus(null);
                    setStimulusContent('');
                  }}
                >
                  {t('cancelStimulusEdit')}
                </Button>
              )}
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
