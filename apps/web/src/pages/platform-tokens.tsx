import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Skeleton } from '@lms/ui/components/skeleton';
import { PageHeader, PageShell } from '../components/page-shell';
import { apiJson } from '#lib/api';

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
