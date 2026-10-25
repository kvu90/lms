import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Course, CourseContent, EnrolInstance } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiJson } from '#lib/api';

/** Ghi danh của chính người dùng trong khoá (GET /courses/:id/enrolments/me). */
interface MyEnrolmentView {
  courseId: string;
  userId: string;
  enrolled: boolean;
  active: boolean;
}

/**
 * Thanh toán của chính người dùng (GET /payments/me — PaymentRow ở tầng
 * API). Trang chỉ cần các trường để lọc theo `itemId` (chính là enrol
 * instance id của payment phí ghi danh) và hiển thị trạng thái thật.
 */
interface MyPaymentView {
  id: string;
  userId: string;
  amount: number;
  currency: string;
  status: string;
  component: string;
  itemId: string | null;
}

/** Một dòng tiến độ hoạt động trong GET /courses/:id/completion/me. */
interface CompletionActivityView {
  cmId: string;
  state: number;
  viewed: boolean;
}

/**
 * Shape thật của GET /courses/:id/completion/me (completion.controller):
 * `{ activities, course }` — activities là trạng thái từng cm của chính
 * người xem, course là bản ghi hoàn thành khoá (mang userId của người xem,
 * dùng làm userId khi đánh dấu thủ công lúc chưa có enrolments/me).
 */
interface MyCompletionView {
  activities: CompletionActivityView[];
  course: { id: string; userId: string; course: string; status: string; timeCompleted: string | null };
}

/** Một course module trong nội dung khoá học (kiểu `CourseModule` của contracts, đã gồm `completionManual`). */
type CourseModuleView = CourseContent['sections'][number]['modules'][number];

/** Tiến độ học của tôi trong khoá (GET /courses/:id/progress/me — K2). */
interface MyProgressView {
  percent: number | null;
  completed: number;
  total: number;
  sections: {
    sectionId: string; percent: number | null; completed: number; total: number;
    items: { cmId: string; completion: number; done: boolean }[];
  }[];
  resume: { cmId: string; reason: string } | null;
}

/** Mốc "lớp đã học tới đây" theo từng lớp (GET /courses/:id/progress/class-markers — K2). */
interface ClassMarkersView {
  markers: { groupId: string | null; groupName: string; markerCmId: string | null }[];
}

/** Tải một endpoint phụ một cách độc lập: lỗi thì trả null thay vì sập cả trang. */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Module có cho phép đánh dấu thủ công hay không — khớp đúng điều kiện
 * phía server (completion.service markManual): tracking phải bật
 * (completion ≠ 0) và module dùng hoàn thành thủ công
 * (completionManual hoặc completion = 1).
 */
function allowsManualCompletion(cm: CourseModuleView): boolean {
  return cm.completion !== 0 && (cm.completionManual === true || cm.completion === 1);
}

/**
 * Trang khoá học: người đã ghi danh đang hoạt động thấy nội dung
 * (section + module kèm availability) như trước, kèm nút tự đánh dấu
 * hoàn thành thủ công cho các module cho phép. Người chưa ghi danh không
 * còn ăn lỗi "access denied" trơ trọi: trang tải độc lập thông tin khoá,
 * danh sách enrol instance và ghi danh của tôi, rồi hiện panel ghi danh
 * với các instance self/fee đang bật (status = 0 là đang bật theo schema
 * enrol; manual/cohort/guest bị bỏ qua vì không phải đường tự ghi danh).
 * Instance fee KHÔNG tự ghi danh trực tiếp — chỉ tạo payment qua
 * POST /payments/fee/:instanceId; ghi danh chỉ kích hoạt khi cổng thanh
 * toán xác nhận qua webhook phía server.
 */
export function CoursePage() {
  const { t } = useTranslation('app');
  const { id } = useParams();
  const [course, setCourse] = useState<Course | null>(null);
  const [content, setContent] = useState<CourseContent | null>(null);
  const [enrolment, setEnrolment] = useState<MyEnrolmentView | null>(null);
  const [instances, setInstances] = useState<EnrolInstance[]>([]);
  const [payments, setPayments] = useState<MyPaymentView[]>([]);
  const [completion, setCompletion] = useState<MyCompletionView | null>(null);
  const [progress, setProgress] = useState<MyProgressView | null>(null);
  const [classMarkers, setClassMarkers] = useState<ClassMarkersView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busyInstanceId, setBusyInstanceId] = useState<string | null>(null);
  const [busyCmId, setBusyCmId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);

  /**
   * Nạp lại toàn bộ trạng thái trang từ API: thông tin khoá, instance,
   * ghi danh của tôi và thanh toán của tôi tải độc lập (endpoint nào lỗi
   * cũng không chặn các endpoint còn lại); nội dung chỉ có khi người xem
   * thật sự truy cập được khoá, tiến độ hoàn thành chỉ tải khi đã có nội
   * dung (endpoint completion/me cũng qua cổng truy cập khoá phía server).
   */
  const reload = useCallback(async () => {
    const [courseRes, instancesRes, enrolmentRes, paymentsRes, contentRes] = await Promise.all([
      probe<Course>(`/api/v1/courses/${id}`),
      probe<EnrolInstance[]>(`/api/v1/courses/${id}/enrol/instances`),
      probe<MyEnrolmentView>(`/api/v1/courses/${id}/enrolments/me`),
      probe<MyPaymentView[]>('/api/v1/payments/me'),
      probe<CourseContent>(`/api/v1/courses/${id}/content`),
    ]);
    setCourse(courseRes);
    setInstances(instancesRes ?? []);
    setEnrolment(enrolmentRes);
    setPayments(paymentsRes ?? []);
    setContent(contentRes);
    if (contentRes) {
      const [completionRes, progressRes, markersRes] = await Promise.all([
        probe<MyCompletionView>(`/api/v1/courses/${id}/completion/me`),
        probe<MyProgressView>(`/api/v1/courses/${id}/progress/me`),
        probe<ClassMarkersView>(`/api/v1/courses/${id}/progress/class-markers`),
      ]);
      setCompletion(completionRes);
      setProgress(progressRes);
      setClassMarkers(markersRes);
    } else {
      setCompletion(null);
      setProgress(null);
      setClassMarkers(null);
    }
    setLoaded(true);
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Tự ghi danh qua instance self: POST không body, xong nạp lại trạng thái/nội dung. */
  async function selfEnrol(instanceId: string) {
    setBusyInstanceId(instanceId);
    setActionError(null);
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${id}/enrol/instances/${instanceId}/self-enrol`, { method: 'POST' });
      setMessage(t('enrolSuccess'));
      await reload();
    } catch {
      setActionError(t('enrolFailed'));
    } finally {
      setBusyInstanceId(null);
    }
  }

  /**
   * Tạo payment cho instance fee. Tuyệt đối không gọi self-enrol ở đây:
   * server trả enrol.payment_required cho fee — ghi danh chỉ kích hoạt
   * sau khi webhook của cổng thanh toán xác nhận payment thành công.
   * Sau khi tạo, hiển thị trạng thái thật từ GET /payments/me.
   */
  async function payFee(instanceId: string) {
    setBusyInstanceId(instanceId);
    setActionError(null);
    setMessage(null);
    try {
      await apiJson(`/api/v1/payments/fee/${instanceId}`, { method: 'POST' });
      const mine = await probe<MyPaymentView[]>('/api/v1/payments/me');
      if (mine) setPayments(mine);
      setMessage(t('enrolPaymentCreated'));
    } catch {
      setActionError(t('enrolPaymentFailed'));
    } finally {
      setBusyInstanceId(null);
    }
  }

  /**
   * Tự đánh dấu hoàn thành thủ công cho một module: body theo
   * markManualCompletionSchema ({ userId, complete }) — userId lấy từ
   * ghi danh của tôi (hoặc từ bản ghi completion của tôi khi thiếu).
   * Lỗi từ server chỉ hiện thông điệp thân thiện, không sập trang.
   */
  async function toggleManualCompletion(cmId: string, complete: boolean) {
    const userId = enrolment?.userId ?? completion?.course.userId;
    if (!userId) {
      setCompletionError(t('completionMarkFailed'));
      return;
    }
    setBusyCmId(cmId);
    setCompletionError(null);
    try {
      await apiJson(`/api/v1/courses/${id}/modules/${cmId}/completion/manual`, {
        method: 'POST',
        body: JSON.stringify({ userId, complete }),
      });
      setCompletion(await probe<MyCompletionView>(`/api/v1/courses/${id}/completion/me`));
    } catch {
      setCompletionError(t('completionMarkFailed'));
    } finally {
      setBusyCmId(null);
    }
  }

  if (!loaded)
    return (
      <PageShell width="wide">
        <div className="space-y-3" aria-label={t('courseLoading')}>
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </PageShell>
    );

  const isEnrolledActive = enrolment?.enrolled === true && enrolment?.active === true;

  if (content) {
    const completionByCm = new Map((completion?.activities ?? []).map((a) => [a.cmId, a]));
    const sectionProgress = new Map((progress?.sections ?? []).map((s) => [s.sectionId, s]));
    const markerNamesByCm = new Map<string, string[]>();
    for (const marker of classMarkers?.markers ?? []) {
      if (!marker.markerCmId) continue;
      markerNamesByCm.set(marker.markerCmId, [...(markerNamesByCm.get(marker.markerCmId) ?? []), marker.groupName]);
    }
    return (
      <PageShell width="wide">
        <PageHeader
          title={content.course.fullName}
          description={`${content.course.shortName}${content.course.visible ? '' : ` ${t('hiddenCourseSuffix')}`}`}
        />
        {progress && progress.percent !== null ? (
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium">{t('courseProgressLabel', { percent: progress.percent })}</span>
              <span className="text-sm text-muted-foreground">
                {t('courseProgressDetail', { completed: progress.completed, total: progress.total })}
              </span>
              {progress.resume ? (
                <Link to={`/courses/${id}/learn/${progress.resume.cmId}`}>
                  <Button type="button" size="sm">{t('learnContinue')}</Button>
                </Link>
              ) : null}
              {(() => {
                // Ôn lại (K2-B6): lối vào riêng tới mục chưa xong đầu
                // tiên của section yếu nhất — khác lối "Học tiếp".
                const weakest = [...progress.sections]
                  .filter((s) => s.percent !== null && s.percent < 100)
                  .sort((a, b) => (a.percent ?? 0) - (b.percent ?? 0))[0];
                const target = weakest?.items.find((i) => i.completion !== 0 && !i.done);
                return target && target.cmId !== progress.resume?.cmId ? (
                  <Link to={`/courses/${id}/learn/${target.cmId}`} className="text-sm underline">
                    {t('reviewWeakest')}
                  </Link>
                ) : null;
              })()}
              <Link to={`/courses/${id}/progress`} className="text-sm underline">
                {t('progressReportLink')}
              </Link>
            </CardContent>
          </Card>
        ) : null}
        {isEnrolledActive ? <p className="text-sm text-muted-foreground">{t('enrolledNotice')}</p> : null}
        {completionError ? (
          <Alert variant="destructive">
            <AlertDescription>{completionError}</AlertDescription>
          </Alert>
        ) : null}
        {content.sections.map((section) => (
          <Card key={section.id}>
            <CardHeader>
              <CardTitle>
                {section.name ?? t('sectionDefaultName', { number: section.section })}
                {sectionProgress.get(section.id)?.percent != null ? (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {t('courseProgressLabel', { percent: sectionProgress.get(section.id)!.percent! })}
                  </span>
                ) : null}
              </CardTitle>
              {section.availabilityResult && !section.availabilityResult.available && (
                <CardDescription>
                  {t('sectionRestricted', { reasons: section.availabilityResult.failedDescriptions.join('; ') })}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent>
              {section.frame ? (
                <div className="mb-3 rounded border border-dashed p-3">
                  <p className="text-sm font-medium">{t('courseFrameOutcomes')}</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {section.frame.outcomes.map((outcome, index) => (
                      <li key={outcome.outcomeId ?? `frame-outcome-${index}`}>{outcome.content}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {section.bookFrame ? (
                <div className="mb-3 rounded border border-dashed p-3">
                  <p className="text-sm font-medium">{t('courseBookFrameItems')}</p>
                  <ul className="mt-1 space-y-2 text-sm">
                    {section.bookFrame.items.map((item, index) => (
                      <li key={item.nodeId ?? `book-item-${index}`}>
                        <span className="font-medium">{item.title}</span>
                        {item.outcomes.length > 0 ? (
                          <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
                            {item.outcomes.map((outcome, outcomeIndex) => (
                              <li key={outcome.outcomeId ?? `book-outcome-${outcomeIndex}`}>{outcome.content}</li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <ul className="space-y-2">
                {section.modules.map((rawCm) => {
                  const cm = rawCm as CourseModuleView;
                  const result = cm.availabilityResult;
                  const locked = result !== undefined && !result.available;
                  const activity = completionByCm.get(cm.id);
                  const isComplete = (activity?.state ?? 0) >= 1;
                  const showManual = completion !== null && allowsManualCompletion(cm);
                  return (
                    <li
                      key={cm.id}
                      data-testid={`cm-${cm.id}`}
                      aria-disabled={locked || undefined}
                      className={locked ? 'opacity-50' : undefined}
                    >
                      {isComplete ? <span aria-label={t('completionCompleted')}>✓ </span> : null}
                      {cm.component === 'mod_quiz' && cm.instanceId && !locked ? (
                        <Link to={`/courses/${id}/quizzes/${cm.instanceId}`}>{cm.name || cm.component}</Link>
                      ) : (cm.component === 'mod_page' || cm.component === 'mod_resource') && !locked ? (
                        <Link to={`/courses/${id}/learn/${cm.id}`}>{cm.name || cm.component}</Link>
                      ) : (
                        <span>{cm.name || cm.component}</span>
                      )}
                      {(markerNamesByCm.get(cm.id) ?? []).map((groupName) => (
                        <span key={groupName} className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                          {t('classMarkerBadge', { name: groupName })}
                        </span>
                      ))}
                      {locked && (
                        <span role="note">
                          {' '}
                          {t('lockedSuffix', {
                            reasons: result.failedDescriptions.length
                              ? result.failedDescriptions.join('; ')
                              : t('notAvailableYet'),
                          })}
                        </span>
                      )}
                      {!locked && result && <span> {t('availableSuffix')}</span>}
                      {showManual && (
                        <span className="ml-3 inline-flex items-center gap-2">
                          <span>{isComplete ? t('completionCompleted') : t('completionIncomplete')}</span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busyCmId === cm.id}
                            onClick={() => void toggleManualCompletion(cm.id, !isComplete)}
                          >
                            {isComplete ? t('completionMarkIncomplete') : t('completionMarkComplete')}
                          </Button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {section.modules.length === 0 ? (
                <Empty className="p-4">
                  <EmptyHeader>
                    <EmptyTitle>{t('noActivities')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </PageShell>
    );
  }

  // Chưa truy cập được nội dung: panel ghi danh (chỉ self/fee đang bật).
  const enrolOptions = instances.filter((i) => i.status === 0 && (i.enrol === 'self' || i.enrol === 'fee'));
  const headerCourse = course;
  return (
    <PageShell width="wide">
      <PageHeader
        title={headerCourse ? headerCourse.fullName : t('enrolPanelTitle')}
        description={
          headerCourse
            ? `${headerCourse.shortName}${headerCourse.visible ? '' : ` ${t('hiddenCourseSuffix')}`}`
            : undefined
        }
      />
      <Card>
        <CardContent className="space-y-4">
          <p>{t('enrolPanelDescription')}</p>
          {message ? (
            <Alert>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
          {actionError ? (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}
          {enrolOptions.length === 0 ? (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>{t('enrolNoOptions')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null}
          <ul className="space-y-3" aria-label={t('enrolPanelTitle')}>
            {enrolOptions.map((instance) => {
              const myPayments = payments.filter((p) => p.itemId === instance.id);
              const latestPayment = myPayments[myPayments.length - 1];
              return (
                <li key={instance.id} className="rounded border p-3" data-testid={`enrol-instance-${instance.id}`}>
                  <p className="font-medium">{instance.name ?? t('enrolInstanceFallback')}</p>
                  {instance.enrol === 'self' ? (
                    <>
                      <p className="text-sm text-muted-foreground">{t('enrolSelfDescription')}</p>
                      <Button
                        type="button"
                        disabled={busyInstanceId === instance.id}
                        onClick={() => void selfEnrol(instance.id)}
                      >
                        {busyInstanceId === instance.id ? t('enrolProcessing') : t('enrolSelfAction')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground">{t('enrolFeeDescription')}</p>
                      <p>
                        {t('enrolFeeLine', { amount: instance.cost.toLocaleString(), currency: instance.currency })}
                      </p>
                      <Button
                        type="button"
                        disabled={busyInstanceId === instance.id}
                        onClick={() => void payFee(instance.id)}
                      >
                        {busyInstanceId === instance.id ? t('enrolProcessing') : t('enrolPayAction')}
                      </Button>
                      {latestPayment ? (
                        <div className="mt-2 space-y-1 text-sm">
                          <p>
                            {t('enrolPaymentLine', {
                              amount: latestPayment.amount.toLocaleString(),
                              currency: latestPayment.currency,
                              status: t(
                                latestPayment.status === 'pending'
                                  ? 'paymentStatusPending'
                                  : latestPayment.status === 'succeeded'
                                    ? 'paymentStatusSucceeded'
                                    : latestPayment.status === 'refunded'
                                      ? 'paymentStatusRefunded'
                                      : 'paymentStatusFailed',
                              ),
                            })}
                          </p>
                          {latestPayment.status === 'pending' ? <p>{t('enrolPaymentWaiting')}</p> : null}
                        </div>
                      ) : null}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {enrolOptions.length === 0 && !headerCourse ? (
            <Alert variant="destructive">
              <AlertDescription>{t('courseAccessDenied')}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default CoursePage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navCourses');
}
