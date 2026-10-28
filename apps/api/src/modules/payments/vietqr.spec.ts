import { describe, expect, it } from 'vitest';
import { decodeQr } from 'vn-qr-pay';
import { buildVietQrPayload } from './vietqr';

/**
 * Vector vàng của VietQR (tiêu chí 6.4.4 của issue #189): khẳng định
 * thuần trên hàm sinh payload và thư viện giải mã `vn-qr-pay` — không
 * qua HTTP, không chạm DB — nên nằm ở tầng unit cạnh mã nguồn. Các ca
 * còn lại của lát VietQR (IPN SePay, che cấu hình, cách ly tenant, cổng
 * hoàn tiền) lái qua HTTP/DB và ở lại `test/payments/payments-vietqr.e2e-spec.ts`.
 */
const SEPAY_XID = 'xid-test-org-001';
const BANK_ACCOUNT = '113366668888';

describe('VietQR — sinh payload QR động', () => {
  it('payload khớp vector vàng của hệ thống từng byte và giải mã ngược đúng số tiền, tài khoản và nội dung chuyển khoản', () => {
    const payload = buildVietQrPayload(
      { gateway: 'sepay', config: { bankCode: 'MBBANK', bankAccountNumber: BANK_ACCOUNT, sepayBankAccountXid: SEPAY_XID } },
      100000, 'LMS7K3QX9P2M',
    );
    // Vector vàng khoá cứng (sinh qua vn-qr-pay 0.0.5, CRC16-CCITT hợp lệ):
    // trường 01=12 (động), 38/02=QRIBFTTA, 54=100000, 62/08=LMS7K3QX9P2M.
    expect(payload).toBe('00020101021238560010A0000007270126000697042201121133666688880208QRIBFTTA530370454061000005802VN62160812LMS7K3QX9P2M6304630E');
    const decoded = decodeQr(payload!);
    expect(decoded.isValid).toBe(true);
    expect(decoded.amount).toBe('100000');
    expect(decoded.consumer.bankNumber).toBe(BANK_ACCOUNT);
    expect((decoded.additionalData as { purpose?: string }).purpose).toBe('LMS7K3QX9P2M');
  });
});
