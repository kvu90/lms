import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@lms/ui/components/ui/badge';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/ui/card';
import { Checkbox } from '@lms/ui/components/ui/checkbox';
import { Input } from '@lms/ui/components/ui/input';
import { Label } from '@lms/ui/components/ui/label';
import { useTranslation } from 'react-i18next';
import type { SiteSetting, SiteSettingAuditEntry } from '@lms/contracts';
import '../i18n';
import { apiJson, ApiError } from '@/lib/api';

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
 * endpoint bằng capability `moodle/site:config`: bị 403 thì trang hiện
 * thông báo không có quyền thay vì sập.
 */
export function AdminSiteConfigPage() {
  const { t } = useTranslation('app');
  const [settings, setSettings] = useState<SiteSetting[]>([]);
  const [audit, setAudit] = useState<SiteSettingAuditEntry[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>({});
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /** Nạp settings + audit; 403 ở GET settings được tách riêng để hiện thông báo quyền. */
  const reload = useCallback(async () => {
    try {
      const list = await apiJson<SiteSetting[]>('/api/v1/site-config');
      setSettings(list);
      setDrafts(
        Object.fromEntries(
          list.map((s) => [settingKey(s), typeof s.value === 'boolean' ? s.value : formatValue(s.value)]),
        ),
      );
      setForbidden(false);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 403) {
        setForbidden(true);
        return;
      }
      setError(t('siteConfigLoadFailed'));
      return;
    }
    const entries = await apiJson<SiteSettingAuditEntry[]>('/api/v1/site-config/audit').catch(() => []);
    setAudit(entries);
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Lưu một setting qua PUT với giá trị đã ép đúng kiểu đã đăng ký (number gửi dạng number, boolean dạng boolean). */
  async function save(setting: SiteSetting) {
    const key = settingKey(setting);
    const draft = drafts[key];
    const value: unknown =
      setting.type === 'boolean' ? draft === true : setting.type === 'number' ? Number(draft) : String(draft ?? '');
    setMessage(null);
    try {
      await apiJson(`/api/v1/site-config/${setting.component}/${setting.name}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      setMessage(t('siteConfigSaved'));
      await reload();
    } catch {
      setMessage(t('siteConfigSaveFailed'));
    }
  }

  /** Xoá ghi đè của một setting qua DELETE để nó trở về giá trị mặc định trong code. */
  async function reset(setting: SiteSetting) {
    setMessage(null);
    try {
      await apiJson(`/api/v1/site-config/${setting.component}/${setting.name}`, { method: 'DELETE' });
      setMessage(t('siteConfigResetDone'));
      await reload();
    } catch {
      setMessage(t('siteConfigResetFailed'));
    }
  }

  const components = [...new Set(settings.map((s) => s.component))];

  return (
    <main className="@container/main flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('siteConfigTitle')}</CardTitle>
          <CardDescription>{t('siteConfigDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {forbidden ? <p role="alert">{t('siteConfigForbidden')}</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          {message ? <p role="status">{message}</p> : null}
          {!forbidden && settings.length === 0 && !error ? (
            <p className="text-sm">{t('siteConfigNoSettings')}</p>
          ) : null}
          {components.map((component) => (
            <div key={component} className="space-y-3">
              <h3 className="font-medium">{component}</h3>
              <ul className="space-y-3" aria-label={component}>
                {settings
                  .filter((s) => s.component === component)
                  .map((setting) => {
                    const key = settingKey(setting);
                    const draft = drafts[key] ?? '';
                    const enumOptions = setting.type === 'enum' ? KNOWN_ENUM_OPTIONS[key] : undefined;
                    const inputId = `site-config-${setting.component}-${setting.name}`;
                    return (
                      <li key={key} className="flex flex-wrap items-center gap-3 text-sm">
                        <span className="min-w-40 font-medium">{setting.name}</span>
                        <Badge variant={setting.source === 'database' ? 'default' : 'secondary'}>
                          {setting.source === 'database' ? t('siteConfigSourceDatabase') : t('siteConfigSourceDefault')}
                        </Badge>
                        <span className="text-muted-foreground">
                          {t('siteConfigDefaultValue', { value: formatValue(setting.defaultValue) })}
                        </span>
                        {setting.type === 'boolean' ? (
                          <span className="flex items-center gap-2">
                            <Checkbox
                              id={inputId}
                              aria-label={t('siteConfigValue', { component: setting.component, name: setting.name })}
                              checked={draft === true}
                              onCheckedChange={(checked) => setDrafts((prev) => ({ ...prev, [key]: checked === true }))}
                            />
                            <Label htmlFor={inputId}>
                              {t('siteConfigValue', { component: setting.component, name: setting.name })}
                            </Label>
                          </span>
                        ) : enumOptions ? (
                          <select
                            id={inputId}
                            aria-label={t('siteConfigValue', { component: setting.component, name: setting.name })}
                            className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                            value={String(draft)}
                            onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                          >
                            {enumOptions.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Input
                            id={inputId}
                            aria-label={t('siteConfigValue', { component: setting.component, name: setting.name })}
                            type={setting.type === 'number' ? 'number' : 'text'}
                            value={String(draft)}
                            onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                          />
                        )}
                        <Button type="button" onClick={() => void save(setting)}>
                          {t('siteConfigSave')}
                        </Button>
                        {setting.source === 'database' ? (
                          <Button type="button" variant="outline" onClick={() => void reset(setting)}>
                            {t('siteConfigReset')}
                          </Button>
                        ) : null}
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
          <ul className="space-y-1 text-sm" aria-label={t('siteConfigAuditTitle')}>
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
            {audit.length === 0 ? <li>{t('siteConfigNoAudit')}</li> : null}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AdminSiteConfigPage;
