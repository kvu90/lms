import { describe, expect, it } from 'vitest';
import type { OutboxEventInput, OutboxWriterService } from './outbox-writer.service';
import type { PaymentRow, PaymentsRepository, ProviderEventRow } from './payments.repository';
import type { PlanEntitlementsService } from './plan-entitlements.service';
import { SepayMatchingService } from './sepay-matching.service';
import type {
  PaidClassEnrolActivationPort,
  PaidEnrolActivationPort,
  PaymentSettlementPort,
} from './sepay-matching-ports';

/**
 * Test đặc trưng hoá luồng matching IPN SePay (issue #538).
 *
 * Các ca này ghim HÀNH VI HIỆN TẠI của `SepayMatchingService` tại
 * thời điểm trích xuất service từ apps/api sang package dùng chung
 * `@lms/payments` — chúng là mốc đối chiếu để việc trích xuất chứng
 * minh bảo toàn hành vi, và là đặc tả thực thi của các luật đã ghi
 * trong docblock của service:
 *
 * - Luật khớp 3 điều kiện (mã thanh toán, số tiền, tài khoản nhận)
 *   cộng payment còn `pending` và chưa hết hạn, cộng phép đối chiếu
 *   đích phía server (issue #419) TRƯỚC khi kích hoạt bất cứ quyền
 *   lợi nào.
 * - Bất biến đồng bộ của nhịp chốt: kích hoạt MỌI quyền lợi TRƯỚC
 *   nhịp lật payment sang `succeeded`, rồi mới phát đúng outbox
 *   `payment_succeeded` và chốt sự kiện `matched` — thứ tự này được
 *   ghim bằng nhật ký thứ tự gọi chung của các bản giả.
 * - Thiếu bất kỳ điều kiện nào: payment còn `pending` chuyển
 *   `needs_review`, sự kiện chuyển `needs_review`, KHÔNG kích hoạt
 *   gì và KHÔNG phát outbox.
 * - Sự kiện `debit` uỷ thác trọn cho cổng xác nhận chi hoàn, không
 *   đi đường khớp tiền về.
 * - Hoàn tất idempotent: payment đã `succeeded` bởi chính giao dịch
 *   này thì chỉ chốt sự kiện, không kích hoạt lại.
 *
 * Tầng dữ liệu và các cổng được thay bằng bản giả ghi lại lời gọi —
 * hành vi đầu-cuối trên DB thật do các suite e2e payments của
 * apps/api ghim (vietqr, class-fee, coupons-slots, entitlement-gate,
 * plans, refund-lifecycle, webhook-verify).
 */

const PAYMENT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const EVENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ACCOUNT_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const TENANT_ID = '9a7b4d2e-5f36-4a1e-b28c-3d5e7f90a1b2';
const USER_ID = 'b3f7c21d-8a4e-4c5d-9e62-1f0a2b3c4d5e';
const ITEM_ID = 'c4a8d32e-9b5f-4d6e-af73-2a1b3c4d5e6f';

/** Payment `enrol_fee` đang `pending`, khớp mẫu với sự kiện tiền về chuẩn. */
function makePayment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: PAYMENT_ID,
    accountId: ACCOUNT_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    amount: 500_000,
    currency: 'VND',
    status: 'pending',
    gateway: 'sepay',
    externalTransactionId: null,
    component: 'enrol_fee',
    itemId: ITEM_ID,
    paymentCode: 'LMSABC123',
    expiresAt: null,
    reviewDecision: null,
    reviewReason: null,
    reviewHandledBy: null,
    reviewHandledAt: null,
    data: null,
    createdAt: new Date('2026-10-29T00:00:00Z'),
    updatedAt: new Date('2026-10-29T00:00:00Z'),
    ...overrides,
  };
}

/** Sự kiện tiền về SePay chuẩn: số tiền và tài khoản khớp payment mẫu. */
function makeEvent(overrides: Partial<ProviderEventRow> = {}): ProviderEventRow {
  return {
    id: EVENT_ID,
    provider: 'sepay',
    tenantId: TENANT_ID,
    accountId: ACCOUNT_ID,
    externalTransactionId: 'TXN-EXT-1',
    direction: 'credit',
    amount: 500_000,
    content: 'CK LMSABC123',
    extractedCode: 'LMSABC123',
    matchedPaymentId: null,
    matchStatus: 'received',
    raw: { reference_code: 'TXN-EXT-1' },
    receivedAt: new Date('2026-10-29T00:01:00Z'),
    ...overrides,
  };
}

interface Harness {
  service: SepayMatchingService;
  /** Nhật ký thứ tự gọi chung — ghim thứ tự các bước trong nhịp chốt. */
  calls: string[];
  outboxInputs: OutboxEventInput[];
  paymentsById: Map<string, PaymentRow>;
  eventsById: Map<string, ProviderEventRow>;
  listPendingArgs: { limit: number; staleBefore: Date }[];
  settleCalls: ProviderEventRow[];
  verifyCalls: PaymentRow[];
  /** Tham số của hai cổng kích hoạt theo thứ tự gọi — ghim việc truyền `tenantId` của payment qua cổng. */
  activationCalls: { port: 'enrol' | 'class'; itemId: string; userId: string; tenantId: string }[];
  setVerifyResult: (value: boolean) => void;
  setClaim: (fn: (id: string) => boolean) => void;
  setPending: (events: ProviderEventRow[]) => void;
}

/**
 * Dựng service với tầng dữ liệu và ba cổng là bản giả trong bộ nhớ:
 * repository giữ payment/sự kiện trong Map (ghi cập nhật hợp nhất vào
 * Map để bước đọc lại sau khi lật trạng thái thấy đúng trạng thái
 * mới, như DB thật), mọi khâu kích hoạt và phát outbox ghi vào cùng
 * một nhật ký `calls` để khẳng định thứ tự.
 */
function createHarness(): Harness {
  const calls: string[] = [];
  const outboxInputs: OutboxEventInput[] = [];
  const paymentsById = new Map<string, PaymentRow>();
  const eventsById = new Map<string, ProviderEventRow>();
  const listPendingArgs: { limit: number; staleBefore: Date }[] = [];
  const settleCalls: ProviderEventRow[] = [];
  const verifyCalls: PaymentRow[] = [];
  const activationCalls: Harness['activationCalls'] = [];
  let verifyResult = true;
  let claimFn: (id: string) => boolean = () => true;
  let pending: ProviderEventRow[] = [];

  const repo = {
    listPendingProviderEvents: async (limit: number, staleBefore: Date) => {
      listPendingArgs.push({ limit, staleBefore });
      return pending.slice(0, limit);
    },
    claimProviderEvent: async (id: string) => claimFn(id),
    getProviderEvent: async (id: string) => eventsById.get(id),
    getPaymentByCode: async (code: string) =>
      [...paymentsById.values()].find((p) => p.paymentCode === code),
    getPayment: async (id: string) => paymentsById.get(id),
    updatePayment: async (id: string, v: Partial<PaymentRow>) => {
      const current = paymentsById.get(id);
      if (current) paymentsById.set(id, { ...current, ...v });
      if (v.status) calls.push(`payment:${v.status}`);
    },
    updateProviderEvent: async (id: string, v: Partial<ProviderEventRow>) => {
      const current = eventsById.get(id);
      if (current) eventsById.set(id, { ...current, ...v });
      if (v.matchStatus) calls.push(`event:${v.matchStatus}`);
    },
  } as unknown as PaymentsRepository;

  const outbox = {
    enqueueStandalone: async (input: OutboxEventInput) => {
      outboxInputs.push(input);
      calls.push(`outbox:${input.type}`);
    },
  } as unknown as OutboxWriterService;

  const enrol: PaidEnrolActivationPort = {
    activatePaidEnrol: async (itemId, userId, tenantId) => {
      activationCalls.push({ port: 'enrol', itemId, userId, tenantId });
      calls.push('activate:enrol');
    },
  };
  const classes: PaidClassEnrolActivationPort = {
    activatePaidClassEnrol: async (itemId, userId, tenantId) => {
      activationCalls.push({ port: 'class', itemId, userId, tenantId });
      calls.push('activate:class');
    },
  };
  const plans = {
    activateForPayment: async () => { calls.push('activate:plan'); },
  } as unknown as PlanEntitlementsService;
  const settlement: PaymentSettlementPort = {
    verifyPaymentAgainstServerTarget: async (payment: PaymentRow) => {
      verifyCalls.push(payment);
      return verifyResult;
    },
    settleRefundFromDebitEvent: async (event: ProviderEventRow) => {
      settleCalls.push(event);
      calls.push('settle:debit');
    },
  };

  return {
    service: new SepayMatchingService(repo, outbox, enrol, classes, plans, settlement),
    calls,
    outboxInputs,
    paymentsById,
    eventsById,
    listPendingArgs,
    settleCalls,
    verifyCalls,
    activationCalls,
    setVerifyResult: (value) => { verifyResult = value; },
    setClaim: (fn) => { claimFn = fn; },
    setPending: (events) => { pending = events; },
  };
}

/** Nạp một cặp payment + sự kiện chuẩn vào harness. */
function seedPair(h: Harness, payment: PaymentRow, event: ProviderEventRow): void {
  h.paymentsById.set(payment.id, payment);
  h.eventsById.set(event.id, event);
}

describe('SepayMatchingService — đặc trưng hoá luồng matching IPN SePay', () => {
  it('quét sự kiện đang chờ theo cửa sổ stale 60 giây và tôn trọng giới hạn của nhịp', async () => {
    const h = createHarness();
    const event = makeEvent();
    seedPair(h, makePayment(), event);
    h.setPending([event]);

    const processed = await h.service.sweep(7);

    expect(processed).toBe(1);
    expect(h.listPendingArgs).toHaveLength(1);
    expect(h.listPendingArgs[0]!.limit).toBe(7);
    const staleAgeMs = Date.now() - h.listPendingArgs[0]!.staleBefore.getTime();
    expect(staleAgeMs).toBeGreaterThanOrEqual(59_000);
    expect(staleAgeMs).toBeLessThanOrEqual(61_000);
  });

  it('một sự kiện lỗi không chặn các sự kiện còn lại trong cùng nhịp quét', async () => {
    const h = createHarness();
    const bad = makeEvent({ id: 'evt-bad' });
    const good = makeEvent();
    seedPair(h, makePayment(), good);
    h.eventsById.set(bad.id, bad);
    h.setPending([bad, good]);
    h.setClaim((id) => {
      if (id === bad.id) throw new Error('claim lỗi');
      return true;
    });

    const processed = await h.service.sweep(20);

    expect(processed).toBe(1);
    expect(h.eventsById.get(good.id)!.matchStatus).toBe('matched');
  });

  it('bỏ qua sự kiện đã bị nhịp khác nhận việc (claim trả false) mà không xử lý gì thêm', async () => {
    const h = createHarness();
    seedPair(h, makePayment(), makeEvent());
    h.setClaim(() => false);

    await h.service.processEvent(EVENT_ID);

    expect(h.calls).toEqual([]);
    expect(h.verifyCalls).toEqual([]);
    expect(h.outboxInputs).toEqual([]);
  });

  it('sự kiện debit được uỷ thác trọn cho cổng xác nhận chi hoàn, không đi đường khớp tiền về', async () => {
    const h = createHarness();
    const debit = makeEvent({ direction: 'debit', extractedCode: null });
    seedPair(h, makePayment(), debit);

    await h.service.processEvent(EVENT_ID);

    expect(h.settleCalls).toEqual([debit]);
    expect(h.calls).toEqual(['settle:debit']);
    expect(h.verifyCalls).toEqual([]);
    expect(h.outboxInputs).toEqual([]);
  });

  it('khớp đủ điều kiện (enrol_fee): kích hoạt ghi danh TRƯỚC khi lật succeeded, rồi phát payment_succeeded và chốt sự kiện matched', async () => {
    const h = createHarness();
    seedPair(h, makePayment(), makeEvent());

    await h.service.processEvent(EVENT_ID);

    // Thứ tự là bất biến nghiệp vụ của nhịp chốt: kích hoạt → lật
    // trạng thái → phát outbox → chốt sự kiện.
    expect(h.calls).toEqual([
      'activate:enrol',
      'payment:succeeded',
      'outbox:payment_succeeded',
      'event:matched',
    ]);
    expect(h.outboxInputs).toEqual([
      {
        aggregate: 'payment',
        type: 'payment_succeeded',
        payload: {
          paymentId: PAYMENT_ID,
          userId: USER_ID,
          amount: 500_000,
          currency: 'VND',
          component: 'enrol_fee',
          itemId: ITEM_ID,
          externalTransactionId: 'TXN-EXT-1',
        },
      },
    ]);
    expect(h.paymentsById.get(PAYMENT_ID)!.status).toBe('succeeded');
    expect(h.paymentsById.get(PAYMENT_ID)!.externalTransactionId).toBe('TXN-EXT-1');
    expect(h.eventsById.get(EVENT_ID)!.matchedPaymentId).toBe(PAYMENT_ID);
    // Cổng kích hoạt nhận đủ định danh của payment, gồm `tenantId`
    // của payment để tiến trình chủ phân giải không gian của
    // trung tâm sở hữu payment.
    expect(h.activationCalls).toEqual([
      { port: 'enrol', itemId: ITEM_ID, userId: USER_ID, tenantId: TENANT_ID },
    ]);
  });

  it('khớp đủ điều kiện (class_fee): kích hoạt ghi danh cấp lớp qua cổng trước nhịp lật trạng thái', async () => {
    const h = createHarness();
    seedPair(h, makePayment({ component: 'class_fee' }), makeEvent());

    await h.service.processEvent(EVENT_ID);

    expect(h.calls).toEqual([
      'activate:class',
      'payment:succeeded',
      'outbox:payment_succeeded',
      'event:matched',
    ]);
    expect(h.activationCalls).toEqual([
      { port: 'class', itemId: ITEM_ID, userId: USER_ID, tenantId: TENANT_ID },
    ]);
  });

  it('khớp đủ điều kiện (tenant_plan): kích hoạt quyền lợi gói trước nhịp lật trạng thái', async () => {
    const h = createHarness();
    seedPair(h, makePayment({ component: 'tenant_plan', itemId: null }), makeEvent());

    await h.service.processEvent(EVENT_ID);

    expect(h.calls).toEqual([
      'activate:plan',
      'payment:succeeded',
      'outbox:payment_succeeded',
      'event:matched',
    ]);
  });

  it('số tiền tiền về lệch với payment: rơi nhánh needs_review, không kích hoạt và không phát outbox', async () => {
    const h = createHarness();
    seedPair(h, makePayment(), makeEvent({ amount: 499_000 }));

    await h.service.processEvent(EVENT_ID);

    expect(h.calls).toEqual(['payment:needs_review', 'event:needs_review']);
    expect(h.paymentsById.get(PAYMENT_ID)!.status).toBe('needs_review');
    expect(h.eventsById.get(EVENT_ID)!.matchedPaymentId).toBe(PAYMENT_ID);
    expect(h.outboxInputs).toEqual([]);
  });

  it('tài khoản nhận của sự kiện lệch với tài khoản của payment: rơi nhánh needs_review, không kích hoạt', async () => {
    const h = createHarness();
    seedPair(h, makePayment(), makeEvent({ accountId: 'acc-khac' }));

    await h.service.processEvent(EVENT_ID);

    expect(h.calls).toEqual(['payment:needs_review', 'event:needs_review']);
    expect(h.outboxInputs).toEqual([]);
  });

  it('payment đã hết hạn khi tiền về: rơi nhánh needs_review, không kích hoạt dù số tiền và tài khoản khớp', async () => {
    const h = createHarness();
    seedPair(h, makePayment({ expiresAt: new Date(Date.now() - 1_000) }), makeEvent());

    await h.service.processEvent(EVENT_ID);

    expect(h.calls).toEqual(['payment:needs_review', 'event:needs_review']);
    expect(h.outboxInputs).toEqual([]);
  });

  it('ba điều kiện khớp nhưng đích phía server không khớp: rơi nhánh needs_review và TUYỆT ĐỐI không kích hoạt', async () => {
    const h = createHarness();
    seedPair(h, makePayment(), makeEvent());
    h.setVerifyResult(false);

    await h.service.processEvent(EVENT_ID);

    expect(h.verifyCalls).toHaveLength(1);
    expect(h.calls).toEqual(['payment:needs_review', 'event:needs_review']);
    expect(h.outboxInputs).toEqual([]);
  });

  it('không tìm thấy payment theo mã trích xuất: sự kiện needs_review với matchedPaymentId rỗng, không payment nào bị đụng', async () => {
    const h = createHarness();
    h.eventsById.set(EVENT_ID, makeEvent({ extractedCode: 'MA-KHONG-TON-TAI' }));

    await h.service.processEvent(EVENT_ID);

    expect(h.calls).toEqual(['event:needs_review']);
    expect(h.eventsById.get(EVENT_ID)!.matchedPaymentId).toBeNull();
    expect(h.verifyCalls).toEqual([]);
    expect(h.outboxInputs).toEqual([]);
  });

  it('payment đã succeeded bởi chính giao dịch này: chỉ chốt sự kiện matched, không kích hoạt lại và không phát outbox', async () => {
    const h = createHarness();
    seedPair(
      h,
      makePayment({ status: 'succeeded', externalTransactionId: 'TXN-EXT-1' }),
      makeEvent(),
    );

    await h.service.processEvent(EVENT_ID);

    expect(h.calls).toEqual(['event:matched']);
    expect(h.eventsById.get(EVENT_ID)!.matchedPaymentId).toBe(PAYMENT_ID);
    expect(h.outboxInputs).toEqual([]);
  });

  it('payment đã ở trạng thái kết thúc (refunded) và thiếu điều kiện: giữ nguyên trạng thái payment, chỉ sự kiện sang needs_review', async () => {
    const h = createHarness();
    seedPair(h, makePayment({ status: 'refunded' }), makeEvent({ amount: 1 }));

    await h.service.processEvent(EVENT_ID);

    expect(h.calls).toEqual(['event:needs_review']);
    expect(h.paymentsById.get(PAYMENT_ID)!.status).toBe('refunded');
    expect(h.outboxInputs).toEqual([]);
  });
});
