import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lms/ui/components/select';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { PageHeader, PageShell } from '#components/page-shell';
import { useCreateReport, usePlatformReports, useReportRun, useScheduleReport } from '../queries/platform';

/**
 * Report builder tối thiểu (platform services): chọn dataSource/column,
 * xem kết quả, đặt lịch. Dữ liệu đọc qua tầng TanStack Query
 * (`lib/platform-data.ts`, khoá `platformReports`/`reportRun`;
 * `clientLoader` của route nạp trước danh sách báo cáo); kết quả chạy
 * chỉ tải khi người dùng bấm chạy một báo cáo, tạo báo cáo qua đột biến
 * làm mới danh sách như lần tải lại thủ công trước đây.
 */
export function ReportsPage() {
  const { t: t } = useTranslation();
  const reportsQuery = usePlatformReports();
  const createReport = useCreateReport();
  const scheduleReport = useScheduleReport();
  const reports = reportsQuery.data ?? [];
  const [name, setName] = useState('');
  const [dataSource, setDatasource] = useState('enrolments');
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const runQuery = useReportRun(selectedReportId);
  const rows = runQuery.data?.rows ?? [];
  const loading = reportsQuery.isPending || (reportsQuery.isError && reportsQuery.isFetching);
  const loadError = reportsQuery.isError && !reportsQuery.isFetching ? t('reportsLoadFailed') : null;
  async function create(event: FormEvent) {
    event.preventDefault();
    await createReport.mutateAsync({ name, dataSource });
    setName('');
  }
  async function schedule(id: string) {
    await scheduleReport.mutateAsync(id);
  }
  return (
    <PageShell width="wide">
      <PageHeader title={t('reportsTitle')} />
      {loadError ? (
        <>
          <ErrorAlert variant="destructive">
            {loadError}
          </ErrorAlert>
          <div>
            <Button type="button" variant="outline" onClick={() => void reportsQuery.refetch()}>
              {t('retry')}
            </Button>
          </div>
        </>
      ) : null}
      <Card>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void create(e)} className="flex items-end gap-2">
            <Field className="flex-1">
              <FieldLabel htmlFor="report-name" className="sr-only">
                {t('reportName')}
              </FieldLabel>
              <Input
                id="report-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('reportName')}
              />
            </Field>
            <Field>
              <FieldLabel id="report-datasource-label" className="sr-only">
                {t('dataSource')}
              </FieldLabel>
              <Select
                items={{ enrolments: t('dsEnrolments'), grades: t('dsGrades'), completion: t('dsCompletion') }}
                value={dataSource}
                onValueChange={(v) => setDatasource(v ?? 'enrolments')}
              >
                <SelectTrigger aria-labelledby="report-datasource-label" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="enrolments">{t('dsEnrolments')}</SelectItem>
                  <SelectItem value="grades">{t('dsGrades')}</SelectItem>
                  <SelectItem value="completion">{t('dsCompletion')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Button type="submit">{t('createReport')}</Button>
          </form>
          {loading ? (
            <PageSkeleton label={t('loading')} rows={['h-10 w-full', 'h-10 w-full']} />
          ) : (
            <>
              <ul aria-label={t('reports')} className="space-y-2">
                {reports.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 rounded border p-2">
                    <span>
                      {r.name} ({r.dataSource})
                    </span>
                    <Button type="button" variant="outline" onClick={() => setSelectedReportId(r.id)}>
                      {t('run')}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void schedule(r.id)}>
                      {t('scheduleDaily')}
                    </Button>
                  </li>
                ))}
              </ul>
              {reports.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('noReportsYet')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
              <p aria-label={t('reportRows', { count: rows.length })}>{t('reportRows', { count: rows.length })}</p>
              <ul aria-label={t('reportResult')} className="space-y-1">
                {rows.map((row, i) => (
                  <li key={i}>{JSON.stringify(row)}</li>
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
export { ReportsPage as default };

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { platformKeyMeta } from '#lib/route-meta';
export function meta() {
  return platformKeyMeta('reportsTitle');
}

// clientLoader (F-01, rà soát #133): nạp trước dữ liệu đúng khoá trang sẽ đọc.
export { reportsPageClientLoader as clientLoader } from '../queries/platform';
