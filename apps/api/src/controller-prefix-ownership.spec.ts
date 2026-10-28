import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Gác bất biến sở hữu tiền tố controller (issue #346 — R6-A4).
 *
 * Luật sở hữu áp dụng: đơn vị sở hữu là tiền tố đầy đủ mà một lớp
 * controller khai báo trong `@Controller({ path })`. Một tiền tố đầy
 * đủ chỉ có đúng một lớp khai báo; vi phạm là khi cùng một tiền tố
 * đầy đủ bị hai lớp trở lên cùng khai, kể cả khi các route con của
 * chúng không trùng tuyệt đối. Hai trường hợp đích danh của issue:
 * tiền tố trơ `courses` chỉ còn module courses sở hữu (lớp
 * `CoursesController`), và tiền tố `guardian` chỉ còn một lớp sở hữu
 * (lớp `GuardianController` sau khi hợp nhất hai lớp cũ).
 *
 * Spec quét trực tiếp các file `*.controller.ts` dưới `src/modules`
 * thay vì khởi động ứng dụng: bất biến này thuộc về hình thức khai
 * báo, và việc quét tĩnh bắt được vi phạm ngay tại bước test rẻ nhất
 * mà không cần DB hay HTTP. Nếu một thay đổi tương lai vô tình khai
 * trùng tiền tố, spec này đỏ và buộc phải tách lớp hoặc đổi tiền tố
 * trước khi merge.
 */

type Declaration = { prefix: string; className: string; file: string };

function collectControllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectControllerFiles(full, out);
    } else if (entry.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

function collectDeclarations(): Declaration[] {
  const modulesDir = join(__dirname, 'modules');
  const declarations: Declaration[] = [];
  const controllerPattern =
    /@Controller\(\s*\{[^}]*?path:\s*['"`]([^'"`]+)['"`][^}]*\}\)[\s\S]*?export\s+class\s+(\w+)/g;
  for (const file of collectControllerFiles(modulesDir)) {
    const text = readFileSync(file, 'utf-8');
    for (const match of text.matchAll(controllerPattern)) {
      declarations.push({ prefix: match[1], className: match[2], file });
    }
  }
  return declarations;
}

describe('Sở hữu tiền tố controller', () => {
  const declarations = collectDeclarations();

  it('mỗi tiền tố đầy đủ chỉ có đúng một lớp controller khai báo', () => {
    const byPrefix = new Map<string, Declaration[]>();
    for (const declaration of declarations) {
      const existing = byPrefix.get(declaration.prefix) ?? [];
      existing.push(declaration);
      byPrefix.set(declaration.prefix, existing);
    }
    const duplicates = [...byPrefix.entries()].filter(([, owners]) => owners.length > 1);
    expect(
      duplicates,
      duplicates.length > 0
        ? `Tiền tố bị khai trùng: ${duplicates.map(([prefix, owners]) => `${prefix} do ${owners.map((o) => o.className).join(', ')} khai`).join('; ')}`
        : 'Không có tiền tố trùng',
    ).toEqual([]);
  });

  it("tiền tố trơ `courses` chỉ còn module courses sở hữu", () => {
    const owners = declarations.filter((d) => d.prefix === 'courses');
    expect(owners.map((o) => o.className)).toEqual(['CoursesController']);
  });

  it("tiền tố `guardian` chỉ còn một lớp sở hữu", () => {
    const owners = declarations.filter((d) => d.prefix === 'guardian');
    expect(owners.map((o) => o.className)).toEqual(['GuardianController']);
  });
});
