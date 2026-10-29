import { useMemo, useState, type FormEvent } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { UserProfile } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { useTranslation } from 'react-i18next';
import { ErrorAlert } from '#components/error-alert';
import { PageSkeleton } from '#components/page-skeleton';
import { PageHeader, PageShell } from '#components/page-shell';
import '#config/i18n';
import { adminUserDetailQueryOptions, adminUsersQueryOptions } from '#features/admin/queries/admin-users';
import { ApiError } from '#lib/api';
import { personName } from '#features/classes/api/classes';
import { formatDate } from '#utils/date-format';
import { guardianLinksQueryOptions, useCreateGuardianLink, useRevokeGuardianLink } from '../queries/guardians';
import type { GuardianLinkView } from '../types/guardians';
import { usePermissions } from '#lib/permissions';

/**
 * Trang quản lý liên kết giám hộ phụ huynh–học viên (gói kích hoạt phụ
 * huynh, route `admin/guardian-links`).
 *
 * Vai trò: đây là bề mặt QUẢN LÝ duy nhất của miền giám hộ — nơi người
 * phụ trách (giữ capability `guardian:manage`) xác lập và thu hồi
 * liên kết, thay cho việc phải gọi thẳng API như trước. Bề mặt xem của
 * chính phụ huynh (`/guardian`) là trang riêng và chỉ đọc; trang này
 * không hiển thị dữ liệu học tập của học viên, chỉ quản lý chính các
 * liên kết.
 *
 * Flow tổng thể:
 *  1. Cờ quyền: trang đọc `canManageGuardians` từ ảnh chụp quyền
 *     (PermissionsProvider). Ảnh chụp quyền chưa tải xong thì trang
 *     hiện khung chờ — KHÔNG kết luận thiếu quyền sớm, vì trong lúc
 *     phiên/capability đang tải, provider tạm trả ảnh chụp rỗng và
 *     kết luận vội sẽ chớp thông báo thiếu quyền oan cho chính người
 *     có quyền. Tải ảnh chụp quyền lỗi thì coi như không có quyền.
 *     Đã có ảnh chụp mà không có cờ thì trang không dựng bề mặt quản
 *     lý nào (không danh sách, không form) và hiện thông báo thiếu
 *     quyền — mục điều hướng trong sidebar cũng chỉ hiện với đúng cờ
 *     này. Đây chỉ là lớp trình bày: API tự gác `guardian:manage` ở
 *     mọi endpoint quản lý (403 `guardian.manage_denied`), trang có
 *     bị mở thẳng bằng URL cũng không lộ dữ liệu.
 *  2. Danh sách: GET /guardian-links (API chỉ trả liên kết của tenant
 *     hiệu lực, gồm cả liên kết đã thu hồi). Hàng liên kết chỉ mang id
 *     người dùng, nên trang tra họ tên từng người qua GET /users/:id
 *     (dùng chung tuỳ chọn truy vấn của khu quản trị người dùng) và
 *     hiển thị kèm tên đăng nhập; tra không được thì rơi về chính id.
 *  3. Tạo liên kết: hai ô chọn người dùng tìm qua GET
 *     /users?search= (phụ huynh và học viên là hai tài khoản có sẵn —
 *     trang này KHÔNG tạo tài khoản), quan hệ là chuỗi tự do theo hồ
 *     sơ giám hộ (cha/mẹ/người giám hộ…), ghi chú tuỳ chọn. Gửi POST
 *     /guardian-links; lỗi nghiệp vụ của API (409 cặp đã có liên kết
 *     đang hiệu lực, 400 một phía chưa là thành viên của tenant) hiển
 *     thị nguyên thông điệp lỗi cho người dùng.
 *  4. Thu hồi: xác nhận rồi DELETE /guardian-links/:linkId — thu hồi
 *     mềm phía API, hàng ở lại danh sách với trạng thái đã thu hồi;
 *     phụ huynh tương ứng mất quyền xem học viên đó ngay ở lần đọc bề
 *     mặt phụ huynh kế tiếp.
 */

interface UserPickerProps {
  /** Nhãn của ô chọn (Phụ huynh / Học viên) — cũng là aria-label cho ô tìm kiếm. */
  label: string;
  /** Người dùng đã chọn; null khi chưa chọn. */
  value: UserProfile | null;
  /** Gọi khi người dùng chọn một kết quả hoặc bỏ chọn. */
  onChange: (user: UserProfile | null) => void;
}

/** Họ tên hiển thị của một hồ sơ người dùng — dùng chung helper `personName` của miền lớp/giám hộ (họ trước, tên sau; trống thì rơi về tên đăng nhập). */
function personLabel(user: UserProfile): string {
  return personName(user);
}

/**
 * Ô chọn một người dùng bằng tìm kiếm: gõ từ khoá (tên, tên đăng nhập
 * hoặc email) → GET /users?search= qua tuỳ chọn truy vấn dùng chung
 * của khu quản trị người dùng → danh sách kết quả để bấm chọn. Đã chọn
 * thì ô thu về một dòng xác nhận kèm nút bỏ chọn. Truy vấn chỉ bật khi
 * có từ khoá và chưa có lựa chọn, để không gọi API thừa.
 */
function UserPicker({ label, value, onChange }: UserPickerProps) {
  const { t } = useTranslation('app');
  const [search, setSearch] = useState('');
  const searchQuery = useQuery({
    ...adminUsersQueryOptions(1, 10, search.trim()),
    enabled: value === null && search.trim().length > 0,
  });
  const results = searchQuery.data?.users ?? [];

  if (value) {
    return (
      <Field>
        <FieldLabel>{label}</FieldLabel>
        <div className="flex items-center gap-2">
          <span className="text-sm">
            {t('guardianLinksSelectedUser', { name: personLabel(value), username: value.username })}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(null)}>
            {t('guardianLinksPickAnother')}
          </Button>
        </div>
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input
        aria-label={label}
        placeholder={t('guardianLinksUserSearchPlaceholder')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {search.trim().length > 0 ? (
        <div className="flex flex-col gap-1">
          {searchQuery.isPending ? (
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
          ) : results.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('guardianLinksUserSearchEmpty')}</p>
          ) : (
            results.map((user) => (
              <Button
                key={user.id}
                type="button"
                variant="outline"
                className="justify-start"
                onClick={() => {
                  onChange(user);
                  setSearch('');
                }}
              >
                {personLabel(user)} ({user.username})
                {user.email ? ` — ${user.email}` : ''}
              </Button>
            ))
          )}
        </div>
      ) : null}
    </Field>
  );
}

/** Trang quản lý liên kết giám hộ — xem khối TSDoc đầu file về flow tổng thể. */
export function AdminGuardianLinksPage() {
  const { t } = useTranslation('app');
  const perms = usePermissions();
  const canManage = perms.canManageGuardians;

  const linksQuery = useQuery({ ...guardianLinksQueryOptions(), enabled: canManage });
  const links = useMemo(() => linksQuery.data ?? [], [linksQuery.data]);

  // Hàng liên kết chỉ mang id của hai phía: tra hồ sơ từng người để
  // hiển thị họ tên; tập id duy nhất của cả danh sách được tra một
  // lượt bằng useQueries với tuỳ chọn dùng chung của khu người dùng.
  const userIds = useMemo(
    () => [...new Set(links.flatMap((link) => [link.guardianUserId, link.studentUserId]))],
    [links],
  );
  const userQueries = useQueries({
    queries: userIds.map((id) => adminUserDetailQueryOptions(id)),
  });
  const usersById = useMemo(() => {
    const map = new Map<string, UserProfile>();
    userQueries.forEach((query, index) => {
      if (query.data) map.set(userIds[index]!, query.data);
    });
    return map;
  }, [userQueries, userIds]);
  const userLabel = (userId: string): string => {
    const user = usersById.get(userId);
    return user ? `${personLabel(user)} (${user.username})` : userId;
  };

  const [guardian, setGuardian] = useState<UserProfile | null>(null);
  const [student, setStudent] = useState<UserProfile | null>(null);
  const [relationship, setRelationship] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createMutation = useCreateGuardianLink();
  const revokeMutation = useRevokeGuardianLink();

  /** Thông điệp lỗi hiển thị cho một lần gọi API hỏng: ưu tiên detail của ProblemDetails phía API. */
  function apiErrorText(err: unknown, fallback: string): string {
    if (err instanceof ApiError) return err.problem.detail ?? err.problem.title ?? fallback;
    return fallback;
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    if (!guardian || !student || relationship.trim() === '') {
      setError(t('guardianLinksFormIncomplete'));
      return;
    }
    try {
      await createMutation.mutateAsync({
        guardianUserId: guardian.id,
        studentUserId: student.id,
        relationship: relationship.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setGuardian(null);
      setStudent(null);
      setRelationship('');
      setNote('');
      setMessage(t('guardianLinksCreated'));
    } catch (err) {
      setError(apiErrorText(err, t('guardianLinksCreateFailed')));
    }
  }

  async function onRevoke(link: GuardianLinkView) {
    const confirmText = t('guardianLinksRevokeConfirm', {
      guardian: userLabel(link.guardianUserId),
      student: userLabel(link.studentUserId),
    });
    if (!window.confirm(confirmText)) return;
    setMessage(null);
    setError(null);
    try {
      await revokeMutation.mutateAsync(link.id);
      setMessage(t('guardianLinksRevoked'));
    } catch (err) {
      setError(apiErrorText(err, t('guardianLinksRevokeFailed')));
    }
  }

  // Chưa có ảnh chụp quyền (phiên/capability đang tải) thì chờ —
  // không kết luận thiếu quyền từ ảnh chụp rỗng tạm thời; ảnh chụp
  // tải lỗi (capabilitiesError) thì rơi xuống nhánh thiếu quyền.
  if (!perms.capabilitiesError && (!perms.ready || !perms.access))
    return <PageSkeleton label={t('loading')} rows={['h-9 w-full', 'h-48 w-full', 'h-48 w-full']} />;

  if (!canManage) {
    return (
      <PageShell width="narrow">
        <PageHeader title={t('guardianLinksTitle')} description={t('guardianLinksDescription')} />
        <ErrorAlert variant="destructive">{t('guardianLinksNoAccess')}</ErrorAlert>
      </PageShell>
    );
  }

  return (
    <PageShell width="full">
      <PageHeader title={t('guardianLinksTitle')} description={t('guardianLinksDescription')} />
      {message ? <ErrorAlert>{message}</ErrorAlert> : null}
      {error ? <ErrorAlert variant="destructive">{error}</ErrorAlert> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('guardianLinksCreateTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(event) => void onCreate(event)}>
            <FieldGroup>
              <UserPicker label={t('guardianLinksGuardian')} value={guardian} onChange={setGuardian} />
              <UserPicker label={t('guardianLinksStudent')} value={student} onChange={setStudent} />
              <Field>
                <FieldLabel>{t('guardianLinksRelationship')}</FieldLabel>
                <Input
                  aria-label={t('guardianLinksRelationship')}
                  placeholder={t('guardianLinksRelationshipPlaceholder')}
                  value={relationship}
                  maxLength={100}
                  onChange={(e) => setRelationship(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>{t('guardianLinksNote')}</FieldLabel>
                <Input
                  aria-label={t('guardianLinksNote')}
                  value={note}
                  maxLength={500}
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
              <div>
                <Button type="submit" disabled={createMutation.isPending}>
                  {t('guardianLinksCreate')}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('guardianLinksListTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {linksQuery.isError ? (
            <ErrorAlert variant="destructive" descriptionClassName="flex items-center justify-between gap-2">
              <span>{t('guardianLinksLoadFailed')}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void linksQuery.refetch()}>
                {t('retry')}
              </Button>
            </ErrorAlert>
          ) : null}
          {linksQuery.isPending ? (
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
          ) : links.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('guardianLinksEmpty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="py-2 pr-4 font-medium">{t('guardianLinksGuardian')}</th>
                  <th className="py-2 pr-4 font-medium">{t('guardianLinksStudent')}</th>
                  <th className="py-2 pr-4 font-medium">{t('guardianLinksRelationship')}</th>
                  <th className="py-2 pr-4 font-medium">{t('guardianLinksStatus')}</th>
                  <th className="py-2 pr-4 font-medium">{t('guardianLinksCreatedAt')}</th>
                  <th className="py-2 font-medium">{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.id} className="border-t">
                    <td className="py-2 pr-4">{userLabel(link.guardianUserId)}</td>
                    <td className="py-2 pr-4">{userLabel(link.studentUserId)}</td>
                    <td className="py-2 pr-4">{link.relationship}</td>
                    <td className="py-2 pr-4">
                      {link.status === 'active' ? t('guardianLinksStatusActive') : t('guardianLinksStatusRevoked')}
                    </td>
                    <td className="py-2 pr-4">{formatDate(link.createdAt)}</td>
                    <td className="py-2">
                      {link.status === 'active' ? (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={revokeMutation.isPending}
                          onClick={() => void onRevoke(link)}
                        >
                          {t('guardianLinksRevoke')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AdminGuardianLinksPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR, cùng mẫu các trang quản trị khác).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('guardianLinksTitle');
}
