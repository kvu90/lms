import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHeader, PageShell } from '#components/page-shell';

/**
 * Spec cho khung trang dùng chung — viết lại theo rà soát #219: chỉ khẳng
 * định HÀNH VI người dùng thấy được (nội dung được dựng trong khung; mẫu
 * tiêu đề trang dựng đủ tiêu đề/mô tả/hành động). Thang bề rộng và các lớp
 * CSS cụ thể (max-w-*, padding...) là chi tiết triển khai của hệ thiết kế:
 * đổi bậc cap hay nhịp padding vô hại không được làm đỏ spec này — các ca
 * khẳng định class đã bỏ.
 */

afterEach(() => {
  cleanup();
});

describe('PageShell — khung của trang', () => {
  it('dựng nội dung con trong khung trang', () => {
    render(
      <PageShell>
        <p>nội dung</p>
      </PageShell>,
    );
    expect(screen.getByText('nội dung')).toBeInTheDocument();
  });

  it('dựng nội dung con ở mọi bậc bề rộng mà không mất nội dung', () => {
    for (const width of ['narrow', 'medium', 'wide', 'full'] as const) {
      const { unmount } = render(
        <PageShell width={width}>
          <p>{`nội dung ${width}`}</p>
        </PageShell>,
      );
      expect(screen.getByText(`nội dung ${width}`)).toBeInTheDocument();
      unmount();
    }
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
