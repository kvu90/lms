import { useState } from 'react';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { PageHeader, PageShell } from '../components/page-shell';
import { useTranslation } from 'react-i18next';
import type { SiteSetting } from '@lms/contracts';
import '../i18n';
import { ApiError } from '#lib/api';
import { useResetSiteSetting, useSaveSiteSetting, useSiteSettingAudit, useSiteSettings } from '#lib/site-config';

/**
 * Các miền giá trị enum đã biết, đối chiếu registry phía backend
 * (`apps/api/src/modules/site-config/settings-registry.ts` ở branch
 * backend): hiện chỉ `core/lang` là enum, với options `['vi', 'en']`.
 * Setting enum nào không có trong bảng này thì sửa bằng ô nhập văn bản.
 */
const KNOWN_ENUM_OPTIONS: Record<string, readonly string[]> = {
  'core/lang': ['vi', 'en'],
};

/** Khoá ghép của một setting trong state bản nháp của trang. */
function settingKey(setting: SiteSetting): string {
  return `${setting.component}/${setting.name}`;
}

/** Đưa một giá trị JSON về dạng hiển thị ngắn cho huy hiệu/audit. */
function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

/**
 * Trang cấu hình site (quản trị): bảng setting nhóm theo component từ
 * GET /api/v1/site-config, mỗi dòng một editor theo `type` đã đăng ký
 * (boolean → checkbox, number → ô số gửi dạng number, enum đã biết options
 * → select, còn lại → ô văn bản), Lưu qua PUT, Đặt lại qua DELETE chỉ khi
 * setting đang có ghi đè (`source = 'database'`). Cuối trang là danh sách
 * vết thay đổi gần nhất từ GET /api/v1/site-config/audit. API khoá mọi
 * endpoint bằng capability `site:config`: bị 403 thì trang hiện
 * thông báo không có quyền thay vì sập.
 *
 * Dữ liệu qua TanStack Query (lib/site-config.ts, F-01): bảng setting và
 * audit là hai query; Lưu/Đặt lại là mutation làm mới cả hai. Bản nháp của
 * trang chỉ giữ phần người dùng ĐÃ sửa so với giá trị server — giá trị
 * hiển thị của dòng chưa sửa suy thẳng từ query nên sau khi lưu/đặt lại
 * (query được làm mới) dòng tự về giá trị server mới, không cần nạp lại
 * toàn trang như trước.
 */
export function AdminSiteConfigPage() {
  const { t } = useTranslation('app');
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>({});
  const [message, setMessage] = useState<string | null>(null);

  const settingsQuery = useSiteSettings();
  const auditQuery = useSiteSettingAudit(settingsQuery.isSuccess);
  const saveMutation = useSaveSiteSetting();
  const resetMutation = useResetSiteSetting();

  const settings = settingsQuery.data ?? [];
  const audit = auditQuery.data ?? [];
  const forbidden =
    settingsQuery.error instanceof ApiError && settingsQuery.error.problem.status === 403;
  const error = settingsQuery.isError && !forbidden ? t('siteConfigLoadFailed') : null;

  /** Giá trị đang hiển thị của một dòng: bản nháp nếu người dùng đã sửa, không thì giá trị server. */
  function draftOf(setting: SiteSetting): string | boolean {
    const key = settingKey(setting);
    if (key in drafts) return drafts[key]!;
    return typeof setting.value === 'boolean' ? setting.value : formatValue(setting.value);
  }

  /** Bỏ bản nháp của một setting sau khi lưu/đặt lại thành công — dòng về giá trị server mới. */
  function clearDraft(setting: SiteSetting) {
    const key = settingKey(setting);
    setDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  /** Lưu một setting qua PUT với giá trị đã ép đúng kiểu đã đăng ký (number gửi dạng number, boolean dạng boolean). */
  function save(setting: SiteSetting) {
    const draft = draftOf(setting);
    const value: unknown =
      setting.type === 'boolean' ? draft === true : setting.type === 'number' ? Number(draft) : String(draft ?? '');
    setMessage(null);
    saveMutation.mutate(
      { component: setting.component, name: setting.name, value },
      {
        onSuccess: () => {
          clearDraft(setting);
          setMessage(t('siteConfigSaved'));
        },
        onError: () => setMessage(t('siteConfigSaveFailed')),
      },
    );
  }

  /** Xoá ghi đè của một setting qua DELETE để nó trở về giá trị mặc định trong code. */
  function reset(setting: SiteSetting) {
    setMessage(null);
    resetMutation.mutate(
      { component: setting.component, name: setting.name },
      {
        onSuccess: () => {
          clearDraft(setting);
          setMessage(t('siteConfigResetDone'));
        },
        onError: () => setMessage(t('siteConfigResetFailed')),
      },
    );
  }

  const components = [...new Set(settings.map((s) => s.component))];

  return (
    <PageShell width="narrow">
      <PageHeader title={t('siteConfigTitle')} description={t('siteConfigDescription')} />
      <Card>
        <CardContent className="flex flex-col gap-6">
          {forbidden ? (
            <Alert variant="destructive">
              <AlertDescription>{t('siteConfigForbidden')}</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {message ? (
            <Alert>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
          {!forbidden && settings.length === 0 && !error ? (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>{t('siteConfigNoSettings')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null}
          {components.map((component) => (
            <div key={component} className="flex flex-col gap-3">
              <h3 className="font-medium">{component}</h3>
              <ul className="flex flex-col gap-4" aria-label={component}>
                {settings
                  .filter((s) => s.component === component)
                  .map((setting) => {
                    const key = settingKey(setting);
                    const draft = draftOf(setting);
                    const enumOptions = setting.type === 'enum' ? KNOWN_ENUM_OPTIONS[key] : undefined;
                    const inputId = `site-config-${setting.component}-${setting.name}`;
                    return (
                      <li key={key} className="flex flex-col gap-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{setting.name}</span>
                          <Badge variant={setting.source === 'database' ? 'default' : 'secondary'}>
                            {setting.source === 'database'
                              ? t('siteConfigSourceDatabase')
                              : t('siteConfigSourceDefault')}
                          </Badge>
                          <span className="text-muted-foreground">
                            {t('siteConfigDefaultValue', { value: formatValue(setting.defaultValue) })}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {setting.type === 'boolean' ? (
                            <span className="flex items-center gap-2">
                              <Checkbox
                                id={inputId}
                                aria-label={t('siteConfigValue', { component: setting.component, name: setting.name })}
                                checked={draft === true}
                                onCheckedChange={(checked) =>
                                  setDrafts((prev) => ({ ...prev, [key]: checked === true }))
                                }
                              />
                              <Label htmlFor={inputId}>
                                {t('siteConfigValue', { component: setting.component, name: setting.name })}
                              </Label>
                            </span>
                          ) : enumOptions ? (
                            <Select
                              items={Object.fromEntries(enumOptions.map((option) => [option, option]))}
                              value={String(draft)}
                              onValueChange={(v) => v && setDrafts((prev) => ({ ...prev, [key]: v }))}
                            >
                              <SelectTrigger
                                aria-label={t('siteConfigValue', { component: setting.component, name: setting.name })}
                                className="min-w-40 flex-1"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {enumOptions.map((option) => (
                                  <SelectItem key={option} value={option}>
                                    {option}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              id={inputId}
                              className="min-w-40 flex-1"
                              aria-label={t('siteConfigValue', { component: setting.component, name: setting.name })}
                              type={setting.type === 'number' ? 'number' : 'text'}
                              value={String(draft)}
                              onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                            />
                          )}
                          <Button type="button" onClick={() => save(setting)}>
                            {t('siteConfigSave')}
                          </Button>
                          {setting.source === 'database' ? (
                            <Button type="button" variant="outline" onClick={() => reset(setting)}>
                              {t('siteConfigReset')}
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('siteConfigAuditTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {audit.length === 0 ? (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>{t('siteConfigNoAudit')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-1 text-sm" aria-label={t('siteConfigAuditTitle')}>
              {audit.map((entry) => (
                <li key={entry.id}>
                  {t('siteConfigAuditLine', {
                    key: entry.settingKey,
                    oldValue: formatValue(entry.oldValue),
                    newValue: formatValue(entry.newValue),
                    changedBy: entry.changedBy ?? '—',
                    time: entry.createdAt,
                  })}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AdminSiteConfigPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navSiteConfig');
}
