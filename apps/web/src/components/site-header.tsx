import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { Separator } from '@lms/ui/components/ui/separator';
import { SidebarTrigger } from '@lms/ui/components/ui/sidebar';
import '../i18n';

/** Ánh xạ tiền tố đường dẫn → khoá i18n của tiêu đề trang, cho header trên cùng. */
const TITLE_KEYS: { prefix: string; key: string; ns: 'app' | 'dashboard' }[] = [
  { prefix: '/admin/users', key: 'navUsers', ns: 'app' },
  { prefix: '/admin/roles', key: 'navRoles', ns: 'app' },
  { prefix: '/courses', key: 'navCourses', ns: 'app' },
  { prefix: '/questions', key: 'navQuestions', ns: 'app' },
  { prefix: '/question-usages', key: 'navQuestions', ns: 'app' },
  { prefix: '/messages', key: 'navMessages', ns: 'app' },
  { prefix: '/notifications', key: 'navNotifications', ns: 'app' },
  { prefix: '/calendar', key: 'navCalendar', ns: 'app' },
  { prefix: '/badges', key: 'navBadges', ns: 'app' },
  { prefix: '/learning-plan', key: 'navLearningPlan', ns: 'app' },
  { prefix: '/blog', key: 'navBlog', ns: 'app' },
  { prefix: '/search', key: 'navSearch', ns: 'app' },
  { prefix: '/tokens', key: 'navTokens', ns: 'app' },
  { prefix: '/backup', key: 'navBackup', ns: 'app' },
  { prefix: '/insights', key: 'navInsights', ns: 'app' },
  { prefix: '/reports', key: 'navReports', ns: 'app' },
  { prefix: '/contentbank', key: 'navContentBank', ns: 'app' },
  { prefix: '/privacy', key: 'navPrivacy', ns: 'app' },
  { prefix: '/profile', key: 'navProfile', ns: 'app' },
  { prefix: '/health', key: 'navHealth', ns: 'app' },
];

/**
 * Header trên cùng của khu vực đã đăng nhập (khung block dashboard-01):
 * nút thu/mở sidebar, tiêu đề trang hiện tại (tra catalog i18n theo route)
 * và bộ chọn ngôn ngữ — chuyển từ header cũ sang để giữ thói quen dùng.
 */
export function SiteHeader() {
  const { t, i18n } = useTranslation(['app', 'dashboard']);
  const { pathname } = useLocation();
  const match =
    pathname === '/'
      ? { key: 'itemDashboard', ns: 'dashboard' as const }
      : TITLE_KEYS.find((entry) => pathname.startsWith(entry.prefix));
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-all ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 pr-4 pl-3 lg:gap-2 lg:px-6">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <h1 className="text-base font-medium">{match ? t(`${match.ns}:${match.key}`) : 'LMS'}</h1>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            {t('app:language')}
            <select
              aria-label={t('app:language')}
              value={i18n.language}
              onChange={(e) => void i18n.changeLanguage(e.target.value)}
              className="border px-1 py-0.5"
            >
              <option value="vi">Tiếng Việt</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
      </div>
    </header>
  );
}
