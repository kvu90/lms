import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { compressBuffer, isCompressibleType, pickEncoding } from './compression.mjs';

/**
 * Hồi quy nén asset tĩnh của prod-server.mjs (F-12 của rà soát #133).
 *
 * Ghim: thương lượng Accept-Encoding đúng q-value (br ưu tiên, q=0 là
 * cấm), chỉ nén loại nội dung text, và buffer nén giải nén lại được
 * nguyên bản. Nén chỉ áp ở đường tĩnh — spec này không thay smoke
 * prod-server thật ở bàn giao.
 */
describe('pickEncoding', () => {
  it('không header hoặc chỉ identity → không nén', () => {
    expect(pickEncoding(undefined)).toBeNull();
    expect(pickEncoding('')).toBeNull();
    expect(pickEncoding('identity')).toBeNull();
  });

  it('chọn đúng encoding client xin', () => {
    expect(pickEncoding('gzip')).toBe('gzip');
    expect(pickEncoding('br')).toBe('br');
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('BR')).toBe('br');
  });

  it('tôn trọng q-value: q cao hơn thắng, q=0 là cấm', () => {
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('gzip;q=0')).toBeNull();
    expect(pickEncoding('gzip;q=0.5, br;q=0.8')).toBe('br');
    expect(pickEncoding('br;q=0.5, gzip;q=0.8')).toBe('gzip');
  });

  it('wildcard * áp cho encoding không nhắc tên', () => {
    expect(pickEncoding('*')).toBe('br');
    expect(pickEncoding('gzip, *;q=0')).toBe('gzip');
  });
});

describe('isCompressibleType', () => {
  it('nén loại text: JS/CSS/HTML/JSON/SVG', () => {
    expect(isCompressibleType('text/javascript; charset=utf-8')).toBe(true);
    expect(isCompressibleType('text/css; charset=utf-8')).toBe(true);
    expect(isCompressibleType('text/html; charset=utf-8')).toBe(true);
    expect(isCompressibleType('application/json; charset=utf-8')).toBe(true);
    expect(isCompressibleType('image/svg+xml')).toBe(true);
  });

  it('không nén ảnh/font/nhị phân (đã nén sẵn)', () => {
    expect(isCompressibleType('image/png')).toBe(false);
    expect(isCompressibleType('font/woff2')).toBe(false);
    expect(isCompressibleType('application/octet-stream')).toBe(false);
  });
});

describe('compressBuffer', () => {
  const sample = Buffer.from('const chunk = "platform";\n'.repeat(200));

  it('gzip: giải nén lại nguyên bản và nhỏ hơn bản gốc', () => {
    const out = compressBuffer(sample, 'gzip');
    expect(out.length).toBeLessThan(sample.length);
    expect(gunzipSync(out).equals(sample)).toBe(true);
  });

  it('brotli: giải nén lại nguyên bản và nhỏ hơn bản gốc', () => {
    const out = compressBuffer(sample, 'br');
    expect(out.length).toBeLessThan(sample.length);
    expect(brotliDecompressSync(out).equals(sample)).toBe(true);
  });
});
