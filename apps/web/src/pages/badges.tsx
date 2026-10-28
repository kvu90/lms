import { useState, type FormEvent } from 'react';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Skeleton } from '@lms/ui/components/skeleton';
import { ErrorAlert } from '#components/error-alert';
import { formatDate } from '#lib/date-format';
import { usePermissions } from '#lib/permissions';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import {
  useAllBadges,
  useBadgeIssued,
  useCreateBadge,
  useMyBadges,
  useSetBadgeCriteria,
  useSetBadgeStatus,
  type BadgeView,
  type MyBadgeView,
} from '#lib/badges';
import { queryKeys } from '#lib/query-keys';
import { buildSsrLoaderData, serverQueryFn, type SsrLoaderData } from '#lib/ssr-data';

/**
 * Loader phía server (tầng SL-1 của #7): prefetch hai danh sách mà
 * trang luôn tải khi mở — huy hiệu của tôi (key `myBadges`) và toàn
 * bộ huy hiệu (key `badgesAll`) — bằng cookie của chính request rồi
 * dehydrate cho root.tsx hydrate vào cache (xem `lib/ssr-data.ts`).
 * Danh sách đã cấp của một badge (key `badgeIssued`) chỉ tải khi
 * người dùng chọn xem một badge cụ thể nên KHÔNG prefetch. Không có
 * cookie phiên thì không gọi API nào.
 *
 * @param request - Request đang phục vụ (nguồn cookie phiên).
 * @returns Dehydrated state cho HydrationBoundary ở root.
 */
export async function loader({ request }: { request: Request }): Promise<SsrLoaderData> {
  return buildSsrLoaderData(request, async (queryClient, req) => {
    await Promise.all([
      queryClient.prefetchQuery({
        queryKey: queryKeys.myBadges,
        queryFn: serverQueryFn<MyBadgeView[]>(req, '/api/v1/badges/mine'),
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.badgesAll,
        queryFn: serverQueryFn<BadgeView[]>(req, '/api/v1/badges'),
      }),
    ]);
  });
}

/**
 * Trang huy hiệu: "huy hiệu của tôi" (từ GET /badges/mine — server tự suy
 * người dùng từ phiên đăng nhập, không còn endpoint theo userId) hiện cho
 * mọi người dùng; panel quản trị (tạo badge, đặt tiêu chí, kích hoạt qua
 * POST /badges/:id/status, xem danh sách đã cấp của một badge qua
 * GET /badges/:id/issued) chỉ render khi usePermissions().canAdminister.
 * Tiêu chí của huy hiệu đang hoạt động bị đóng băng phía server; panel
 * chỉ hiển thị kết quả từ chối đó.
 *
 * Dữ liệu qua TanStack Query (lib/badges.ts, F-01): hai danh sách là hai
 * query dùng chung cache với mọi bề mặt huy hiệu khác; các đột biến của
 * panel quản trị làm mới cả ba truy vấn (mọi huy hiệu / của tôi / đã cấp)
 * qua tiền tố khoá factory thay vì nạp lại cục bộ như trước. Từ lát SL-1
 * (#7), loader của route prefetch hai danh sách phía server (khi có
 * cookie phiên) và trang hydrate từ cache thay vì fetch lại khi mở.
 */
export function BadgesPage() {
  const { t } = useTranslation('app');
  const STATUS_LABEL: Record<number, string> = {
    0: t('badgeStatusInactive'),
    1: t('badgeStatusActive'),
    2: t('badgeStatusRetired'),
    3: t('badgeStatusArchived'),
    4: t('badgeStatusDisabled'),
  };
  const { canAdminister } = usePermissions();
  const [name, setName] = useState('');
  const [criteriaBadgeId, setCriteriaBadgeId] = useState('');
  const [criteriaCourseId, setCriteriaCourseId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [issuedBadgeId, setIssuedBadgeId] = useState<string | null>(null);

  const mineQuery = useMyBadges();
  const allQuery = useAllBadges();
  const issuedQuery = useBadgeIssued(issuedBadgeId);
  const createBadgeMutation = useCreateBadge();
  const criteriaMutation = useSetBadgeCriteria();
  const statusMutation = useSetBadgeStatus();

  const mine = mineQuery.data ?? [];
  const all = allQuery.data ?? [];
  const issuedList = issuedQuery.data ?? [];
  const loading = mineQuery.isPending || allQuery.isPending;
  const loadFailed = mineQuery.isError || allQuery.isError;
  const issuedError = issuedBadgeId !== null && issuedQuery.isError ? t('issuedLoadFailed') : null;

  /** Tên huy hiệu của một bản ghi đã cấp: ưu tiên badge lồng trong /mine. */
  const badgeName = (entry: MyBadgeView) =>
    entry.badge?.name ?? all.find((b) => b.id === entry.badgeId)?.name ?? t('badgeFallback', { id: entry.badgeId });

  /** Tạo một site badge mới (panel quản trị). */
  function createBadge(event: FormEvent) {
    event.preventDefault();
    createBadgeMutation.mutate(name, {
      onSuccess: () => {
        setName('');
        setMessage(t('badgeCreated'));
      },
      onError: () => setMessage(t('badgeCreateFailed')),
    });
  }

  /** Đặt tiêu chí hoàn thành khoá học cho một badge (panel quản trị). */
  function setCriteria(event: FormEvent) {
    event.preventDefault();
    criteriaMutation.mutate(
      { badgeId: criteriaBadgeId, courseId: criteriaCourseId },
      {
        onSuccess: () => setMessage(t('criteriaSaved')),
        onError: () => setMessage(t('criteriaRefused')),
      },
    );
  }

  /** Kích hoạt badge: đổi trạng thái qua POST /badges/:id/status với { status: 1 }. */
  function activate(id: string) {
    statusMutation.mutate(
      { badgeId: id, status: 1 },
      {
        onSuccess: () => setMessage(t('badgeActivated')),
        onError: () => setMessage(t('badgeActivationRefused')),
      },
    );
  }

  /** Xem (hoặc ẩn) danh sách đã cấp của một badge qua GET /badges/:id/issued. */
  function toggleIssued(badge: BadgeView) {
    setIssuedBadgeId((current) => (current === badge.id ? null : badge.id));
  }

  const issuedBadgeName = all.find((b) => b.id === issuedBadgeId)?.name ?? '';
  const issuedOpen = issuedBadgeId !== null && issuedQuery.data !== undefined;

  return (
    <PageShell width="medium">
      <PageHeader title={t('badgesHeading')} />
      {loadFailed ? (
        <>
          <ErrorAlert variant="destructive">
            {t('badgesLoadFailed')}
          </ErrorAlert>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void mineQuery.refetch();
                void allQuery.refetch();
              }}
            >
              {t('retry')}
            </Button>
          </div>
        </>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('myBadges')}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <ul className="space-y-2" aria-label={t('myBadgesLabel')}>
                {mine.map((i) => (
                  <li key={i.id} className="rounded border p-2">
                    <p className="font-medium">
                      {badgeName(i)}
                      {i.revoked ? ` ${t('revokedSuffix')}` : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('issuedLine', {
                        date: formatDate(i.dateIssued),
                        hash: i.uniqueHash.slice(0, 12),
                      })}
                      {i.dateExpire ? ` ${t('expiresSuffix', { date: formatDate(i.dateExpire) })}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
              {mine.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('noBadgesYet')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
      {canAdminister ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('badgeAdministration')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {message ? (
              <ErrorAlert>
                {message}
              </ErrorAlert>
            ) : null}
            <ul className="space-y-1" aria-label={t('allBadgesLabel')}>
              {all.map((b) => (
                <li key={b.id} className="flex items-center gap-3 text-sm">
                  <span className="font-medium">{b.name}</span>
                  <span>{STATUS_LABEL[b.status] ?? b.status}</span>
                  {b.status === 0 ? (
                    <Button type="button" variant="outline" onClick={() => activate(b.id)}>
                      {t('activate')}
                    </Button>
                  ) : null}
                  <Button type="button" variant="outline" onClick={() => toggleIssued(b)}>
                    {issuedBadgeId === b.id ? t('hideIssued') : t('viewIssued')}
                  </Button>
                </li>
              ))}
            </ul>
            {issuedError ? (
              <ErrorAlert variant="destructive">
                {issuedError}
              </ErrorAlert>
            ) : null}
            {issuedOpen ? (
              <div className="space-y-2">
                <p className="font-medium">{t('issuedListTitle', { name: issuedBadgeName })}</p>
                <ul className="space-y-1" aria-label={t('issuedListTitle', { name: issuedBadgeName })}>
                  {issuedList.map((i) => (
                    <li key={i.id} className="rounded border p-2 text-sm">
                      <p>
                        {t('issuedToLine', { userId: i.userId, date: formatDate(i.dateIssued) })}
                        {i.revoked ? ` ${t('revokedSuffix')}` : ''}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('issuedLine', {
                          date: formatDate(i.dateIssued),
                          hash: i.uniqueHash.slice(0, 12),
                        })}
                      </p>
                    </li>
                  ))}
                  {issuedList.length === 0 ? <li>{t('noIssuedYet')}</li> : null}
                </ul>
              </div>
            ) : null}
            <form onSubmit={(e) => createBadge(e)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="badge-name">{t('badgeName')}</FieldLabel>
                  <Input id="badge-name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <div className="flex justify-end">
                  <Button type="submit">{t('createBadge')}</Button>
                </div>
              </FieldGroup>
            </form>
            <form onSubmit={(e) => setCriteria(e)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="criteria-badge">{t('badgeId')}</FieldLabel>
                  <Input
                    id="criteria-badge"
                    value={criteriaBadgeId}
                    onChange={(e) => setCriteriaBadgeId(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="criteria-course">{t('criteriaCourseId')}</FieldLabel>
                  <Input
                    id="criteria-course"
                    value={criteriaCourseId}
                    onChange={(e) => setCriteriaCourseId(e.target.value)}
                  />
                </Field>
                <div className="flex justify-end">
                  <Button type="submit">{t('setCriteriaAll')}</Button>
                </div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default BadgesPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navBadges');
}
