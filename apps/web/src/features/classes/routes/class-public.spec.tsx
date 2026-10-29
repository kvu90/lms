import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { ClassEditPage } from './class-edit';
import { ClassPublicPage, loader as classPublicLoader, meta as classPublicMeta, type ClassPublicSummary } from './class-public';

/**
 * Spec HỌC PHÍ THEO LỚP phía web (CLASS-3, issue #184): kiểm LUỒNG
 * NGHIỆP VỤ qua endpoint thật (fetch stub ở biên mạng):
 *  - người chưa ghi danh thấy gói + nút thanh toán; bấm mua gọi đúng
 *    POST /payments/class-fee/:classId và hiện mã VietQR/mã thanh toán;
 *  - poll thấy payment succeeded → báo đã vào lớp;
 *  - poll DỪNG hẳn khi payment đã succeeded (không gọi lặp vô thời
 *    hạn theo trạng thái cũ trong state);
 *  - người ĐÃ ghi danh ACTIVE chỉ thấy trạng thái đã ghi danh, KHÔNG
 *    có nút mua (không bị mời mua lại) và không phát sinh payment nào;
 *  - lớp không bật học phí → không có nút mua;
 *  - màn sửa lớp: GV đặt học phí thì PATCH mang feeCost đúng số nguyên
 *    đã nhập.
 * Đổi luật (mời mua lại thành viên, tự ghi danh ở web…) thì ca phải đỏ.
 */
const CLASS_ID = '01900000-0000-7000-8000-0000000000c1';
const PAYMENT_ID = '01900000-0000-7000-8000-0000000000p1'.replace('p', 'f');

const PUBLIC_PACKAGE = {
  classId: CLASS_ID,
  name: 'Lớp 10A1',
  code: '10A1',
  schoolYear: '2026-2027',
  description: 'Lớp toán nâng cao',
  ownerName: 'Lê Cô',
  status: 'active',
  feeCost: 1500000,
  feeCurrency: 'VND',
  feeEnabled: true,
  isMember: false,
  canPurchase: true,
};

const CLASS_VIEW_NO_FEE = {
  id: CLASS_ID,
  tenantId: '01900000-0000-7000-8000-0000000000a1',
  name: 'Lớp 10A1',
  code: '10A1',
  schoolYear: '2026-2027',
  ownerId: '01900000-0000-7000-8000-0000000000b1',
  cohortId: '01900000-0000-7000-8000-0000000000d1',
  allowSelfReport: false,
  joinCode: null,
  joinAutoApprove: false,
  onLeave: 'suspend',
  status: 'active',
  description: '',
  feeCost: null,
  feeCurrency: 'VND',
  feePaymentAccountId: null,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(calls: RecordedCall[], pub: unknown, paymentStatus = 'pending') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/v1/classes/${CLASS_ID}/public`) return respond(pub);
      if (url === `/api/v1/payments/class-fee/${CLASS_ID}` && method === 'POST')
        return respond(
          {
            id: PAYMENT_ID, amount: 1500000, currency: 'VND', status: 'pending', component: 'class_fee',
            itemId: CLASS_ID, paymentCode: 'LMS7K3QX9P2M', vietqrPayload: '0002010102123856PAYLOAD6304XXXX',
          },
          201,
        );
      if (url === `/api/v1/payments/${PAYMENT_ID}`) {
        // Lần poll đầu còn pending, các lần sau succeeded (đối soát đã khớp ở API).
        const polls = calls.filter((c) => c.url === url).length;
        return respond({
          id: PAYMENT_ID, amount: 1500000, currency: 'VND', status: polls > 1 ? paymentStatus : 'pending',
          component: 'class_fee', itemId: CLASS_ID, paymentCode: 'LMS7K3QX9P2M', vietqrPayload: null,
        });
      }
      if (url === `/api/v1/classes/${CLASS_ID}` && method === 'GET') return respond(CLASS_VIEW_NO_FEE);
      if (url === `/api/v1/classes/${CLASS_ID}` && method === 'PATCH')
        return respond({ ...CLASS_VIEW_NO_FEE, feeCost: 2000000 });
      return respond({}, 404);
    }),
  );
}

function renderPublic() {
  localStorage.setItem('lms.accessToken', 'test-token');
  const router = createMemoryRouter([{ path: '/classes/:id/public', element: <ClassPublicPage /> }], {
    initialEntries: [`/classes/${CLASS_ID}/public`],
  });
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Trang công khai mua gói lớp (CLASS-3)', () => {
  it('người chưa ghi danh: thấy học phí, bấm thanh toán → tạo payment class_fee và hiện VietQR + mã thanh toán', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, PUBLIC_PACKAGE);
    renderPublic();

    expect(await screen.findByRole('heading', { name: 'Lớp 10A1' })).toBeTruthy();
    expect(screen.getByText(/1\.500\.000/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Thanh toán học phí' }));

    await waitFor(() => {
      expect(calls.some((c) => c.url === `/api/v1/payments/class-fee/${CLASS_ID}` && c.method === 'POST')).toBe(true);
    });
    expect(await screen.findByText('LMS7K3QX9P2M')).toBeTruthy();
    expect(screen.getByText(/Đang chờ đối soát thanh toán/)).toBeTruthy();
  });

  it('đối soát khớp (payment succeeded) → báo đã vào lớp', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, PUBLIC_PACKAGE, 'succeeded');
    renderPublic();

    await userEvent.click(await screen.findByRole('button', { name: 'Thanh toán học phí' }));
    expect(await screen.findByText(/Thanh toán thành công — bạn đã vào lớp/, undefined, { timeout: 8000 })).toBeTruthy();
  });

  it('poll dừng hẳn sau khi payment succeeded — không còn gọi GET /payments/:id', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, PUBLIC_PACKAGE, 'succeeded');
    renderPublic();

    await userEvent.click(await screen.findByRole('button', { name: 'Thanh toán học phí' }));
    expect(await screen.findByText(/Thanh toán thành công — bạn đã vào lớp/, undefined, { timeout: 8000 })).toBeTruthy();

    const paymentCalls = () => calls.filter((c) => c.url === `/api/v1/payments/${PAYMENT_ID}`).length;
    const settledCount = paymentCalls();
    expect(settledCount).toBeGreaterThan(0);
    // Quá một chu kỳ poll (3 giây): số lần gọi phải đứng yên — poll
    // đã dừng theo trạng thái mới nhất, không chạy vô thời hạn.
    await new Promise((resolve) => setTimeout(resolve, 3400));
    expect(paymentCalls()).toBe(settledCount);
  }, 20000);

  it('người đã ghi danh ACTIVE: chỉ thấy trạng thái đã ghi danh, không có nút mua và không tạo payment', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { ...PUBLIC_PACKAGE, isMember: true, canPurchase: false });
    renderPublic();

    expect(await screen.findByText(/Bạn đã ghi danh lớp này/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Thanh toán học phí' })).toBeNull();
    expect(calls.some((c) => c.url.includes('/payments/class-fee/'))).toBe(false);
  });

  it('lớp không bật học phí: không có nút mua, hiện hướng dẫn liên hệ giáo viên', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { ...PUBLIC_PACKAGE, feeCost: null, feeEnabled: false, canPurchase: false });
    renderPublic();

    expect(await screen.findByText(/không thu học phí qua hệ thống/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Thanh toán học phí' })).toBeNull();
  });
});

const PUBLIC_SUMMARY: ClassPublicSummary = {
  classId: CLASS_ID,
  name: 'Lớp 10A1',
  code: '10A1',
  schoolYear: '2026-2027',
  description: 'Lớp toán nâng cao',
  ownerName: 'Lê Cô',
  status: 'active',
  feeCost: 1500000,
  feeCurrency: 'VND',
  feeEnabled: true,
};

describe('Loader phía server của trang lớp public (HTML đầu mang dữ kiện công khai)', () => {
  it('loader chiếu đúng 10 trường công khai và LOẠI hẳn isMember/canPurchase khỏi kết quả', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify(PUBLIC_PACKAGE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const request = new Request(`http://localhost/classes/${CLASS_ID}/public`, {
      headers: { Cookie: 'better-auth.session_token=phien-thu' },
    });
    const data = await classPublicLoader({ params: { id: CLASS_ID }, request });

    expect(calls).toEqual([`http://127.0.0.1:3000/api/v1/classes/${CLASS_ID}/public`]);
    expect(data.classPublic).toEqual(PUBLIC_SUMMARY);
    expect(data.classPublic !== null && 'isMember' in data.classPublic).toBe(false);
    expect(data.classPublic !== null && 'canPurchase' in data.classPublic).toBe(false);
  });

  it('loader không có cookie phiên: không gọi API nào và trả null (trang tải phía client như trước)', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const data = await classPublicLoader({
      params: { id: CLASS_ID },
      request: new Request(`http://localhost/classes/${CLASS_ID}/public`),
    });
    expect(spy).not.toHaveBeenCalled();
    expect(data.classPublic).toBeNull();
  });

  it('meta dùng tên lớp thật + mô tả công khai khi có dữ kiện loader; không có thì rơi về tiêu đề tĩnh', () => {
    expect(classPublicMeta({ data: { classPublic: PUBLIC_SUMMARY } })).toEqual([
      { title: 'Lớp 10A1 · LMS' },
      { name: 'description', content: 'Lớp toán nâng cao' },
    ]);
    const fallback = classPublicMeta({ data: { classPublic: null } });
    expect(fallback).toHaveLength(1);
    expect(JSON.stringify(fallback)).not.toContain('Lớp 10A1');
  });

  it('query phía client còn pending: trang hiện ngay tên/mô tả lớp từ dữ kiện loader, chưa có nút mua', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === `/api/v1/classes/${CLASS_ID}/public`
          ? new Promise<Response>(() => {})
          : Promise.resolve(new Response('{}', { status: 404 })),
      ),
    );
    localStorage.setItem('lms.accessToken', 'test-token');
    const router = createMemoryRouter(
      [{ path: '/classes/:id/public', element: <ClassPublicPage initialPublic={PUBLIC_SUMMARY} /> }],
      { initialEntries: [`/classes/${CLASS_ID}/public`] },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    expect(screen.getByRole('heading', { name: 'Lớp 10A1' })).toBeTruthy();
    expect(screen.getByText('Lớp toán nâng cao')).toBeTruthy();
    // Trạng thái theo người gọi chưa có dữ kiện: tuyệt đối không hiện
    // nút mua từ bản chiếu công khai.
    expect(screen.queryByRole('button', { name: 'Thanh toán học phí' })).toBeNull();
  });
});

describe('Màn sửa lớp — đặt học phí (CLASS-3)', () => {
  it('GV nhập học phí và lưu → PATCH mang feeCost là số nguyên đã nhập', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, PUBLIC_PACKAGE);
    localStorage.setItem('lms.accessToken', 'test-token');
    const router = createMemoryRouter([{ path: '/classes/:id/edit', element: <ClassEditPage /> }], {
      initialEntries: [`/classes/${CLASS_ID}/edit`],
    });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    const feeInput = await screen.findByLabelText(/Số tiền học phí/);
    await userEvent.type(feeInput, '2000000');
    const saveButtons = screen.getAllByRole('button', { name: 'Lưu thay đổi' });
    await userEvent.click(saveButtons[saveButtons.length - 1]!);

    await waitFor(() => {
      const patch = calls.find((c) => c.url === `/api/v1/classes/${CLASS_ID}` && c.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect((patch!.body as { feeCost: unknown }).feeCost).toBe(2000000);
    });
  });
});
