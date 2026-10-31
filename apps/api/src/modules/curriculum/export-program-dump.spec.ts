import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProgramDumpOutPath } from './export-program-dump';

/**
 * Hồi quy cho CLI xuất dump chương trình (issue #613): sau khi file
 * CLI dời vào `modules/curriculum`, đường đích mặc định từng giữ
 * công thức của vị trí cũ ở root src nên nhân đôi đoạn
 * `modules/curriculum` và trỏ vào thư mục không tồn tại — chạy
 * không kèm đối số đầu ra sẽ ENOENT ở bước ghi file. Ca này ghim
 * đích mặc định đúng: thư mục `program-data-dump` ngay cạnh file
 * CLI, nơi artifact thật của repo đang nằm (và là nơi bước build
 * chép artifact vào dist khi chạy bản build).
 */
describe('CLI xuất dump chương trình — file đích mặc định', () => {
  it('chạy không kèm đối số đầu ra thì đích mặc định là artifact program-data-dump/program-dump.sql ngay cạnh file CLI, không nhân đôi đoạn modules/curriculum', () => {
    const outPath = resolveProgramDumpOutPath([]);

    // Đích tính từ chính thư mục chứa file CLI (spec này nằm cạnh
    // file CLI nên __dirname của hai file trùng nhau).
    expect(outPath).toBe(join(__dirname, 'program-data-dump', 'program-dump.sql'));
    // Đoạn nhân đôi của công thức cũ không được xuất hiện.
    expect(outPath).not.toContain(join('modules', 'curriculum', 'modules', 'curriculum'));
    // Đích trỏ tới artifact thật đang tồn tại trong repo.
    expect(existsSync(dirname(outPath))).toBe(true);
    expect(existsSync(outPath)).toBe(true);
  });
});
