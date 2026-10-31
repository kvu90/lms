import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RoleListItem, UserProfile } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@lms/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@lms/ui/components/input-group';
import { Search } from 'lucide-react';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { ApiError } from '#lib/api';
import type { ContextRow } from '#lib/access';
import { contextOptionLabel } from '../api/context-labels';
import { adminUsersQueryOptions } from '../queries/admin-users';
import { useCreateRoleAssignment } from '../queries/admin-roles';
import { NATIVE_SELECT_CLASS } from './permission-select';

/**
 * Hộp thoại gán vai trò của feature admin, dựng trên component
 * Dialog thật của `@lms/ui`.
 *
 * Luồng nghiệp vụ: người quản trị chọn người dùng (tìm theo tên hoặc
 * email qua danh sách người dùng phân trang phía server), chọn vai trò
 * và chọn ngữ cảnh, rồi gửi qua POST /access/assignments. Ngữ cảnh mặc
 * định là ngữ cảnh hệ thống (level 10), suy ra trực tiếp từ cây context
 * mỗi lần render thay vì đặt bằng effect — tránh lỗi lint
 * set-state-in-effect mà form gán cũ từng mang. Nhãn của ô chọn ngữ
 * cảnh lấy qua adapter nhãn ngữ cảnh (tên cấp dạng chữ), không bày
 * chuỗi kỹ thuật của dòng ngữ cảnh. Gán trùng cùng nguồn là no-op lặng
 * ở backend nên hộp thoại đóng như thành công và bảng tải lại không
 * thêm dòng trùng.
 *
 * Chế độ người dùng chọn sẵn (mở từ hộp thoại quản lý vai trò của một
 * người): ô tìm người dùng thay bằng một dòng tĩnh nêu người được gán
 * — luồng gán không đổi, chỉ bỏ bước chọn người.
 *
 * Khi backend từ chối, hộp thoại GIỮ NGUYÊN kèm đúng lý do backend trả
 * về — chốt gói số chỗ của trung tâm và chốt tách vai theo ngữ cảnh là
 * hai trường hợp phân biệt bằng mã lỗi riêng; mã lạ thì dùng thông báo
 * chung, không hiện mã kỹ thuật và không báo thành công giả. Danh sách
 * người dùng tải thêm từng đợt 20 (nút "Tải thêm người dùng" hiện khi
 * còn người chưa tải) để từ khoá khớp trên 20 người vẫn chọn được
 * người ở đợt sau, thay vì chặn ở 20 kết quả đầu như trước — nhưng
 * chỉ tới trần 100 của API danh sách người dùng: chạm trần thì nút
 * tải thêm ẩn đi kèm gợi ý thu hẹp từ khoá, vì gửi `pageSize` vượt
 * trần bị server trả HTTP 400 và người sau 100 kết quả không chọn
 * được bằng cách bấm thêm nữa.
 *
 * @param props - Trạng thái mở, danh sách vai trò và cây context đã tải
 * ở trang, người dùng chọn sẵn (tuỳ chọn) và hàm đóng hộp thoại.
 */
export interface RoleAssignmentDialogProps {
  /** Hộp thoại đang mở hay không. */
  open: boolean;
  /** Danh sách vai trò để chọn (lưới thẻ của trang đã tải). */
  roles: RoleListItem[];
  /** Cây context để chọn ngữ cảnh gán. */
  contexts: ContextRow[];
  /**
   * Người dùng chọn sẵn: khi có, hộp thoại bỏ bước tìm/chọn người
   * dùng và gán thẳng cho người này.
   */
  presetUser?: Pick<UserProfile, 'id' | 'username' | 'email'> | null;
  /** Đóng hộp thoại (sau khi gán thành công hoặc khi người dùng huỷ). */
  onClose: () => void;
}

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

/** Trần `pageSize` của API danh sách người dùng — gửi vượt trần bị HTTP 400. */
const MAX_USER_PAGE_SIZE = 100;

export function RoleAssignmentDialog({
  open,
  roles,
  contexts,
  presetUser = null,
  onClose,
}: RoleAssignmentDialogProps) {
  const { t } = useTranslation('app');
  const [userSearch, setUserSearch] = useState('');
  /** Số người tối đa tải về cho ô chọn; nút tải thêm tăng từng đợt 20 tới trần của API. */
  const [userPageSize, setUserPageSize] = useState(20);
  /** Người dùng đã chọn trong danh sách tìm kiếm; null khi chưa chọn (và không có người chọn sẵn). */
  const [selectedUser, setSelectedUser] = useState<Pick<UserProfile, 'id' | 'username' | 'email'> | null>(null);
  const [roleId, setRoleId] = useState('');
  const [contextId, setContextId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const createMutation = useCreateRoleAssignment();

  /** Danh sách người dùng cho ô chọn: tải từ đầu với cỡ trang hiện tại, tìm phía server theo từ khoá. */
  const usersQuery = useQuery({
    ...adminUsersQueryOptions(1, userPageSize, userSearch),
    placeholderData: keepPreviousData,
    enabled: open && presetUser === null,
  });

  if (!open) return null;

  /** Người được gán hiệu lực: người chọn sẵn, nếu không thì lựa chọn trong danh sách tìm kiếm. */
  const effectiveUser = presetUser ?? selectedUser;

  /**
   * Ngữ cảnh gán hiệu lực: lựa chọn của người dùng, hoặc ngữ cảnh hệ
   * thống (level 10) khi chưa chọn — suy ra mỗi lần render nên cây
   * context về muộn vẫn tự thành mặc định mà không cần effect đặt state.
   */
  const effectiveContextId =
    contextId === '' ? (contexts.find((ctx) => ctx.contextLevel === 10)?.id ?? '') : contextId;

  /** Gán vai: lỗi thì giữ hộp thoại mở kèm lý do; thành công thì đóng. */
  async function submitAssign() {
    if (!effectiveUser || !roleId || !effectiveContextId) return;
    setError(null);
    try {
      await createMutation.mutateAsync({ userId: effectiveUser.id, roleId, contextId: effectiveContextId });
      onClose();
    } catch (caught) {
      setError(assignErrorMessage(caught, (key) => t(key)));
    }
  }

  const users = usersQuery.data?.users ?? [];
  const canSubmit = effectiveUser !== null && roleId !== '' && effectiveContextId !== '' && !createMutation.isPending;

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !createMutation.isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-semibold">{t('assignRoleDialogTitle')}</DialogTitle>
        </DialogHeader>
        {error ? <ErrorAlert variant="destructive">{error}</ErrorAlert> : null}
        <FieldGroup>
          {presetUser !== null ? (
            <Field>
              <FieldLabel>{t('assignPresetUserLabel')}</FieldLabel>
              <p className="text-sm">
                <strong>{presetUser.username}</strong>{' '}
                <span className="text-muted-foreground">{presetUser.email}</span>
              </p>
            </Field>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="assign-dialog-user-search">{t('assignUserSearch')}</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <Search />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="assign-dialog-user-search"
                    placeholder={t('assignUserSearchPlaceholder')}
                    value={userSearch}
                    onChange={(e) => {
                      setUserSearch(e.target.value);
                      setSelectedUser(null);
                      setUserPageSize(20);
                    }}
                  />
                </InputGroup>
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
                    userPageSize < MAX_USER_PAGE_SIZE ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={usersQuery.isFetching}
                        onClick={() => setUserPageSize((s) => Math.min(s + 20, MAX_USER_PAGE_SIZE))}
                      >
                        {t('assignLoadMoreUsers')}
                      </Button>
                    ) : (
                      <p className="text-sm text-muted-foreground">{t('assignLoadMoreAtCap')}</p>
                    )
                  ) : null}
                </>
              )}
            </>
          )}
          <Field>
            <FieldLabel htmlFor="assign-dialog-role">{t('role')}</FieldLabel>
            <select
              id="assign-dialog-role"
              className={NATIVE_SELECT_CLASS}
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
              className={NATIVE_SELECT_CLASS}
              value={effectiveContextId}
              onChange={(e) => setContextId(e.target.value)}
            >
              <option value="">{t('selectContext')}</option>
              {contexts.map((c) => (
                <option key={c.id} value={c.id}>
                  {contextOptionLabel(contexts, c, (key, options) => t(key, options))}
                </option>
              ))}
            </select>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={createMutation.isPending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void submitAssign()}>
            {createMutation.isPending ? t('assigningRole') : t('assignRole')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
