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

import { Button } from '@lms/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@lms/ui/components/dropdown-menu';
import { Input } from '@lms/ui/components/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@lms/ui/components/table';

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
  /**
   * Dòng chữ khoảng dòng đang hiển thị ở chân bảng (ví dụ "Hiển thị
   * 1–20 trong 57 dòng"). Khi được truyền, chân bảng chuyển sang biến
   * thể khoảng dòng: dòng chữ này thay cho pageInfo và cụm nút chuyển
   * trang LUÔN hiển thị (kể cả khi chỉ có một trang) kèm các nút số
   * trang. Bỏ qua thì chân bảng giữ biến thể mặc định (pageInfo + cụm
   * nút chỉ hiện khi có từ hai trang).
   */
  rangeInfo?: (from: number, to: number, total: number) => string;
}

/**
 * Danh sách nút số trang của cụm phân trang biến thể khoảng dòng:
 * tối đa 7 trang thì liệt kê hết; nhiều hơn thì giữ trang đầu, trang
 * cuối và ba trang quanh trang hiện tại, các khoảng nhảy thay bằng
 * dấu 'ellipsis' để cụm nút không tràn khi số trang lớn.
 */
function pageNumberList(pageCount: number, current: number): (number | 'ellipsis')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i);
  const kept = [...new Set([0, pageCount - 1, current - 1, current, current + 1])]
    .filter((page) => page >= 0 && page < pageCount)
    .sort((a, b) => a - b);
  const list: (number | 'ellipsis')[] = [];
  kept.forEach((page, index) => {
    if (index > 0 && page - kept[index - 1]! > 1) list.push('ellipsis');
    list.push(page);
  });
  return list;
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
 * không tự cắt trang). Tương tự, khi thứ tự dòng do server quyết định
 * theo hợp đồng sắp xếp thì bật manualSorting và giữ trạng thái sắp xếp
 * ở trang gọi (bảng không tự sắp xếp lại trang đơn lẻ — sắp xếp một
 * trang sẽ gây hiểu nhầm là sắp xếp toàn cục). Dữ liệu và cột do trang gọi cung cấp — luôn là
 * dữ liệu thật của vai trò tương ứng; component không biết nghiệp vụ.
 * Chân bảng có hai biến thể do nhãn của trang gọi chọn: mặc định hiện
 * "Trang X / Y" và chỉ bày cụm nút khi có từ hai trang; khi trang gọi
 * truyền nhãn rangeInfo thì hiện khoảng dòng đang hiển thị kèm cụm nút
 * luôn bày (có thêm nút số trang) như các bảng quản trị mẫu.
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
  manualSorting = false,
  sorting: sortingProp,
  onSortingChange,
  rowTestId,
  totalRows,
}: {
  title?: string;
  data: T[];
  columns: DataColumn<T>[];
  labels: DataTableLabels;
  getRowId: (row: T) => string;
  pageSize?: number;
  /**
   * Tổng số dòng khớp toàn cục cho dòng chữ khoảng dòng ở chân bảng
   * (chỉ dùng khi labels.rangeInfo được truyền): bắt buộc truyền ở chế
   * độ manualPagination vì bảng chỉ thấy đúng một trang; ở chế độ client
   * mà bỏ qua thì bảng tự lấy tổng sau lọc từ row model.
   */
  totalRows?: number;
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
  /**
   * Sắp xếp phía server: dữ liệu truyền vào đã được server sắp xếp
   * theo hợp đồng, bảng chỉ giữ trạng thái sắp xếp và báo lên trang
   * gọi qua onSortingChange; id của trạng thái sắp xếp là id cột của
   * trang gọi, trang gọi tự ánh xạ sang tham số hợp đồng của API.
   */
  manualSorting?: boolean;
  /** Trạng thái sắp xếp do trang gọi giữ (bắt buộc khi manualSorting). */
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  /** data-testid cho từng hàng — giữ tay cầm kiểm thử/điều hướng của trang gọi. */
  rowTestId?: (row: T) => string;
}) {
  type AnyRow = Record<string, any>;
  const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = React.useState('');
  const [internalSorting, setInternalSorting] = React.useState<SortingState>([]);
  const sorting = sortingProp ?? internalSorting;
  const handleSortingChange: OnChangeFn<SortingState> = onSortingChange ?? setInternalSorting;
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
    manualSorting,
    pageCount,
    onRowSelectionChange: setRowSelection,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: handleSortingChange,
    onPaginationChange: handlePaginationChange,
  });

  /**
   * Số liệu khoảng dòng cho biến thể chân bảng rangeInfo: tổng toàn
   * cục do trang gọi truyền (phân trang phía server) hoặc lấy từ row
   * model sau lọc (phân trang phía client); khoảng đang hiển thị suy
   * từ vị trí trang và số hàng thật trên trang hiện tại, tổng bằng 0
   * thì khoảng bắt đầu cũng là 0.
   */
  const currentPageIndex = table.state.pagination.pageIndex;
  const totalForRange = totalRows ?? table.getFilteredRowModel().rows.length;
  const rangeFrom = totalForRange === 0 ? 0 : currentPageIndex * table.state.pagination.pageSize + 1;
  const rangeTo = currentPageIndex * table.state.pagination.pageSize + table.getRowModel().rows.length;

  return (
    <div className="flex w-full flex-col gap-4 px-4 lg:px-6">
      {/* Tiêu đề bảng đứng một hàng riêng như mẫu data-table của block:
          trước đây nó chen cùng hàng với ô lọc và nút Cột nên bị ép
          xuống hai dòng trong cột hẹp. */}
      {title ? <h3 className="text-base font-semibold">{title}</h3> : null}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
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
      {/* §5.4: bảng rộng cuộn ngang TRONG khung của nó; cột đầu dính
          trái để tên dòng luôn nhìn thấy khi cuộn (sổ điểm, ma trận). */}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header, headerIndex) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    className={headerIndex === 0 ? 'sticky left-0 z-20 bg-muted' : undefined}
                  >
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
                  {row.getVisibleCells().map((cell, cellIndex) => (
                    <TableCell key={cell.id} className={cellIndex === 0 ? 'sticky left-0 z-10 bg-background' : undefined}>
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">
          {labels.rangeInfo
            ? labels.rangeInfo(rangeFrom, rangeTo, totalForRange)
            : labels.pageInfo(table.state.pagination.pageIndex + 1, Math.max(table.getPageCount(), 1))}
        </div>
        {/* Cụm nút chuyển trang: biến thể mặc định chỉ hiện khi có từ
            hai trang — bảng một trang mà vẫn bày bốn nút vô hiệu
            (đầu/trước/sau/cuối) chỉ gây nhiễu, đúng cách rút gọn của
            mẫu data-table chuẩn. Biến thể khoảng dòng (rangeInfo) thì
            LUÔN hiện kèm nút số trang như các bảng quản trị mẫu: một
            trang vẫn bày cụm nút ở trạng thái tắt để bố cục chân bảng
            ổn định. Hàng chân bảng và chính cụm nút đều cho phép
            xuống dòng (flex-wrap): ở khung nhìn hẹp, khi có nhiều
            trang thì cụm nút tự xuống hàng trong bề rộng khả dụng
            thay vì tràn ngang và bị cắt khuất ở mép thẻ chứa. */}
        {labels.rangeInfo || table.getPageCount() > 1 ? (
          <div className="flex flex-wrap items-center gap-2">
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
            {labels.rangeInfo
              ? pageNumberList(Math.max(table.getPageCount(), 1), currentPageIndex).map((item, index) =>
                  item === 'ellipsis' ? (
                    <span key={`ellipsis-${index}`} className="px-1 text-sm text-muted-foreground">
                      …
                    </span>
                  ) : (
                    <Button
                      key={item}
                      variant={item === currentPageIndex ? 'default' : 'outline'}
                      className="size-8"
                      size="icon"
                      aria-current={item === currentPageIndex ? 'page' : undefined}
                      onClick={() => table.setPageIndex(item)}
                    >
                      {item + 1}
                    </Button>
                  ),
                )
              : null}
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
        ) : null}
      </div>
    </div>
  );
}
