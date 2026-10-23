import * as React from 'react';
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconLayoutColumns,
} from '@tabler/icons-react';
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  FlexRender,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type OnChangeFn,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';

import { Button } from '@lms/ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@lms/ui/components/ui/dropdown-menu';
import { Input } from '@lms/ui/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@lms/ui/components/ui/table';

// Bộ tính năng của bảng (TanStack Table v9 khai báo tường minh để
// tree-shake), giữ đúng bộ khung của block dashboard-01 và hướng dẫn
// data-table chính thức của shadcn: sắp xếp, lọc theo cột, lọc toàn
// bảng, ẩn/hiện cột, phân trang, chọn hàng — kèm các hàm lọc/sắp xếp
// tích hợp mà cột dựa vào (includesString cho lọc, text/alphanumeric
// cho sắp xếp chuỗi).
const features = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
});

/** Định nghĩa một cột theo ngôn ngữ nghiệp vụ của trang gọi, không lộ chi tiết TanStack. */
export interface DataColumn<T extends Record<string, any>> {
  id: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  /** Giá trị để sắp xếp; bỏ qua thì cột không sắp xếp được. */
  sortValue?: (row: T) => string | number;
  /**
   * Chuỗi đại diện của hàng cho bộ lọc toàn bảng (ô lọc ở thanh công
   * cụ quét qua giá trị này của mọi cột); bỏ qua thì dùng sortValue.
   */
  filterValue?: (row: T) => string;
}

/** Các nhãn đã dịch do trang gọi truyền vào — component không chứa chuỗi cứng. */
export interface DataTableLabels {
  columns: string;
  previous: string;
  next: string;
  empty: string;
  pageInfo: (page: number, pages: number) => string;
  /** Placeholder của ô lọc toàn bảng; bỏ qua thì không hiện ô lọc (ví dụ bảng lọc phía server). */
  filterPlaceholder?: string;
}

/**
 * Bảng dữ liệu dùng chung của toàn app (trang tổng quan, quản trị người
 * dùng, ngân hàng câu hỏi, sổ điểm, ma trận vai trò…), khung theo block
 * dashboard-01 và hướng dẫn data-table chính thức của shadcn: thanh công
 * cụ có ô lọc toàn bảng + nút tuỳ biến cột, bảng viền bo góc, chân phân
 * trang. Mọi cơ chế bảng (sắp xếp, lọc, ẩn/hiện cột, phân trang, chọn
 * hàng) do TanStack Table đảm nhiệm — không trang nào tự chế lại. Hai
 * chế độ dữ liệu: mặc định trang gọi đưa toàn bộ hàng và bảng tự sắp
 * xếp/lọc/phân trang phía client; khi dữ liệu đã phân trang phía server
 * thì bật manualPagination và giữ trạng thái trang ở trang gọi (bảng
 * không tự cắt trang). Dữ liệu và cột do trang gọi cung cấp — luôn là
 * dữ liệu thật của vai trò tương ứng; component không biết nghiệp vụ.
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
  manualPagination = false,
  pageCount,
  pagination: paginationProp,
  onPaginationChange,
  rowTestId,
}: {
  title?: string;
  data: T[];
  columns: DataColumn<T>[];
  labels: DataTableLabels;
  getRowId: (row: T) => string;
  pageSize?: number;
  /**
   * Phân trang phía server: dữ liệu truyền vào đã là đúng một trang,
   * bảng chỉ giữ trạng thái trang và báo lên trang gọi qua
   * onPaginationChange; tổng số trang lấy từ pageCount.
   */
  manualPagination?: boolean;
  /** Tổng số trang khi manualPagination (suy từ tổng bản ghi phía server). */
  pageCount?: number;
  /** Trạng thái phân trang do trang gọi giữ (bắt buộc khi manualPagination). */
  pagination?: PaginationState;
  onPaginationChange?: OnChangeFn<PaginationState>;
  /** data-testid cho từng hàng — giữ tay cầm kiểm thử/điều hướng của trang gọi. */
  rowTestId?: (row: T) => string;
}) {
  type AnyRow = Record<string, any>;
  const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = React.useState('');
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [internalPagination, setInternalPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize,
  });
  const pagination = paginationProp ?? internalPagination;
  const handlePaginationChange: OnChangeFn<PaginationState> = onPaginationChange ?? setInternalPagination;

  /**
   * Định nghĩa cột phải ỔN ĐỊNH danh tính giữa các lần render. Trang
   * gọi thường khai cột ngay trong thân component nên mảng cột là một
   * object mới sau mỗi lần render; nếu dựng lại cột theo nó, TanStack
   * dựng lại toàn bộ ô và phần tử tương tác trong ô (checkbox chọn câu
   * hỏi, nút thao tác) bị thay node giữa chừng — sự kiện click/change
   * rơi vào node đã rời cây khiến handler của trang không bao giờ chạy
   * (đã gặp thật ở ngân hàng câu hỏi). Vì vậy bảng chỉ dựng lại cột khi
   * tập (id + tiêu đề) thay đổi, còn nội dung ô và hàm tính giá trị
   * luôn đọc bản cột mới nhất qua ref.
   */
  const columnsRef = React.useRef(columns);
  columnsRef.current = columns;
  const columnSignature = columns.map((col) => `${col.id}:${col.header}`).join('|');
  const tableColumns = React.useMemo(() => {
    const helper = createColumnHelper<typeof features, AnyRow>();
    return helper.columns(
      columns.map((col) =>
        helper.accessor(
          (row: AnyRow): string | number => {
            const latest = columnsRef.current.find((c) => c.id === col.id);
            return latest?.filterValue
              ? latest.filterValue(row as T)
              : latest?.sortValue
                ? latest.sortValue(row as T)
                : '';
          },
          {
            id: col.id,
            header: col.header,
            enableSorting: Boolean(col.sortValue),
            cell: (info) => {
              const latest = columnsRef.current.find((c) => c.id === col.id);
              return latest ? latest.cell(info.row.original as T) : null;
            },
          },
        ),
      ),
    );
    // Phụ thuộc có chủ đích vào chữ ký cột — xem ghi chú phía trên.
  }, [columnSignature]);

  const table = useTable({
    features,
    data: data as AnyRow[],
    columns: tableColumns,
    state: { columnVisibility, rowSelection, columnFilters, globalFilter, sorting, pagination },
    getRowId: (row) => getRowId(row as T),
    enableRowSelection: true,
    manualPagination,
    pageCount,
    onRowSelectionChange: setRowSelection,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    onPaginationChange: handlePaginationChange,
  });

  return (
    <div className="flex w-full flex-col gap-4 px-4 lg:px-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {title ? <h3 className="text-base font-semibold">{title}</h3> : null}
          {labels.filterPlaceholder ? (
            <Input
              aria-label={labels.filterPlaceholder}
              placeholder={labels.filterPlaceholder}
              value={globalFilter}
              onChange={(event) => table.setGlobalFilter(event.target.value)}
              className="max-w-sm"
            />
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            <IconLayoutColumns />
            <span className="hidden lg:inline">{labels.columns}</span>
            <IconChevronDown />
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
          <TableHeader className="sticky top-0 z-10 bg-muted">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} colSpan={header.colSpan}>
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-2 h-8"
                        onClick={() => header.column.toggleSorting(header.column.getIsSorted() === 'asc')}
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
                <TableRow key={row.id} data-testid={rowTestId?.(row.original as T)}>
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
          {labels.pageInfo(table.state.pagination.pageIndex + 1, Math.max(table.getPageCount(), 1))}
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
  );
}
