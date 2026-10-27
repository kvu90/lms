import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { IconSearch } from '@tabler/icons-react';

import { Input } from '@lms/ui/components/input';
import { Separator } from '@lms/ui/components/separator';
import { SidebarTrigger } from '@lms/ui/components/sidebar';
import { CommandPalette } from '#components/command-palette';
import { NotificationBell } from '#components/notification-bell';
import '../i18n';

/** Ánh xạ tiền tố đường dẫn → khoá i18n của tiêu đề trang, cho header trên cùng. */
const TITLE_KEYS: { prefix: string; key: string; ns: 'app' | 'dashboard' }[] = [
  { prefix: '/admin/users', key: 'navUsers', ns: 'app' },
  { prefix: '/admin/roles', key: 'navRoles', ns: 'app' },
  { prefix: '/admin/site-config', key: 'navSiteConfig', ns: 'app' },
  { prefix: '/courses', key: 'navCourses', ns: 'app' },
  { prefix: '/questions', key: 'navQuestions', ns: 'app' },
  { prefix: '/exams', key: 'navMyPapers', ns: 'app' },
  { prefix: '/matrices', key: 'navMyMatrices', ns: 'app' },
  { prefix: '/system-bank/questions', key: 'navQuestions', ns: 'app' },
  { prefix: '/system-bank/exams', key: 'navMyPapers', ns: 'app' },
  { prefix: '/system-bank/matrices', key: 'navMyMatrices', ns: 'app' },
  { prefix: '/question-usages', key: 'navQuestions', ns: 'app' },
  { prefix: '/messages', key: 'navMessages', ns: 'app' },
  { prefix: '/notifications', key: 'navNotifications', ns: 'app' },
  { prefix: '/guardian', key: 'navGuardian', ns: 'app' },
  { prefix: '/calendar', key: 'navCalendar', ns: 'app' },
  { prefix: '/badges', key: 'navBadges', ns: 'app' },
  { prefix: '/learning-plan', key: 'navLearningPlan', ns: 'app' },
  { prefix: '/search', key: 'navSearch', ns: 'app' },
  { prefix: '/tokens', key: 'navTokens', ns: 'app' },
  { prefix: '/backup', key: 'navBackup', ns: 'app' },
  { prefix: '/insights', key: 'navInsights', ns: 'app' },
  { prefix: '/reports', key: 'navReports', ns: 'app' },
  { prefix: '/content-bank', key: 'navContentBank', ns: 'app' },
  { prefix: '/privacy', key: 'navPrivacy', ns: 'app' },
  { prefix: '/profile', key: 'navProfile', ns: 'app' },
  { prefix: '/settings', key: 'navSettings', ns: 'app' },
  { prefix: '/health', key: 'navHealth', ns: 'app' },
];

/**
 * Ô tìm kiếm nội dung ở GIỮA header (chốt 23:52 ngày
 * 26/10/2026, issue #303 — khuôn Facebook/YouTube: header ba vùng,
 * ô tìm kiếm nằm giữa). Đây là đường vào trang kết quả tìm kiếm
 * toàn cục đầy đủ. Bề mặt mở bằng Ctrl/Cmd+K (xem
 * command-palette.tsx) là bề mặt hợp nhất theo chốt gộp tìm kiếm
 * ngày 27/10/2026 — nhóm "Nội dung" của nó dùng chung cùng API
 * /search với trang kết quả — nhưng ô giữa GIỮ NGUYÊN vai trò và
 * hành vi: gõ tại chỗ không gọi API, Enter mới sang trang kết quả.
 *
 * Flow:
 * 1. Người dùng gõ vào ô (trạng thái chữ sống cục bộ trong component
 *    này, gõ không làm điều hướng hay gọi API).
 * 2. Enter / submit form: từ khoá sau khi cắt khoảng trắng mà RỖNG
 *    thì KHÔNG điều hướng (ở yên trang hiện tại — tránh đẩy người
 *    dùng tới một trang kết quả trống vô nghĩa); có chữ thì điều
 *    hướng tới `/search?q=<từ khoá đã mã hoá URL>` và trang kết quả
 *    tự đọc `q` chạy tìm ngay (xem pages/platform-search.tsx).
 * 3. Đồng bộ ngược từ URL: khi đang ở `/search`, ô luôn hiển thị
 *    đúng từ khoá của tham số `q` hiện tại (kể cả khi `q` đổi do
 *    điều hướng từ nơi khác); rời khỏi `/search` thì giữ nguyên chữ
 *    người dùng đã gõ để quay lại trang kết quả là thấy đúng ngữ
 *    cảnh tìm trước đó.
 */
function HeaderSearch() {
  const { t } = useTranslation(['platform']);
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  // Từ khoá chuẩn theo URL khi đang ở trang kết quả; null = không ở
  // /search (không đồng bộ gì, giữ chữ người dùng đang gõ dở).
  const urlKeyword = pathname === '/search' ? (new URLSearchParams(search).get('q') ?? '') : null;
  const [keyword, setKeyword] = useState(urlKeyword ?? '');

  // URL là nguồn sự thật khi ở /search: q đổi (gửi lại từ chính ô
  // này, đi từ bảng lệnh, hay dán link) thì ô phải khớp theo.
  useEffect(() => {
    if (urlKeyword !== null) setKeyword(urlKeyword);
  }, [urlKeyword]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = keyword.trim();
    if (!trimmed) return;
    void navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <form role="search" onSubmit={onSubmit} className="w-full">
      <div className="relative">
        <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t('platform:searchPlaceholder')}
          aria-label={t('platform:searchQuery')}
          className="rounded-full pl-9"
        />
      </div>
    </form>
  );
}

/**
 * Header trên cùng của khu vực đã đăng nhập (khung block
 * dashboard-01), bố cục BA VÙNG theo chốt 23:52 ngày 26/10/2026
 * (issue #303, khuôn Facebook/YouTube):
 *
 * - VÙNG TRÁI: nút thu/mở sidebar + tiêu đề trang hiện tại (tra
 *   catalog i18n theo route bằng TITLE_KEYS ở trên).
 * - VÙNG GIỮA: ô tìm kiếm nội dung toàn cục (component HeaderSearch
 *   cùng file) — vùng co giãn linh hoạt ở giữa, ô có bề rộng tối đa
 *   cố định và tự co khi bề ngang hẹp để không đẩy vùng phải tràn
 *   hàng. Mục "Tìm kiếm" ở sidebar đã BỎ từ cùng chốt này.
 * - VÙNG PHẢI: chuông thông báo kèm dropdown xem nhanh (lát NB-3,
 *   issue #174 — xem notification-bell.tsx; số chưa đọc dùng chung
 *   khoá với huy hiệu ở mục Thông báo trên sidebar). Bề mặt tìm
 *   kiếm hợp nhất Cmd+K KHÔNG còn nút mở riêng ở vùng này (chốt gộp
 *   tìm kiếm ngày 27/10/2026): component CommandPalette vẫn mount
 *   tại đây để đăng ký phím tắt toàn cục và lớp phủ, nhưng không
 *   render gì khi đang đóng.
 *
 * Site chỉ dành cho người Việt nên không có bộ chọn ngôn ngữ trên
 * giao diện — i18n chỉ quản lý chuỗi tập trung, locale cố định
 * tiếng Việt.
 */
export function SiteHeader() {
  const { t } = useTranslation(['app', 'dashboard']);
  const { pathname } = useLocation();
  const match =
    pathname === '/'
      ? { key: 'itemDashboard', ns: 'dashboard' as const }
      : TITLE_KEYS.find((entry) => pathname.startsWith(entry.prefix));
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-all ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-2 pr-4 pl-3 lg:px-6">
        {/* Vùng trái: nút mở sidebar + tiêu đề trang. min-w-0 +
            truncate để tiêu đề dài tự cắt thay vì đẩy vùng giữa. */}
        <div className="flex min-w-0 items-center gap-1 lg:gap-2">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
          <h1 className="truncate text-base font-medium">{match ? t(`${match.ns}:${match.key}`) : 'LMS'}</h1>
        </div>
        {/* Vùng giữa: ô tìm kiếm chiếm phần linh hoạt còn lại và căn
            giữa trong phần đó; max-w-xl giữ ô không bè ra quá rộng
            trên màn hình lớn, min-w-0 cho phép co khi hẹp. */}
        <div className="flex min-w-0 flex-1 justify-center px-1 lg:px-4">
          <div className="w-full max-w-xl min-w-0">
            <HeaderSearch />
          </div>
        </div>
        {/* Vùng phải: chuông thông báo, shrink-0 để không bị vùng
            giữa ép méo. CommandPalette mount tại đây chỉ để giữ
            phím tắt Ctrl/Cmd+K toàn cục — không còn nút mở riêng. */}
        <div className="flex shrink-0 items-center gap-1 lg:gap-2">
          <CommandPalette />
          <NotificationBell />
        </div>
      </div>
    </header>
  );
}
