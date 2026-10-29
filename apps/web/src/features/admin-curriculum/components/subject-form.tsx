import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { ErrorAlert } from '#components/error-alert';
import {
  useCreateCurriculumSubject, useUpdateCurriculumSubject, type CurriculumSubject,
} from '#lib/curriculum';
import { errorText } from '../utils/shared';

export function SubjectForm({ initial, subjectId }: { initial?: CurriculumSubject; subjectId?: string }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [position, setPosition] = useState(String(initial?.position ?? 1));
  const [error, setError] = useState<string | null>(null);
  // Ghi môn qua các đột biến của lib/curriculum (F-01 của rà soát
  // #133): tạo mới tự neo context hệ thống trong đột biến, sửa đi
  // thẳng PATCH; thành công thì danh sách môn được làm mới.
  const createSubject = useCreateCurriculumSubject();
  const updateSubject = useUpdateCurriculumSubject();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (subjectId) {
        await updateSubject.mutateAsync({ subjectId, body: { name, slug, position: Number(position) } });
      } else {
        await createSubject.mutateAsync({ name, slug, position: Number(position) });
      }
      navigate('/admin/curriculum');
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      {error ? (
        <ErrorAlert variant="destructive">
          {error}
        </ErrorAlert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="subject-name">{t('curriculumSubjectName')}</Label>
        <Input id="subject-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="subject-slug">{t('curriculumSubjectSlug')}</Label>
        <Input id="subject-slug" value={slug} onChange={(e) => setSlug(e.target.value)} required />
        <p className="text-xs text-muted-foreground">{t('curriculumSubjectSlugHelp')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="subject-position">{t('curriculumPosition')}</Label>
        <Input id="subject-position" type="number" min={1} value={position} onChange={(e) => setPosition(e.target.value)} />
      </div>
      <Button type="submit">{t('curriculumSave')}</Button>
    </form>
  );
}
