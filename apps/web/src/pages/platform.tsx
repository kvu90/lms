import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/ui/card';
import { Input } from '@lms/ui/components/ui/input';
import { Label } from '@lms/ui/components/ui/label';
import { apiJson } from '@/lib/api';

interface SearchDoc {
  id: string;
  area: string;
  itemid: string;
  title: string;
  content: string;
}
interface ServiceView {
  id: string;
  name: string;
  shortname: string;
  enabled: boolean;
  functions: string[];
}
interface TokenView {
  id: string;
  userid: string;
  serviceid: string;
  revoked: boolean;
}
interface BackupJob {
  id: string;
  type: string;
  courseid: string;
  targetcourseid: string | null;
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
  userid: string;
  heading: string;
  courseid: string;
}
interface ReportView {
  id: string;
  name: string;
  datasource: string;
  columns: string[];
}
interface ContentView {
  id: string;
  name: string;
  visibility: string;
  contextid: string;
  fileid: string | null;
}
interface PrivacyRequestView {
  id: string;
  userid: string;
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
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('searchTitle')}</CardTitle>
        </CardHeader>
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
                  {d.area} · item {d.itemid}
                </p>
                <p className="text-sm">{d.content}</p>
              </li>
            ))}
            {searched && results.length === 0 ? <li>{t('noResults')}</li> : null}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}

/** Quản trị integration tokens (platform services): service + token, token thô chỉ hiện một lần khi tạo. */
export function TokensPage() {
  const { t: tr } = useTranslation();
  const [services, setServices] = useState<ServiceView[]>([]);
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [name, setName] = useState('');
  const reload = useCallback(async () => {
    const [s, t] = await Promise.all([
      apiJson<ServiceView[]>('/api/v1/webservice/services'),
      apiJson<TokenView[]>('/api/v1/webservice/tokens').catch(() => []),
    ]);
    setServices(s);
    setTokens(t);
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);
  async function createService(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/webservice/services', {
      method: 'POST',
      body: JSON.stringify({ name, shortname: `svc${Date.now()}`, functions: ['core_course_get_courses'] }),
    });
    setName('');
    await reload();
  }
  async function createToken(serviceid: string) {
    const me = await apiJson<{ id: string }>('/api/v1/users/me');
    const created = await apiJson<{ token: string }>('/api/v1/webservice/tokens', {
      method: 'POST',
      body: JSON.stringify({ userid: me.id, serviceid }),
    });
    setCreatedToken(created.token);
    await reload();
  }
  async function revoke(id: string) {
    await apiJson(`/api/v1/webservice/tokens/${id}/revoke`, { method: 'POST', body: '{}' });
    await reload();
  }
  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{tr('tokensTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void createService(e)} className="flex gap-2">
            <Label htmlFor="svc-name" className="sr-only">
              {tr('serviceName')}
            </Label>
            <Input
              id="svc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tr('serviceName')}
            />
            <Button type="submit">{tr('createService')}</Button>
          </form>
          {createdToken ? <p role="status">{tr('newToken', { token: createdToken })}</p> : null}
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
          <ul aria-label={tr('tokens')} className="space-y-2">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded border p-2">
                <span>
                  Token #{t.id} for user {t.userid} {t.revoked ? '(revoked)' : ''}
                </span>
                {!t.revoked ? (
                  <Button type="button" variant="outline" onClick={() => void revoke(t.id)}>
                    {tr('revoke')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}

/** Backup/restore (platform services): tạo job, xem bước, restore sang course mới. */
export function BackupPage() {
  const { t: t } = useTranslation();
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [steps, setSteps] = useState<BackupStep[]>([]);
  const [courseId, setCourseId] = useState('');
  const reload = useCallback(async () => {
    setJobs(await apiJson<BackupJob[]>('/api/v1/backup/jobs'));
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);
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
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('backupTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void createBackup(e)} className="flex gap-2">
            <Label htmlFor="backup-course" className="sr-only">
              {t('courseId')}
            </Label>
            <Input
              id="backup-course"
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
              placeholder={t('courseId')}
            />
            <Button type="submit">{t('createBackup')}</Button>
          </form>
          <ul aria-label={t('backupJobs')} className="space-y-2">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center gap-3 rounded border p-2">
                <span>
                  {t('jobLine', { type: j.type, id: j.id, courseid: j.courseid, status: j.status })}
                  {j.targetcourseid ? ` → ${j.targetcourseid}` : ''}
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
          <ul aria-label={t('jobSteps')} className="space-y-1">
            {steps.map((s) => (
              <li key={s.id}>
                {s.name}: {s.status}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}

/** Insights cho teacher (platform services): chỉ insight mà server đã lọc theo capability mới tới client. */
export function InsightsPage() {
  const { t: t } = useTranslation();
  const [insights, setInsights] = useState<InsightView[]>([]);
  useEffect(() => {
    void apiJson<InsightView[]>('/api/v1/analytics/insights/me')
      .then(setInsights)
      .catch(() => undefined);
  }, []);
  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('insightsTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul aria-label={t('insightsTitle')} className="space-y-2">
            {insights.map((i) => (
              <li key={i.id} className="rounded border p-2">
                <p className="font-medium">{i.heading}</p>
                <p className="text-sm">
                  Student {i.userid} · course {i.courseid}
                </p>
              </li>
            ))}
            {insights.length === 0 ? <li>{t('noInsights')}</li> : null}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}

/** Report builder tối thiểu (platform services): chọn datasource/column, xem kết quả, đặt lịch. */
export function ReportsPage() {
  const { t: t } = useTranslation();
  const [reports, setReports] = useState<ReportView[]>([]);
  const [name, setName] = useState('');
  const [datasource, setDatasource] = useState('enrolments');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const reload = useCallback(async () => {
    setReports(await apiJson<ReportView[]>('/api/v1/reports'));
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);
  async function create(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/reports', {
      method: 'POST',
      body: JSON.stringify({ name, datasource, columns: ['userId', 'courseId', 'status'], filters: {} }),
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
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('reportsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void create(e)} className="flex gap-2">
            <Label htmlFor="report-name" className="sr-only">
              {t('reportName')}
            </Label>
            <Input
              id="report-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('reportName')}
            />
            <Label htmlFor="report-datasource" className="sr-only">
              {t('datasource')}
            </Label>
            <select id="report-datasource" value={datasource} onChange={(e) => setDatasource(e.target.value)}>
              <option value="enrolments">{t('dsEnrolments')}</option>
              <option value="grades">{t('dsGrades')}</option>
              <option value="completion">{t('dsCompletion')}</option>
            </select>
            <Button type="submit">{t('createReport')}</Button>
          </form>
          <ul aria-label={t('reports')} className="space-y-2">
            {reports.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded border p-2">
                <span>
                  {r.name} ({r.datasource})
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
          <p aria-label={t('reportRows', { count: rows.length })}>{t('reportRows', { count: rows.length })}</p>
          <ul aria-label={t('reportResult')} className="space-y-1">
            {rows.map((row, i) => (
              <li key={i}>{JSON.stringify(row)}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}

/** Content bank (platform services): list theo context và upload file dạng base64 qua envelope JSON. */
export function ContentBankPage() {
  const { t: t } = useTranslation();
  const [items, setItems] = useState<ContentView[]>([]);
  const [name, setName] = useState('');
  const [contextId, setContextId] = useState('');
  const reload = useCallback(async () => {
    const path = contextId ? `/api/v1/contentbank?contextid=${contextId}` : '/api/v1/contentbank';
    setItems(await apiJson<ContentView[]>(path));
  }, [contextId]);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);
  async function create(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/contentbank', {
      method: 'POST',
      body: JSON.stringify({ name, contextid: contextId, visibility: 'public' }),
    });
    setName('');
    await reload();
  }
  async function upload(id: string) {
    await apiJson(`/api/v1/contentbank/${id}/file`, {
      method: 'POST',
      body: JSON.stringify({
        filename: 'file.txt',
        contentBase64: btoa('content bank upload'),
        mimetype: 'text/plain',
      }),
    });
    await reload();
  }
  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('contentBankTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void create(e)} className="flex gap-2">
            <Label htmlFor="cb-name" className="sr-only">
              {t('contentName')}
            </Label>
            <Input id="cb-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('contentName')} />
            <Label htmlFor="cb-context" className="sr-only">
              {t('contextId')}
            </Label>
            <Input
              id="cb-context"
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
              placeholder={t('contextId')}
            />
            <Button type="submit">{t('addContent')}</Button>
          </form>
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
        </CardContent>
      </Card>
    </main>
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
  const reload = useCallback(async () => {
    setRequests(await apiJson<PrivacyRequestView[]>('/api/v1/privacy/requests'));
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);
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
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('privacyTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Button type="button" onClick={() => void send('export')}>
              {t('requestExport')}
            </Button>
            <Button type="button" variant="outline" onClick={() => void send('delete')}>
              {t('requestDelete')}
            </Button>
          </div>
          {sent ? <p role="status">{sent}</p> : null}
          <ul aria-label={t('privacyRequests')} className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded border p-2">
                <span>{t('requestLine', { id: r.id, userid: r.userid, type: r.type, status: r.status })}</span>
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
        </CardContent>
      </Card>
    </main>
  );
}
