import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RoleListItem, UserProfile } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { ApiError } from '#lib/api';
import type { ContextRow } from '#lib/access';
import { adminUsersQueryOptions } from '../queries/admin-users';
import { useCreateRoleAssignment } from '../queries/admin-roles';

/**
 * Hộp thoại gán vai trò từ bảng gán vai (đợt 3, issue #547).
 *
 * Luồng nghiệp vụ: người quản trị chọn người dùng (tìm theo tên hoặc
 * email qua danh sách người dùng phân trang phía server), chọn vai trò
 * và chọn ngữ cảnh, rồi gửi qua POST /access/assignments. Ngữ cảnh mặc
 * định là ngữ cảnh hệ thống (level 10), suy ra trực tiếp từ cây context
 * mỗi lần render thay vì đặt bằng effect — tránh lỗi lint
 * set-state-in-effect mà form gán cũ từng mang. Gán trùng cùng nguồn là
 * no-op lặng ở backend nên hộp thoại
 * đóng như thành công và bảng tải lại không thêm dòng trùng.
 *
 * Khi backend từ chối, hộp thoại GIỮ NGUYÊN kèm đúng lý do backend trả
 * về — chốt gói số chỗ của trung tâm và chốt tách vai theo ngữ cảnh là
 * hai trường hợp phân biệt bằng mã lỗi riêng; mã lạ thì dùng thông báo
 * chung, không hiện mã kỹ thuật và không báo thành công giả. Danh sách
 * người dùng tải thêm từng đợt 20 (nút "Tải thêm người dùng" hiện khi
 * còn người chưa tải) để từ khoá khớp trên 20 người vẫn chọn được
 * người ở đợt sau, thay vì chặn ở 20 kết quả đầu như trước.
 *
 * @param props - Trạng thái mở, danh sách vai trò và cây context đã tải
 * ở trang, và hàm đóng hộp thoại.
 */
export interface RoleAssignmentDialogProps {
  /** Hộp thoại đang mở hay không. */
  open: boolean;
  /** Danh sách vai trò để chọn (lưới thẻ của trang đã tải). */
  roles: RoleListItem[];
  /** Cây context để chọn ngữ cảnh gán. */
  contexts: ContextRow[];
  /** Đóng hộp thoại (sau khi gán thành công hoặc khi người dùng huỷ). */
  onClose: () => void;
}

/**
 * Kiểu ô chọn native của hộp thoại — cùng chuỗi class với hộp thoại ma
 * trận trên cùng trang để các ô chọn nhìn nhất quán; dùng select native
 * thay cho Select của Base UI vì select native mới điều khiển được bằng
 * selectOptions trong test component như hộp thoại ma trận.
 */
const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Dịch mã lỗi gán vai của backend thành thông báo cho người dùng; mã lạ
 * thì dùng thông báo chung, không hiện mã kỹ thuật ra giao diện.
 */
function assignErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    if (error.problem.code === 'plan.tenant_slot_limit_reached') {
      return t('assignSlotLimitReached');
    }
    if (error.problem.code === 'access.role_context_conflict') {
      return t('assignRoleContextConflict');
    }
  }
  return t('assignRoleFailed');
}

export function RoleAssignmentDialog({ open, roles, contexts, onClose }: RoleAssignmentDialogProps) {
  const { t } = useTranslation('app');
  const [userSearch, setUserSearch] = useState('');
  /** Số người tối đa tải về cho ô chọn; nút tải thêm tăng từng đợt 20. */
  const [userPageSize, setUserPageSize] = useState(20);
  /** Người dùng đã chọn trong danh sách tìm kiếm; null khi chưa chọn. */
  const [selectedUser, setSelectedUser] = useState<Pick<UserProfile, 'id' | 'username' | 'email'> | null>(null);
  const [roleId, setRoleId] = useState('');
  const [contextId, setContextId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const createMutation = useCreateRoleAssignment();

  /** Danh sách người dùng cho ô chọn: tải từ đầu với cỡ trang hiện tại, tìm phía server theo từ khoá. */
  const usersQuery = useQuery({
    ...adminUsersQueryOptions(1, userPageSize, userSearch),
    placeholderData: keepPreviousData,
    enabled: open,
  });

  /** Phím Escape đóng hộp thoại khi không trong lúc gán. */
  useEffect(() => {
    if (!open || createMutation.isPending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, createMutation.isPending, onClose]);

  if (!open) return null;

  /**
   * Ngữ cảnh gán hiệu lực: lựa chọn của người dùng, hoặc ngữ cảnh hệ
   * thống (level 10) khi chưa chọn — suy ra mỗi lần render nên cây
   * context về muộn vẫn tự thành mặc định mà không cần effect đặt state.
   */
  const effectiveContextId =
    contextId === '' ? (contexts.find((ctx) => ctx.contextLevel === 10)?.id ?? '') : contextId;

  /** Gán vai: lỗi thì giữ hộp thoại mở kèm lý do; thành công thì đóng. */
  async function submitAssign() {
    if (!selectedUser || !roleId || !effectiveContextId) return;
    setError(null);
    try {
      await createMutation.mutateAsync({ userId: selectedUser.id, roleId, contextId: effectiveContextId });
      onClose();
    } catch (caught) {
      setError(assignErrorMessage(caught, (key) => t(key)));
    }
  }

  const users = usersQuery.data?.users ?? [];
  const canSubmit = selectedUser !== null && roleId !== '' && effectiveContextId !== '' && !createMutation.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onClick={() => {
        if (!createMutation.isPending) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('assignRoleDialogTitle')}
        className="w-full max-w-lg rounded-xl border bg-background p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold">{t('assignRoleDialogTitle')}</h2>
        {error ? (
          <ErrorAlert variant="destructive" className="mb-4">
            {error}
          </ErrorAlert>
        ) : null}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="assign-dialog-user-search">{t('assignUserSearch')}</FieldLabel>
            <Input
              id="assign-dialog-user-search"
              placeholder={t('assignUserSearchPlaceholder')}
              value={userSearch}
              onChange={(e) => {
                setUserSearch(e.target.value);
                setSelectedUser(null);
                setUserPageSize(20);
              }}
            />
          </Field>
          {/* Danh sách chọn người dùng: mỗi dòng là một nút chọn, dòng đã chọn tô đậm. */}
          {usersQuery.isPending ? (
            <PageSkeleton label={t('loading')} rows={['h-9 w-full', 'h-9 w-full']} />
          ) : usersQuery.isError ? (
            <ErrorAlert variant="destructive">
              {t('assignUsersLoadFailed')}{' '}
              <Button type="button" variant="outline" size="sm" onClick={() => void usersQuery.refetch()}>
                {t('retry')}
              </Button>
            </ErrorAlert>
          ) : users.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('assignNoUserFound')}</p>
          ) : (
            <>
              <ul className="max-h-56 space-y-1 overflow-y-auto">
                {users.map((u) => {
                  const selected = selectedUser?.id === u.id;
                  return (
                    <li key={u.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        className={`w-full rounded-md border p-2 text-left hover:bg-accent ${selected ? 'border-primary bg-accent' : ''}`}
                        onClick={() => setSelectedUser({ id: u.id, username: u.username, email: u.email })}
                      >
                        <strong>{u.username}</strong>
                        <span className="block text-sm text-muted-foreground">{u.email ?? '—'}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {users.length > 0 && users.length < (usersQuery.data?.total ?? 0) ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={usersQuery.isFetching}
                  onClick={() => setUserPageSize((s) => s + 20)}
                >
                  {t('assignLoadMoreUsers')}
                </Button>
              ) : null}
            </>
          )}
          <Field>
            <FieldLabel htmlFor="assign-dialog-role">{t('role')}</FieldLabel>
            <select
              id="assign-dialog-role"
              className={SELECT_CLASS}
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
            >
              <option value="">{t('selectRole')}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="assign-dialog-context">{t('roleContext')}</FieldLabel>
            <select
              id="assign-dialog-context"
              className={SELECT_CLASS}
              value={effectiveContextId}
              onChange={(e) => setContextId(e.target.value)}
            >
              <option value="">{t('selectContext')}</option>
              {contexts.map((c) => (
                <option key={c.id} value={c.id}>
                  {t('contextOption', { level: c.contextLevel, instance: c.instanceId, path: c.path })}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={createMutation.isPending} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="button" disabled={!canSubmit} onClick={() => void submitAssign()}>
              {createMutation.isPending ? t('assigningRole') : t('assignRole')}
            </Button>
          </div>
        </FieldGroup>
      </div>
    </div>
  );
}
