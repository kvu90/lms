import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { PageHeader, PageShell } from '#components/page-shell';
import { useBackupJobs, useBackupSteps, useCreateBackupJob, useRestoreBackup } from '../queries/platform';

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
          <ErrorAlert variant="destructive">
            {loadError}
          </ErrorAlert>
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
            <PageSkeleton label={t('loading')} rows={['h-10 w-full', 'h-10 w-full']} />
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

/** Route module gộp (issue #500): nội dung trang bên dưới vốn ở module pages riêng, phần khung route (biên lỗi + tiêu đề) vốn ở wrapper routes riêng — hai module nhập một theo bản đồ features/. */
export { BackupPage as default };

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { platformKeyMeta } from '#lib/route-meta';
export function meta() {
  return platformKeyMeta('backupTitle');
}

// clientLoader (F-01, rà soát #133): nạp trước dữ liệu đúng khoá trang sẽ đọc.
export { backupPageClientLoader as clientLoader } from '../queries/platform';
