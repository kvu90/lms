import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Skeleton } from '@lms/ui/components/skeleton';
import { PageHeader, PageShell } from '../components/page-shell';
import { useBackupJobs, useBackupSteps, useCreateBackupJob, useRestoreBackup } from '#lib/platform-data';

/**
 * Backup/restore (platform services): tạo job, xem bước, restore sang
 * course mới. Dữ liệu đọc qua tầng TanStack Query
 * (`lib/platform-data.ts`, khoá `backupJobs`/`backupSteps`;
 * `clientLoader` của route nạp trước danh sách việc); các bước chỉ tải
 * khi người dùng chọn xem một việc, tạo job và restore qua đột biến làm
 * mới danh sách như lần tải lại thủ công trước đây.
 */
export function BackupPage() {
  const { t: t } = useTranslation();
  const jobsQuery = useBackupJobs();
  const createJob = useCreateBackupJob();
  const restoreJob = useRestoreBackup();
  const jobs = jobsQuery.data ?? [];
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const stepsQuery = useBackupSteps(selectedJobId);
  const steps = stepsQuery.data ?? [];
  const [courseId, setCourseId] = useState('');
  const loading = jobsQuery.isPending || (jobsQuery.isError && jobsQuery.isFetching);
  const loadError = jobsQuery.isError && !jobsQuery.isFetching ? t('backupLoadFailed') : null;
  async function createBackup(event: FormEvent) {
    event.preventDefault();
    await createJob.mutateAsync(courseId);
  }
  async function restore(id: string) {
    await restoreJob.mutateAsync(id);
  }
  return (
    <PageShell width="medium">
      <PageHeader title={t('backupTitle')} />
      {loadError ? (
        <>
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
          <div>
            <Button type="button" variant="outline" onClick={() => void jobsQuery.refetch()}>
              {t('retry')}
            </Button>
          </div>
        </>
      ) : null}
      <Card>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void createBackup(e)} className="flex items-end gap-2">
            <Field className="flex-1">
              <FieldLabel htmlFor="backup-course" className="sr-only">
                {t('courseId')}
              </FieldLabel>
              <Input
                id="backup-course"
                value={courseId}
                onChange={(e) => setCourseId(e.target.value)}
                placeholder={t('courseId')}
              />
            </Field>
            <Button type="submit">{t('createBackup')}</Button>
          </form>
          {loading ? (
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <ul aria-label={t('backupJobs')} className="space-y-2">
                {jobs.map((j) => (
                  <li key={j.id} className="flex items-center gap-3 rounded border p-2">
                    <span>
                      {t('jobLine', { type: j.type, id: j.id, courseId: j.courseId, status: j.status })}
                      {j.targetCourseId ? ` → ${j.targetCourseId}` : ''}
                    </span>
                    <Button type="button" variant="outline" onClick={() => setSelectedJobId(j.id)}>
                      {t('steps')}
                    </Button>
                    {j.type === 'backup' && j.status === 'completed' ? (
                      <Button type="button" onClick={() => void restore(j.id)}>
                        {t('restoreAsNew')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {jobs.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('noBackupJobsYet')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
              <ul aria-label={t('jobSteps')} className="space-y-1">
                {steps.map((s) => (
                  <li key={s.id}>
                    {s.name}: {s.status}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
