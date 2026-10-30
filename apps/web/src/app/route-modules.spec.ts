import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Spec gác: MỌI route module đăng ký trong `src/app/routes.ts` (file
 * gộp) và các config route theo feature `features/<feature>/routes.ts`
 * phải có export mặc định (issue #406).
 *
 * Vì sao phải gác ở mức toàn bộ cây route: React Router framework mode
 * chỉ lấy component của route từ export mặc định (hoặc export tên
 * `Component`) của route module. Thiếu export mặc định thì:
 *
 *  1. Điều hướng trong ứng dụng: outlet không gắn được component —
 *     khung vỏ hiện, vùng nội dung trống, không thông báo lỗi.
 *  2. Mở thẳng URL / hard reload: nếu route lá đồng thời thiếu cả
 *     `ErrorBoundary`, request tài liệu bị xếp vào đường resource
 *     route và trả HTTP 400 với thân `{"message":"Unexpected Server
 *     Error"}` thay vì HTML của trang.
 *
 * Lỗi này đã lọt hai lần cùng một cơ chế: trang `/curriculum` (cơ chế
 * được ghi lại trong comment của `features/curriculum/routes/teacher-curriculum.tsx`) và
 * trang `/admin/guardian-links` (chỉ xuất component theo tên riêng,
 * thiếu cả export mặc định lẫn `ErrorBoundary` và `meta()`). Cả hai
 * lần đều lọt vì spec của chính trang render component theo tên riêng
 * trực tiếp — không nạp file như route module của framework — còn các
 * spec gác route module trước đây (`app/shell-pages-routes.spec.tsx`,
 * `features/platform/routes/platform-routes.spec.tsx`) chỉ liệt kê cứng một số module
 * nhất định, trang mới nằm ngoài danh sách là nằm ngoài diện gác.
 *
 * Cách gác của spec này: danh sách module được SUY RA từ chính nội
 * dung các file config route khi spec chạy — file gộp
 * `src/app/routes.ts` (chuỗi của chính nó là đường dẫn tương đối
 * theo thư mục `app/`) cộng mọi config feature mà nó import (chuỗi
 * trong config feature là đường dẫn tương đối theo thư mục của
 * feature). Mọi chuỗi đường dẫn file `.ts`/`.tsx` trong các file
 * config đều là đích mà `route()`/`index()`/`layout()` đăng ký
 * (đường dẫn URL của route không bao giờ kết thúc bằng `.ts`/`.tsx`);
 * các đường dẫn được chuẩn hoá về dạng tương đối theo `src/` trước
 * khi đối chiếu. Trang mới thêm vào config tự động vào diện gác,
 * không cần sửa spec. Từng file
 * được đọc ở dạng nguồn (gọt comment trước khi quét, để chữ trong
 * comment không bị tính là export) và được khẳng định có export mặc
 * định ở một trong ba dạng cú pháp đang dùng trong repo:
 *
 *  - `export default ...` (hàm/class/biến ở đầu câu lệnh);
 *  - `export { X as default }` — kể cả viết nhiều dòng và kèm `from`;
 *  - `export { default } from '...'` — chuyển tiếp export mặc định.
 *
 * Chống xanh giả: ca đầu tiên khẳng định danh sách suy ra phải đủ lớn
 * và chứa đúng module của lỗi gốc. Nếu cách suy danh sách hỏng (quét
 * ra rỗng hoặc thiếu), ca đó đỏ thay vì toàn bộ spec xanh rỗng.
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
/** Thư mục `src/` — gốc để chuẩn hoá đường dẫn module suy ra từ các file config. */
const SRC_ROOT = dirname(SRC_DIR);

/** Gọt block comment và line comment để chỉ quét code thật. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Khẳng định một file nguồn có export mặc định ở một trong ba dạng cú pháp của repo. */
function hasDefaultExport(source: string): boolean {
  const code = stripComments(source);
  return (
    /(^|\n)\s*export\s+default[\s(]/.test(code) ||
    /export\s*\{[^}]*\bas\s+default\b[^}]*\}/.test(code) ||
    /export\s*\{[^}]*\bdefault\b[^}]*\}\s*from/.test(code)
  );
}

/** Suy danh sách route module từ chính nội dung file gộp `routes.ts` và các config feature mà nó import. */
function listRouteModuleFiles(): string[] {
  const files = new Set<string>();
  const collect = (source: string, baseDir: string) => {
    for (const match of stripComments(source).matchAll(/'([^']+\.tsx?)'/g)) {
      files.add(join(baseDir, match[1]));
    }
  };
  const appRoutesSource = readFileSync(join(SRC_DIR, 'routes.ts'), 'utf8');
  collect(appRoutesSource, 'app');
  for (const match of stripComments(appRoutesSource).matchAll(/from\s+'(\.\.\/features\/[a-z-]+\/routes)'/g)) {
    const configRel = match[1].replace(/^\.\.\//, '');
    collect(readFileSync(join(SRC_ROOT, `${configRel}.ts`), 'utf8'), dirname(configRel));
  }
  return [...files].sort();
}

const ROUTE_MODULE_FILES = listRouteModuleFiles();

describe('Gác route module (issue #406): mọi module đăng ký trong src/app/routes.ts đều có export mặc định', () => {
  it('suy ra đầy đủ danh sách module route từ chính routes.ts', () => {
    // Số route module tại thời điểm viết spec là 94; ngưỡng 50 chỉ để
    // bắt trường hợp cách suy danh sách hỏng và quét thiếu hàng loạt.
    expect(ROUTE_MODULE_FILES.length).toBeGreaterThan(50);
    // Neo hồi quy của chính lỗi gốc: module này từng là module duy
    // nhất trong toàn app thiếu export mặc định.
    expect(ROUTE_MODULE_FILES).toContain('features/guardians/routes/admin-guardian-links.tsx');
  });

  for (const file of ROUTE_MODULE_FILES) {
    it(`module route ${file} có export mặc định`, () => {
      const source = readFileSync(join(SRC_ROOT, file), 'utf8');
      expect(
        hasDefaultExport(source),
        `Route module ${file} thiếu export mặc định — React Router framework mode sẽ không gắn được component cho route này`,
      ).toBe(true);
    });
  }
});
