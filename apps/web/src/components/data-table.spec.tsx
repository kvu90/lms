import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { DataTable, type DataColumn } from '#components/data-table';

/**
 * Spec của bảng dữ liệu dùng chung: ghim bốn cơ chế mà TanStack Table
 * phải gánh cho mọi bảng của app — sắp xếp theo cột, lọc toàn bảng qua
 * ô lọc ở thanh công cụ, phân trang, và ẩn/hiện cột qua menu Cột —
 * để không trang nào phải tự chế lại logic bảng. Kèm hai biến thể chân
 * bảng: mặc định hiện "Trang X / Y" và ẩn cụm nút khi chỉ có một
 * trang; biến thể khoảng dòng (trang gọi truyền rangeInfo) hiện
 * khoảng dòng đang hiển thị và luôn bày cụm nút kèm nút số trang.
 * Kèm ca hồi quy chống tràn ở màn hẹp: với 7 trang, hàng chân bảng
 * và cụm nút phải mang class cho phép xuống dòng để không nút nào
 * bị cắt khuất khỏi bề rộng khả dụng.
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

/** Nhãn của biến thể chân bảng khoảng dòng: thêm rangeInfo vào bộ nhãn mặc định. */
const RANGE_LABELS = {
  ...LABELS,
  rangeInfo: (from: number, to: number, total: number) => `Hiển thị ${from}–${to} trong ${total} dòng`,
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
    // Chỉ một trang thì cụm nút chuyển trang ẩn hẳn, không bày các nút
    // Trước/Sau vô hiệu như trước.
    expect(screen.queryAllByRole('button', { name: 'Sau' })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'Trước' })).toHaveLength(0);
  });

  it('biến thể khoảng dòng: chỉ một trang vẫn hiện cụm nút kèm nút số trang ở trạng thái tắt', () => {
    render(
      <DataTable
        title="Bảng điểm"
        data={ROWS.slice(0, 5)}
        columns={COLUMNS}
        labels={RANGE_LABELS}
        getRowId={(r) => r.id}
      />,
    );
    // Dòng khoảng dòng thay cho "Trang X / Y" của biến thể mặc định.
    expect(screen.getByText('Hiển thị 1–5 trong 5 dòng')).toBeInTheDocument();
    expect(screen.queryByText('Trang 1 / 1')).not.toBeInTheDocument();
    // Khác biến thể mặc định (ẩn cụm nút khi một trang): nút số trang 1
    // vẫn bày và các nút Trước/Sau ở trạng thái tắt.
    expect(screen.getByRole('button', { name: '1' })).toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: 'Sau' })) {
      expect(button).toBeDisabled();
    }
    for (const button of screen.getAllByRole('button', { name: 'Trước' })) {
      expect(button).toBeDisabled();
    }
  });

  it('biến thể khoảng dòng: bấm nút số trang nhảy thẳng tới trang đó và khoảng dòng cập nhật theo', async () => {
    const { container } = render(
      <DataTable title="Bảng điểm" data={ROWS} columns={COLUMNS} labels={RANGE_LABELS} getRowId={(r) => r.id} />,
    );
    expect(screen.getByText('Hiển thị 1–10 trong 25 dòng')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '3' }));

    expect(bodyRows(container)).toHaveLength(5);
    expect(screen.getByText('Hiển thị 21–25 trong 25 dòng')).toBeInTheDocument();
    expect(screen.getByText('Học viên 21')).toBeInTheDocument();
  });

  it('biến thể khoảng dòng: 7 trang vẫn bày đủ nút số trang và hàng chân bảng cùng cụm nút mang class cho phép xuống dòng để không tràn ở màn hẹp', () => {
    const rows65: Row[] = Array.from({ length: 65 }, (_, i) => ({
      id: `r${i + 1}`,
      name: `Học viên ${String(i + 1).padStart(2, '0')}`,
      score: (i * 7) % 100,
    }));
    render(
      <DataTable
        title="Bảng điểm"
        data={rows65}
        columns={COLUMNS}
        labels={RANGE_LABELS}
        getRowId={(r) => r.id}
        totalRows={65}
      />,
    );
    // 65 dòng ở cỡ trang 10 cho đúng 7 trang: khoảng dòng hiện tổng 65
    // và đủ 7 nút số trang cùng các nút Trước/Sau — không nút nào bị
    // lược khỏi cụm phân trang.
    expect(screen.getByText('Hiển thị 1–10 trong 65 dòng')).toBeInTheDocument();
    for (const page of ['1', '2', '3', '4', '5', '6', '7']) {
      expect(screen.getByRole('button', { name: page })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('button', { name: 'Trước' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Sau' }).length).toBeGreaterThan(0);
    // Ghim cơ chế chống tràn: hàng chân bảng và cụm nút phân trang đều
    // mang class cho phép xuống dòng. jsdom không có engine bố cục nên
    // ca này chỉ ghim cơ chế class, không khẳng định số đo px thật —
    // bề rộng ở khung nhìn 320/360 px được kiểm ở nghiệm thu trình
    // duyệt, không bịa số đo tại đây.
    const footerRow = screen.getByText('Hiển thị 1–10 trong 65 dòng').parentElement;
    expect(footerRow?.className).toContain('flex-wrap');
    expect(footerRow?.className).toContain('gap-2');
    const paginationCluster = screen.getByRole('button', { name: '1' }).parentElement;
    expect(paginationCluster?.className).toContain('flex-wrap');
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
