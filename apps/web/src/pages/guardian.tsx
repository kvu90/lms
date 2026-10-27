import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import type { GuardianDigestFrequency, GuardianDigestPreferenceView, GuardianStudentOverviewView, GuardianStudentResultsView } from '@lms/contracts';
import '../i18n';
import { apiJson } from '#lib/api';
import { queryKeys } from '#lib/query-keys';
import { SectionCards, type StatCard } from '#components/section-cards';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Skeleton } from '@lms/ui/components/skeleton';
import { PageShell } from '../components/page-shell';

/** Một liên kết con của phụ huynh (GET /guardian-links/mine/students). */
interface MyStudentEntry {
  student: { id: string; firstName: string; lastName: string; username: string };
}

/** Tên hiển thị của học sinh: Họ + Tên như hồ sơ người dùng. */
function studentName(s: { firstName: string; lastName: string }): string {
  return `${s.lastName} ${s.firstName}`.trim();
}

/** Nhãn ngày dd/MM/yyyy theo ngôn ngữ giao diện. */
function dayLabel(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
}

/** Nhãn ngày giờ ngắn theo ngôn ngữ giao diện. */
function dateTimeLabel(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

/** Số điểm hiển thị theo ngôn ngữ (tối đa 2 chữ số thập phân, không ép 0). */
function scoreLabel(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/** Tiêu đề một khối trên bề mặt phụ huynh. */
function BlockTitle({ children }: { children: string }) {
  return <h2 className="px-4 text-lg font-semibold lg:px-6">{children}</h2>;
}

/**
 * Bề mặt phụ huynh chỉ-xem (PH-1, issue #130): chọn con → 4 khối rút gọn
 * của research mục 4.3 (tóm tắt tuần; kết quả mới ĐÃ CÔNG BỐ từ mốc xem
 * của chính phụ huynh; thông báo lớp; tiến độ theo khoá) + kết quả học
 * tập đã công bố theo môn. Chỉ-xem về dữ liệu của con: trang không có
 * bất kỳ nút hành động nào thay con — dữ liệu đã qua cổng liên kết
 * giám hộ + cổng công bố phía server, trang chỉ trình bày. Ngoại lệ
 * duy nhất thuộc về chính phụ huynh: khối cài đặt tần suất digest
 * (PH-2, issue #159).
 *
 * Đường dẫn (chuẩn đường dẫn #221, lát R2): con đang xem do path
 * quyết định — `/guardian/students/:studentId`; gốc `/guardian`
 * hiện con đầu tiên trong danh sách liên kết. Link sâu digest PH-2
 * nay trỏ thẳng path theo con; các link cũ dạng
 * `/guardian?student=<id>` còn lưu trong thông báo đã phát được
 * trang này chuyển hướng thay thế sang path mới (id không thuộc
 * các con đang liên kết thì về gốc `/guardian`).
 */
/**
 * Khối cài đặt digest của chính phụ huynh cho con đang chọn (PH-2,
 * issue #159): tần suất tổng hợp weekly (mặc định) | daily | off —
 * đây là tuỳ chọn của phụ huynh về thông báo gửi cho CHÍNH MÌNH,
 * không phải hành động thay con nên không phá tính chỉ-xem của bề mặt.
 */
function DigestSettings({ studentId }: { studentId: string }) {
  const { t } = useTranslation('guardian');
  const queryClient = useQueryClient();
  const preferenceQuery = useQuery({
    queryKey: queryKeys.guardianDigestPreference(studentId),
    queryFn: () => apiJson<GuardianDigestPreferenceView>(`/api/v1/guardian/students/${studentId}/digest-preference`),
  });
  const mutation = useMutation({
    mutationFn: (frequency: GuardianDigestFrequency) => apiJson<GuardianDigestPreferenceView>(
      `/api/v1/guardian/students/${studentId}/digest-preference`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frequency }) },
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.guardianDigestPreference(studentId) });
    },
  });
  const current = preferenceQuery.data?.frequency ?? 'weekly';
  const options: { value: GuardianDigestFrequency; label: string }[] = [
    { value: 'weekly', label: t('digestWeekly') },
    { value: 'daily', label: t('digestDaily') },
    { value: 'off', label: t('digestOff') },
  ];
  return (
    <section className="flex flex-col gap-3">
      <BlockTitle>{t('digestTitle')}</BlockTitle>
      <div className="px-4 lg:px-6">
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <p className="text-sm text-muted-foreground">{t('digestDescription')}</p>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('digestTitle')}>
              {options.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant={current === option.value ? 'default' : 'outline'}
                  aria-pressed={current === option.value}
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            {mutation.isError && <p className="text-sm text-destructive">{t('digestError')}</p>}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

export function GuardianPage() {
  const { t, i18n } = useTranslation('guardian');
  const locale = i18n.language;

  const studentsQuery = useQuery({
    queryKey: queryKeys.guardianMyStudents,
    queryFn: () => apiJson<MyStudentEntry[]>('/api/v1/guardian-links/mine/students'),
  });
  const students = studentsQuery.data ?? [];
  // Con đang xem do path quyết định (chuẩn #221, lát R2): tham số
  // :studentId của route con; ở gốc /guardian trang hiện con đầu
  // tiên trong danh sách liên kết như hành vi trước lát.
  const params = useParams();
  const routeStudentId = params.studentId ?? null;
  const navigate = useNavigate();
  // Lớp tương thích cho link cũ /guardian?student=<id>: phán quyết
  // chỉ chốt khi danh sách con đã nạp xong (trước đó trang giữ
  // trạng thái đang tải); id thuộc các con đang liên kết thì sang
  // path mới của đúng con đó, id lạ thì về gốc /guardian bỏ query.
  const [searchParams] = useSearchParams();
  const legacyStudentId = searchParams.get('student');
  const studentsSettled = studentsQuery.isSuccess;
  const routeStudentLinked = routeStudentId !== null && students.some((s) => s.student.id === routeStudentId);
  const studentId = routeStudentLinked ? routeStudentId : students[0]?.student.id;

  const overviewQuery = useQuery({
    queryKey: queryKeys.guardianOverview(studentId ?? ''),
    queryFn: () => apiJson<GuardianStudentOverviewView>(`/api/v1/guardian/students/${studentId}/overview`),
    enabled: !!studentId,
  });
  const resultsQuery = useQuery({
    queryKey: queryKeys.guardianResults(studentId ?? ''),
    queryFn: () => apiJson<GuardianStudentResultsView>(`/api/v1/guardian/students/${studentId}/results`),
    enabled: !!studentId,
  });
  const overview = overviewQuery.data;
  const results = resultsQuery.data;

  const weeklyCards: StatCard[] = overview
    ? [
        { id: 'due', label: t('statDue'), value: String(overview.weekly.dueThisWeek) },
        { id: 'submitted', label: t('statSubmitted'), value: String(overview.weekly.submitted) },
        { id: 'not-submitted', label: t('statNotSubmitted'), value: String(overview.weekly.notSubmitted) },
        { id: 'overdue', label: t('statOverdue'), value: String(overview.weekly.overdue) },
      ]
    : [];

  // Chuyển hướng thay thế của lớp tương thích (chỉ khi danh sách
  // con đã nạp xong): link cũ ?student= hợp lệ → path theo con;
  // path theo con trỏ tới con không thuộc liên kết → về gốc khu
  // vực, tránh hiện dữ liệu của con khác dưới URL của con lạ (đọc
  // dữ liệu vẫn do API gác theo liên kết như mọi đường khác).
  if (studentsSettled && !routeStudentId && legacyStudentId) {
    const legacyLinked = students.some((s) => s.student.id === legacyStudentId);
    return <Navigate to={legacyLinked ? `/guardian/students/${legacyStudentId}` : '/guardian'} replace />;
  }
  if (studentsSettled && routeStudentId && !routeStudentLinked) {
    return <Navigate to="/guardian" replace />;
  }

  return (
    <PageShell width="wide" className="px-0 lg:px-0">
      <div className="flex flex-col gap-2 px-4 lg:px-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {studentsQuery.isPending ? (
        <div className="flex flex-col gap-4 px-4 lg:px-6" data-testid="guardian-loading">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : students.length === 0 ? (
        <div className="px-4 lg:px-6">
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">{t('noChildren')}</CardContent>
          </Card>
        </div>
      ) : (
        <>
          {/* Chọn con là điều hướng sang path của con đó (chuẩn
              #221, lát R2) — URL luôn phản ánh đúng con đang xem. */}
          {students.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 px-4 lg:px-6" role="group" aria-label={t('chooseChild')}>
              {students.map((entry) => (
                <Button
                  key={entry.student.id}
                  type="button"
                  variant={entry.student.id === studentId ? 'default' : 'outline'}
                  aria-pressed={entry.student.id === studentId}
                  onClick={() => navigate(`/guardian/students/${entry.student.id}`)}
                >
                  {studentName(entry.student)}
                </Button>
              ))}
            </div>
          )}
          {students.length === 1 && (
            <p className="px-4 text-base font-medium lg:px-6">{studentName(students[0]!.student)}</p>
          )}

          {studentId && <DigestSettings studentId={studentId} />}

          {overviewQuery.isError || resultsQuery.isError ? (
            <p className="px-4 text-sm text-destructive lg:px-6">{t('loadError')}</p>
          ) : !overview || !results ? (
            <div className="flex flex-col gap-4 px-4 lg:px-6" data-testid="guardian-loading">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : (
            <>
              {/* Khối (a): tóm tắt tuần của con. */}
              <section className="flex flex-col gap-3">
                <BlockTitle>{t('weeklyTitle')}</BlockTitle>
                <p className="-mt-2 px-4 text-sm text-muted-foreground lg:px-6">
                  {t('weeklyRange', { start: dayLabel(overview.weekly.weekStart, locale), end: dayLabel(overview.weekly.weekEnd, locale) })}
                </p>
                <SectionCards cards={weeklyCards} />
                <div className="px-4 lg:px-6">
                  <Card>
                    <CardContent className="py-4">
                      {overview.weekly.items.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t('weeklyEmpty')}</p>
                      ) : (
                        <ul className="flex flex-col divide-y">
                          {overview.weekly.items.map((item) => (
                            <li key={item.cmId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                              <Badge variant={item.status === 'overdue' ? 'destructive' : 'secondary'}>
                                {item.status === 'overdue'
                                  ? t('statusOverdue')
                                  : item.status === 'submitted'
                                    ? t('statusSubmitted')
                                    : t('statusNotSubmitted')}
                              </Badge>
                              <span className="font-medium">{item.name}</span>
                              <span className="text-muted-foreground">
                                {item.kind === 'quiz' ? t('kindQuiz') : t('kindAssignment')} · {item.courseName}
                              </span>
                              <span className="ml-auto text-muted-foreground">{t('dueAt', { date: dateTimeLabel(item.dueAt, locale) })}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </section>

              {/* Khối (b): kết quả mới đã công bố kể từ lần xem trước của phụ huynh. */}
              <section className="flex flex-col gap-3">
                <BlockTitle>{t('newResultsTitle')}</BlockTitle>
                <div className="px-4 lg:px-6">
                  <Card>
                    <CardContent className="py-4">
                      {overview.newResults.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t('newResultsEmpty')}</p>
                      ) : (
                        <ul className="flex flex-col divide-y">
                          {overview.newResults.map((r, idx) => (
                            <li key={`${r.courseId}-${r.itemId ?? r.kind}-${idx}`} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                              <span className="font-medium">
                                {r.itemName}
                              </span>
                              <span className="text-muted-foreground">{r.courseName}</span>
                              {r.finalGrade !== null && r.gradeMax !== null && (
                                <span className="ml-auto font-medium">
                                  {t('newResultGrade', { grade: scoreLabel(r.finalGrade, locale), max: scoreLabel(r.gradeMax, locale) })}
                                </span>
                              )}
                              {r.feedback && <span className="w-full text-muted-foreground">{r.feedback}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </section>

              {/* Khối (c): thông báo lớp của các khoá con ghi danh. */}
              <section className="flex flex-col gap-3">
                <BlockTitle>{t('announcementsTitle')}</BlockTitle>
                <div className="px-4 lg:px-6">
                  <Card>
                    <CardContent className="py-4">
                      {overview.announcements.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t('announcementsEmpty')}</p>
                      ) : (
                        <ul className="flex flex-col divide-y">
                          {overview.announcements.map((a) => (
                            <li key={a.id} className="py-2 text-sm">
                              <div className="flex flex-wrap items-baseline gap-2">
                                <span className="font-medium">{a.subject}</span>
                                <span className="text-muted-foreground">{a.courseName}</span>
                                <span className="ml-auto text-muted-foreground">{dateTimeLabel(a.createdAt, locale)}</span>
                              </div>
                              <p className="text-muted-foreground">{a.body}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </section>

              {/* Khối (d): tiến độ % theo khoá. */}
              <section className="flex flex-col gap-3">
                <BlockTitle>{t('progressTitle')}</BlockTitle>
                <div className="px-4 lg:px-6">
                  <Card>
                    <CardContent className="flex flex-col gap-4 py-4">
                      {overview.courseProgress.map((p) => (
                        <div key={p.courseId} className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-baseline gap-2 text-sm">
                            <span className="font-medium">{p.courseName}</span>
                            <span className="ml-auto text-muted-foreground">
                              {p.percent === null
                                ? t('progressNotTracked')
                                : `${t('progressLine', { completed: p.completed, total: p.total })} · ${p.percent}%`}
                            </span>
                          </div>
                          {p.percent !== null && (
                            <div className="h-2 w-full rounded bg-muted" role="progressbar" aria-valuenow={p.percent} aria-valuemin={0} aria-valuemax={100}>
                              <div className="h-2 rounded bg-primary" style={{ width: `${p.percent}%` }} />
                            </div>
                          )}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </div>
              </section>

              {/* Kết quả học tập đã công bố theo môn/khoá. */}
              <section className="flex flex-col gap-3">
                <BlockTitle>{t('resultsTitle')}</BlockTitle>
                <div className="flex flex-col gap-4 px-4 lg:px-6">
                  {results.courses.length === 0 ? (
                    <Card>
                      <CardContent className="py-4 text-sm text-muted-foreground">{t('resultsEmpty')}</CardContent>
                    </Card>
                  ) : (
                    results.courses.map((course) => (
                      <Card key={course.courseId}>
                        <CardHeader>
                          <CardTitle className="text-base">{course.courseName}</CardTitle>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-2 text-sm">
                          {course.activities.map((activity) => (
                            <div key={activity.itemId} className="flex flex-wrap items-baseline gap-2 border-b pb-2 last:border-0">
                              <span className="font-medium">{activity.itemName}</span>
                              <span className="ml-auto font-medium">
                                {activity.finalGrade !== null
                                  ? t('newResultGrade', { grade: scoreLabel(activity.finalGrade, locale), max: scoreLabel(activity.gradeMax, locale) })
                                  : '—'}
                              </span>
                              {activity.feedback && <span className="w-full text-muted-foreground">{activity.feedback}</span>}
                            </div>
                          ))}
                        </CardContent>
                      </Card>
                    ))
                  )}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </PageShell>
  );
}

export default GuardianPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { guardianKeyMeta } from '../lib/route-meta';
export function meta() {
  return guardianKeyMeta('title');
}
