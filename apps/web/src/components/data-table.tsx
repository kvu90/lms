import * as React from "react"
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconLayoutColumns,
} from "@tabler/icons-react"
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  FlexRender,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// Bộ tính năng của bảng (TanStack Table v9 khai báo tường minh để
// tree-shake), giữ đúng bộ khung của block dashboard-01.
const features = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
})

/** Định nghĩa một cột theo ngôn ngữ nghiệp vụ của trang gọi, không lộ chi tiết TanStack. */
export interface DataColumn<T extends Record<string, any>> {
  id: string
  header: string
  cell: (row: T) => React.ReactNode
  /** Giá trị để sắp xếp; bỏ qua thì cột không sắp xếp được. */
  sortValue?: (row: T) => string | number
}

/** Các nhãn đã dịch do trang gọi truyền vào — component không chứa chuỗi cứng. */
export interface DataTableLabels {
  columns: string
  previous: string
  next: string
  empty: string
  pageInfo: (page: number, pages: number) => string
}

/**
 * Bảng dữ liệu dùng chung cho trang tổng quan, khung theo block
 * dashboard-01 (thanh công cụ với nút tuỳ biến cột, bảng viền bo góc, chân
 * phân trang). Dữ liệu và cột do trang gọi cung cấp — luôn là dữ liệu thật
 * của vai trò tương ứng; component không biết gì về nghiệp vụ.
 *
 * Chi tiết kiểu: TanStack v9 chỉ suy luận chặt khi mảng cột được bọc qua
 * `columnHelper.columns(...)` với kiểu hàng cụ thể, nên phần nội bộ làm
 * việc trên Record<string, any> và ép ngược về T tại đúng các điểm chạm
 * dữ liệu của trang gọi (accessor, cell, getRowId) — bề mặt props vẫn
 * được kiểm kiểu đầy đủ theo T.
 */
export function DataTable<T extends Record<string, any>>({
  title,
  data,
  columns,
  labels,
  getRowId,
  pageSize = 10,
}: {
  title?: string
  data: T[]
  columns: DataColumn<T>[]
  labels: DataTableLabels
  getRowId: (row: T) => string
  pageSize?: number
}) {
  type AnyRow = Record<string, any>
  const [columnVisibility, setColumnVisibility] =
    React.useState<ColumnVisibilityState>({})
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [pagination, setPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize,
  })

  const tableColumns = React.useMemo(() => {
    const helper = createColumnHelper<typeof features, AnyRow>()
    return helper.columns(
      columns.map((col) =>
        helper.accessor(
          (row: AnyRow): string | number => (col.sortValue ? col.sortValue(row as T) : ""),
          {
            id: col.id,
            header: col.header,
            enableSorting: Boolean(col.sortValue),
            cell: (info) => col.cell(info.row.original as T),
          },
        ),
      ),
    )
  }, [columns])

  const table = useTable({
    features,
    data: data as AnyRow[],
    columns: tableColumns,
    state: { columnVisibility, rowSelection, columnFilters, sorting, pagination },
    getRowId: (row) => getRowId(row as T),
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
  })

  return (
    <div className="flex w-full flex-col gap-4 px-4 lg:px-6">
      <div className="flex items-center justify-between">
        {title ? <h3 className="text-base font-semibold">{title}</h3> : <span />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <IconLayoutColumns />
              <span className="hidden lg:inline">{labels.columns}</span>
              <IconChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {table
              .getAllColumns()
              .filter((column) => column.getCanHide())
              .map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  className="capitalize"
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {columns.find((c) => c.id === column.id)?.header ?? column.id}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} colSpan={header.colSpan}>
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-2 h-8"
                        onClick={() =>
                          header.column.toggleSorting(
                            header.column.getIsSorted() === "asc",
                          )
                        }
                      >
                        <FlexRender header={header} />
                      </Button>
                    ) : (
                      <FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {labels.empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">
          {labels.pageInfo(
            table.state.pagination.pageIndex + 1,
            Math.max(table.getPageCount(), 1),
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="hidden size-8 lg:flex"
            size="icon"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">{labels.previous}</span>
            <IconChevronsLeft />
          </Button>
          <Button
            variant="outline"
            className="size-8"
            size="icon"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">{labels.previous}</span>
            <IconChevronLeft />
          </Button>
          <Button
            variant="outline"
            className="size-8"
            size="icon"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">{labels.next}</span>
            <IconChevronRight />
          </Button>
          <Button
            variant="outline"
            className="hidden size-8 lg:flex"
            size="icon"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">{labels.next}</span>
            <IconChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  )
}
