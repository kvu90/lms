import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { IconSearch } from '@tabler/icons-react';
import { Button } from '@lms/ui/components/button';
import { usePermissions } from '#lib/permissions';
import '../i18n';

/** Một đích đến trong bảng lệnh: màn hình (theo quyền) hoặc một khoá học. */
interface PaletteItem {
  id: string;
  title: string;
  hint?: string;
  url: string;
  group: 'screens' | 'courses';
}

/**
 * Bỏ dấu tiếng Việt + hạ chữ thường để khớp tìm kiếm không dấu: người
 * dùng gõ "khoa hoc" vẫn ra "Khoá học", gõ "tin nhan" ra "Tin nhắn".
 */
function normalizeForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/**
 * Bảng lệnh tìm nhanh Cmd+K / Ctrl+K (chuẩn app hiện đại — Linear,
 * Notion, GitHub): mở từ mọi trang của khu vực đã đăng nhập, gõ để lọc
 * và Enter/nhấp chuột để đi thẳng tới màn hình hoặc khoá học.
 *
 * Tôn trọng quyền theo đúng cây sidebar: danh sách màn hình dựng từ
 * CÙNG các cổng của AppSidebar (canUseQuestionBank cho Ngân hàng câu
 * hỏi, canAdminister cho hai nhóm quản trị) và khoá học lấy từ ảnh
 * chụp quyền (perms.courses — API /courses đã tự lọc theo người xem).
 * Mục không có quyền thì KHÔNG xuất hiện, không để kết quả dẫn tới
 * trang 403. Component tự chứa cả nút mở ở header lẫn lớp phủ, mount
 * một lần duy nhất trong SiteHeader nên mọi trang đều dùng được.
 */
export function CommandPalette() {
  const { t } = useTranslation(['app', 'dashboard']);
  const perms = usePermissions();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const screens: PaletteItem[] = [
      { id: 'screen-dashboard', title: t('dashboard:itemDashboard'), url: '/', group: 'screens' },
      { id: 'screen-courses', title: t('app:navCourses'), url: '/courses', group: 'screens' },
      { id: 'screen-calendar', title: t('app:navCalendar'), url: '/calendar', group: 'screens' },
      { id: 'screen-messages', title: t('app:navMessages'), url: '/messages', group: 'screens' },
      { id: 'screen-notifications', title: t('app:navNotifications'), url: '/notifications', group: 'screens' },
      { id: 'screen-search', title: t('app:navSearch'), url: '/search', group: 'screens' },
      { id: 'screen-profile', title: t('app:navProfile'), url: '/profile', group: 'screens' },
      { id: 'screen-badges', title: t('app:navBadges'), url: '/badges', group: 'screens' },
      { id: 'screen-learning-plan', title: t('app:navLearningPlan'), url: '/learning-plan', group: 'screens' },
      { id: 'screen-blog', title: t('app:navBlog'), url: '/blog', group: 'screens' },
      ...(perms.canUseQuestionBank
        ? [{ id: 'screen-questions', title: t('app:navQuestions'), url: '/questions', group: 'screens' } as PaletteItem]
        : []),
      ...(perms.canAdminister
        ? ([
            { id: 'screen-admin-users', title: t('app:navUsers'), url: '/admin/users', group: 'screens' },
            { id: 'screen-admin-roles', title: t('app:navRoles'), url: '/admin/roles', group: 'screens' },
            { id: 'screen-tokens', title: t('app:navTokens'), url: '/tokens', group: 'screens' },
            { id: 'screen-site-config', title: t('app:navSiteConfig'), url: '/admin/site-config', group: 'screens' },
            { id: 'screen-reports', title: t('app:navReports'), url: '/reports', group: 'screens' },
            { id: 'screen-insights', title: t('app:navInsights'), url: '/insights', group: 'screens' },
            { id: 'screen-contentbank', title: t('app:navContentBank'), url: '/contentbank', group: 'screens' },
            { id: 'screen-backup', title: t('app:navBackup'), url: '/backup', group: 'screens' },
            { id: 'screen-privacy', title: t('app:navPrivacy'), url: '/privacy', group: 'screens' },
            { id: 'screen-health', title: t('app:navHealth'), url: '/health', group: 'screens' },
          ] as PaletteItem[])
        : []),
    ];
    const courses: PaletteItem[] = perms.courses.map((c) => ({
      id: `course-${c.course.id}`,
      title: c.course.fullName,
      hint: c.course.shortName,
      url: `/courses/${c.course.id}`,
      group: 'courses',
    }));
    return [...screens, ...courses];
  }, [perms, t]);

  const filtered = useMemo(() => {
    const q = normalizeForSearch(query.trim());
    if (!q) return items;
    return items.filter((item) => normalizeForSearch(`${item.title} ${item.hint ?? ''}`).includes(q));
  }, [items, query]);

  // Mở bằng Cmd+K (macOS) / Ctrl+K (Windows/Linux) từ bất kỳ trang nào;
  // bấm lại khi đang mở thì đóng (toggle như các app chuẩn).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Mỗi lần mở: xoá truy vấn cũ, chọn mục đầu, dồn focus vào ô gõ.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open ]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Giữ mục đang chọn luôn trong tầm mắt khi di chuyển bằng phím.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function go(item: PaletteItem | undefined) {
    if (!item) return;
    setOpen(false);
    void navigate(item.url);
  }

  function onListKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(filtered[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ml-auto gap-2 text-muted-foreground"
        onClick={() => setOpen(true)}
        data-testid="command-palette-trigger"
      >
        <IconSearch className="size-4" />
        <span className="hidden sm:inline">{t('app:paletteTrigger')}</span>
        <kbd className="pointer-events-none hidden h-5 items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium md:flex">
          Ctrl K
        </kbd>
      </Button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('app:paletteTitle')}
            data-testid="command-palette"
            className="w-full max-w-lg overflow-hidden rounded-xl border bg-background shadow-lg"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={onListKeyDown}
          >
            <div className="flex items-center gap-2 border-b px-3">
              <IconSearch className="size-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('app:palettePlaceholder')}
                aria-label={t('app:paletteTitle')}
                className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <ul ref={listRef} role="listbox" aria-label={t('app:paletteTitle')} className="max-h-80 overflow-y-auto p-2">
              {(['screens', 'courses'] as const).map((group) => {
                const groupItems = filtered
                  .map((item, index) => ({ item, index }))
                  .filter(({ item }) => item.group === group);
                if (!groupItems.length) return null;
                return (
                  <Fragment key={group}>
                    <li className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground" aria-hidden="true">
                      {group === 'screens' ? t('app:paletteScreensGroup') : t('app:paletteCoursesGroup')}
                    </li>
                    {groupItems.map(({ item, index }) => (
                      <li
                        key={item.id}
                        role="option"
                        aria-selected={index === activeIndex}
                        data-index={index}
                        data-testid={`palette-item-${item.id}`}
                        className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                          index === activeIndex ? 'bg-accent text-accent-foreground' : ''
                        }`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => go(item)}
                      >
                        <span className="truncate">{item.title}</span>
                        {item.hint ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">{item.hint}</span> : null}
                      </li>
                    ))}
                  </Fragment>
                );
              })}
              {filtered.length === 0 ? (
                <li className="px-2 py-6 text-center text-sm text-muted-foreground">{t('app:paletteEmpty')}</li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
