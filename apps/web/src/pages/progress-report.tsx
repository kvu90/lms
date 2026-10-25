import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiFetch, apiJson } from '#lib/api';

/** Một học sinh trong báo cáo tiến độ (GET /courses/:id/progress/report). */
interface ReportStudent {
  userId: string;
  username: string;
  fullName: string;
  completed: number;
  total: number;
  percent: number | null;
  lastAccessAt: string | null;
  states: Record<string, number>;
}

/** Báo cáo tiến độ cho giáo viên: ma trận lớp × mục + tổng theo mục/HS. */
interface ProgressReport {
  courseId: string;
  items: { cmId: string; name: string; component: string; completedCount: number; totalStudents: number; percent: number | null }[];
  students: ReportStudent[];
}

interface CourseGroup { id: string; name: string }

/** Tải một endpoint phụ độc lập: lỗi thì trả null. */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Báo cáo tiến độ học cho giáo viên (K2-B4) — ba bề mặt trên một trang:
 * tổng theo mục (mục nào cả lớp kẹt), ma trận lớp × mục (ô = trạng
 * thái hoàn thành), và tổng theo học sinh kèm lần học gần nhất. Lọc
 * được theo lớp/nhóm và tải xuống CSV. Quyền do API thực thi
 * (completion:view/manage của khoá) — học sinh vào trang chỉ thấy
 * thông báo không có quyền.
 */
export function ProgressReportPage() {
  const { t } = useTranslation('app');
  const { id } = useParams();
  const [report, setReport] = useState<ProgressReport | null>(null);
  const [denied, setDenied] = useState(false);
  const [groups, setGroups] = useState<CourseGroup[]>([]);
  const [groupId, setGroupId] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    const query = groupId ? `?groupId=${groupId}` : '';
    const data = await probe<ProgressReport>(`/api/v1/courses/${id}/progress/report${query}`);
    if (!data) {
      setDenied(true);
      setReport(null);
      return;
    }
    setDenied(false);
    setReport(data);
  }, [id, groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      const data = await probe<CourseGroup[]>(`/api/v1/courses/${id}/groups`);
      setGroups(data ?? []);
    })();
  }, [id]);

  /** Tải CSV qua fetch có xác thực rồi lưu bằng blob URL. */
  async function downloadCsv() {
    if (!id) return;
    const query = groupId ? `?groupId=${groupId}` : '';
    const res = await apiFetch(`/api/v1/courses/${id}/progress/report.csv${query}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'progress-report.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to={`/courses/${id}`} className="text-sm underline">{t('playerBackToCourse')}</Link>
        <h1 className="text-lg font-semibold">{t('progressReportTitle')}</h1>
        {groups.length > 0 ? (
          <select
            className="rounded-md border border-input bg-transparent px-2 py-1 text-sm"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            aria-label={t('progressReportGroupFilter')}
          >
            <option value="">{t('progressReportAllGroups')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        ) : null}
        {report ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void downloadCsv()}>
            {t('progressReportDownloadCsv')}
          </Button>
        ) : null}
      </div>
      {denied ? <p role="alert">{t('progressReportDenied')}</p> : null}
      {report ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('progressReportByItem')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {report.items.map((item) => (
                  <li key={item.cmId}>
                    {item.name} — {t('progressReportItemLine', {
                      done: item.completedCount, total: item.totalStudents, percent: item.percent ?? 0,
                    })}
                  </li>
                ))}
                {report.items.length === 0 ? <li>{t('progressReportEmpty')}</li> : null}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('progressReportMatrix')}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left">{t('progressReportStudent')}</th>
                    {report.items.map((item) => (
                      <th key={item.cmId} className="text-left">{item.name}</th>
                    ))}
                    <th className="text-left">{t('progressReportPercentColumn')}</th>
                    <th className="text-left">{t('progressReportLastAccess')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.students.map((student) => (
                    <tr key={student.userId}>
                      <td>{student.fullName || student.username}</td>
                      {report.items.map((item) => (
                        <td key={item.cmId}>{(student.states[item.cmId] ?? 0) !== 0 ? '✓' : '—'}</td>
                      ))}
                      <td>{student.percent !== null ? `${student.percent}%` : '—'}</td>
                      <td>{student.lastAccessAt ? new Date(student.lastAccessAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                  {report.students.length === 0 ? (
                    <tr><td>{t('progressReportEmpty')}</td></tr>
                  ) : null}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      ) : null}
      {!report && !denied ? <p>{t('courseLoading')}</p> : null}
    </main>
  );
}

/** Route module là chính trang này (src/routes.ts trỏ thẳng vào file): cần default export để framework mode coi đây là route có component — thiếu nó, request tài liệu phía server bị xếp vào resource route và trả 400 (GĐ4 của issue #7 phát hiện khi rà SSR toàn bộ route). */
export default ProgressReportPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Tiến độ học tập');
}
