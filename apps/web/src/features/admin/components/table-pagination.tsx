import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { Button } from '@lms/ui/components/button';

/**
 * Chân phân trang của các bảng thuộc feature admin, dựng đúng số đo
 * của bảng mẫu: dòng tóm tắt bên trái (cỡ 14px, màu phụ, không xuống
 * dòng), cụm nút bên phải cách nhau gap-1 — nút số trang là nút vuông
 * size-9 (36px), trang hiện tại nền chính chữ trắng, các trang khác
 * dạng ghost; nút Trước/Sau cao h-9 kèm chevron, nhãn chữ của chúng
 * ẩn ở bề rộng hẹp. Ở bề rộng hẹp và trung bình, hai cụm xếp chồng
 * dọc như chân bảng mẫu thay vì ép ngang. Số trang dài thì giữ trang
 * đầu, trang cuối và ba trang quanh trang hiện tại, khoảng nhảy thay
 * bằng biểu tượng ba chấm ngang — cùng thuật toán với chân bảng dùng
 * chung của app nhưng số đo theo bảng mẫu của các bề mặt vai trò &
 * quyền (nút 36px thay vì 32px). Mọi biểu tượng ở đây là Lucide như
 * toàn bộ bản mẫu.
 *
 * Component chỉ trình bày: trạng thái trang và tổng số dòng do bề
 * mặt chứa giữ (phân trang phía server), component không tự cắt dữ
 * kiện.
 */

/**
 * Danh sách nút số trang: tối đa 7 trang thì liệt kê hết; nhiều hơn
 * thì giữ trang đầu, trang cuối và ba trang quanh trang hiện tại.
 *
 * @param pageCount - Tổng số trang (ít nhất 1).
 * @param current - Chỉ số trang hiện tại, đếm từ 0.
 * @returns Danh sách chỉ số trang và dấu 'ellipsis' chen giữa.
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
 * Chân phân trang kèm dòng tóm tắt khoảng đang hiển thị.
 *
 * @param props - Trang hiện tại (đếm từ 1), tổng số trang, dòng tóm
 * tắt đã dịch, nhãn nút Trước/Sau đã dịch và hàm đổi trang.
 */
export interface TablePaginationProps {
  /** Trang hiện tại, đếm từ 1. */
  page: number;
  /** Tổng số trang (ít nhất 1). */
  pageCount: number;
  /** Dòng tóm tắt đã dịch, ví dụ "Hiển thị 1 đến 10 trong 57 mục". */
  summary: string;
  /** Nhãn nút về trang trước, đã dịch. */
  previousLabel: string;
  /** Nhãn nút sang trang sau, đã dịch. */
  nextLabel: string;
  /** Báo lên bề mặt chứa khi người dùng chọn trang mới (đếm từ 1). */
  onPageChange: (page: number) => void;
}

export function TablePagination({
  page,
  pageCount,
  summary,
  previousLabel,
  nextLabel,
  onPageChange,
}: TablePaginationProps) {
  const current = page - 1;
  const pages = pageNumberList(Math.max(pageCount, 1), current);
  return (
    <div className="flex items-center justify-between gap-3 px-6 py-4 max-sm:flex-col md:max-lg:flex-col">
      <p className="text-sm whitespace-nowrap text-muted-foreground">{summary}</p>
      <nav aria-label="pagination" className="mx-0 w-auto">
        <ul className="flex flex-row items-center gap-1">
          <li>
            <Button
              type="button"
              variant="ghost"
              className="h-9 gap-1.5 px-2.5"
              disabled={current <= 0}
              onClick={() => onPageChange(current)}
            >
              <ChevronLeft className="size-4" />
              <span className="hidden sm:block">{previousLabel}</span>
            </Button>
          </li>
          {pages.map((item, index) =>
            item === 'ellipsis' ? (
              <li key={`ellipsis-${index}`} className="grid size-9 place-items-center">
                <MoreHorizontal aria-hidden className="size-4 text-muted-foreground" />
              </li>
            ) : (
              <li key={item}>
                <Button
                  type="button"
                  variant={item === current ? 'default' : 'ghost'}
                  size="icon"
                  className="size-9"
                  aria-current={item === current ? 'page' : undefined}
                  onClick={() => onPageChange(item + 1)}
                >
                  {item + 1}
                </Button>
              </li>
            ),
          )}
          <li>
            <Button
              type="button"
              variant="ghost"
              className="h-9 gap-1.5 px-2.5"
              disabled={current >= pageCount - 1}
              onClick={() => onPageChange(current + 2)}
            >
              <span className="hidden sm:block">{nextLabel}</span>
              <ChevronRight className="size-4" />
            </Button>
          </li>
        </ul>
      </nav>
    </div>
  );
}
