/**
 * GradeCsv — đọc/ghi CSV điểm theo RFC 4180 tối thiểu, thuần hàm (không I/O).
 *
 * Dùng cho export/import sổ điểm (issue #24): export ghi CRLF và trích dẫn
 * trường chứa dấu phẩy/ngoặc kép/xuống dòng; parser chấp nhận cả CRLF lẫn LF,
 * trường trích dẫn có `""` là ngoặc kép thoát, và BOM UTF-8 ở đầu file (Excel
 * hay chèn khi lưu CSV) bị bỏ qua. Dòng trống hoàn toàn ở cuối file không sinh
 * dòng dữ liệu rỗng.
 */

/** Thoát một trường CSV: bọc ngoặc kép khi trường chứa ký tự đặc biệt, nhân đôi ngoặc kép bên trong. */
function escapeField(field: string): string {
  if (/[",\r\n]/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

/** Nối các dòng thành văn bản CSV (mỗi dòng kết thúc CRLF, kể cả dòng cuối). */
export function serializeCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(escapeField).join(',')).join('\r\n') + (rows.length ? '\r\n' : '');
}

/**
 * Phân tích văn bản CSV thành bảng chuỗi. Ký tự đầu tiên là BOM thì bỏ qua.
 * Ngoặc kép chỉ có nghĩa đặc biệt ở đầu trường; bên trong trường trích dẫn,
 * `""` là một ngoặc kép và dấu phẩy/xuống dòng là dữ liệu.
 */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldQuoted = false;
  let i = 0;

  const endField = (): void => { row.push(field); field = ''; fieldQuoted = false; };
  const endRow = (): void => { endField(); rows.push(row); row = []; };

  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field === '' && !fieldQuoted) { inQuotes = true; fieldQuoted = true; i += 1; continue; }
    if (ch === ',') { endField(); i += 1; continue; }
    if (ch === '\r') { if (input[i + 1] === '\n') i += 1; endRow(); i += 1; continue; }
    if (ch === '\n') { endRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  // Dòng cuối không có ký tự xuống dòng vẫn là một dòng; file kết thúc bằng
  // xuống dòng thì không sinh dòng rỗng thừa.
  if (field !== '' || row.length > 0) endRow();
  // Bỏ các dòng trống hoàn toàn (một ô rỗng duy nhất) — thường là dòng thừa do file thừa xuống dòng.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}
