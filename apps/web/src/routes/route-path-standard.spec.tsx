import { describe, expect, it } from 'vitest';
import routesConfig from '../routes';

/**
 * Spec khoá bản đồ route của lát R2–R4 (chuẩn đường dẫn #221) trên
 * CHÍNH bảng route thật của app (`src/routes.ts`):
 *
 * - R2: khu vực phụ huynh có gốc `/guardian` và path theo từng con
 *   `/guardian/students/:studentId` — đối tượng chính của khu vực
 *   nằm trong path, không định danh bằng query.
 * - R3: họ Kho học liệu có cây chính viết tách `/content-bank*` và
 *   cả ba path cũ viết dính `/contentbank*` còn được khai làm lớp
 *   tương thích (hành vi chuyển hướng của chúng được kiểm ở
 *   `pages/content-bank-redirect.spec.tsx`).
 * - R4: họ `admin/curriculum` khớp đúng bản đồ rà soát đã duyệt —
 *   danh sách path kỳ vọng viết tay dưới đây là ảnh chụp có chủ
 *   đích của họ, và mọi path đều thuộc đúng một trong hai hình
 *   dạng chuẩn đã tuyên bố cho họ này: (a) TẠO — lồng đúng một cấp
 *   cha trực tiếp, kết thúc bằng `/new`, tối đa một segment tham
 *   số là định danh của cha trực tiếp; (b) SỬA/CHI TIẾT — phẳng
 *   theo định danh của chính tài nguyên. Không tồn tại hình dạng
 *   thứ ba (tạo lồng hai cấp cha, sửa lồng theo cha, path chứa
 *   tham số không phải định danh của tài nguyên đứng trước nó).
 */

/** Mọi (path, route module) đã khai trong bảng route thật (layout Shell + các route ngoài vỏ). */
const ALL_ROUTES: Array<{ path: string; file: string }> = (() => {
  const collected: Array<{ path: string; file: string }> = [];
  const walk = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries as Array<{ path?: string; file?: string; children?: unknown }>) {
      if (typeof entry.path === 'string') collected.push({ path: entry.path, file: entry.file ?? '' });
      walk(entry.children);
    }
  };
  walk(routesConfig);
  return collected;
})();

/** Mọi path đã khai trong bảng route thật. */
const ALL_PATHS: string[] = ALL_ROUTES.map((route) => route.path);

/** Ánh xạ tài nguyên → tên tham số định danh của chính nó trong họ admin/curriculum. */
const RESOURCE_PARAM: Record<string, string> = {
  subjects: ':subjectId',
  curricula: ':curriculumId',
  nodes: ':nodeId',
  outcomes: ':outcomeId',
};

/** Bản đồ rà soát R4: toàn bộ họ admin/curriculum tại thời điểm duyệt lát — path nào lệch danh sách này là thay đổi chưa qua rà soát. */
const EXPECTED_CURRICULUM_PATHS = [
  'admin/curriculum',
  'admin/curriculum/curricula/:curriculumId',
  'admin/curriculum/curricula/:curriculumId/edit',
  'admin/curriculum/curricula/:curriculumId/nodes/new',
  'admin/curriculum/nodes/:nodeId/edit',
  'admin/curriculum/nodes/:nodeId/outcomes/new',
  'admin/curriculum/outcomes/:outcomeId/edit',
  'admin/curriculum/subjects/:subjectId/curricula/new',
  'admin/curriculum/subjects/:subjectId/edit',
  'admin/curriculum/subjects/new',
];

describe('Bản đồ route của lát R2–R4 (chuẩn đường dẫn #221)', () => {
  it('R2: khu vực phụ huynh có gốc và path theo từng con', () => {
    expect(ALL_PATHS).toContain('guardian');
    expect(ALL_PATHS).toContain('guardian/students/:studentId');
  });

  it('R3: Kho học liệu có cây chính viết tách và giữ đủ ba path cũ làm lớp tương thích', () => {
    for (const path of ['content-bank', 'content-bank/new', 'content-bank/:id/edit']) {
      expect(ALL_PATHS).toContain(path);
    }
    for (const path of ['contentbank', 'contentbank/new', 'contentbank/:id/edit']) {
      expect(ALL_PATHS).toContain(path);
    }
  });

  it('không có hai path nào dùng chung một route module (id route suy ra từ file, trùng là lỗi cấu hình khi build)', () => {
    const byFile = new Map<string, string[]>();
    for (const route of ALL_ROUTES) {
      if (!route.file) continue;
      byFile.set(route.file, [...(byFile.get(route.file) ?? []), route.path]);
    }
    const duplicated = [...byFile.entries()].filter(([, paths]) => paths.length > 1);
    expect(duplicated).toEqual([]);
  });

  it('R4: họ admin/curriculum khớp đúng bản đồ rà soát đã duyệt', () => {
    const family = ALL_PATHS.filter((path) => path === 'admin/curriculum' || path.startsWith('admin/curriculum/'));
    expect([...family].sort()).toEqual([...EXPECTED_CURRICULUM_PATHS].sort());
  });

  it('R4: mọi path trong họ thuộc đúng một trong hai hình dạng chuẩn, không có hình dạng thứ ba', () => {
    const family = EXPECTED_CURRICULUM_PATHS.filter((path) => path !== 'admin/curriculum');
    for (const path of family) {
      const segments = path.replace('admin/curriculum/', '').split('/');
      const paramSegments = segments.filter((segment) => segment.startsWith(':'));
      // Mọi segment tham số đều là định danh của chính tài nguyên
      // đứng ngay trước nó (subjects→:subjectId, nodes→:nodeId…).
      segments.forEach((segment, index) => {
        if (segment.startsWith(':')) {
          expect(RESOURCE_PARAM[segments[index - 1]!]).toBe(segment);
        }
      });
      if (segments[segments.length - 1] === 'new') {
        // Hình dạng (a) TẠO: tối đa một tham số — định danh của cha
        // trực tiếp; segment ngay trước 'new' là tên tài nguyên con.
        expect(paramSegments.length).toBeLessThanOrEqual(1);
        expect(Object.keys(RESOURCE_PARAM)).toContain(segments[segments.length - 2]);
      } else {
        // Hình dạng (b) SỬA/CHI TIẾT: đúng một tham số là định danh
        // của tài nguyên chính, không lồng theo cha nào khác.
        expect(paramSegments.length).toBe(1);
      }
    }
  });
});
