import type { ReactNode } from 'react';
import { IconBell, IconLink, IconShieldLock } from '@tabler/icons-react';
import { NavLink } from 'react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@lms/ui/lib/utils';
import { PageHeader, PageShell } from './page-shell';
import '../i18n';

/**
 * Khung KHU CÀI ĐẶT cá nhân (issue #288 — Lão gia chốt 21:29 ngày
 * 26/10/2026 theo research chuẩn site lớn): mọi trang `/settings/*`
 * dùng chung khung này — tiêu đề khu "Cài đặt" + MENU TRÁI theo mục
 * (Bảo mật / Tài khoản liên kết / Thông báo), nội dung của mục đang
 * chọn nằm ở cột phải. Google/GitHub/YouTube đều tổ chức khu cài đặt
 * bằng menu trái như vậy; tab ngang đã bị bác ở quyết này.
 *
 * Flow: route module của từng mục render `SettingsShell` rồi truyền
 * nội dung mục vào `children` — khung không tự nạp dữ liệu nghiệp vụ
 * nào, mỗi thẻ cài đặt bên trong tự chứa (xem `profile-cards.tsx` và
 * trang tuỳ chọn thông báo). Mục đang chọn được `NavLink` đánh dấu
 * bằng `aria-current="page"` + nền nhấn; trên màn hẹp menu trái co
 * thành một hàng ngang cuộn được ở trên nội dung để không chiếm hết
 * bề rộng cột nội dung.
 *
 * Phân biệt tên gọi: khu này là cài đặt CÁ NHÂN của người dùng hiện
 * tại — khác hẳn "Cài đặt hệ thống" (`/admin/site-config`, chỉ admin)
 * đã chốt tên riêng từ 26/10/2026.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation('app');

  /** Ba mục của khu Cài đặt theo đúng thứ tự research chốt: bảo mật là mục đầu (đích redirect của `/settings`). */
  const items = [
    { to: '/settings/security', label: t('settingsSecurity'), icon: IconShieldLock },
    { to: '/settings/linked-accounts', label: t('settingsLinkedAccounts'), icon: IconLink },
    { to: '/settings/notifications', label: t('settingsNotifications'), icon: IconBell },
  ];

  return (
    <PageShell width="medium">
      <PageHeader title={t('settingsTitle')} />
      <div className="flex flex-col gap-4 md:flex-row md:gap-6">
        <nav aria-label={t('settingsTitle')} className="shrink-0 md:w-56">
          <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {items.map((item) => (
              <li key={item.to} className="shrink-0 md:shrink">
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors',
                      'hover:bg-accent hover:text-accent-foreground',
                      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      isActive ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground',
                    )
                  }
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-4 md:gap-6">{children}</div>
      </div>
    </PageShell>
  );
}
