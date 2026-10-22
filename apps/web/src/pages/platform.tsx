import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiJson } from '@/lib/api';

interface SearchDoc { id: number; area: string; itemid: number; title: string; content: string }
interface ServiceView { id: number; name: string; shortname: string; enabled: boolean; functions: string[] }
interface TokenView { id: number; userid: number; serviceid: number; revoked: boolean }
interface BackupJob { id: number; type: string; courseid: number; targetcourseid: number | null; mode: string; status: string }
interface BackupStep { id: number; name: string; status: string }
interface InsightView { id: number; userid: number; heading: string; courseid: number }
interface ReportView { id: number; name: string; datasource: string; columns: string[] }
interface ContentView { id: number; name: string; visibility: string; contextid: number; fileid: number | null }
interface PrivacyRequestView { id: number; userid: number; type: string; status: string }

/**
 * Tìm kiếm toàn cục (platform services): kết quả đã được server lọc theo quyền của người
 * tìm tại thời điểm truy vấn — client không tự lọc thêm.
 */
export function SearchPage() {
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
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <Card>
        <CardHeader><CardTitle>Global search</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void submit(e)} className="flex gap-2">
            <Label htmlFor="search-q" className="sr-only">Search query</Label>
            <Input id="search-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search courses, people, content…" />
            <Button type="submit">Search</Button>
          </form>
          <ul aria-label="Search results" className="space-y-2">
            {results.map((d) => (
              <li key={d.id} className="rounded border p-2">
                <p className="font-medium">{d.title}</p>
                <p className="text-xs text-muted-foreground">{d.area} · item {d.itemid}</p>
                <p className="text-sm">{d.content}</p>
              </li>
            ))}
            {searched && results.length === 0 ? <li>No results you are allowed to see.</li> : null}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}

/** Quản trị integration tokens (platform services): service + token, token thô chỉ hiện một lần khi tạo. */
export function TokensPage() {
  const [services, setServices] = useState<ServiceView[]>([]);
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [name, setName] = useState('');
  const reload = useCallback(async () => {
    const [s, t] = await Promise.all([
      apiJson<ServiceView[]>('/api/v1/webservice/services'),
      apiJson<TokenView[]>('/api/v1/webservice/tokens').catch(() => []),
    ]);
    setServices(s); setTokens(t);
  }, []);
  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  async function createService(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/webservice/services', {
      method: 'POST',
      body: JSON.stringify({ name, shortname: `svc${Date.now()}`, functions: ['core_course_get_courses'] }),
    });
    setName('');
    await reload();
  }
  async function createToken(serviceid: number) {
    const me = await apiJson<{ id: number }>('/api/v1/users/me');
    const created = await apiJson<{ token: string }>('/api/v1/webservice/tokens', {
      method: 'POST', body: JSON.stringify({ userid: me.id, serviceid }),
    });
    setCreatedToken(created.token);
    await reload();
  }
  async function revoke(id: number) {
    await apiJson(`/api/v1/webservice/tokens/${id}/revoke`, { method: 'POST', body: '{}' });
    await reload();
  }
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <Card>
        <CardHeader><CardTitle>Integration tokens</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void createService(e)} className="flex gap-2">
            <Label htmlFor="svc-name" className="sr-only">Service name</Label>
            <Input id="svc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Service name" />
            <Button type="submit">Create service</Button>
          </form>
          {createdToken ? <p role="status">New token (shown once): {createdToken}</p> : null}
          <ul aria-label="Services" className="space-y-2">
            {services.map((s) => (
              <li key={s.id} className="flex items-center gap-3 rounded border p-2">
                <span className="font-medium">{s.name}</span>
                <span className="text-xs">{s.functions.join(', ')}</span>
                <Button type="button" variant="outline" onClick={() => void createToken(s.id)}>Create token</Button>
              </li>
            ))}
          </ul>
          <ul aria-label="Tokens" className="space-y-2">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded border p-2">
                <span>Token #{t.id} for user {t.userid} {t.revoked ? '(revoked)' : ''}</span>
                {!t.revoked ? <Button type="button" variant="outline" onClick={() => void revoke(t.id)}>Revoke</Button> : null}
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
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [steps, setSteps] = useState<BackupStep[]>([]);
  const [courseId, setCourseId] = useState('');
  const reload = useCallback(async () => { setJobs(await apiJson<BackupJob[]>('/api/v1/backup/jobs')); }, []);
  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  async function createBackup(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/backup/jobs', { method: 'POST', body: JSON.stringify({ courseId: Number(courseId) }) });
    await reload();
  }
  async function viewSteps(id: number) { setSteps(await apiJson<BackupStep[]>(`/api/v1/backup/jobs/${id}/steps`)); }
  async function restore(id: number) {
    await apiJson('/api/v1/backup/restore', { method: 'POST', body: JSON.stringify({ backupJobId: id, mode: 'new' }) });
    await reload();
  }
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <Card>
        <CardHeader><CardTitle>Backup and restore</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void createBackup(e)} className="flex gap-2">
            <Label htmlFor="backup-course" className="sr-only">Course id</Label>
            <Input id="backup-course" value={courseId} onChange={(e) => setCourseId(e.target.value)} placeholder="Course id" />
            <Button type="submit">Create backup</Button>
          </form>
          <ul aria-label="Backup jobs" className="space-y-2">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center gap-3 rounded border p-2">
                <span>{j.type} job #{j.id} — course {j.courseid} — {j.status}{j.targetcourseid ? ` → ${j.targetcourseid}` : ''}</span>
                <Button type="button" variant="outline" onClick={() => void viewSteps(j.id)}>Steps</Button>
                {j.type === 'backup' && j.status === 'completed' ? <Button type="button" onClick={() => void restore(j.id)}>Restore as new course</Button> : null}
              </li>
            ))}
          </ul>
          <ul aria-label="Job steps" className="space-y-1">
            {steps.map((s) => <li key={s.id}>{s.name}: {s.status}</li>)}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}

/** Insights cho teacher (platform services): chỉ insight mà server đã lọc theo capability mới tới client. */
export function InsightsPage() {
  const [insights, setInsights] = useState<InsightView[]>([]);
  useEffect(() => { void apiJson<InsightView[]>('/api/v1/analytics/insights/me').then(setInsights).catch(() => undefined); }, []);
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <Card>
        <CardHeader><CardTitle>Insights</CardTitle></CardHeader>
        <CardContent>
          <ul aria-label="Insights" className="space-y-2">
            {insights.map((i) => (
              <li key={i.id} className="rounded border p-2">
                <p className="font-medium">{i.heading}</p>
                <p className="text-sm">Student {i.userid} · course {i.courseid}</p>
              </li>
            ))}
            {insights.length === 0 ? <li>No insights for you right now.</li> : null}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}

/** Report builder tối thiểu (platform services): chọn datasource/column, xem kết quả, đặt lịch. */
export function ReportsPage() {
  const [reports, setReports] = useState<ReportView[]>([]);
  const [name, setName] = useState('');
  const [datasource, setDatasource] = useState('enrolments');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const reload = useCallback(async () => { setReports(await apiJson<ReportView[]>('/api/v1/reports')); }, []);
  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  async function create(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/reports', { method: 'POST', body: JSON.stringify({ name, datasource, columns: ['userId', 'courseId', 'status'], filters: {} }) });
    setName('');
    await reload();
  }
  async function run(id: number) {
    const result = await apiJson<{ rows: Record<string, unknown>[] }>(`/api/v1/reports/${id}/run`);
    setRows(result.rows);
  }
  async function schedule(id: number) {
    await apiJson(`/api/v1/reports/${id}/schedules`, { method: 'POST', body: JSON.stringify({ cron: 'daily' }) });
  }
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <Card>
        <CardHeader><CardTitle>Report builder</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void create(e)} className="flex gap-2">
            <Label htmlFor="report-name" className="sr-only">Report name</Label>
            <Input id="report-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Report name" />
            <Label htmlFor="report-datasource" className="sr-only">Datasource</Label>
            <select id="report-datasource" value={datasource} onChange={(e) => setDatasource(e.target.value)}>
              <option value="enrolments">enrolments</option>
              <option value="grades">grades</option>
              <option value="completion">completion</option>
            </select>
            <Button type="submit">Create report</Button>
          </form>
          <ul aria-label="Reports" className="space-y-2">
            {reports.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded border p-2">
                <span>{r.name} ({r.datasource})</span>
                <Button type="button" variant="outline" onClick={() => void run(r.id)}>Run</Button>
                <Button type="button" variant="outline" onClick={() => void schedule(r.id)}>Schedule daily</Button>
              </li>
            ))}
          </ul>
          <p aria-label="Report rows">{rows.length} rows</p>
          <ul aria-label="Report result" className="space-y-1">
            {rows.map((row, i) => <li key={i}>{JSON.stringify(row)}</li>)}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}

/** Content bank (platform services): list theo context và upload file dạng base64 qua envelope JSON. */
export function ContentBankPage() {
  const [items, setItems] = useState<ContentView[]>([]);
  const [name, setName] = useState('');
  const [contextId, setContextId] = useState('');
  const reload = useCallback(async () => {
    const path = contextId ? `/api/v1/contentbank?contextid=${contextId}` : '/api/v1/contentbank';
    setItems(await apiJson<ContentView[]>(path));
  }, [contextId]);
  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  async function create(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/contentbank', { method: 'POST', body: JSON.stringify({ name, contextid: Number(contextId), visibility: 'public' }) });
    setName('');
    await reload();
  }
  async function upload(id: number) {
    await apiJson(`/api/v1/contentbank/${id}/file`, {
      method: 'POST',
      body: JSON.stringify({ filename: 'file.txt', contentBase64: btoa('content bank upload'), mimetype: 'text/plain' }),
    });
    await reload();
  }
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <Card>
        <CardHeader><CardTitle>Content bank</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void create(e)} className="flex gap-2">
            <Label htmlFor="cb-name" className="sr-only">Content name</Label>
            <Input id="cb-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Content name" />
            <Label htmlFor="cb-context" className="sr-only">Context id</Label>
            <Input id="cb-context" value={contextId} onChange={(e) => setContextId(e.target.value)} placeholder="Context id" />
            <Button type="submit">Add content</Button>
          </form>
          <ul aria-label="Content bank items" className="space-y-2">
            {items.map((c) => (
              <li key={c.id} className="flex items-center gap-3 rounded border p-2">
                <span>{c.name} — {c.visibility}</span>
                <Button type="button" variant="outline" onClick={() => void upload(c.id)}>Upload file</Button>
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
  const [requests, setRequests] = useState<PrivacyRequestView[]>([]);
  const [sent, setSent] = useState<string | null>(null);
  const reload = useCallback(async () => { setRequests(await apiJson<PrivacyRequestView[]>('/api/v1/privacy/requests')); }, []);
  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  async function send(type: 'export' | 'delete') {
    const created = await apiJson<PrivacyRequestView>('/api/v1/privacy/requests', { method: 'POST', body: JSON.stringify({ type }) });
    setSent(`Request #${created.id} (${created.type}) is ${created.status}`);
    await reload();
  }
  async function decide(id: number, decision: 'approved' | 'rejected') {
    await apiJson(`/api/v1/privacy/requests/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision }) });
    await reload();
  }
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <Card>
        <CardHeader><CardTitle>Privacy requests</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Button type="button" onClick={() => void send('export')}>Request my data export</Button>
            <Button type="button" variant="outline" onClick={() => void send('delete')}>Request deletion of my data</Button>
          </div>
          {sent ? <p role="status">{sent}</p> : null}
          <ul aria-label="Privacy requests" className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded border p-2">
                <span>#{r.id} user {r.userid} — {r.type} — {r.status}</span>
                {r.status === 'pending' ? (
                  <>
                    <Button type="button" variant="outline" onClick={() => void decide(r.id, 'approved')}>Approve</Button>
                    <Button type="button" variant="outline" onClick={() => void decide(r.id, 'rejected')}>Reject</Button>
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
