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

import { NavMain, type NavEntry } from '#components/nav-main';
import { NavUser } from '#components/nav-user';
import { apiJson } from '#lib/api';
import { useNotificationUnreadStream } from '#lib/notification-unread-stream';
import { queryKeys } from '#lib/query-keys';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@lms/ui/components/sidebar';
import { usePermissions } from '#lib/permissions';
import '../i18n';

/** Khoá localStorage lưu các nhóm điều hướng đang mở (hồ sơ UI/UX §4.3). */
const OPEN_GROUPS_STORAGE_KEY = 'lms:sidebar:open-groups';

/**
 * Đọc lười danh sách nhóm đang mở đã lưu ở lần render đầu tiên, theo
 * đúng mẫu `readSidebarDefaultOpen` của shell: giá trị hỏng/không phải
 * mảng chuỗi thì coi như chưa lưu gì. Nhóm chứa route đang xem luôn mở
 * bất kể giá trị đã lưu — quy tắc đó nằm ở NavMain, không ở đây.
 */
function readStoredOpenGroups(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(OPEN_GROUPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Sidebar điều hướng của khu vực đã đăng nhập, LỌC THEO QUYỀN THẬT của
 * người đang đăng nhập (hồ sơ UI/UX §4 — cây nhóm thay cho 3 nhóm phẳng
 * của khung dashboard-01 trước đây):
 *
 * - 6 mục trực tiếp (Tổng quan, Khoá học, Lịch, Tin nhắn, Thông báo,
 *   Tìm kiếm): các trang mọi người dùng đăng nhập đều tự phục vụ được.
 * - Nhóm "Học tập" thu/mở được: Huy hiệu, Kế hoạch học tập, Blog.
 * - Nhóm "Ngân hàng câu hỏi" thu/mở được NGAY SAU nhóm Học tập — chỉ
 *   khi API cho phép dùng ngân hàng câu hỏi (canUseQuestionBank), học
 *   viên thuần không nhìn thấy nhóm này: 4 mục con liên kết sâu tới
 *   từng khu vực của trang /questions (?bank=system / my-questions /
 *   my-papers / my-matrices).
 * - Hai nhóm quản trị ("Người dùng & quyền", "Hệ thống & dữ liệu") chỉ
 *   hiện khi người dùng có ít nhất một capability quản trị cấp hệ thống
 *   (canAdminister do PermissionsProvider đọc từ ảnh chụp quyền
 *   GET /users/me/capabilities). Phần tử không có quyền thì KHÔNG
 *   render — không render rồi disable, không để link dẫn tới trang 403.
 * - Mục Thông báo mang huy hiệu số chưa đọc: số ban đầu từ GET
 *   /notifications/unread-count, sau đó được stream SSE đẩy cập nhật
 *   thời gian thực (không polling) — đây là chỗ duy nhất báo tin chưa
 *   đọc trong khung đã đăng nhập, header không còn chuông thông báo.
 * - Thu sidebar là thu về rail icon (`collapsible="icon"` + SidebarRail)
 *   thay vì mất hẳn điều hướng như `offcanvas` trước đây; trạng thái
 *   thu/mở của từng nhóm lưu ở localStorage, trạng thái sidebar toàn
 *   cục vẫn do cookie `sidebar_state` của SidebarProvider giữ.
 */
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation(['app', 'dashboard']);
  const perms = usePermissions();

  // Số thông báo chưa đọc cho huy hiệu ở mục Thông báo: REST cho số
  // ngay khi mở trang, stream SSE giữ số đó luôn mới trong cache.
  // Đang tải hoặc lỗi truy vấn ban đầu thì coi như 0 (không hiện huy hiệu).
  useNotificationUnreadStream();
  const unreadQuery = useQuery({
    queryKey: queryKeys.notificationUnreadCount,
    queryFn: () => apiJson<{ unread: number }>('/api/v1/notifications/unread-count'),
  });
  const unreadNotifications = unreadQuery.data?.unread ?? 0;

  // Mục "Phụ huynh" (PH-1, issue #130) chỉ hiện khi tài khoản có ít
  // nhất một liên kết giám hộ đang hiệu lực — người dùng thường không
  // thấy bề mặt này.
  const guardianQuery = useQuery({
    queryKey: queryKeys.guardianMyStudents,
    queryFn: () => apiJson<{ student: { id: string } }[]>('/api/v1/guardian-links/mine/students'),
  });
  const hasGuardianChildren = (guardianQuery.data?.length ?? 0) > 0;

  // Trạng thái mở của các nhóm collapse: đọc lười từ localStorage ở
  // lần render đầu, ghi lại mỗi lần người dùng thu/mở một nhóm.
  const [openGroups, setOpenGroups] = React.useState<string[]>(readStoredOpenGroups);
  const handleOpenGroupChange = React.useCallback((groupId: string, open: boolean) => {
    setOpenGroups((prev) => {
      const next = open ? [...new Set([...prev, groupId])] : prev.filter((id) => id !== groupId);
      try {
        window.localStorage.setItem(OPEN_GROUPS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // localStorage có thể bị chặn (chế độ riêng tư…) — trạng thái
        // vẫn sống trong bộ nhớ cho phiên hiện tại, chỉ không bền qua F5.
      }
      return next;
    });
  }, []);

  const entries: NavEntry[] = [
    { title: t('dashboard:itemDashboard'), url: '/', icon: IconLayoutDashboard },
    { title: t('app:navCourses'), url: '/courses', icon: IconBook },
    { title: t('app:navCalendar'), url: '/calendar', icon: IconCalendar },
    { title: t('app:navMessages'), url: '/messages', icon: IconMail },
    { title: t('app:navNotifications'), url: '/notifications', icon: IconBell, badgeCount: unreadNotifications },
    ...(hasGuardianChildren
      ? [{ title: t('app:navGuardian'), url: '/guardian', icon: IconUsers }]
      : []),
    { title: t('app:navSearch'), url: '/search', icon: IconSearch },
    {
      groupId: 'learning',
      title: t('app:navGroupLearning'),
      icon: IconNotebook,
      children: [
        { title: t('app:navBadges'), url: '/badges', icon: IconAward },
        { title: t('app:navLearningPlan'), url: '/learning-plan', icon: IconNotebook },
        { title: t('app:navBlog'), url: '/blog', icon: IconBooks },
      ],
    },
    ...(perms.canUseQuestionBank
      ? [
          {
            groupId: 'question-bank',
            title: t('app:navQuestions'),
            icon: IconQuestionMark,
            children: [
              { title: t('app:navBankSystem'), url: '/questions?bank=system', icon: IconDatabase },
              { title: t('app:navMyQuestions'), url: '/questions?bank=my-questions', icon: IconQuestionMark },
              { title: t('app:navMyPapers'), url: '/questions?bank=my-papers', icon: IconNotebook },
              { title: t('app:navMyMatrices'), url: '/questions?bank=my-matrices', icon: IconChartBar },
            ],
          },
        ]
      : []),
    ...(perms.canAdminister
      ? [
          {
            groupId: 'users-access',
            title: t('app:navGroupUsersAccess'),
            icon: IconUsers,
            children: [
              { title: t('app:navUsers'), url: '/admin/users', icon: IconUsers },
              { title: t('app:navRoles'), url: '/admin/roles', icon: IconShieldLock },
              { title: t('app:navTokens'), url: '/tokens', icon: IconSettings },
            ],
          },
          {
            groupId: 'system-data',
            title: t('app:navGroupSystemData'),
            icon: IconSettings,
            children: [
              { title: t('app:navSiteConfig'), url: '/admin/site-config', icon: IconSettings },
              { title: t('app:navCurriculum'), url: '/admin/curriculum', icon: IconNotebook },
              { title: t('app:navReports'), url: '/reports', icon: IconReport },
              { title: t('app:navInsights'), url: '/insights', icon: IconChartBar },
              { title: t('app:navContentBank'), url: '/contentbank', icon: IconDatabase },
              { title: t('app:navBackup'), url: '/backup', icon: IconDatabase },
              { title: t('app:navPrivacy'), url: '/privacy', icon: IconShieldLock },
              { title: t('app:navHealth'), url: '/health', icon: IconHelpCircle },
            ],
          },
        ]
      : []),
  ];

  return (
    <Sidebar collapsible="icon" {...props}>
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
        <NavMain items={entries} openGroups={openGroups} onOpenGroupChange={handleOpenGroupChange} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
