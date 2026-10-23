import { describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv } from './grade-csv';

/**
 * GradeCsv — vòng serialize/parse phải khớp nhau trên các ca biên của CSV:
 * dấu phẩy và ngoặc kép trong tên, xuống dòng trong trường, BOM của Excel,
 * CRLF lẫn LF.
 */
describe('GradeCsv', () => {
  it('serialize: trích dẫn trường có dấu phẩy/ngoặc kép/xuống dòng, kết dòng CRLF', () => {
    expect(serializeCsv([['a', 'b,c'], ['he said "hi"', 'x\ny']]))
      .toBe('a,"b,c"\r\n"he said ""hi""","x\ny"\r\n');
    expect(serializeCsv([['plain', '42']])).toBe('plain,42\r\n');
  });

  it('parse: đọc lại đúng những gì serialize ghi (round trip)', () => {
    const rows = [['username', 'Quiz, 1', 'note "A"'], ['sv01', '85', 'dòng 1\ndòng 2'], ['sv02', '', '']];
    expect(parseCsv(serializeCsv(rows))).toEqual(rows);
  });

  it('parse: chấp nhận LF trần, BOM UTF-8 và bỏ dòng trống cuối file', () => {
    expect(parseCsv('﻿a,b\n1,2\n\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('parse: trường trích dẫn giữ dấu phẩy và "" thành một ngoặc kép', () => {
    expect(parseCsv('"a,""b""",c\r\n')).toEqual([['a,"b"', 'c']]);
  });

  it('parse: file rỗng và file chỉ có tiêu đề', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('username,Quiz 1\r\n')).toEqual([['username', 'Quiz 1']]);
  });
});
