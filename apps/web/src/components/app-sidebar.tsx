import * as React from 'react';
import {
  IconAward,
  IconBell,
  IconBook,
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
 * - 5 mục trực tiếp (Tổng quan, Khoá học, Lịch, Tin nhắn, Thông
 *   báo): các trang mọi người dùng đăng nhập đều tự phục vụ được.
 *   Mục "Tìm kiếm" KHÔNG còn ở sidebar: Lão gia chốt 23:52 ngày
 *   26/10/2026 (issue #303) đưa ô tìm kiếm ra GIỮA header theo khuôn
 *   Facebook/YouTube; trang kết quả /search vẫn tới được từ ô đó và
 *   từ bảng lệnh ⌘K (mục màn hình của bảng lệnh giữ khoá navSearch).
 * - Nhóm "Học tập" thu/mở được: Huy hiệu, Kế hoạch học tập — chỉ
 *   hiện khi người dùng có dấu chân học tập (issue #176, quy tắc M+A:
 *   đang là học viên ở ≥1 khoá HOẶC có hiện vật học tập của chính mình
 *   qua cờ hasLearnerFootprint). Ẩn điều hướng ≠ khoá trang: gõ thẳng
 *   /badges hay /learning-plan vẫn vào được, API hai trang vốn chỉ trả
 *   dữ liệu của chính người gọi.
 * - Ba mục ngân hàng ở CẤP CAO NHẤT ngay sau nhóm Học tập (Lão gia
 *   chốt lại 11:40 ngày 26/10/2026, issue #228 — BỎ hẳn mục "Ngân
 *   hàng hệ thống" ở sidebar): "Ngân hàng câu hỏi" (thân mục dẫn tới
 *   /questions, thu/mở ra mục con "Ngữ liệu" ở /questions/stimuli),
 *   "Ngân hàng đề" (/exams) và "Ngân hàng ma trận" (/matrices) —
 *   thân hai mục này dẫn thẳng tới trang danh sách. Khu hệ thống
 *   không còn là mục sidebar riêng: mỗi màn danh sách ngân hàng có
 *   thanh tab Cá nhân | Hệ thống ở đầu vùng danh sách, bấm tab là
 *   điều hướng giữa path cá nhân và /system-bank/* tương ứng (mỗi
 *   khu vực vẫn một PATH RIÊNG theo chuẩn đường dẫn, issue #221 —
 *   trước đây cả cụm dùng chung /questions?bank=&section=). Cả ba
 *   chỉ hiện khi API cho phép dùng ngân hàng câu hỏi
 *   (canUseQuestionBank) — học viên thuần không nhìn thấy.
 * - Hai nhóm quản trị ("Người dùng & quyền", "Cài đặt hệ thống") chỉ
 *   hiện khi người dùng có ít nhất một capability quản trị cấp hệ thống
 *   (canAdminister do PermissionsProvider đọc từ ảnh chụp quyền
 *   GET /users/me/capabilities). Phần tử không có quyền thì KHÔNG
 *   render — không render rồi disable, không để link dẫn tới trang 403.
 * - Mục Thông báo mang huy hiệu số chưa đọc: số ban đầu từ GET
 *   /notifications/unread-count, sau đó được stream SSE đẩy cập nhật
 *   thời gian thực (không polling) — số này dùng chung đúng một khoá
 *   truy vấn với chuông thông báo ở header (lát NB-3, issue #174).
 * - Mục Tin nhắn mang huy hiệu SỐ CONVERSATION chưa đọc (lát M1,
 *   issue #204): nguồn GET /messages/unread-count (trường
 *   `conversations` — phía server đếm bằng countUnreadConversations,
 *   đã loại conversation 1–1 bị ẩn vì quan hệ chặn; hội thoại tắt
 *   tiếng sẽ bị loại tại đúng hàm đếm này khi lát M5 tạo trạng thái
 *   tắt tiếng). Chiến lược làm tươi ở lát này là react-query
 *   refetchInterval 30 giây + refetch khi cửa sổ được focus, KHÔNG mở
 *   thêm socket ở vỏ app — đánh đổi đã chốt trong hồ sơ audit: ngoài
 *   trang tin nhắn số có thể trễ tối đa 30 giây, trong trang tin nhắn
 *   vẫn realtime qua socket của chính trang (trang còn chủ động làm
 *   mới truy vấn này mỗi lần tự đếm lại).
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

  // Số conversation tin nhắn chưa đọc cho huy hiệu ở mục Tin nhắn
  // (lát M1, issue #204): làm tươi mỗi 30 giây và khi cửa sổ được
  // focus lại; đang tải hoặc lỗi thì coi như 0 (không hiện huy hiệu).
  const messageUnreadQuery = useQuery({
    queryKey: queryKeys.messageUnreadCount,
    queryFn: () => apiJson<{ conversations: number; notifications: number }>('/api/v1/messages/unread-count'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const unreadConversations = messageUnreadQuery.data?.conversations ?? 0;

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
    { title: t('app:navClasses'), url: '/classes', icon: IconUsers },
    { title: t('app:navCalendar'), url: '/calendar', icon: IconCalendar },
    { title: t('app:navMessages'), url: '/messages', icon: IconMail, badgeCount: unreadConversations },
    { title: t('app:navNotifications'), url: '/notifications', icon: IconBell, badgeCount: unreadNotifications },
    ...(hasGuardianChildren
      ? [{ title: t('app:navGuardian'), url: '/guardian', icon: IconUsers }]
      : []),
    // Mục "Liên kết phụ huynh" (gói kích hoạt phụ huynh): bề mặt
    // quản lý liên kết giám hộ — chỉ hiện khi người dùng có
    // capability guardian:manage (cờ canManageGuardians từ ảnh chụp
    // quyền), theo cùng khuôn có điều kiện của mục "Phụ huynh" ở
    // trên; người không có quyền không render mục này, và API vẫn
    // thực thi quyền thật ở mọi endpoint quản lý.
    ...(perms.canManageGuardians
      ? [{ title: t('app:navGuardianLinks'), url: '/admin/guardian-links', icon: IconUsers }]
      : []),
    ...(perms.hasLearnerFootprint
      ? [
          {
            groupId: 'learning',
            title: t('app:navGroupLearning'),
            icon: IconNotebook,
            children: [
              { title: t('app:navBadges'), url: '/badges', icon: IconAward },
              { title: t('app:navLearningPlan'), url: '/learning-plan', icon: IconNotebook },
            ],
          },
        ]
      : []),
    ...(perms.canUseQuestionBank
      ? [
          {
            groupId: 'my-questions',
            title: t('app:navMyQuestions'),
            icon: IconQuestionMark,
            url: '/questions',
            toggleLabel: t('app:navExpandGroup', { name: t('app:navMyQuestions') }),
            children: [
              { title: t('app:navStimuli'), url: '/questions/stimuli', icon: IconBook },
            ],
          },
          {
            groupId: 'my-papers',
            title: t('app:navMyPapers'),
            icon: IconNotebook,
            url: '/exams',
            toggleLabel: t('app:navExpandGroup', { name: t('app:navMyPapers') }),
            children: [],
          },
          {
            groupId: 'my-matrices',
            title: t('app:navMyMatrices'),
            icon: IconChartBar,
            url: '/matrices',
            toggleLabel: t('app:navExpandGroup', { name: t('app:navMyMatrices') }),
            children: [],
          },
          // Xem bảng chương trình GDPT theo mẫu Bộ (issue #161, lát
          // T2): cùng cụm bề mặt soạn học liệu của giáo viên; trang
          // đích tự gác quyền đọc theo khoá giáo viên đang dạy.
          { title: t('app:navTeacherProgramme'), url: '/curriculum', icon: IconNotebook },
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
              { title: t('app:navContentBank'), url: '/content-bank', icon: IconDatabase },
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
