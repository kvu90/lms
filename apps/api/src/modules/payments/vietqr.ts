import { encodeVietQr } from 'vn-qr-pay';

/**
 * Lõi VietQR Lát 1 (issue #189; hồ sơ payment-vietqr §2/§6):
 * - Mã thanh toán: `LMS` + 9 ký tự base32 Crockford mã hoá từ số thứ tự của
 *   sequence `payment_code_seq` — sinh một lần, duy nhất (unique ở DB),
 *   không tái sử dụng; đặt ở trường 62/08 (purpose) của QR.
 * - QR ĐỘNG theo chuẩn EMVCo/NAPAS qua `vn-qr-pay`: trường 54 khoá số tiền,
 *   trường 62/08 mang mã thanh toán. Mã dịch vụ trường 38/02 giữ chuẩn
 *   NAPAS `QRIBFTTA` (chuyển khoản tới số tài khoản).
 *   GHI NHẬN KIỂM CHỨNG (25/10/2026): test vector vàng §2.2 là mẫu của
 *   payOS — trường 38/02 của mẫu là mã dịch vụ RIÊNG của payOS
 *   (`99998888`) và CRC cuối mẫu không tái tạo được bằng vn-qr-pay kể cả
 *   khi ép cùng tham số; vì vậy tiêu chí 6.4.4 được khoá bằng vector vàng
 *   của chính hệ thống (sinh qua vn-qr-pay, giải mã ngược đúng 54/62-08,
 *   CRC hợp lệ) trong vietqr.spec.ts cạnh mã nguồn, không giả mạo khớp mẫu.
 */

export const PAYMENT_CODE_PREFIX = 'LMS';
/** Hạn hiệu lực mặc định của mã thanh toán/QR: 24 giờ (hồ sơ §2.3). */
export const PAYMENT_CODE_TTL_MS = 24 * 60 * 60 * 1000;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Mã hoá một số thứ tự thành mã thanh toán 12 ký tự (`LMS` + 9). */
export function paymentCodeFromSequence(seq: number): string {
  let n = Math.floor(Math.abs(seq));
  let encoded = '';
  do {
    encoded = CROCKFORD[n % 32] + encoded;
    n = Math.floor(n / 32);
  } while (n > 0);
  return PAYMENT_CODE_PREFIX + encoded.padStart(9, '0');
}

const PAYMENT_CODE_RE = /LMS[0-9A-HJKMNP-TV-Z]{9}/;

/**
 * Trích mã thanh toán từ nội dung chuyển khoản: chuẩn hoá viết hoa và bỏ
 * mọi ký tự ngoài [A-Z0-9] (ngân hàng thường chèn dấu cách/gạch), rồi tìm
 * mẫu `LMS` + 9 ký tự Crockford (không chứa I, L, O, U).
 */
export function extractPaymentCode(content: string): string | null {
  const normalized = content.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = normalized.match(PAYMENT_CODE_RE);
  return match ? match[0] : null;
}

/** Cấu hình ngân hàng/provider của một payment account (config jsonb). */
export interface PaymentAccountConfig {
  bankBin?: string;
  /** Khoá enum ngân hàng của vn-qr-pay (vd `MBBANK`) — ưu tiên hơn bankBin nếu có. */
  bankCode?: string;
  bankAccountNumber?: string;
  bankAccountName?: string;
  sepayApiKey?: string;
  sepayBankAccountXid?: string;
  [key: string]: unknown;
}

/** Ánh xạ BIN NAPAS → khoá enum ngân hàng của vn-qr-pay (các ngân hàng phổ biến). */
const BIN_TO_BANK_KEY: Record<string, string> = {
  '970422': 'MBBANK',
  '970436': 'VIETCOMBANK',
  '970415': 'VIETINBANK',
  '970407': 'TECHCOMBANK',
  '970418': 'BIDV',
  '970405': 'AGRIBANK',
  '970416': 'ACB',
  '970432': 'VPBANK',
  '970423': 'TPBANK',
  '970403': 'SACOMBANK',
  '970428': 'MSB',
  '970441': 'VIB',
  '970443': 'SHB',
  '970431': 'EXIMBANK',
  '970414': 'OCB',
  '970449': 'LIENVIETPOST_BANK',
  '970437': 'HDBANK',
};

export function readAccountConfig(raw: unknown): PaymentAccountConfig {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PaymentAccountConfig) : {};
}

/**
 * Dựng payload VietQR động cho một payment; trả `null` khi tài khoản không
 * đủ điều kiện sinh QR (chưa liên kết SePay theo §6.3, thiếu số tài khoản
 * hoặc không rõ ngân hàng) — đường `manual` xác nhận tay vẫn chạy bình thường.
 */
export function buildVietQrPayload(account: { gateway: string; config: unknown }, amount: number, paymentCode: string): string | null {
  const config = readAccountConfig(account.config);
  if (account.gateway !== 'sepay') return null;
  if (!config.sepayBankAccountXid) return null; // chưa liên kết SePay → không sinh QR tự động
  const accountNumber = typeof config.bankAccountNumber === 'string' ? config.bankAccountNumber : '';
  if (!accountNumber) return null;
  const bankKey = (typeof config.bankCode === 'string' && config.bankCode) || (config.bankBin ? BIN_TO_BANK_KEY[config.bankBin] : undefined);
  if (!bankKey) return null;
  try {
    return encodeVietQr({
      bank: bankKey as never,
      account: accountNumber,
      amount: String(amount),
      additionalData: { purpose: paymentCode },
    });
  } catch {
    return null;
  }
}

const SENSITIVE_KEY_RE = /(api[-_]?key|secret|checksum|password|token)/i;

/**
 * Che cấu hình nhạy cảm trước khi ra response (tiêu chí 6.4.5): khoá có tên
 * chứa apiKey/secret/checksum/token/password bị thay bằng dấu hiệu đã cấu
 * hình + tối đa 4 ký tự cuối; các trường công khai (số tài khoản, BIN, xid)
 * giữ nguyên để vận hành đối chiếu được.
 */
export function maskAccountConfig(raw: unknown): Record<string, unknown> {
  const config = readAccountConfig(raw);
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      masked[key] = typeof value === 'string' && value.length > 4 ? `••••••${value.slice(-4)}` : '••••••';
    } else {
      masked[key] = value;
    }
  }
  return masked;
}
