import type { Icon } from "@tabler/icons-react"
import { Link, useLocation } from "react-router"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@lms/ui/components/ui/sidebar"

/** Một mục điều hướng trong sidebar: nhãn đã dịch sẵn, đường dẫn route thật của app. */
export interface NavItem {
  title: string
  url: string
  icon?: Icon
}

/**
 * Nhóm điều hướng trong sidebar (khung từ block dashboard-01): nhãn nhóm
 * tuỳ chọn, mỗi mục là một route thật; mục khớp với đường dẫn hiện tại được
 * đánh dấu đang chọn. Việc lọc mục theo quyền do AppSidebar quyết định —
 * component này chỉ trình bày những gì được truyền vào.
 */
export function NavMain({
  label,
  items,
}: {
  label?: string
  items: NavItem[]
}) {
  const { pathname } = useLocation()
  if (items.length === 0) return null
  return (
    <SidebarGroup>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const isActive =
              item.url === "/"
                ? pathname === "/"
                : pathname === item.url || pathname.startsWith(`${item.url}/`)
            return (
              <SidebarMenuItem key={item.url}>
                <SidebarMenuButton render={<Link to={item.url} />} tooltip={item.title} isActive={isActive}>
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
