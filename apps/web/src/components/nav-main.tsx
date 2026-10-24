import type { Icon } from '@tabler/icons-react';
import { ChevronRightIcon } from 'lucide-react';
import { Link, useLocation } from 'react-router';

import { Badge } from '@lms/ui/components/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@lms/ui/components/collapsible';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@lms/ui/components/sidebar';

/** Một mục điều hướng lá trong sidebar: nhãn đã dịch sẵn, đường dẫn route thật của app. */
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
 * Một mục cha thu/mở được trong sidebar (cơ chế collapse lấy từ block
 * sidebar-07): cha là nút thu/mở thuần KHÔNG có URL — bấm chỉ mở/đóng
 * danh sách mục con. `groupId` là định danh ổn định để lưu trạng thái
 * mở của nhóm (xem AppSidebar).
 */
export interface NavGroupItem {
  groupId: string;
  title: string;
  icon?: Icon;
  children: NavItem[];
}

/** Một dòng trong cây điều hướng: hoặc mục lá (có `url`), hoặc mục cha (có `children`). */
export type NavEntry = NavItem | NavGroupItem;

function isNavGroup(entry: NavEntry): entry is NavGroupItem {
  return 'children' in entry;
}

/** Mục đang chọn: khớp chính xác, hoặc route con của nó (riêng trang chủ chỉ khớp chính xác). */
function isPathActive(url: string, pathname: string): boolean {
  return url === '/' ? pathname === '/' : pathname === url || pathname.startsWith(`${url}/`);
}

/** Mục lá ở cấp trực tiếp của sidebar (nút có icon + tooltip khi thu thành rail). */
function NavLeafButton({ item, pathname }: { item: NavItem; pathname: string }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<Link to={item.url} />}
        tooltip={item.title}
        isActive={isPathActive(item.url, pathname)}
      >
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
}

/**
 * Mục cha collapse: Collapsible bọc trong SidebarMenuItem, nút cha kèm
 * chevron xoay 90° khi mở (đúng cơ chế của sidebar-07). Trạng thái mở
 * do AppSidebar kiểm soát (đã gồm quy tắc nhóm chứa route đang xem thì
 * luôn mở). Ở chế độ rail icon, mục con bị primitive ẩn bằng CSS — bấm
 * vào cha khi đó sẽ bung sidebar ra rồi mở nhóm, thay vì bấm mà không
 * thấy gì xảy ra.
 */
function NavGroupCollapsible({
  item,
  pathname,
  open,
  onOpenChange,
}: {
  item: NavGroupItem;
  pathname: string;
  open: boolean;
  onOpenChange: (groupId: string, open: boolean) => void;
}) {
  const { state, isMobile, setOpen } = useSidebar();
  const hasActiveChild = item.children.some((child) => isPathActive(child.url, pathname));

  const handleOpenChange = (nextOpen: boolean) => {
    if (state === 'collapsed' && !isMobile) {
      // Rail icon: mục con đang bị ẩn — bung sidebar trước, nhóm mở theo.
      setOpen(true);
      if (!open) onOpenChange(item.groupId, true);
      return;
    }
    onOpenChange(item.groupId, nextOpen);
  };

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} className="group/collapsible" render={<SidebarMenuItem />}>
      <CollapsibleTrigger render={<SidebarMenuButton tooltip={item.title} isActive={hasActiveChild} />}>
        {item.icon && <item.icon />}
        <span>{item.title}</span>
        <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[collapsible=icon]:hidden group-data-open/collapsible:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarMenuSub>
          {item.children.map((child) => (
            <SidebarMenuSubItem key={child.url}>
              <SidebarMenuSubButton render={<Link to={child.url} />} isActive={isPathActive(child.url, pathname)}>
                {child.icon && <child.icon />}
                <span>{child.title}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Cây điều hướng trong MỘT SidebarGroup không nhãn (hồ sơ UI/UX §4):
 * lần lượt các mục trực tiếp rồi các mục cha collapse. Việc lọc mục
 * theo quyền do AppSidebar quyết định — component này chỉ trình bày
 * những gì được truyền vào; nhóm cha rỗng (mọi mục con bị lọc hết
 * quyền) thì không render. Trạng thái mở của từng nhóm được AppSidebar
 * giữ và lưu bền; nhóm chứa route đang xem luôn mở.
 */
export function NavMain({
  items,
  openGroups,
  onOpenGroupChange,
}: {
  items: NavEntry[];
  openGroups: string[];
  onOpenGroupChange: (groupId: string, open: boolean) => void;
}) {
  const { pathname } = useLocation();
  const visible = items.filter((entry) => !isNavGroup(entry) || entry.children.length > 0);
  if (visible.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {visible.map((entry) =>
            isNavGroup(entry) ? (
              <NavGroupCollapsible
                key={entry.groupId}
                item={entry}
                pathname={pathname}
                open={
                  openGroups.includes(entry.groupId) ||
                  entry.children.some((child) => isPathActive(child.url, pathname))
                }
                onOpenChange={onOpenGroupChange}
              />
            ) : (
              <NavLeafButton key={entry.url} item={entry} pathname={pathname} />
            ),
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
