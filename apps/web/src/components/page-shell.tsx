import * as React from 'react';

import { cn } from '@lms/ui/lib/utils';

/**
 * Bậc bề rộng nội dung chuẩn của khung trang (hồ sơ UI/UX §3.1): màn ít
 * thông tin (đọc, form một cột, cài đặt) đứng ở cột 768px; màn nhiều
 * thông tin hơn nới dần; bảng dày/workspace/chat dùng toàn bề rộng.
 */
export type PageWidth = 'narrow' | 'medium' | 'wide' | 'full';

const WIDTH_CLASSES: Record<PageWidth, string> = {
  narrow: 'mx-auto w-full max-w-3xl',
  medium: 'mx-auto w-full max-w-5xl',
  wide: 'mx-auto w-full max-w-7xl',
  full: 'w-full',
};

/**
 * Khung trang dùng chung cho mọi màn đã đăng nhập (hồ sơ UI/UX §5.1),
 * thay chuỗi wrapper full-width sao chép tay trước đây
 * (`<main className="@container/main flex flex-1 flex-col gap-4 px-4 …">`).
 * Lớp ngoài giữ nhịp padding/khoảng cách hiện tại và `@container/main`
 * cho các truy vấn container trong trang; lớp trong áp cap bề rộng theo
 * bậc. Biến thể `fillHeight` dành cho màn ứng dụng đầy chiều cao (chat):
 * trang không cuộn, các cột con tự cuộn riêng.
 */
export function PageShell({
  width = 'full',
  fillHeight = false,
  className,
  contentClassName,
  children,
  ...props
}: React.ComponentProps<'main'> & {
  width?: PageWidth;
  fillHeight?: boolean;
  contentClassName?: string;
}) {
  return (
    <main
      data-slot="page-shell"
      data-width={width}
      className={cn(
        '@container/main flex flex-1 flex-col px-4 py-4 md:py-6 lg:px-6',
        fillHeight && 'min-h-0',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'flex flex-col gap-4 md:gap-6',
          WIDTH_CLASSES[width],
          fillHeight && 'min-h-0 flex-1',
          contentClassName,
        )}
      >
        {children}
      </div>
    </main>
  );
}

/**
 * Mẫu tiêu đề đầu trang (hồ sơ UI/UX §5.1): tiêu đề + mô tả một dòng +
 * cụm hành động bên phải (một nút chính, tối đa một nút phụ — caller
 * truyền vào qua `actions`); trên mobile cụm hành động xuống dòng dưới
 * tiêu đề. `SiteHeader` vẫn giữ vai trò tên trang rút gọn ở header chung.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      data-slot="page-header"
      className={cn('flex flex-col gap-4 md:flex-row md:items-start md:justify-between', className)}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
