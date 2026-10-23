import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@lms/ui/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@lms/ui/components/ui/chart"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@lms/ui/components/ui/toggle-group"

/** Một điểm dữ liệu của biểu đồ: trục hoành là nhãn, giá trị nằm ở khoá `value`. */
export interface ChartPoint {
  label: string
  value: number
}

/** Một lựa chọn khoảng hiển thị: giữ `count` điểm cuối của chuỗi. */
export interface ChartRange {
  value: string
  label: string
  count: number
}

/**
 * Biểu đồ vùng tương tác theo block dashboard-01 (Recharts AreaChart trong
 * ChartContainer, có chuyển khoảng hiển thị ở góc phải header). Chuỗi số
 * được truyền từ trang gọi — là dữ liệu thật của API (người dùng mới theo
 * tuần, phân bố điểm, sự kiện theo ngày); khi chuỗi rỗng component hiện
 * dòng trạng thái trống đã dịch thay vì vẽ biểu đồ giả.
 */
export function ChartAreaInteractive({
  title,
  description,
  seriesLabel,
  emptyText,
  data,
  ranges,
}: {
  title: string
  description: string
  seriesLabel: string
  emptyText: string
  data: ChartPoint[]
  ranges?: ChartRange[]
}) {
  const [range, setRange] = React.useState<string>(ranges?.[ranges.length - 1]?.value ?? "")
  const activeRange = ranges?.find((r) => r.value === range) ?? ranges?.[ranges.length - 1]
  const visible = activeRange ? data.slice(-activeRange.count) : data
  const config: ChartConfig = {
    value: { label: seriesLabel, color: "var(--primary)" },
  }
  return (
    <div className="px-4 lg:px-6">
      <Card className="@container/card">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
          {ranges && ranges.length > 1 ? (
            <CardAction>
              <ToggleGroup
                type="single"
                value={activeRange?.value}
                onValueChange={(v) => {
                  if (v) setRange(v)
                }}
                variant="outline"
                className="hidden *:data-[slot=toggle-group-item]:px-3 @[767px]/card:flex"
              >
                {ranges.map((r) => (
                  <ToggleGroupItem key={r.value} value={r.value}>
                    {r.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
          {visible.length === 0 ? (
            <p className="text-muted-foreground py-10 text-center text-sm">{emptyText}</p>
          ) : (
            <ChartContainer config={config} className="aspect-auto h-[250px] w-full">
              <AreaChart data={visible}>
                <defs>
                  <linearGradient id="dashboardChartFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0.1} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                />
                <YAxis tickLine={false} axisLine={false} tickMargin={8} allowDecimals={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
                <Area
                  dataKey="value"
                  type="monotone"
                  fill="url(#dashboardChartFill)"
                  stroke="var(--color-value)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
