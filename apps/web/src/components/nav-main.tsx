import type { Icon } from '@tabler/icons-react';
import { ChevronRightIcon } from 'lucide-react';
import { NavLink, useLocation } from 'react-router';

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
 * sidebar-07). Hai biến thể:
 *
 * - KHÔNG có `url`: cha là nút thu/mở thuần — bấm chỉ mở/đóng danh sách
 *   mục con (vd "Học tập", "Cài đặt hệ thống").
 * - CÓ `url`: thân mục cha là LINK điều hướng tới trang danh sách của
 *   chính nó (vd "Ngân hàng câu hỏi" → /questions); khi nhóm có mục
 *   con, chevron thu/mở GẮN Ở CUỐI CÙNG MỘT bề mặt nút với nhãn
 *   (trigger định vị tuyệt đối bên trong SidebarMenuItem, `toggleLabel`
 *   là nhãn aria của trigger đó) — KHÔNG tách thành một nút chevron
 *   riêng đứng cạnh nhãn, để hai biến thể trình bày giống nhau (chốt
 *   sổ quyết định [26/10 23:16], việc nối tiếp issue #70). Nhóm có
 *   `url` mà chưa có mục con vẫn render thành mục cấp cao nhất điều
 *   hướng được, không chevron — chờ bổ sung mục con sau (đính chính
 *   sidebar ngân hàng, issue #70).
 *
 * `groupId` là định danh ổn định để lưu trạng thái mở của nhóm (xem
 * AppSidebar).
 */
export interface NavGroupItem {
  groupId: string;
  title: string;
  icon?: Icon;
  url?: string;
  toggleLabel?: string;
  children: NavItem[];
}

/**
 * className cho NavLink của các mục điều hướng chính (F-14, rà soát
 * #133): trong lúc router đang tải trang đích của chính mục này
 * (`isPending`), mục mờ nhẹ ngay từ cú bấm — phản hồi tức thì tại
 * link, bổ sung cho chỉ báo toàn cục ở khung.
 */
function navPendingClassName({ isPending }: { isPending: boolean }): string | undefined {
  return isPending ? 'opacity-50 transition-opacity' : undefined;
}

/** Một dòng trong cây điều hướng: hoặc mục lá (có `url`), hoặc mục cha (có `children`). */
export type NavEntry = NavItem | NavGroupItem;

function isNavGroup(entry: NavEntry): entry is NavGroupItem {
  return 'children' in entry;
}

/**
 * Mục đang chọn: khớp chính xác, hoặc route con của nó (riêng trang
 * chủ chỉ khớp chính xác) — nhờ vậy các khu vực ngân hàng theo path
 * riêng (chuẩn đường dẫn #221: /questions, /exams, /matrices)
 * active đúng trang của chúng và nhóm cha tự mở đúng
 * khi đang ở trang đích hay route con của nó (vd /questions/stimuli
 * làm sáng cả mục cha "Ngân hàng câu hỏi" lẫn mục con "Ngữ liệu"). URL
 * có query (trạng thái nội bộ của một trang, kiểu ?conversation=...)
 * thì chỉ active khi pathname khớp VÀ mọi tham số trong query của
 * URL đều có mặt với đúng giá trị trong query hiện tại.
 */
function isPathActive(url: string, pathname: string, search: string): boolean {
  const queryIndex = url.indexOf('?');
  const urlPath = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  const pathMatches = urlPath === '/' ? pathname === '/' : pathname === urlPath || pathname.startsWith(`${urlPath}/`);
  if (!pathMatches || queryIndex < 0) return pathMatches;
  const wanted = new URLSearchParams(url.slice(queryIndex + 1));
  const current = new URLSearchParams(search);
  let queryMatches = true;
  wanted.forEach((value, key) => {
    if (current.get(key) !== value) queryMatches = false;
  });
  return queryMatches;
}

/** Mục lá ở cấp trực tiếp của sidebar (nút có icon + tooltip khi thu thành rail). */
function NavLeafButton({ item, pathname, search }: { item: NavItem; pathname: string; search: string }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<NavLink to={item.url} className={navPendingClassName} />}
        tooltip={item.title}
        isActive={isPathActive(item.url, pathname, search)}
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
  search,
  open,
  onOpenChange,
}: {
  item: NavGroupItem;
  pathname: string;
  search: string;
  open: boolean;
  onOpenChange: (groupId: string, open: boolean) => void;
}) {
  const { state, isMobile, setOpen } = useSidebar();
  const hasActiveChild = item.children.some((child) => isPathActive(child.url, pathname, search));

  const handleOpenChange = (nextOpen: boolean) => {
    if (state === 'collapsed' && !isMobile) {
      // Rail icon: mục con đang bị ẩn — bung sidebar trước, nhóm mở theo.
      setOpen(true);
      if (!open) onOpenChange(item.groupId, true);
      return;
    }
    onOpenChange(item.groupId, nextOpen);
  };

  const subMenu = (
    <SidebarMenuSub>
      {item.children.map((child) => (
        <SidebarMenuSubItem key={child.url}>
          <SidebarMenuSubButton render={<NavLink to={child.url} className={navPendingClassName} />} isActive={isPathActive(child.url, pathname, search)}>
            {child.icon && <child.icon />}
            <span>{child.title}</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  );

  // Biến thể thân mục là LINK: chưa có mục con thì render như một mục
  // lá cấp cao nhất (không chevron, không collapse) — điều hướng thẳng
  // tới trang danh sách của chính mục đó.
  if (item.url && item.children.length === 0) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton render={<NavLink to={item.url} className={navPendingClassName} />} tooltip={item.title} isActive={isPathActive(item.url, pathname, search)}>
          {item.icon && <item.icon />}
          <span>{item.title}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  // Biến thể thân mục là LINK và có mục con: thân là nút điều hướng
  // (NavLink) chiếm trọn bề mặt hàng; chevron thu/mở gắn ở CUỐI CÙNG
  // MỘT bề mặt nút đó — trigger định vị tuyệt đối lồng trong
  // SidebarMenuItem (phần tử `relative`), trong suốt, không nền hover
  // riêng và không khoảng tách riêng, đúng cách trình bày của biến
  // thể không URL ở dưới (chevron `ml-auto` nằm trong chính nút) và
  // khuôn sidebar-07. Lý do phải giống nhau (chốt sổ quyết định
  // [26/10 23:16]): người dùng nhìn sidebar chỉ thấy MỘT nút liền có
  // chevron ở cuối; việc một nhóm có URL điều hướng không được làm
  // chevron của nó trông như một nút khác tách rời khỏi nhãn. Nút
  // điều hướng chừa `pr-8` ở cuối để nhãn không chạy xuống dưới vùng
  // chevron; bấm vùng chevron chỉ thu/mở danh sách con (trigger là
  // phần tử riêng chồng lên cuối nút nên không kích điều hướng), bấm
  // phần còn lại của nút thì điều hướng tới URL của nhóm.
  if (item.url) {
    return (
      <Collapsible open={open} onOpenChange={handleOpenChange} className="group/collapsible" render={<SidebarMenuItem />}>
        <SidebarMenuButton
          render={<NavLink to={item.url} className={navPendingClassName} />}
          tooltip={item.title}
          isActive={isPathActive(item.url, pathname, search)}
          className="pr-8"
        >
          {item.icon && <item.icon />}
          <span>{item.title}</span>
        </SidebarMenuButton>
        <CollapsibleTrigger
          aria-label={item.toggleLabel ?? item.title}
          className="absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md text-sidebar-foreground/70 ring-sidebar-ring outline-hidden focus-visible:ring-2 group-data-[collapsible=icon]:hidden"
        >
          <ChevronRightIcon className="size-4 transition-transform duration-200 group-data-open/collapsible:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>{subMenu}</CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} className="group/collapsible" render={<SidebarMenuItem />}>
      <CollapsibleTrigger render={<SidebarMenuButton tooltip={item.title} isActive={hasActiveChild} />}>
        {item.icon && <item.icon />}
        <span>{item.title}</span>
        <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[collapsible=icon]:hidden group-data-open/collapsible:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>{subMenu}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Cây điều hướng trong MỘT SidebarGroup không nhãn (hồ sơ UI/UX §4):
 * lần lượt các mục trực tiếp rồi các mục cha collapse. Việc lọc mục
 * theo quyền do AppSidebar quyết định — component này chỉ trình bày
 * những gì được truyền vào; nhóm cha rỗng (mọi mục con bị lọc hết
 * quyền) và không có URL riêng thì không render — nhóm có URL vẫn
 * render vì thân nó tự điều hướng được. Trạng thái mở của từng nhóm
 * được AppSidebar giữ và lưu bền; nhóm chứa route đang xem luôn mở
 * (với nhóm có URL: chính URL của nhóm khớp route cũng tính là đang
 * xem).
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
  const { pathname, search } = useLocation();
  const visible = items.filter((entry) => !isNavGroup(entry) || entry.children.length > 0 || Boolean(entry.url));
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
                search={search}
                open={
                  openGroups.includes(entry.groupId) ||
                  entry.children.some((child) => isPathActive(child.url, pathname, search)) ||
                  (entry.url ? isPathActive(entry.url, pathname, search) : false)
                }
                onOpenChange={onOpenGroupChange}
              />
            ) : (
              <NavLeafButton key={entry.url} item={entry} pathname={pathname} search={search} />
            ),
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
