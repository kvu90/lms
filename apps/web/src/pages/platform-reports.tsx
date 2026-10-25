import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
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
import { Skeleton } from '@lms/ui/components/skeleton';
import { PageHeader, PageShell } from '../components/page-shell';
import { apiJson } from '#lib/api';

interface ReportView {
  id: string;
  name: string;
  dataSource: string;
  columns: string[];
}

/** Report builder tối thiểu (platform services): chọn dataSource/column, xem kết quả, đặt lịch. */
export function ReportsPage() {
  const { t: t } = useTranslation();
  const [reports, setReports] = useState<ReportView[]>([]);
  const [name, setName] = useState('');
  const [dataSource, setDatasource] = useState('enrolments');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setReports(await apiJson<ReportView[]>('/api/v1/reports'));
  }, []);
  useEffect(() => {
    void reload()
      .catch(() => setLoadError(t('reportsLoadFailed')))
      .finally(() => setLoading(false));
  }, [reload, t]);
  async function create(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/reports', {
      method: 'POST',
      body: JSON.stringify({ name, dataSource, columns: ['userId', 'courseId', 'status'], filters: {} }),
    });
    setName('');
    await reload();
  }
  async function run(id: string) {
    const result = await apiJson<{ rows: Record<string, unknown>[] }>(`/api/v1/reports/${id}/run`);
    setRows(result.rows);
  }
  async function schedule(id: string) {
    await apiJson(`/api/v1/reports/${id}/schedules`, { method: 'POST', body: JSON.stringify({ cron: 'daily' }) });
  }
  return (
    <PageShell width="wide">
      <PageHeader title={t('reportsTitle')} />
      {loadError ? (
        <>
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setLoadError(null);
                setLoading(true);
                void reload()
                  .catch(() => setLoadError(t('reportsLoadFailed')))
                  .finally(() => setLoading(false));
              }}
            >
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
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <ul aria-label={t('reports')} className="space-y-2">
                {reports.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 rounded border p-2">
                    <span>
                      {r.name} ({r.dataSource})
                    </span>
                    <Button type="button" variant="outline" onClick={() => void run(r.id)}>
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
