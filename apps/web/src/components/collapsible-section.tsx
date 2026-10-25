import type { ReactNode } from 'react';
import { IconChevronDown } from '@tabler/icons-react';
import { Card, CardDescription, CardHeader, CardTitle, CardContent } from '@lms/ui/components/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@lms/ui/components/collapsible';
import { cn } from '@lms/ui/lib/utils';

/**
 * UI-1: MỘT khuôn collapse/section dùng chung cho toàn web — Card +
 * Collapsible của @lms/ui, trigger full-width có chevron xoay theo
 * trạng thái mở, hover/focus rõ, tiêu đề CardTitle + mô tả
 * CardDescription nhất quán, nội dung trong CollapsibleContent.
 *
 * Trước component này, trang /questions có ba kiểu collapse tự chế
 * khác nhau (nút button trơn trong CardHeader cho các thẻ ngân hàng;
 * CollapsibleTrigger với span font-semibold trơn cho danh mục; lẫn
 * lộn trạng thái mở/đóng) — mọi collapse mới phải dùng khuôn này.
 *
 * Hành vi giữ nguyên theo nơi dùng: component là controlled
 * (open/onOpenChange do trang giữ), nội dung chỉ render khi mở
 * (CollapsibleContent tự gỡ khỏi DOM khi đóng) nên các luồng tải dữ
 * liệu lười khi mở không đổi.
 */
export function CollapsibleSection({
  title,
  description,
  open,
  onOpenChange,
  id,
  className,
  contentClassName,
  paddedContent = true,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Neo id đặt trên Card (vd cho liên kết sâu cuộn tới). */
  id?: string;
  className?: string;
  /** Class cho CardContent khi paddedContent=true (mặc định 'space-y-4'). */
  contentClassName?: string;
  /**
   * true (mặc định): nội dung bọc trong CardContent có padding của
   * Card. false: nội dung tự quản padding (vd DataTable đã có px
   * riêng) — chỉ dùng khi nội dung thật sự cần full-width trong thẻ.
   */
  paddedContent?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <Card id={id} className={className}>
        <CardHeader>
          <CollapsibleTrigger className="group/collapse-trigger flex w-full cursor-pointer items-center justify-between gap-3 rounded-md text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            <span className="flex min-w-0 flex-col gap-1">
              <CardTitle>{title}</CardTitle>
              {description ? <CardDescription>{description}</CardDescription> : null}
            </span>
            <IconChevronDown
              aria-hidden
              className={cn(
                'size-5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover/collapse-trigger:text-foreground',
                open && 'rotate-180',
              )}
            />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          {paddedContent ? (
            <CardContent className={contentClassName ?? 'space-y-4'}>{children}</CardContent>
          ) : (
            children
          )}
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
