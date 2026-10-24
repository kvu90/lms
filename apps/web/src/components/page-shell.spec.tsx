import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHeader, PageShell, type PageWidth } from './page-shell';

/**
 * Spec cho khung trang dùng chung (Lát 0 của hồ sơ UI/UX): PageShell áp
 * đúng cap bề rộng của từng bậc trong thang 4 bậc (narrow 768 / medium
 * 1024 / wide 1280 / full không cap) và giữ nhịp padding chuẩn; biến
 * thể đầy chiều cao (chat) khoá cuộn trang; PageHeader dựng tiêu đề,
 * mô tả và cụm hành động đúng mẫu.
 */

afterEach(() => {
  cleanup();
});

const WIDTH_CASES: Array<{ width: PageWidth; capClass: string | null }> = [
  { width: 'narrow', capClass: 'max-w-3xl' },
  { width: 'medium', capClass: 'max-w-5xl' },
  { width: 'wide', capClass: 'max-w-7xl' },
  { width: 'full', capClass: null },
];

describe('PageShell — thang bề rộng 4 bậc', () => {
  it.each(WIDTH_CASES)('bậc $width áp đúng lớp cap', ({ width, capClass }) => {
    const { container } = render(
      <PageShell width={width}>
        <p>nội dung</p>
      </PageShell>,
    );
    const shell = container.querySelector('[data-slot="page-shell"]');
    expect(shell).not.toBeNull();
    expect(shell).toHaveAttribute('data-width', width);
    // Nhịp padding chuẩn giữ nguyên ở mọi bậc.
    expect(shell).toHaveClass('px-4', 'py-4', 'md:py-6', 'lg:px-6');
    const inner = shell!.firstElementChild;
    expect(inner).not.toBeNull();
    if (capClass) {
      expect(inner).toHaveClass(capClass, 'mx-auto', 'w-full');
    } else {
      expect(inner).toHaveClass('w-full');
      expect(inner!.className).not.toMatch(/max-w-/);
    }
    expect(screen.getByText('nội dung')).toBeInTheDocument();
  });

  it('mặc định là bậc full (không cap) khi không truyền width', () => {
    const { container } = render(
      <PageShell>
        <p>nội dung</p>
      </PageShell>,
    );
    const shell = container.querySelector('[data-slot="page-shell"]');
    expect(shell).toHaveAttribute('data-width', 'full');
    expect(shell!.firstElementChild!.className).not.toMatch(/max-w-/);
  });

  it('biến thể fillHeight khoá cuộn trang cho màn đầy chiều cao', () => {
    const { container } = render(
      <PageShell width="full" fillHeight>
        <p>chat</p>
      </PageShell>,
    );
    const shell = container.querySelector('[data-slot="page-shell"]');
    expect(shell).toHaveClass('min-h-0');
    expect(shell!.firstElementChild).toHaveClass('min-h-0', 'flex-1');
  });
});

describe('PageHeader — mẫu tiêu đề trang', () => {
  it('dựng tiêu đề, mô tả và cụm hành động', () => {
    render(
      <PageHeader
        title="Hồ sơ"
        description="Thông tin cá nhân và bảo mật tài khoản."
        actions={<button type="button">Lưu</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Hồ sơ' })).toBeInTheDocument();
    expect(screen.getByText('Thông tin cá nhân và bảo mật tài khoản.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lưu' })).toBeInTheDocument();
  });

  it('không có mô tả/hành động thì chỉ dựng tiêu đề', () => {
    const { container } = render(<PageHeader title="Tổng quan" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Tổng quan' })).toBeInTheDocument();
    expect(container.querySelector('[data-slot="page-header"]')!.children).toHaveLength(1);
  });
});
