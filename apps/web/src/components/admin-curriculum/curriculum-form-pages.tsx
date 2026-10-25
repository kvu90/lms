import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { apiJson } from '#lib/api';
import type { Curriculum } from '#lib/curriculum';
import { FormScreen } from './form-screen';
import { errorText } from './shared';

export function AdminCurriculumNewPage() {
  const { t } = useTranslation('app');
  const { subjectId } = useParams();
  const navigate = useNavigate();
  const [grade, setGrade] = useState('1');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await apiJson('/api/v1/curriculum/curricula', {
        method: 'POST',
        body: JSON.stringify({ subjectId, grade: Number(grade) }),
      });
      navigate('/admin/curriculum');
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <FormScreen title={t('curriculumCreateCurriculum')} backTo="/admin/curriculum">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-2">
          <span id="curriculum-grade-label" className="text-sm font-medium">
            {t('curriculumGrade')}
          </span>
          <Select items={Object.fromEntries(
              Array.from({ length: 12 }, (_, i) => i + 1).map((g) => [String(g), t('curriculumGradeLabel', { grade: g })]),
            )} value={grade} onValueChange={(v) => v && setGrade(v)}>
            <SelectTrigger aria-labelledby="curriculum-grade-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                <SelectItem key={g} value={String(g)}>
                  {t('curriculumGradeLabel', { grade: g })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit">{t('curriculumSave')}</Button>
      </form>
    </FormScreen>
  );
}

export function AdminCurriculumEditPage() {
  const { t } = useTranslation('app');
  const { curriculumId } = useParams();
  const navigate = useNavigate();
  const [grade, setGrade] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!curriculumId) return;
    void apiJson<Curriculum>(`/api/v1/curriculum/curricula/${curriculumId}`)
      .then((row) => setGrade(String(row.grade)))
      .catch(() => setGrade(''));
  }, [curriculumId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await apiJson(`/api/v1/curriculum/curricula/${curriculumId}`, {
        method: 'PATCH',
        body: JSON.stringify({ grade: Number(grade) }),
      });
      navigate('/admin/curriculum');
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <FormScreen title={t('curriculumEditCurriculum')} backTo="/admin/curriculum">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-2">
          <span id="curriculum-grade-edit-label" className="text-sm font-medium">
            {t('curriculumGrade')}
          </span>
          <Select items={Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => i + 1).map((g) => [String(g), t('curriculumGradeLabel', { grade: g })]),
          )} value={grade} onValueChange={(v) => v && setGrade(v)}>
            <SelectTrigger aria-labelledby="curriculum-grade-edit-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                <SelectItem key={g} value={String(g)}>
                  {t('curriculumGradeLabel', { grade: g })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit">{t('curriculumSave')}</Button>
      </form>
    </FormScreen>
  );
}
