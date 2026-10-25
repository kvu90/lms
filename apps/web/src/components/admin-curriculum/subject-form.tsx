import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { apiJson } from '#lib/api';
import { fetchSystemContextId, type CurriculumSubject } from '#lib/curriculum';
import { errorText } from './shared';

export function SubjectForm({ initial, subjectId }: { initial?: CurriculumSubject; subjectId?: string }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [position, setPosition] = useState(String(initial?.position ?? 1));
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (subjectId) {
        await apiJson(`/api/v1/curriculum/subjects/${subjectId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, slug, position: Number(position) }),
        });
      } else {
        const contextId = await fetchSystemContextId();
        if (!contextId) throw new Error('no system context');
        await apiJson('/api/v1/curriculum/subjects', {
          method: 'POST',
          body: JSON.stringify({ contextId, name, slug, position: Number(position) }),
        });
      }
      navigate('/admin/curriculum');
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
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
