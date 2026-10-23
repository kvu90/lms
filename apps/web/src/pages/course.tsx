import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import type { Course, CourseContent, EnrolInstance } from '@lms/contracts';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/ui/card';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';

/** Ghi danh của chính người dùng trong khoá (GET /courses/:id/enrolments/me). */
interface MyEnrolmentView {
  courseId: string;
  userId: string;
  enrolled: boolean;
  active: boolean;
}

/**
 * Thanh toán của chính người dùng (GET /payments/me — PaymentRow ở tầng
 * API). Trang chỉ cần các trường để lọc theo `itemid` (chính là enrol
 * instance id của payment phí ghi danh) và hiển thị trạng thái thật.
 */
interface MyPaymentView {
  id: string;
  userid: string;
  amount: number;
  currency: string;
  status: string;
  component: string;
  itemid: string | null;
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
 * người xem, course là bản ghi hoàn thành khoá (mang userid của người xem,
 * dùng làm userid khi đánh dấu thủ công lúc chưa có enrolments/me).
 */
interface MyCompletionView {
  activities: CompletionActivityView[];
  course: { id: string; userid: string; course: string; status: string; timecompleted: string | null };
}

/** Một course module trong nội dung khoá học (kiểu `CourseModule` của contracts, đã gồm `completionmanual`). */
type CourseModuleView = CourseContent['sections'][number]['modules'][number];

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
 * (completionmanual hoặc completion = 1).
 */
function allowsManualCompletion(cm: CourseModuleView): boolean {
  return cm.completion !== 0 && (cm.completionmanual === true || cm.completion === 1);
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
      setCompletion(await probe<MyCompletionView>(`/api/v1/courses/${id}/completion/me`));
    } else {
      setCompletion(null);
    }
    setLoaded(true);
  }, [id]);

  useEffect(() => { void reload(); }, [reload]);

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
   * markManualCompletionSchema ({ userid, complete }) — userid lấy từ
   * ghi danh của tôi (hoặc từ bản ghi completion của tôi khi thiếu).
   * Lỗi từ server chỉ hiện thông điệp thân thiện, không sập trang.
   */
  async function toggleManualCompletion(cmId: string, complete: boolean) {
    const userid = enrolment?.userId ?? completion?.course.userid;
    if (!userid) {
      setCompletionError(t('completionMarkFailed'));
      return;
    }
    setBusyCmId(cmId);
    setCompletionError(null);
    try {
      await apiJson(`/api/v1/courses/${id}/modules/${cmId}/completion/manual`, {
        method: 'POST',
        body: JSON.stringify({ userid, complete }),
      });
      setCompletion(await probe<MyCompletionView>(`/api/v1/courses/${id}/completion/me`));
    } catch {
      setCompletionError(t('completionMarkFailed'));
    } finally {
      setBusyCmId(null);
    }
  }

  if (!loaded) return <main className="px-4 py-4 md:py-6 lg:px-6">{t('courseLoading')}</main>;

  const isEnrolledActive = enrolment?.enrolled === true && enrolment?.active === true;

  if (content) {
    const completionByCm = new Map((completion?.activities ?? []).map((a) => [a.cmId, a]));
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>{content.course.fullname}</CardTitle>
            <CardDescription>{content.course.shortname}{content.course.visible ? '' : ` ${t('hiddenCourseSuffix')}`}</CardDescription>
          </CardHeader>
        </Card>
        {isEnrolledActive ? (
          <p className="text-sm text-muted-foreground">{t('enrolledNotice')}</p>
        ) : null}
        {completionError ? <p role="alert">{completionError}</p> : null}
        {content.sections.map((section) => (
          <Card key={section.id}>
            <CardHeader>
              <CardTitle>{section.name ?? t('sectionDefaultName', { number: section.section })}</CardTitle>
              {section.availabilityResult && !section.availabilityResult.available && (
                <CardDescription>{t('sectionRestricted', { reasons: section.availabilityResult.failedDescriptions.join('; ') })}</CardDescription>
              )}
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {section.modules.map((rawCm) => {
                  const cm = rawCm as CourseModuleView;
                  const result = cm.availabilityResult;
                  const locked = result !== undefined && !result.available;
                  const activity = completionByCm.get(cm.id);
                  const isComplete = (activity?.state ?? 0) >= 1;
                  const showManual = completion !== null && allowsManualCompletion(cm);
                  return (
                    <li key={cm.id} data-testid={`cm-${cm.id}`} aria-disabled={locked || undefined} className={locked ? 'opacity-50' : undefined}>
                      <span>{cm.name || cm.component}</span>
                      {locked && (
                        <span role="note"> {t('lockedSuffix', { reasons: result.failedDescriptions.length ? result.failedDescriptions.join('; ') : t('notAvailableYet') })}</span>
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
                {section.modules.length === 0 && <li>{t('noActivities')}</li>}
              </ul>
            </CardContent>
          </Card>
        ))}
      </main>
    );
  }

  // Chưa truy cập được nội dung: panel ghi danh (chỉ self/fee đang bật).
  const enrolOptions = instances.filter((i) => i.status === 0 && (i.enrol === 'self' || i.enrol === 'fee'));
  const headerCourse = course;
  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{headerCourse ? headerCourse.fullname : t('enrolPanelTitle')}</CardTitle>
          {headerCourse ? (
            <CardDescription>{headerCourse.shortname}{headerCourse.visible ? '' : ` ${t('hiddenCourseSuffix')}`}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          <p>{t('enrolPanelDescription')}</p>
          {message ? <p>{message}</p> : null}
          {actionError ? <p role="alert">{actionError}</p> : null}
          {enrolOptions.length === 0 ? <p>{t('enrolNoOptions')}</p> : null}
          <ul className="space-y-3" aria-label={t('enrolPanelTitle')}>
            {enrolOptions.map((instance) => {
              const myPayments = payments.filter((p) => p.itemid === instance.id);
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
                      <p>{t('enrolFeeLine', { amount: instance.cost.toLocaleString(), currency: instance.currency })}</p>
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
          {enrolOptions.length === 0 && !headerCourse ? <p role="alert">{t('courseAccessDenied')}</p> : null}
        </CardContent>
      </Card>
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default CoursePage;
