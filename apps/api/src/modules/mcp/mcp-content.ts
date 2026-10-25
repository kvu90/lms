import { createHash } from 'node:crypto';

/**
 * Validate LỚP 3 — NỘI DUNG (hồ sơ research MCP Phần 3.1) cho payload
 * qua MCP. Biên MCP chỉ nhận chuỗi thuần và lát rich text là text-only
 * nên không tồn tại đường HTML/script vào nội dung; lớp này lo phần
 * riêng của đầu vào AI:
 *  - chặn ký tự điều khiển C0 (trừ \n, \t) và ký tự zero-width /
 *    bidi-override (chống trojan-source trong nội dung câu hỏi);
 *  - chuẩn hoá: \r\n/\r → \n, Unicode NFC (dấu tiếng Việt dạng tổ hợp
 *    không lách được chống trùng — khớp hàm chuẩn hoá QB-4 + NFC);
 *  - từ chối trường nội dung toàn khoảng trắng.
 * Giới hạn độ dài/số lượng nằm ở lớp 1 (schema contracts); nghiệp vụ
 * theo qtype nằm ở lớp 2 (QuestionsService) — lớp này không lặp lại.
 */

export interface ContentViolation {
  fieldPath: string;
  message: string;
}

// C0 controls except \t (0009) and \n (000A); \r (000D) được chuẩn hoá
// thành \n TRƯỚC khi quét nên không nằm trong tập cấm ở đây.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// Zero-width (200B–200D, FEFF) + bidi embedding/override (202A–202E, 2066–2069).
const INVISIBLE_CHARS = /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/;

function scanString(value: string, fieldPath: string, out: ContentViolation[]): void {
  if (CONTROL_CHARS.test(value)) {
    out.push({ fieldPath, message: 'Content contains forbidden control characters' });
  }
  if (INVISIBLE_CHARS.test(value)) {
    out.push({ fieldPath, message: 'Content contains forbidden zero-width or bidirectional control characters' });
  }
}

/** Quét đệ quy mọi chuỗi trong payload (trừ các trường định danh id/key được liệt kê ở skipPaths). */
export function scanContent(payload: unknown, out: ContentViolation[], path = '', skipPaths: ReadonlySet<string> = new Set()): void {
  if (typeof payload === 'string') {
    if (!skipPaths.has(path)) scanString(payload, path || '/', out);
    return;
  }
  if (Array.isArray(payload)) {
    payload.forEach((item, index) => scanContent(item, out, `${path}/${index}`, skipPaths));
    return;
  }
  if (typeof payload === 'object' && payload !== null) {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      scanContent(value, out, `${path}/${key}`, skipPaths);
    }
  }
}

/** Chuẩn hoá đệ quy: gộp đầu dòng về \n + NFC. Trả bản mới, không sửa bản gốc. */
export function normalizeContentStrings<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\r\n?/g, '\n').normalize('NFC') as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeContentStrings(item)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeContentStrings(item);
    }
    return out as T;
  }
  return value;
}

/** JSON ổn định (khoá đối tượng sắp xếp đệ quy) để hash payload bất biến theo thứ tự khoá. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Hash của một lần gọi tool ghi (tên tool + payload đã chuẩn hoá, KHÔNG gồm idempotencyKey). */
export function mcpRequestHash(tool: string, payload: unknown): string {
  return createHash('sha256').update(`${tool}|${stableStringify(payload)}`).digest('hex');
}
