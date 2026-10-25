/**
 * Nén asset tĩnh cho prod-server.mjs (F-12 của rà soát #133).
 *
 * Module thuần (không I/O) tách riêng để có spec độc lập, cùng khuôn
 * proxy-paths.mjs của PR #128. CHỈ đường phục vụ file tĩnh (tryStatic)
 * được dùng module này — đường SSR streaming và đường proxy API/SSE
 * không qua đây, giữ nguyên hành vi stream không đệm.
 *
 * Thương lượng theo RFC 9110: đọc q-value của Accept-Encoding, ưu tiên
 * brotli khi q ngang hoặc cao hơn gzip; encoding bị q=0 là bị cấm tường
 * minh. Ngưỡng kích thước tối thiểu tránh nén file nhỏ (chi phí CPU và
 * tỉ lệ nén không đáng).
 */
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';

/** File tĩnh nhỏ hơn ngưỡng này trả thẳng, không nén. */
export const MIN_COMPRESS_BYTES = 1024;

const COMPRESSIBLE_TYPE = /^(?:text\/|application\/json\b|image\/svg\+xml\b)/;

/** Loại nội dung có lợi khi nén (JS/CSS/HTML/JSON/SVG/text); ảnh và font đã nén sẵn thì không. */
export function isCompressibleType(contentType) {
  return COMPRESSIBLE_TYPE.test(contentType ?? '');
}

/** q-value của một encoding trong Accept-Encoding; undefined nếu không được nhắc tới. */
function encodingQ(entries, name) {
  if (entries.has(name)) return entries.get(name);
  return entries.get('*');
}

/**
 * Chọn encoding từ header Accept-Encoding: 'br' | 'gzip' | null.
 * null nghĩa là trả bản gốc (không header, q=0 hết, hoặc chỉ identity).
 */
export function pickEncoding(acceptEncoding) {
  if (!acceptEncoding) return null;
  const entries = new Map();
  for (const part of String(acceptEncoding).split(',')) {
    const [rawName, ...params] = part.split(';').map((s) => s.trim());
    const name = rawName?.toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const match = /^q=([0-9]+(?:\.[0-9]+)?)$/.exec(param);
      if (match) q = Number(match[1]);
    }
    entries.set(name, q);
  }
  const br = encodingQ(entries, 'br') ?? 0;
  const gzip = encodingQ(entries, 'gzip') ?? 0;
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return null;
}

/** Nén một buffer theo encoding đã chọn (brotli quality 5: cân bằng tỉ lệ/tốc độ cho nén tại chỗ). */
export function compressBuffer(buffer, encoding) {
  if (encoding === 'br') {
    return brotliCompressSync(buffer, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
    });
  }
  return gzipSync(buffer, { level: 6 });
}
