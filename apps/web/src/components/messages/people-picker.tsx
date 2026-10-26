import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { cn } from '@lms/ui/lib/utils';
import { useTranslation } from 'react-i18next';
import type { MessagingCourse, PeoplePickerContext, RosterMember } from './types';
import { initialsOf } from './utils';

/**
 * Bộ CHỌN NGƯỜI theo ngữ cảnh — dùng chung cho sheet "Tin nhắn mới"
 * và sheet "Tạo nhóm" của màn Tin nhắn (lát MSG-T3, issue #33).
 *
 * Flow tổng thể:
 *
 * 1. Người dùng chọn MỘT ngữ cảnh khám phá người: liên hệ đã kết
 *    bạn, một LỚP của mình, hoặc một KHOÁ của mình. Đây là ba nguồn
 *    người DUY NHẤT hệ cho phép (quyết đã chốt: bỏ hẳn tìm người
 *    theo tên; khám phá qua danh sách thành viên lớp/khoá + liên
 *    hệ). Đổi ngữ cảnh là sự kiện đi lên trang chứa — trang nạp
 *    roster tương ứng (phân trang con trỏ phía server) rồi đưa
 *    xuống qua `members`.
 * 2. Với ngữ cảnh lớp/khoá, component trình bày danh sách roster:
 *    mỗi dòng avatar + tên + vai, phần HÀNH ĐỘNG ở cuối dòng do
 *    sheet chứa quyết định qua `renderMemberAction` (chế độ nhắn
 *    tin: nút Nhắn tin/Kết bạn theo quan hệ) hoặc qua chế độ chọn
 *    nhiều người (chế độ tạo nhóm: `onToggleMember` + `selectedIds`
 *    — bấm cả dòng là đảo chọn, có hộp kiểm thể hiện trạng thái).
 * 3. Ngữ cảnh liên hệ không có roster: ở chế độ nhắn tin, phần
 *    danh sách do sheet chứa tự trình bày (liên hệ là danh sách
 *    phẳng đã nạp sẵn ở trang) và component này chỉ giữ phần chọn
 *    ngữ cảnh; ở chế độ tạo nhóm, sheet đưa danh sách liên hệ xuống
 *    qua `contactEntries` để chọn thành viên ngay trong bộ chọn.
 *
 * Bất biến: component KHÔNG tự gọi API và không tự quyết luật quan
 * hệ — nó chỉ trình bày dữ kiện trang đưa xuống (cờ
 * `canDirectMessage`, `relationship` do server tính) và phát sự
 * kiện người dùng lên trên.
 */
interface PeoplePickerProps {
  /** Ngữ cảnh đang chọn. */
  context: PeoplePickerContext;
  /** Đổi ngữ cảnh khám phá người. */
  onSelectContext: (context: PeoplePickerContext) => void;
  /** Các lớp của tôi (từ cây nhóm) — nguồn của ngữ cảnh theo lớp. */
  classes: { classId: string; name: string }[];
  /** Các khoá của tôi — nguồn của ngữ cảnh theo khoá. */
  courses: MessagingCourse[];
  /** Một trang roster của ngữ cảnh lớp/khoá đang chọn (rỗng ở ngữ cảnh liên hệ). */
  members: RosterMember[];
  /** Lỗi nạp roster gần nhất; null khi không có. */
  rosterError: string | null;
  /** Con trỏ trang roster kế; null là đã hết trang. */
  rosterCursor: string | null;
  /** Tải trang roster tiếp theo. */
  onLoadMore: () => void;
  /** Hành động cuối mỗi dòng roster ở chế độ nhắn tin (sheet chứa quyết định). */
  renderMemberAction?: (member: RosterMember) => ReactNode;
  /** Tập người đang được chọn — chỉ dùng ở chế độ tạo nhóm. */
  selectedIds?: ReadonlySet<string>;
  /** Đảo chọn một người — chỉ truyền ở chế độ tạo nhóm; có nó thì bấm dòng là chọn/bỏ chọn. */
  onToggleMember?: (member: RosterMember) => void;
  /**
   * Danh sách LIÊN HỆ (id + tên hiển thị) — chỉ dùng ở chế độ tạo
   * nhóm: ngữ cảnh liên hệ không có roster nên sheet tạo nhóm đưa
   * danh sách này xuống để người tạo chọn thành viên từ liên hệ của
   * mình ngay trong bộ chọn. Chế độ nhắn tin không truyền (sheet
   * chứa tự trình bày mục liên hệ).
   */
  contactEntries?: { userId: string; displayName: string }[];
  /** Đảo chọn một liên hệ trong danh sách `contactEntries` — chỉ ở chế độ tạo nhóm. */
  onToggleContactEntry?: (userId: string) => void;
}

/**
 * Trình bày bộ chọn ngữ cảnh + danh sách roster của ngữ cảnh
 * lớp/khoá đang chọn.
 *
 * @param props - Dữ kiện và sự kiện do sheet chứa (trang Tin nhắn) đưa xuống.
 * @returns Khối chọn người hoàn chỉnh cho thân sheet.
 */
export function PeoplePicker({
  context, onSelectContext, classes, courses, members, rosterError, rosterCursor,
  onLoadMore, renderMemberAction, selectedIds, onToggleMember,
  contactEntries, onToggleContactEntry,
}: PeoplePickerProps) {
  const { t } = useTranslation('app');
  const picking = Boolean(onToggleMember);

  /** Một nút chọn ngữ cảnh: đang chọn thì nổi bật, bấm là phát sự kiện đổi ngữ cảnh lên trên. */
  const contextButton = (target: PeoplePickerContext, label: string) => {
    const isActive = context.kind === target.kind
      && (target.kind === 'contacts' || (context.kind !== 'contacts' && context.id === (target as { id: string }).id));
    return (
      <Button
        key={target.kind === 'contacts' ? 'contacts' : `${target.kind}-${(target as { id: string }).id}`}
        type="button"
        size="sm"
        variant={isActive ? 'default' : 'outline'}
        aria-pressed={isActive}
        onClick={() => onSelectContext(target)}
      >
        {label}
      </Button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {contextButton({ kind: 'contacts' }, t('newMessageContactsContext'))}
        {classes.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t('newMessagePickClass')}</p>
            <div className="flex flex-wrap gap-1.5">
              {classes.map((c) => contextButton({ kind: 'class', id: c.classId, name: c.name }, c.name))}
            </div>
          </div>
        ) : null}
        {courses.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t('newMessagePickCourse')}</p>
            <div className="flex flex-wrap gap-1.5">
              {courses.map((c) => contextButton({ kind: 'course', id: c.courseId, name: c.fullName }, c.fullName))}
            </div>
          </div>
        ) : null}
      </div>
      {context.kind === 'contacts' && picking && contactEntries ? (
        <div className="space-y-2">
          {contactEntries.length > 0 ? (
            <ul className="space-y-1">
              {contactEntries.map((entry) => {
                const selected = selectedIds?.has(entry.userId) ?? false;
                return (
                  <li key={entry.userId} data-testid={`group-contact-${entry.userId}`}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      className={cn('flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-muted', selected && 'bg-muted')}
                      onClick={() => onToggleContactEntry?.(entry.userId)}
                    >
                      <Avatar>
                        <AvatarFallback>{initialsOf(entry.displayName)}</AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1 truncate text-sm">{entry.displayName}</span>
                      <span
                        aria-hidden
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                        )}
                      >
                        {selected ? <Check className="size-3.5" /> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noContacts')}</p>
          )}
        </div>
      ) : null}
      {context.kind !== 'contacts' ? (
        <div className="space-y-2">
          {rosterError ? <p role="alert" className="text-sm">{rosterError}</p> : null}
          {members.length > 0 ? (
            <ul className="space-y-1">
              {members.map((m) => {
                const selected = selectedIds?.has(m.userId) ?? false;
                const row = (
                  <>
                    <Avatar>
                      <AvatarFallback>{initialsOf(m.displayName)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {m.displayName} <span className="text-muted-foreground">@{m.username}</span>
                    </span>
                    <Badge variant="secondary">
                      {m.role === 'teacher' ? t('rosterTeacher') : t('rosterStudent')}
                    </Badge>
                    {picking ? (
                      // Dấu chọn TRÌNH BÀY THUẦN: cả dòng đã là một nút
                      // bấm (aria-pressed) nên không lồng thêm nút hộp
                      // kiểm thật vào trong — trạng thái chọn đọc qua
                      // aria-pressed của dòng và qua dấu tích này.
                      <span
                        aria-hidden
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                        )}
                      >
                        {selected ? <Check className="size-3.5" /> : null}
                      </span>
                    ) : renderMemberAction?.(m)}
                  </>
                );
                return (
                  <li key={m.userId} data-testid={`roster-member-${m.userId}`}>
                    {picking ? (
                      <button
                        type="button"
                        aria-pressed={selected}
                        className={cn('flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-muted', selected && 'bg-muted')}
                        onClick={() => onToggleMember?.(m)}
                      >
                        {row}
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 px-1 py-1">{row}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('rosterEmpty')}</p>
          )}
          {rosterCursor ? (
            <Button type="button" variant="outline" onClick={() => onLoadMore()}>
              {t('rosterLoadMore')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
