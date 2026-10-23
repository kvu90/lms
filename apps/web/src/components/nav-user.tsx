import {
  IconDotsVertical,
  IconLogout,
  IconUserCircle,
} from "@tabler/icons-react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router"

import {
  Avatar,
  AvatarFallback,
} from "@lms/ui/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@lms/ui/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@lms/ui/components/ui/sidebar"
import { useAuth } from "@/lib/auth"
import "../i18n"

/** Chữ viết tắt từ họ tên để làm avatar khi người dùng chưa có ảnh đại diện. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("")
}

/**
 * Khối người dùng ở chân sidebar (khung từ block dashboard-01): hiển thị
 * người đang đăng nhập thật từ AuthContext, menu gồm hồ sơ và đăng xuất —
 * chỉ những thao tác người dùng nào cũng thực hiện được với chính mình.
 */
export function NavUser() {
  const { user, logout } = useAuth()
  const { t } = useTranslation("app")
  const { isMobile } = useSidebar()
  const navigate = useNavigate()
  if (!user) return null
  const name = `${user.firstname} ${user.lastname}`.trim() || user.username
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarFallback className="rounded-lg">{initialsOf(name)}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{name}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {user.email ?? user.username}
                </span>
              </div>
              <IconDotsVertical className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">{initialsOf(name)}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{name}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {user.email ?? user.username}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate("/profile")}>
              <IconUserCircle />
              {t("navProfile")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void logout().then(() => navigate("/login"))
              }}
            >
              <IconLogout />
              {t("logout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
