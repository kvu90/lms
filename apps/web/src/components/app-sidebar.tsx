import * as React from 'react';
import {
  IconAward,
  IconBell,
  IconBook,
  IconBooks,
  IconCalendar,
  IconChartBar,
  IconDatabase,
  IconHelpCircle,
  IconInnerShadowTop,
  IconLayoutDashboard,
  IconMail,
  IconNotebook,
  IconQuestionMark,
  IconReport,
  IconSearch,
  IconSettings,
  IconShieldLock,
  IconUsers,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { NavMain, type NavItem } from '@/components/nav-main';
import { NavUser } from '@/components/nav-user';
import { apiJson } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@lms/ui/components/ui/sidebar';
import { usePermissions } from '@/lib/permissions';
import '../i18n';

/**
 * Sidebar điều hướng của khu vực đã đăng nhập (khung block dashboard-01),
 * LỌC THEO QUYỀN THẬT của người đang đăng nhập:
 *
 * - Nhóm chính và nhóm học tập: các trang mọi người dùng đăng nhập đều tự
 *   phục vụ được (hồ sơ, khoá học, lịch, tin nhắn, thông báo, huy hiệu của
 *   mình, kế hoạch của mình, blog, tìm kiếm).
 * - Mục ngân hàng câu hỏi: chỉ hiện khi API cho phép đọc danh mục câu hỏi
 *   (canUseQuestionBank) — học viên thuần không nhìn thấy.
 * - Nhóm quản trị: chỉ hiện khi người dùng có ít nhất một capability quản
 *   trị cấp hệ thống (canAdminister do PermissionsProvider đọc từ ảnh chụp
 *   quyền GET /users/me/capabilities). Phần tử không có quyền thì KHÔNG
 *   render — không render rồi disable, không để link dẫn tới trang 403.
 * - Mục Thông báo mang huy hiệu số chưa đọc từ GET
 *   /notifications/unread-count (làm mới nền mỗi 60 giây) — đây là chỗ
 *   duy nhất báo tin chưa đọc trong khung đã đăng nhập, header không
 *   còn chuông thông báo.
 */
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation(['app', 'dashboard']);
  const perms = usePermissions();

  // Số thông báo chưa đọc cho huy hiệu ở mục Thông báo; đang tải hoặc
  // lỗi thì coi như 0 (không hiện huy hiệu) cho tới lần làm mới sau.
  const unreadQuery = useQuery({
    queryKey: queryKeys.notificationUnreadCount,
    queryFn: () => apiJson<{ unread: number }>('/api/v1/notifications/unread-count'),
    refetchInterval: 60_000,
  });
  const unreadNotifications = unreadQuery.data?.unread ?? 0;

  const mainItems: NavItem[] = [
    { title: t('dashboard:itemDashboard'), url: '/', icon: IconLayoutDashboard },
    { title: t('app:navCourses'), url: '/courses', icon: IconBook },
    { title: t('app:navCalendar'), url: '/calendar', icon: IconCalendar },
    { title: t('app:navMessages'), url: '/messages', icon: IconMail },
    { title: t('app:navNotifications'), url: '/notifications', icon: IconBell, badgeCount: unreadNotifications },
    { title: t('app:navSearch'), url: '/search', icon: IconSearch },
  ];

  const learningItems: NavItem[] = [
    { title: t('app:navBadges'), url: '/badges', icon: IconAward },
    { title: t('app:navLearningPlan'), url: '/learning-plan', icon: IconNotebook },
    { title: t('app:navBlog'), url: '/blog', icon: IconBooks },
    ...(perms.canUseQuestionBank ? [{ title: t('app:navQuestions'), url: '/questions', icon: IconQuestionMark }] : []),
  ];

  const adminItems: NavItem[] = perms.canAdminister
    ? [
        { title: t('app:navUsers'), url: '/admin/users', icon: IconUsers },
        { title: t('app:navRoles'), url: '/admin/roles', icon: IconShieldLock },
        { title: t('app:navSiteConfig'), url: '/admin/site-config', icon: IconSettings },
        { title: t('app:navTokens'), url: '/tokens', icon: IconSettings },
        { title: t('app:navBackup'), url: '/backup', icon: IconDatabase },
        { title: t('app:navReports'), url: '/reports', icon: IconReport },
        { title: t('app:navInsights'), url: '/insights', icon: IconChartBar },
        { title: t('app:navContentBank'), url: '/contentbank', icon: IconDatabase },
        { title: t('app:navPrivacy'), url: '/privacy', icon: IconShieldLock },
        { title: t('app:navHealth'), url: '/health', icon: IconHelpCircle },
      ]
    : [];

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/" />} className="data-[slot=sidebar-menu-button]:p-1.5!">
              <IconInnerShadowTop className="size-5!" />
              <span className="text-base font-semibold">LMS</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={mainItems} />
        <NavMain label={t('dashboard:groupLearning')} items={learningItems} />
        <NavMain label={t('dashboard:groupAdmin')} items={adminItems} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
