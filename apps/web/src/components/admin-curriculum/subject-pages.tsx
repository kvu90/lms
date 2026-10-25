import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageShell } from '../page-shell';
import { apiJson } from '#lib/api';
import type { CurriculumSubject } from '#lib/curriculum';
import { FormScreen } from './form-screen';
import { SubjectForm } from './subject-form';

export function AdminSubjectNewPage() {
  const { t } = useTranslation('app');
  return (
    <FormScreen title={t('curriculumCreateSubject')} backTo="/admin/curriculum">
      <SubjectForm />
    </FormScreen>
  );
}

export function AdminSubjectEditPage() {
  const { t } = useTranslation('app');
  const { subjectId } = useParams();
  const [subject, setSubject] = useState<CurriculumSubject | null>(null);
  useEffect(() => {
    if (!subjectId) return;
    void apiJson<CurriculumSubject>(`/api/v1/curriculum/subjects/${subjectId}`).then(setSubject).catch(() => setSubject(null));
  }, [subjectId]);
  if (!subject) {
    return (
      <PageShell width="narrow">
        <p className="text-sm text-muted-foreground">{t('curriculumLoading')}</p>
      </PageShell>
    );
  }
  return (
    <FormScreen title={t('curriculumEditSubject', { name: subject.name })} backTo="/admin/curriculum">
      <SubjectForm initial={subject} subjectId={subject.id} />
    </FormScreen>
  );
}
