import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AssignmentListItem, RoleListItem } from '@lms/contracts';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Button } from '@lms/ui/components/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@lms/ui/components/input-group';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@lms/ui/components/table';
import { Plus, Search, UserMinus } from 'lucide-react';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import type { ContextRow } from '#lib/access';
import { formatWithOptions } from '#utils/date-format';
import { contextOptionLabel } from '../api/context-labels';
import { roleAssignmentsQueryOptions } from '../queries/admin-roles';
import { AdminSelect } from './admin-select';
import { RoleAssignmentDialog } from './role-assignment-dialog';
import { RoleUnassignDialog, type UnassignTarget } from './role-unassign-dialog';
import { TablePagination } from './table-pagination';

/**
 * Khu vực bảng gán vai trên trang quản trị vai trò, đặt dưới lưới thẻ
 * vai trò: bảng + bộ lọc + tìm kiếm + phân trang đều chạy phía server
 * trên hợp đồng danh sách gán, thao tác gán/gỡ ngay tại bảng.
 *
 * Hình dáng theo thẻ bảng mẫu: thẻ phẳng (không bóng, không đệm dọc),
 * đầu thẻ có viền dưới (tiêu đề 18px medium + mô tả), vùng lọc gồm
 * hai khối riêng ngăn nhau bằng viền dưới, mỗi khối đệm 24px — khối
 * lọc là các ô chọn có nhãn đặt phía trên (vai trò, ngữ cảnh), khối
 * công cụ là ô tìm kiếm bên trái và cụm cỡ trang + nút Gán vai trò
 * bên phải; ở bề rộng hẹp các khối gói dòng nhưng không tràn ngang.
 * Mọi ô chọn là Select của `@lms/ui` qua component dùng chung của
 * feature. Hàng bảng cao 56px, cột thời gian bày dạng ngày chữ như
 * bảng người dùng cùng trang, thao tác gỡ là nút ghost biểu tượng
 * như ngôn ngữ thao tác của khuôn bảng mẫu. Chân bảng là dòng tóm
 * tắt khoảng đang hiển thị kèm cụm nút chuyển trang 36px.
 * Nhãn ngữ cảnh lấy qua adapter nhãn ngữ cảnh (tên cấp dạng chữ) —
 * không bày định danh, đường dẫn hay chuỗi kỹ thuật trong bảng.
 *
 * Luồng hiển thị:
 *
 * 1. Trạng thái lọc/tìm/trang sống ở đây: đổi vai trò, ngữ cảnh, từ
 *    khoá hay trang đều đổi khoá truy vấn nên gọi lại
 *    GET /access/assignments với tham số tương ứng; tổng số dòng khớp
 *    do server trả về quyết định số trang. Bảng giữ keepPreviousData
 *    nên đổi lọc/trang không nháy rỗng mà chỉ hiện dòng "đang tải".
 *    Trang hiện tại được kẹp theo tổng mới nhất ngay trong lúc render
 *    (không dùng effect để tránh lỗi lint set-state-in-effect): sau
 *    khi gỡ — hay bất kỳ thay đổi nào làm tổng giảm — trang cũ có thể
 *    vượt quá trang cuối; truy vấn tự tải lại trang hợp lệ cuối cùng
 *    thay vì kẹt ở trang rỗng không có nút quay lại. API chưa có hợp
 *    đồng sắp xếp nên bảng không bật sắp xếp cột — sắp xếp một trang
 *    đơn lẻ sẽ gây hiểu nhầm là sắp xếp toàn cục.
 * 2. Mỗi dòng gán là một bộ ba người dùng × vai trò × ngữ cảnh: cùng
 *    vai trò ở nhiều ngữ cảnh thành nhiều dòng. Tên vai trò phân giải
 *    từ danh sách vai của trang, nhãn ngữ cảnh qua adapter từ cây
 *    context của trang; định danh không phân giải được thì hiện dấu
 *    "—" thay vì lộ định danh kỹ thuật (tên thật của thực thể là việc
 *    của đợt nối backend). Tên/email người dùng lấy từ phản hồi đã
 *    ghép sẵn; dòng trỏ tới người dùng không còn tồn tại (cả hai đều
 *    null) thì hiện trạng thái đó thay cho tên.
 * 3. Dòng do ghi danh quản lý (`component = 'enrol'`) không có nút gỡ:
 *    ô thao tác hiện thẳng trạng thái không gỡ trực tiếp được kèm lý
 *    do (phải rút ghi danh). Dòng thường có nút gỡ mở hộp thoại xác
 *    nhận; hộp thoại đó vẫn dịch mã `access.assignment_enrol_managed`
 *    cho trường hợp đua dữ kiện giữa lúc liệt kê và lúc bấm gỡ.
 * 4. Gán vai mở hộp thoại riêng từ bảng (chọn người dùng có tìm kiếm,
 *    chọn vai trò, chọn ngữ cảnh). Sau gán/gỡ thành công, đột biến làm
 *    mới gốc khoá bảng nên bảng tải lại đúng trang và bộ lọc hiện hành,
 *    đồng thời lưới thẻ cập nhật số người giữ qua tiền tố `access`.
 *
 * @param props - Danh sách vai trò và cây context trang đã tải, dùng để
 * phân giải tên vai trò, nhãn ngữ cảnh và làm lựa chọn cho bộ lọc.
 */
export interface RoleAssignmentsSectionProps {
  /** Danh sách vai trò (lưới thẻ của trang đã tải). */
  roles: RoleListItem[];
  /** Cây context (trang đã tải). */
  contexts: ContextRow[];
}

/** Các lựa chọn số dòng mỗi trang của bảng (API chặn tối đa 100). */
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

export function RoleAssignmentsSection({ roles, contexts }: RoleAssignmentsSectionProps) {
  const { t } = useTranslation('app');
  /** '' nghĩa là không lọc theo tiêu chí đó — Select hiện mục "Tất cả". */
  const [roleFilter, setRoleFilter] = useState('');
  const [contextFilter, setContextFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [assignOpen, setAssignOpen] = useState(false);
  /** Dòng đang chờ xác nhận gỡ; null khi hộp thoại đóng. */
  const [unassignTarget, setUnassignTarget] = useState<UnassignTarget | null>(null);

  const assignmentsQuery = useQuery({
    ...roleAssignmentsQueryOptions({
      roleId: roleFilter === '' ? undefined : roleFilter,
      contextId: contextFilter === '' ? undefined : contextFilter,
      search: search === '' ? undefined : search,
      page,
      pageSize,
    }),
    placeholderData: keepPreviousData,
  });
  const data = assignmentsQuery.data;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  /**
   * Kẹp trang hiện tại theo tổng mới nhất, thực hiện ngay trong lúc
   * render theo mẫu "điều chỉnh state khi dữ liệu đổi" của React (không
   * dùng effect): khi tổng giảm mà trang hiện tại vượt quá trang cuối
   * thì đưa trang về trang cuối; lần render sau điều kiện đã sai nên
   * dừng, và truy vấn với trang mới tự tải lại dữ liệu đúng trang. Đổi
   * lọc/tìm/cỡ trang đã tự reset về trang 1 ở onChange nên đường kẹp
   * này chủ yếu bao phủ đường gỡ và mọi thay đổi tổng từ bên ngoài.
   */
  if (data && page > pageCount) {
    setPage(pageCount);
  }
  const rows = data?.assignments ?? [];
  const rangeFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeTo = (page - 1) * pageSize + rows.length;

  /** Tên vai trò của dòng gán, phân giải từ danh sách vai của trang; không phân giải được thì hiện "—". */
  function roleNameOf(row: AssignmentListItem): string {
    return roles.find((r) => r.id === row.roleId)?.name ?? '—';
  }

  /** Nhãn ngữ cảnh dạng chữ của dòng gán qua adapter; không phân giải được thì hiện "—". */
  function contextLabelOf(row: AssignmentListItem): string {
    const ctx = contexts.find((c) => c.id === row.contextId);
    if (!ctx) return '—';
    return contextOptionLabel(contexts, ctx, (key, options) => t(key, options));
  }

  /** Tên người dùng hiển thị của dòng gán; trạng thái thay thế khi người dùng không còn tồn tại. */
  function userLabelOf(row: AssignmentListItem): string {
    return row.userName ?? t('assignmentMissingUser');
  }

  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="border-b px-6 py-5">
        <CardTitle className="text-lg">{t('assignmentTableTitle')}</CardTitle>
        <CardDescription>{t('assignmentTableDescription')}</CardDescription>
      </CardHeader>
      {/* Vùng lọc hai khối ngăn nhau bằng viền dưới như thẻ bảng mẫu:
          khối lọc là các ô chọn có nhãn phía trên, khối công cụ là
          tìm kiếm bên trái + cỡ trang và nút gán bên phải. */}
      <div className="border-b">
        <div className="flex flex-col gap-4 border-b p-6">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="assignment-role-filter">{t('assignmentFilterRole')}</FieldLabel>
              <AdminSelect
                id="assignment-role-filter"
                value={roleFilter}
                onValueChange={(next) => {
                  setRoleFilter(next);
                  setPage(1);
                }}
                options={[
                  { value: '', label: t('assignmentFilterRoleAll') },
                  ...roles.map((r) => ({ value: r.id, label: r.name })),
                ]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="assignment-context-filter">{t('assignmentFilterContext')}</FieldLabel>
              <AdminSelect
                id="assignment-context-filter"
                value={contextFilter}
                onValueChange={(next) => {
                  setContextFilter(next);
                  setPage(1);
                }}
                options={[
                  { value: '', label: t('assignmentFilterContextAll') },
                  ...contexts.map((c) => ({
                    value: c.id,
                    label: contextOptionLabel(contexts, c, (key, options) => t(key, options)),
                  })),
                ]}
              />
            </Field>
          </div>
        </div>
        <div className="flex gap-4 p-6 max-sm:flex-col sm:items-center sm:justify-between">
          <Field className="w-full max-w-2xs">
            <InputGroup>
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                id="assignment-search"
                aria-label={t('assignmentSearch')}
                placeholder={t('assignmentSearchPlaceholder')}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </InputGroup>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <AdminSelect
              id="assignment-pagesize"
              ariaLabel={t('assignmentPageSize')}
              className="w-fit"
              value={String(pageSize)}
              onValueChange={(next) => {
                const size = Number(next);
                setPageSize(PAGE_SIZE_OPTIONS.includes(size as 10 | 20 | 50) ? size : 20);
                setPage(1);
              }}
              options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
            />
            <Button type="button" className="h-9 gap-1.5 px-2.5" onClick={() => setAssignOpen(true)}>
              <Plus aria-hidden className="size-4" />
              {t('assignRole')}
            </Button>
          </div>
        </div>
      </div>
      {assignmentsQuery.isError ? (
        <div className="px-6 pt-4">
          <ErrorAlert variant="destructive" descriptionClassName="flex items-center justify-between gap-2">
            <span>{t('assignmentLoadFailed')}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void assignmentsQuery.refetch()}>
              {t('retry')}
            </Button>
          </ErrorAlert>
        </div>
      ) : null}
      {assignmentsQuery.isFetching && !assignmentsQuery.isPending ? (
        <p className="px-6 pt-4 text-sm text-muted-foreground">{t('loading')}</p>
      ) : null}
      {assignmentsQuery.isPending ? (
        <div className="p-6">
          <PageSkeleton label={t('loading')} rows={['h-9 w-full', 'h-9 w-full', 'h-9 w-full']} />
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow className="h-14 border-t hover:bg-transparent">
                <TableHead className="pl-4 text-muted-foreground">{t('assignmentUserColumn')}</TableHead>
                <TableHead className="text-muted-foreground">{t('assignmentRoleColumn')}</TableHead>
                <TableHead className="text-muted-foreground">{t('assignmentContextColumn')}</TableHead>
                <TableHead className="text-muted-foreground">{t('assignmentAssignedAtColumn')}</TableHead>
                <TableHead className="pr-4 text-center text-muted-foreground">
                  {t('assignmentActionsColumn')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">
                    {t('assignmentEmpty')}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.id} className="h-14">
                    <TableCell className="pl-4">
                      <span className="flex items-center gap-2">
                        <Avatar className="size-9">
                          <AvatarFallback className="text-xs">
                            {row.userName ? row.userName.charAt(0) : '?'}
                          </AvatarFallback>
                        </Avatar>
                        <span>
                          <span className="block text-sm font-medium">{userLabelOf(row)}</span>
                          <span className="block text-sm text-muted-foreground">{row.userEmail ?? '—'}</span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>{roleNameOf(row)}</TableCell>
                    <TableCell>{contextLabelOf(row)}</TableCell>
                    <TableCell>
                      {formatWithOptions(row.updatedAt, undefined, {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </TableCell>
                    <TableCell className="pr-4 text-center">
                      {row.component === 'enrol' ? (
                        <span className="text-sm text-muted-foreground">{t('assignmentEnrolManaged')}</span>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-9"
                          aria-label={t('unassignRole')}
                          onClick={() =>
                            setUnassignTarget({
                              assignment: row,
                              userLabel: userLabelOf(row),
                              roleLabel: roleNameOf(row),
                              contextLabel: contextLabelOf(row),
                            })
                          }
                        >
                          <UserMinus aria-hidden className="size-4.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <TablePagination
            page={page}
            pageCount={pageCount}
            summary={t('assignmentShowing', { from: rangeFrom, to: rangeTo, total })}
            previousLabel={t('dashboard:tablePrevious')}
            nextLabel={t('dashboard:tableNext')}
            onPageChange={setPage}
          />
        </>
      )}
      {/* Render có điều kiện: mỗi lần mở hộp thoại là một lượt làm việc mới với state khởi tạo sạch. */}
      {assignOpen ? (
        <RoleAssignmentDialog open roles={roles} contexts={contexts} onClose={() => setAssignOpen(false)} />
      ) : null}
      {unassignTarget !== null ? (
        <RoleUnassignDialog open target={unassignTarget} onClose={() => setUnassignTarget(null)} />
      ) : null}
    </Card>
  );
}
