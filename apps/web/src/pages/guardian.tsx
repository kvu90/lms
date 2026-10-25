import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { GuardianStudentOverviewView, GuardianStudentResultsView } from '@lms/contracts';
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
 * tập đã công bố theo môn. Chỉ-xem tuyệt đối: trang không có bất kỳ nút
 * hành động nào thay con — dữ liệu đã qua cổng liên kết giám hộ + cổng
 * công bố phía server, trang chỉ trình bày.
 */
export function GuardianPage() {
  const { t, i18n } = useTranslation('guardian');
  const locale = i18n.language;

  const studentsQuery = useQuery({
    queryKey: queryKeys.guardianMyStudents,
    queryFn: () => apiJson<MyStudentEntry[]>('/api/v1/guardian-links/mine/students'),
  });
  const students = studentsQuery.data ?? [];
  const [pickedId, setPickedId] = useState<string | null>(null);
  const studentId = pickedId && students.some((s) => s.student.id === pickedId)
    ? pickedId
    : students[0]?.student.id;

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
          {students.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 px-4 lg:px-6" role="group" aria-label={t('chooseChild')}>
              {students.map((entry) => (
                <Button
                  key={entry.student.id}
                  type="button"
                  variant={entry.student.id === studentId ? 'default' : 'outline'}
                  aria-pressed={entry.student.id === studentId}
                  onClick={() => setPickedId(entry.student.id)}
                >
                  {studentName(entry.student)}
                </Button>
              ))}
            </div>
          )}
          {students.length === 1 && (
            <p className="px-4 text-base font-medium lg:px-6">{studentName(students[0]!.student)}</p>
          )}

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
                                {r.kind === 'grade_item' ? r.itemName : r.kind === 'vn_year' ? t('newResultVnYear') : t('newResultVnTerm')}
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
                          {course.terms.map((term) => (
                            <div key={term.bookId} className="flex flex-col gap-0.5 border-b pb-2 last:border-0">
                              <span className="font-medium">{term.term === 'hk1' ? t('termHk1') : t('termHk2')}</span>
                              {term.dtbHk !== null && (
                                <span>
                                  {t('dtbLabel')}: <span className="font-medium">{scoreLabel(term.dtbHk, locale)}</span>
                                </span>
                              )}
                              {term.commentResult && (
                                <span>
                                  {t('commentResultLabel')}: <span className="font-medium">{term.commentResult}</span>
                                </span>
                              )}
                              {term.comment && (
                                <span className="text-muted-foreground">
                                  {t('commentLabel')}: {term.comment}
                                </span>
                              )}
                            </div>
                          ))}
                          {course.year && (
                            <div className="flex flex-col gap-0.5 border-b pb-2 last:border-0">
                              <span className="font-medium">{t('yearLabel')}</span>
                              {course.year.dtbYear !== null && (
                                <span>
                                  {t('dtbYearLabel')}: <span className="font-medium">{scoreLabel(course.year.dtbYear, locale)}</span>
                                </span>
                              )}
                              {course.year.comment && <span className="text-muted-foreground">{course.year.comment}</span>}
                            </div>
                          )}
                          {course.courseTotal && course.courseTotal.finalGrade !== null && (
                            <span>
                              {t('courseTotalLabel')}:{' '}
                              <span className="font-medium">
                                {t('newResultGrade', { grade: scoreLabel(course.courseTotal.finalGrade, locale), max: scoreLabel(course.courseTotal.gradeMax, locale) })}
                              </span>
                            </span>
                          )}
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
