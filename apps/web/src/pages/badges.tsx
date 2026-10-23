import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { usePermissions } from '#lib/permissions';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';

/** Huy hiệu (BadgeRow ở tầng API) như trang này cần để hiển thị. */
interface BadgeView {
  id: string;
  name: string;
  description: string;
  type: number;
  courseid: string | null;
  status: number;
}

/** Bản ghi đã cấp (IssuedRow ở tầng API): bằng chứng bất biến của một lần cấp. */
interface IssuedView {
  id: string;
  badgeid: string;
  userid: string;
  uniquehash: string;
  dateissued: string;
  dateexpire: string | null;
  revoked: boolean;
}

/**
 * Một dòng của GET /badges/mine: bản ghi đã cấp kèm chính huy hiệu lồng
 * bên trong (badges.service listMyBadges trả `IssuedRow & { badge }`) —
 * tên huy hiệu lấy thẳng từ đây, danh sách /badges chỉ còn là nguồn dự
 * phòng khi bản ghi thiếu badge lồng.
 */
interface MyBadgeView extends IssuedView {
  badge?: BadgeView;
}

/**
 * Trang huy hiệu: "huy hiệu của tôi" (từ GET /badges/mine — server tự suy
 * người dùng từ phiên đăng nhập, không còn endpoint theo userId) hiện cho
 * mọi người dùng; panel quản trị (tạo badge, đặt tiêu chí, kích hoạt qua
 * POST /badges/:id/status, xem danh sách đã cấp của một badge qua
 * GET /badges/:id/issued) chỉ render khi usePermissions().canAdminister.
 * Tiêu chí của huy hiệu đang hoạt động bị đóng băng phía server; panel
 * chỉ hiển thị kết quả từ chối đó.
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
  const [mine, setMine] = useState<MyBadgeView[]>([]);
  const [all, setAll] = useState<BadgeView[]>([]);
  const [name, setName] = useState('');
  const [criteriaBadgeId, setCriteriaBadgeId] = useState('');
  const [criteriaCourseId, setCriteriaCourseId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuedBadgeId, setIssuedBadgeId] = useState<string | null>(null);
  const [issuedList, setIssuedList] = useState<IssuedView[]>([]);
  const [issuedError, setIssuedError] = useState<string | null>(null);

  /**
   * Nạp lại huy hiệu của tôi và (chỉ để tra tên dự phòng + panel quản trị)
   * danh sách mọi huy hiệu. Huy hiệu của tôi luôn qua /badges/mine.
   */
  const reload = useCallback(async () => {
    const badges = await apiJson<BadgeView[]>('/api/v1/badges');
    setAll(badges);
    const issued = await apiJson<MyBadgeView[]>('/api/v1/badges/mine');
    setMine(issued);
  }, []);

  useEffect(() => {
    void reload().catch(() => setError(t('badgesLoadFailed')));
  }, [reload, t]);

  /** Tên huy hiệu của một bản ghi đã cấp: ưu tiên badge lồng trong /mine. */
  const badgeName = (entry: MyBadgeView) =>
    entry.badge?.name ?? all.find((b) => b.id === entry.badgeid)?.name ?? t('badgeFallback', { id: entry.badgeid });

  /** Tạo một site badge mới (panel quản trị). */
  async function createBadge(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson('/api/v1/badges', { method: 'POST', body: JSON.stringify({ name, type: 1 }) });
      setName('');
      setMessage(t('badgeCreated'));
      await reload();
    } catch {
      setMessage(t('badgeCreateFailed'));
    }
  }

  /** Đặt tiêu chí hoàn thành khoá học cho một badge (panel quản trị). */
  async function setCriteria(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson(`/api/v1/badges/${criteriaBadgeId}/criteria`, {
        method: 'PUT',
        body: JSON.stringify({
          method: 1,
          criteria: [{ criteriatype: 'coursecompletion', params: { courseId: criteriaCourseId } }],
        }),
      });
      setMessage(t('criteriaSaved'));
      await reload();
    } catch {
      setMessage(t('criteriaRefused'));
    }
  }

  /** Kích hoạt badge: đổi trạng thái qua POST /badges/:id/status với { status: 1 }. */
  async function activate(id: string) {
    try {
      await apiJson(`/api/v1/badges/${id}/status`, { method: 'POST', body: JSON.stringify({ status: 1 }) });
      setMessage(t('badgeActivated'));
      await reload();
    } catch {
      setMessage(t('badgeActivationRefused'));
    }
  }

  /** Xem (hoặc ẩn) danh sách đã cấp của một badge qua GET /badges/:id/issued. */
  async function toggleIssued(badge: BadgeView) {
    if (issuedBadgeId === badge.id) {
      setIssuedBadgeId(null);
      setIssuedList([]);
      return;
    }
    setIssuedError(null);
    try {
      const rows = await apiJson<IssuedView[]>(`/api/v1/badges/${badge.id}/issued`);
      setIssuedList(rows);
      setIssuedBadgeId(badge.id);
    } catch {
      setIssuedError(t('issuedLoadFailed'));
    }
  }

  const issuedBadgeName = all.find((b) => b.id === issuedBadgeId)?.name ?? '';

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      {error ? <p role="alert">{error}</p> : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('myBadges')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2" aria-label={t('myBadgesLabel')}>
            {mine.map((i) => (
              <li key={i.id} className="rounded border p-2">
                <p className="font-medium">
                  {badgeName(i)}
                  {i.revoked ? ` ${t('revokedSuffix')}` : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('issuedLine', {
                    date: new Date(i.dateissued).toLocaleDateString(),
                    hash: i.uniquehash.slice(0, 12),
                  })}
                  {i.dateexpire ? ` ${t('expiresSuffix', { date: new Date(i.dateexpire).toLocaleDateString() })}` : ''}
                </p>
              </li>
            ))}
            {mine.length === 0 ? <li>{t('noBadgesYet')}</li> : null}
          </ul>
        </CardContent>
      </Card>
      {canAdminister ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('badgeAdministration')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {message ? <p>{message}</p> : null}
            <ul className="space-y-1" aria-label={t('allBadgesLabel')}>
              {all.map((b) => (
                <li key={b.id} className="flex items-center gap-3 text-sm">
                  <span className="font-medium">{b.name}</span>
                  <span>{STATUS_LABEL[b.status] ?? b.status}</span>
                  {b.status === 0 ? (
                    <Button type="button" variant="outline" onClick={() => void activate(b.id)}>
                      {t('activate')}
                    </Button>
                  ) : null}
                  <Button type="button" variant="outline" onClick={() => void toggleIssued(b)}>
                    {issuedBadgeId === b.id ? t('hideIssued') : t('viewIssued')}
                  </Button>
                </li>
              ))}
            </ul>
            {issuedError ? <p role="alert">{issuedError}</p> : null}
            {issuedBadgeId ? (
              <div className="space-y-2">
                <p className="font-medium">{t('issuedListTitle', { name: issuedBadgeName })}</p>
                <ul className="space-y-1" aria-label={t('issuedListTitle', { name: issuedBadgeName })}>
                  {issuedList.map((i) => (
                    <li key={i.id} className="rounded border p-2 text-sm">
                      <p>
                        {t('issuedToLine', { userId: i.userid, date: new Date(i.dateissued).toLocaleDateString() })}
                        {i.revoked ? ` ${t('revokedSuffix')}` : ''}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('issuedLine', {
                          date: new Date(i.dateissued).toLocaleDateString(),
                          hash: i.uniquehash.slice(0, 12),
                        })}
                      </p>
                    </li>
                  ))}
                  {issuedList.length === 0 ? <li>{t('noIssuedYet')}</li> : null}
                </ul>
              </div>
            ) : null}
            <form onSubmit={(e) => void createBadge(e)} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="badge-name">{t('badgeName')}</Label>
                <Input id="badge-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <Button type="submit">{t('createBadge')}</Button>
            </form>
            <form onSubmit={(e) => void setCriteria(e)} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="criteria-badge">{t('badgeId')}</Label>
                <Input
                  id="criteria-badge"
                  value={criteriaBadgeId}
                  onChange={(e) => setCriteriaBadgeId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="criteria-course">{t('criteriaCourseId')}</Label>
                <Input
                  id="criteria-course"
                  value={criteriaCourseId}
                  onChange={(e) => setCriteriaCourseId(e.target.value)}
                />
              </div>
              <Button type="submit">{t('setCriteriaAll')}</Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default BadgesPage;
