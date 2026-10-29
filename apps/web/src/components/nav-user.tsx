import { IconDotsVertical, IconLogout, IconSettings, IconUserCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@lms/ui/components/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@lms/ui/components/sidebar';
import { useAuth } from '#lib/auth';
import { TenantSwitcherMenu } from '#components/tenant-switcher';
import '#config/i18n';

/** Chữ viết tắt từ họ tên để làm avatar khi người dùng chưa có ảnh đại diện. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

/**
 * Khối người dùng ở chân sidebar (khung từ block dashboard-01): hiển thị
 * người đang đăng nhập thật từ AuthContext, menu gồm hồ sơ, cài đặt và
 * đăng xuất — chỉ những thao tác người dùng nào cũng thực hiện được với
 * chính mình. Từ issue #288 "Hồ sơ" và "Cài đặt" là HAI lối vào tách
 * bạch như các site lớn: Hồ sơ (`/profile`) chỉ còn thông tin user,
 * Cài đặt (`/settings`) là khu riêng có menu trái (bảo mật, liên kết,
 * thông báo).
 */
export function NavUser() {
  const { user, logout } = useAuth();
  const { t } = useTranslation('app');
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  if (!user) return null;
  const name = `${user.firstName} ${user.lastName}`.trim() || user.username;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
              />
            }
          >
            <Avatar className="h-8 w-8 rounded-lg">
              <AvatarFallback className="rounded-lg">{initialsOf(name)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email ?? user.username}</span>
            </div>
            <IconDotsVertical className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--anchor-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            {/* Base UI bắt buộc nhãn nhóm phải nằm trong DropdownMenuGroup
                (Menu.GroupLabel cần MenuGroupContext); thiếu lớp bọc này
                menu ném lỗi ngay khi mở. Bản Radix trước đây không đòi. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarFallback className="rounded-lg">{initialsOf(name)}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{name}</span>
                    <span className="truncate text-xs text-muted-foreground">{user.email ?? user.username}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/profile')}>
              <IconUserCircle />
              {t('navProfile')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate('/settings')}>
              <IconSettings />
              {t('navSettings')}
            </DropdownMenuItem>
            <TenantSwitcherMenu />
            <DropdownMenuItem
              onClick={() => {
                void logout().then(() => navigate('/login'));
              }}
            >
              <IconLogout />
              {t('logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
