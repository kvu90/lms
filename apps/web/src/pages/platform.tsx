import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
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

interface SearchDoc {
  id: string;
  area: string;
  itemId: string;
  title: string;
  content: string;
}
interface ServiceView {
  id: string;
  name: string;
  shortName: string;
  enabled: boolean;
  functions: string[];
}
interface TokenView {
  id: string;
  userId: string;
  serviceId: string;
  revoked: boolean;
}
interface BackupJob {
  id: string;
  type: string;
  courseId: string;
  targetCourseId: string | null;
  mode: string;
  status: string;
}
interface BackupStep {
  id: string;
  name: string;
  status: string;
}
interface InsightView {
  id: string;
  userId: string;
  heading: string;
  courseId: string;
}
interface ReportView {
  id: string;
  name: string;
  dataSource: string;
  columns: string[];
}
interface ContentView {
  id: string;
  name: string;
  visibility: string;
  contextId: string;
  fileId: string | null;
}
interface PrivacyRequestView {
  id: string;
  userId: string;
  type: string;
  status: string;
}

/**
 * Tìm kiếm toàn cục (platform services): kết quả đã được server lọc theo quyền của người
 * tìm tại thời điểm truy vấn — client không tự lọc thêm.
 */
export function SearchPage() {
  const { t: t } = useTranslation();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchDoc[]>([]);
  const [searched, setSearched] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const docs = await apiJson<SearchDoc[]>(`/api/v1/search?q=${encodeURIComponent(q)}`);
    setResults(docs);
    setSearched(true);
  }
  return (
    <PageShell width="narrow">
      <PageHeader title={t('searchTitle')} />
      <Card>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void submit(e)} className="flex gap-2">
            <Label htmlFor="search-q" className="sr-only">
              {t('searchQuery')}
            </Label>
            <Input
              id="search-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('searchPlaceholder')}
            />
            <Button type="submit">{t('searchButton')}</Button>
          </form>
          <ul aria-label={t('searchResults')} className="space-y-2">
            {results.map((d) => (
              <li key={d.id} className="rounded border p-2">
                <p className="font-medium">{d.title}</p>
                <p className="text-xs text-muted-foreground">
                  {d.area} · item {d.itemId}
                </p>
                <p className="text-sm">{d.content}</p>
              </li>
            ))}
          </ul>
          {searched && results.length === 0 ? (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>{t('noResults')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null}
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** Quản trị integration tokens (platform services): service + token, token thô chỉ hiện một lần khi tạo. */
export function TokensPage() {
  const { t: tr } = useTranslation();
  const [services, setServices] = useState<ServiceView[]>([]);
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const [s, t] = await Promise.all([
      apiJson<ServiceView[]>('/api/v1/webservice/services'),
      apiJson<TokenView[]>('/api/v1/webservice/tokens').catch(() => []),
    ]);
    setServices(s);
    setTokens(t);
  }, []);
  useEffect(() => {
    void reload()
      .catch(() => setLoadError(tr('tokensLoadFailed')))
      .finally(() => setLoading(false));
  }, [reload, tr]);
  async function createService(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/webservice/services', {
      method: 'POST',
      body: JSON.stringify({ name, shortName: `svc${Date.now()}`, functions: ['core_course_get_courses'] }),
    });
    setName('');
    await reload();
  }
  async function createToken(serviceId: string) {
    const me = await apiJson<{ id: string }>('/api/v1/users/me');
    const created = await apiJson<{ token: string }>('/api/v1/webservice/tokens', {
      method: 'POST',
      body: JSON.stringify({ userId: me.id, serviceId }),
    });
    setCreatedToken(created.token);
    await reload();
  }
  async function revoke(id: string) {
    await apiJson(`/api/v1/webservice/tokens/${id}/revoke`, { method: 'POST', body: '{}' });
    await reload();
  }
  return (
    <PageShell width="medium">
      <PageHeader title={tr('tokensTitle')} />
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
                  .catch(() => setLoadError(tr('tokensLoadFailed')))
                  .finally(() => setLoading(false));
              }}
            >
              {tr('retry')}
            </Button>
          </div>
        </>
      ) : null}
      <Card>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void createService(e)} className="flex items-end gap-2">
            <Field className="flex-1">
              <FieldLabel htmlFor="svc-name" className="sr-only">
                {tr('serviceName')}
              </FieldLabel>
              <Input
                id="svc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tr('serviceName')}
              />
            </Field>
            <Button type="submit">{tr('createService')}</Button>
          </form>
          {createdToken ? (
            <Alert>
              <AlertDescription>{tr('newToken', { token: createdToken })}</AlertDescription>
            </Alert>
          ) : null}
          {loading ? (
            <div className="space-y-2" aria-label={tr('loading')}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <ul aria-label={tr('services')} className="space-y-2">
                {services.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 rounded border p-2">
                    <span className="font-medium">{s.name}</span>
                    <span className="text-xs">{s.functions.join(', ')}</span>
                    <Button type="button" variant="outline" onClick={() => void createToken(s.id)}>
                      {tr('createToken')}
                    </Button>
                  </li>
                ))}
              </ul>
              {services.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{tr('noServicesYet')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
              <ul aria-label={tr('tokens')} className="space-y-2">
                {tokens.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 rounded border p-2">
                    <span>
                      Token #{t.id} for user {t.userId} {t.revoked ? '(revoked)' : ''}
                    </span>
                    {!t.revoked ? (
                      <Button type="button" variant="outline" onClick={() => void revoke(t.id)}>
                        {tr('revoke')}
                      </Button>
                    ) : null}
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

/** Backup/restore (platform services): tạo job, xem bước, restore sang course mới. */
export function BackupPage() {
  const { t: t } = useTranslation();
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [steps, setSteps] = useState<BackupStep[]>([]);
  const [courseId, setCourseId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setJobs(await apiJson<BackupJob[]>('/api/v1/backup/jobs'));
  }, []);
  useEffect(() => {
    void reload()
      .catch(() => setLoadError(t('backupLoadFailed')))
      .finally(() => setLoading(false));
  }, [reload, t]);
  async function createBackup(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/backup/jobs', { method: 'POST', body: JSON.stringify({ courseId }) });
    await reload();
  }
  async function viewSteps(id: string) {
    setSteps(await apiJson<BackupStep[]>(`/api/v1/backup/jobs/${id}/steps`));
  }
  async function restore(id: string) {
    await apiJson('/api/v1/backup/restore', { method: 'POST', body: JSON.stringify({ backupJobId: id, mode: 'new' }) });
    await reload();
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
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setLoadError(null);
                setLoading(true);
                void reload()
                  .catch(() => setLoadError(t('backupLoadFailed')))
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
                    <Button type="button" variant="outline" onClick={() => void viewSteps(j.id)}>
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

/** Insights cho teacher (platform services): chỉ insight mà server đã lọc theo capability mới tới client. */
export function InsightsPage() {
  const { t: t } = useTranslation();
  const [insights, setInsights] = useState<InsightView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setInsights(await apiJson<InsightView[]>('/api/v1/analytics/insights/me'));
  }, []);
  useEffect(() => {
    void load()
      .catch(() => setLoadError(t('insightsLoadFailed')))
      .finally(() => setLoading(false));
  }, [load, t]);
  return (
    <PageShell width="medium">
      <PageHeader title={t('insightsTitle')} />
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
                void load()
                  .catch(() => setLoadError(t('insightsLoadFailed')))
                  .finally(() => setLoading(false));
              }}
            >
              {t('retry')}
            </Button>
          </div>
        </>
      ) : null}
      <Card>
        <CardContent>
          {loading ? (
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <ul aria-label={t('insightsTitle')} className="space-y-2">
                {insights.map((i) => (
                  <li key={i.id} className="rounded border p-2">
                    <p className="font-medium">{i.heading}</p>
                    <p className="text-sm">
                      Student {i.userId} · course {i.courseId}
                    </p>
                  </li>
                ))}
              </ul>
              {insights.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('noInsights')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
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
              <Select value={dataSource} onValueChange={(v) => setDatasource(v ?? 'enrolments')}>
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

/** Content bank (platform services): list theo context và upload file dạng base64 qua envelope JSON. */
export function ContentBankPage() {
  const { t: t } = useTranslation();
  const [items, setItems] = useState<ContentView[]>([]);
  const [name, setName] = useState('');
  const [contextId, setContextId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const path = contextId ? `/api/v1/contentbank?contextId=${contextId}` : '/api/v1/contentbank';
    setItems(await apiJson<ContentView[]>(path));
  }, [contextId]);
  useEffect(() => {
    void reload()
      .catch(() => setLoadError(t('contentBankLoadFailed')))
      .finally(() => setLoading(false));
  }, [reload, t]);
  async function create(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/contentbank', {
      method: 'POST',
      body: JSON.stringify({ name, contextId: contextId, visibility: 'public' }),
    });
    setName('');
    await reload();
  }
  async function upload(id: string) {
    await apiJson(`/api/v1/contentbank/${id}/file`, {
      method: 'POST',
      body: JSON.stringify({
        fileName: 'file.txt',
        contentBase64: btoa('content bank upload'),
        mimeType: 'text/plain',
      }),
    });
    await reload();
  }
  return (
    <PageShell width="medium">
      <PageHeader title={t('contentBankTitle')} />
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
                  .catch(() => setLoadError(t('contentBankLoadFailed')))
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
              <FieldLabel htmlFor="cb-name" className="sr-only">
                {t('contentName')}
              </FieldLabel>
              <Input id="cb-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('contentName')} />
            </Field>
            <Field className="flex-1">
              <FieldLabel htmlFor="cb-context" className="sr-only">
                {t('contextId')}
              </FieldLabel>
              <Input
                id="cb-context"
                value={contextId}
                onChange={(e) => setContextId(e.target.value)}
                placeholder={t('contextId')}
              />
            </Field>
            <Button type="submit">{t('addContent')}</Button>
          </form>
          {loading ? (
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <ul aria-label={t('contentItems')} className="space-y-2">
                {items.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 rounded border p-2">
                    <span>
                      {c.name} — {c.visibility}
                    </span>
                    <Button type="button" variant="outline" onClick={() => void upload(c.id)}>
                      {t('uploadFile')}
                    </Button>
                  </li>
                ))}
              </ul>
              {items.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('noContentYet')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

/**
 * Privacy requests (platform services): user tự gửi yêu cầu export/delete cho chính mình;
 * admin thấy mọi yêu cầu và duyệt/từ chối.
 */
export function PrivacyPage() {
  const { t: t } = useTranslation();
  const [requests, setRequests] = useState<PrivacyRequestView[]>([]);
  const [sent, setSent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setRequests(await apiJson<PrivacyRequestView[]>('/api/v1/privacy/requests'));
  }, []);
  useEffect(() => {
    void reload()
      .catch(() => setLoadError(t('privacyLoadFailed')))
      .finally(() => setLoading(false));
  }, [reload, t]);
  async function send(type: 'export' | 'delete') {
    const created = await apiJson<PrivacyRequestView>('/api/v1/privacy/requests', {
      method: 'POST',
      body: JSON.stringify({ type }),
    });
    setSent(t('requestSent', { id: created.id, type: created.type, status: created.status }));
    await reload();
  }
  async function decide(id: string, decision: 'approved' | 'rejected') {
    await apiJson(`/api/v1/privacy/requests/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision }) });
    await reload();
  }
  return (
    <PageShell width="medium">
      <PageHeader title={t('privacyTitle')} />
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
                  .catch(() => setLoadError(t('privacyLoadFailed')))
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
          <div className="flex gap-2">
            <Button type="button" onClick={() => void send('export')}>
              {t('requestExport')}
            </Button>
            <Button type="button" variant="outline" onClick={() => void send('delete')}>
              {t('requestDelete')}
            </Button>
          </div>
          {sent ? (
            <Alert>
              <AlertDescription>{sent}</AlertDescription>
            </Alert>
          ) : null}
          {loading ? (
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <ul aria-label={t('privacyRequests')} className="space-y-2">
                {requests.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 rounded border p-2">
                    <span>{t('requestLine', { id: r.id, userId: r.userId, type: r.type, status: r.status })}</span>
                    {r.status === 'pending' ? (
                      <>
                        <Button type="button" variant="outline" onClick={() => void decide(r.id, 'approved')}>
                          {t('approve')}
                        </Button>
                        <Button type="button" variant="outline" onClick={() => void decide(r.id, 'rejected')}>
                          {t('reject')}
                        </Button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
              {requests.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('noPrivacyRequestsYet')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
