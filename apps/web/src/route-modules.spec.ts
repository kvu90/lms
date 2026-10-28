import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Spec gác: MỌI route module đăng ký trong `src/routes.ts` phải có
 * export mặc định (issue #406).
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
 * được ghi lại trong comment của `routes/teacher-curriculum.tsx`) và
 * trang `/admin/guardian-links` (chỉ xuất component theo tên riêng,
 * thiếu cả export mặc định lẫn `ErrorBoundary` và `meta()`). Cả hai
 * lần đều lọt vì spec của chính trang render component theo tên riêng
 * trực tiếp — không nạp file như route module của framework — còn các
 * spec gác route module trước đây (`pages/shell-pages-routes.spec.tsx`,
 * `routes/platform-routes.spec.tsx`) chỉ liệt kê cứng một số module
 * nhất định, trang mới nằm ngoài danh sách là nằm ngoài diện gác.
 *
 * Cách gác của spec này: danh sách module được SUY RA từ chính nội
 * dung `src/routes.ts` khi spec chạy — mọi chuỗi đường dẫn file
 * `.ts`/`.tsx` xuất hiện trong `routes.ts` đều là đích mà
 * `route()`/`index()`/`layout()` đăng ký (đường dẫn URL của route
 * không bao giờ kết thúc bằng `.ts`/`.tsx`). Trang mới thêm vào
 * `routes.ts` tự động vào diện gác, không cần sửa spec. Từng file
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

/** Suy danh sách route module từ chính nội dung `src/routes.ts`. */
function listRouteModuleFiles(): string[] {
  const routesSource = readFileSync(join(SRC_DIR, 'routes.ts'), 'utf8');
  const files = new Set<string>();
  for (const match of routesSource.matchAll(/'([^']+\.tsx?)'/g)) {
    files.add(match[1]);
  }
  return [...files].sort();
}

const ROUTE_MODULE_FILES = listRouteModuleFiles();

describe('Gác route module (issue #406): mọi module đăng ký trong src/routes.ts đều có export mặc định', () => {
  it('derives the full route module list from routes.ts itself', () => {
    // Số route module tại thời điểm viết spec là 94; ngưỡng 50 chỉ để
    // bắt trường hợp cách suy danh sách hỏng và quét thiếu hàng loạt.
    expect(ROUTE_MODULE_FILES.length).toBeGreaterThan(50);
    // Neo hồi quy của chính lỗi gốc: module này từng là module duy
    // nhất trong toàn app thiếu export mặc định.
    expect(ROUTE_MODULE_FILES).toContain('pages/admin-guardian-links.tsx');
  });

  for (const file of ROUTE_MODULE_FILES) {
    it(`route module ${file} has a default export`, () => {
      const source = readFileSync(join(SRC_DIR, file), 'utf8');
      expect(
        hasDefaultExport(source),
        `Route module ${file} thiếu export mặc định — React Router framework mode sẽ không gắn được component cho route này`,
      ).toBe(true);
    });
  }
});
