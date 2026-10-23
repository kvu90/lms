import type { Icon } from '@tabler/icons-react';
import { Link, useLocation } from 'react-router';

import { Badge } from '@lms/ui/components/ui/badge';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@lms/ui/components/ui/sidebar';

/** Một mục điều hướng trong sidebar: nhãn đã dịch sẵn, đường dẫn route thật của app. */
export interface NavItem {
  title: string;
  url: string;
  icon?: Icon;
  /**
   * Số đếm hiện thành huy hiệu đỏ cạnh nhãn (vd số thông báo chưa đọc
   * của mục Thông báo). Chỉ trình bày số được truyền vào — việc truy
   * vấn số liệu thuộc về AppSidebar; bằng 0 hoặc không đặt thì không
   * hiện huy hiệu.
   */
  badgeCount?: number;
}

/**
 * Nhóm điều hướng trong sidebar (khung từ block dashboard-01): nhãn nhóm
 * tuỳ chọn, mỗi mục là một route thật; mục khớp với đường dẫn hiện tại được
 * đánh dấu đang chọn. Việc lọc mục theo quyền do AppSidebar quyết định —
 * component này chỉ trình bày những gì được truyền vào.
 */
export function NavMain({ label, items }: { label?: string; items: NavItem[] }) {
  const { pathname } = useLocation();
  if (items.length === 0) return null;
  return (
    <SidebarGroup>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const isActive =
              item.url === '/' ? pathname === '/' : pathname === item.url || pathname.startsWith(`${item.url}/`);
            return (
              <SidebarMenuItem key={item.url}>
                <SidebarMenuButton render={<Link to={item.url} />} tooltip={item.title} isActive={isActive}>
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                  {item.badgeCount != null && item.badgeCount > 0 ? (
                    <Badge variant="destructive" className="ml-auto h-5 min-w-5 shrink-0 rounded-full px-1">
                      {item.badgeCount}
                    </Badge>
                  ) : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
