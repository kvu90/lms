import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { DataTable, type DataColumn } from './data-table';

/**
 * Spec của bảng dữ liệu dùng chung: ghim bốn cơ chế mà TanStack Table
 * phải gánh cho mọi bảng của app — sắp xếp theo cột, lọc toàn bảng qua
 * ô lọc ở thanh công cụ, phân trang, và ẩn/hiện cột qua menu Cột —
 * để không trang nào phải tự chế lại logic bảng.
 */

interface Row {
  id: string;
  name: string;
  score: number;
}

const ROWS: Row[] = Array.from({ length: 25 }, (_, i) => ({
  id: `r${i + 1}`,
  name: `Học viên ${String(i + 1).padStart(2, '0')}`,
  score: (i * 7) % 100,
}));

const COLUMNS: DataColumn<Row>[] = [
  {
    id: 'name',
    header: 'Họ tên',
    cell: (row) => row.name,
    sortValue: (row) => row.name,
    filterValue: (row) => row.name,
  },
  {
    id: 'score',
    header: 'Điểm',
    cell: (row) => row.score,
    sortValue: (row) => row.score,
  },
];

const LABELS = {
  columns: 'Cột',
  previous: 'Trước',
  next: 'Sau',
  empty: 'Chưa có dữ liệu.',
  pageInfo: (page: number, pages: number) => `Trang ${page} / ${pages}`,
  filterPlaceholder: 'Lọc trong bảng…',
};

function renderTable() {
  return render(<DataTable title="Bảng điểm" data={ROWS} columns={COLUMNS} labels={LABELS} getRowId={(r) => r.id} />);
}

function bodyRows(container: HTMLElement) {
  return [...container.querySelectorAll('tbody tr')];
}

afterEach(() => {
  cleanup();
});

describe('DataTable (TanStack Table)', () => {
  it('phân trang: trang đầu 10 hàng, nút Sau chuyển trang và cập nhật thông tin trang', async () => {
    const { container } = renderTable();
    expect(bodyRows(container)).toHaveLength(10);
    expect(screen.getByText('Trang 1 / 3')).toBeInTheDocument();

    // Hai nút cùng nhãn trợ năng "Sau" (trang kế và trang cuối, theo
    // đúng mẫu block); nút trang kế đứng trước trong DOM.
    await userEvent.click(screen.getAllByRole('button', { name: 'Sau' })[0]!);

    expect(bodyRows(container)).toHaveLength(10);
    expect(screen.getByText('Trang 2 / 3')).toBeInTheDocument();
    expect(screen.getByText('Học viên 11')).toBeInTheDocument();
  });

  it('sắp xếp: bấm tiêu đề cột Điểm đổi thứ tự tăng/giảm', async () => {
    const { container } = renderTable();
    const firstCellText = () => bodyRows(container)[0]?.querySelectorAll('td')[1]?.textContent;

    await userEvent.click(screen.getByRole('button', { name: 'Điểm' }));
    // Điểm nhỏ nhất trong dữ liệu là 0 (hàng r1: (0*7)%100).
    expect(firstCellText()).toBe('0');

    await userEvent.click(screen.getByRole('button', { name: 'Điểm' }));
    // Điểm lớn nhất là 98 ((14*7)%100).
    expect(firstCellText()).toBe('98');
  });

  it('lọc toàn bảng: ô lọc thu hẹp hàng theo chuỗi khớp và tính lại số trang', async () => {
    const { container } = renderTable();
    await userEvent.type(screen.getByPlaceholderText('Lọc trong bảng…'), 'Học viên 2');

    const rows = bodyRows(container);
    // Khớp "Học viên 20".."Học viên 25" = 6 hàng, một trang ("Học
    // viên 02" không chứa chuỗi con "Học viên 2").
    expect(rows).toHaveLength(6);
    expect(screen.getByText('Trang 1 / 1')).toBeInTheDocument();
    expect(screen.getByText('Học viên 25')).toBeInTheDocument();
  });

  it('ẩn/hiện cột: bỏ chọn một cột trong menu Cột thì cột biến mất khỏi bảng', async () => {
    const { container } = renderTable();
    await userEvent.click(screen.getByRole('button', { name: /Cột/ }));
    const menu = await screen.findByRole('menu');
    await userEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Điểm' }));

    expect(screen.queryByRole('button', { name: 'Điểm' })).not.toBeInTheDocument();
    expect(container.querySelectorAll('thead th')).toHaveLength(1);
  });
});
