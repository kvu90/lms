import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Skeleton } from '@lms/ui/components/skeleton';
import { ErrorAlert } from '#components/error-alert';
import { PageHeader, PageShell } from '../components/page-shell';
import {
  useCreateWebserviceService,
  useCreateWebserviceToken,
  useRevokeWebserviceToken,
  useWebserviceServices,
  useWebserviceTokens,
} from '#lib/platform-data';

/**
 * Quản trị integration tokens (platform services): service + token,
 * token thô chỉ hiện một lần khi tạo. Dữ liệu đọc qua tầng TanStack
 * Query (`lib/platform-data.ts`, khoá `webserviceServices`/
 * `webserviceTokens`; `clientLoader` của route nạp trước cả hai danh
 * sách). Như bản thủ công: lỗi của riêng danh sách token bị nuốt thành
 * danh sách rỗng — chỉ lỗi danh sách dịch vụ mới làm trang báo lỗi; tạo
 * service/token và thu hồi qua đột biến làm mới cả hai danh sách.
 */
export function TokensPage() {
  const { t: tr } = useTranslation();
  const servicesQuery = useWebserviceServices();
  const tokensQuery = useWebserviceTokens();
  const createServiceMutation = useCreateWebserviceService();
  const createTokenMutation = useCreateWebserviceToken();
  const revokeTokenMutation = useRevokeWebserviceToken();
  const services = servicesQuery.data ?? [];
  const tokens = tokensQuery.data ?? [];
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [name, setName] = useState('');
  const loading =
    servicesQuery.isPending ||
    tokensQuery.isPending ||
    (servicesQuery.isError && servicesQuery.isFetching);
  const loadError =
    servicesQuery.isError && !servicesQuery.isFetching ? tr('tokensLoadFailed') : null;
  async function createService(event: FormEvent) {
    event.preventDefault();
    await createServiceMutation.mutateAsync({
      name,
      shortName: `svc${Date.now()}`,
      functions: ['core_course_get_courses'],
    });
    setName('');
  }
  async function createToken(serviceId: string) {
    const created = await createTokenMutation.mutateAsync(serviceId);
    setCreatedToken(created.token);
  }
  async function revoke(id: string) {
    await revokeTokenMutation.mutateAsync(id);
  }
  return (
    <PageShell width="medium">
      <PageHeader title={tr('tokensTitle')} />
      {loadError ? (
        <>
          <ErrorAlert variant="destructive">
            {loadError}
          </ErrorAlert>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void servicesQuery.refetch();
                void tokensQuery.refetch();
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
            <ErrorAlert>
              {tr('newToken', { token: createdToken })}
            </ErrorAlert>
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
