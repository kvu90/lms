import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Skeleton } from '@lms/ui/components/skeleton';

/** Một thẻ thống kê: nhãn, giá trị lớn và dòng chú thích phụ — tất cả từ dữ liệu thật. */
export interface StatCard {
  id: string;
  label: string;
  value: string;
  footer?: string;
  /**
   * Đang chờ dữ liệu: thẻ vẫn chiếm đúng ô của nó trong lưới với nhãn
   * thật và khung xương ở phần giá trị/chú thích, để lưới không co giãn
   * khi số liệu về (giữ hình học, tránh nhảy bố cục).
   */
  loading?: boolean;
}

/**
 * Hàng thẻ thống kê theo đúng trình bày của block dashboard-01 (nền
 * gradient, giá trị lớn dạng tabular-nums, chú thích hai lớp ở chân thẻ).
 * Khác block mẫu ở dữ liệu: thẻ nào không có số liệu thật thì trang gọi
 * không truyền vào — component không tự bịa số hay phần trăm xu hướng.
 */
export function SectionCards({ cards }: { cards: StatCard[] }) {
  if (cards.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      {cards.map((card) => (
        <Card key={card.id} className="@container/card" data-testid={`stat-card-${card.id}`}>
          <CardHeader>
            <CardDescription>{card.label}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {card.loading ? <Skeleton className="h-8 w-20" /> : card.value}
            </CardTitle>
          </CardHeader>
          {card.loading ? (
            <CardFooter className="flex-col items-start gap-1.5 text-sm">
              <Skeleton className="h-4 w-28" />
            </CardFooter>
          ) : card.footer ? (
            <CardFooter className="flex-col items-start gap-1.5 text-sm">
              <div className="text-muted-foreground">{card.footer}</div>
            </CardFooter>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
