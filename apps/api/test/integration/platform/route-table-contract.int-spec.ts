import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../support/identity-access-helpers';

/**
 * Hợp đồng bảng route tĩnh của các bề mặt đã đổi tên/hợp nhất
 * (issue #345, #342, #343): mọi khẳng định trong spec này hoặc đọc
 * tài liệu OpenAPI của ứng dụng đã boot, hoặc quét tĩnh khai báo
 * `@Controller` trên cây nguồn — không khẳng định nào lái hành vi qua
 * đáp ứng HTTP, nên spec thuộc tầng integration. Hành vi của các bề
 * mặt này (alias mang header Deprecation/Sunset và sinh log cấu trúc
 * `deprecated_route_alias`, đích xuất file theo định dạng) ở lại các
 * spec e2e tương ứng: `test/e2e/platform/action-path-standard`,
 * `test/e2e/platform/grades-path-standard` và
 * `test/e2e/platform/controller-consolidation-r6a1`.
 *
 * Bất biến được ghim: thêm/bớt/đổi bất kỳ route nào thuộc các bề mặt
 * dưới đây đều làm spec đỏ, kể cả khi các flow nghiệp vụ vẫn chạy —
 * các bảng kỳ vọng viết literal là mốc đối chiếu, không sinh từ code
 * đang được kiểm.
 */
/**
 * Bảng route kỳ vọng của ba họ + alias: 100 cặp (method, path) dạng
 * OpenAPI, chụp tại main ngay trước lát dọn (sau khi PR #338 merge)
 * và viết literal tại đây làm mốc đối chiếu bất biến của lát.
 */
const EXPECTED_ROUTES: string[] = [

      'DELETE /exam-matrices/{id}',
      'DELETE /exam-matrices/{id}/cells/{cellId}',
      'DELETE /exam-papers/dossiers/{dossierId}',
      'DELETE /exam-papers/{id}',
      'DELETE /exams/dossiers/{dossierId}',
      'DELETE /exams/{id}',
      'GET /exam-matrices/by-subject/{subjectId}',
      'GET /exam-matrices/template',
      'GET /exam-matrices/{id}',
      'GET /exam-matrices/{id}/attribution',
      'GET /exam-matrices/{id}/availability',
      'GET /exam-matrices/{id}/generated-exams',
      'GET /exam-matrices/{id}/specification',
      'GET /exam-matrices/{id}/specification/export',
      'GET /exam-matrices/{id}/versions/{version}',
      'GET /exam-papers/banks/{bankId}/contributions',
      'GET /exam-papers/banks/{bankId}/dossiers',
      'GET /exam-papers/banks/{bankId}/exams',
      'GET /exam-papers/dossiers/mine',
      'GET /exam-papers/dossiers/{dossierId}',
      'GET /exam-papers/dossiers/{dossierId}/specification',
      'GET /exam-papers/dossiers/{dossierId}/specification/export',
      'GET /exam-papers/{id}',
      'GET /exam-papers/{id}/pins',
      'GET /exam-papers/{id}/print',
      'GET /exam-papers/{id}/specification',
      'GET /exam-papers/{id}/specification/export',
      'GET /exams/banks/{bankId}/contributions',
      'GET /exams/banks/{bankId}/dossiers',
      'GET /exams/banks/{bankId}/exams',
      'GET /exams/dossiers/mine',
      'GET /exams/dossiers/{dossierId}',
      'GET /exams/dossiers/{dossierId}/specification',
      'GET /exams/dossiers/{dossierId}/specification/export',
      'GET /exams/{id}',
      'GET /exams/{id}/pins',
      'GET /exams/{id}/print',
      'GET /exams/{id}/specification',
      'GET /exams/{id}/specification/export',
      'GET /question-banks',
      'GET /question-banks/matrix-contributions/mine',
      'GET /question-banks/{bankId}/matrices',
      'GET /question-banks/{bankId}/matrix-contributions',
      'GET /question-banks/{id}',
      'GET /question-banks/{id}/contributions',
      'PATCH /exam-matrices/{id}',
      'PATCH /exam-matrices/{id}/cells/{cellId}',
      'PATCH /exam-papers/{id}',
      'PATCH /exams/{id}',
      'POST /exam-matrices',
      'POST /exam-matrices/import',
      'POST /exam-matrices/import/preview',
      'POST /exam-matrices/{id}/cells',
      'POST /exam-matrices/{id}/contributions',
      'POST /exam-matrices/{id}/copy',
      'POST /exam-matrices/{id}/generate',
      'POST /exam-matrices/{id}/restore',
      'POST /exam-matrices/{id}/withdraw',
      'POST /exam-papers/banks/{bankId}/contributions',
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/approve',
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/board-approve',
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/board-reject',
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/reject',
      'POST /exam-papers/banks/{bankId}/exams',
      'POST /exam-papers/dossiers/{dossierId}/approve',
      'POST /exam-papers/dossiers/{dossierId}/board-approve',
      'POST /exam-papers/dossiers/{dossierId}/board-reject',
      'POST /exam-papers/dossiers/{dossierId}/reject',
      'POST /exam-papers/dossiers/{dossierId}/submit',
      'POST /exam-papers/{id}/copy',
      'POST /exam-papers/{id}/dossiers',
      'POST /exam-papers/{id}/restore',
      'POST /exam-papers/{id}/status',
      'POST /exam-papers/{id}/swap',
      'POST /exam-papers/{id}/withdraw',
      'POST /exams/banks/{bankId}/contributions',
      'POST /exams/banks/{bankId}/contributions/{contributionId}/approve',
      'POST /exams/banks/{bankId}/contributions/{contributionId}/board-approve',
      'POST /exams/banks/{bankId}/contributions/{contributionId}/board-reject',
      'POST /exams/banks/{bankId}/contributions/{contributionId}/reject',
      'POST /exams/banks/{bankId}/exams',
      'POST /exams/dossiers/{dossierId}/approve',
      'POST /exams/dossiers/{dossierId}/board-approve',
      'POST /exams/dossiers/{dossierId}/board-reject',
      'POST /exams/dossiers/{dossierId}/reject',
      'POST /exams/dossiers/{dossierId}/submit',
      'POST /exams/{id}/copy',
      'POST /exams/{id}/dossiers',
      'POST /exams/{id}/restore',
      'POST /exams/{id}/status',
      'POST /exams/{id}/swap',
      'POST /exams/{id}/withdraw',
      'POST /question-banks',
      'POST /question-banks/{bankId}/matrix-contributions/{contributionId}/approve',
      'POST /question-banks/{bankId}/matrix-contributions/{contributionId}/reject',
      'POST /question-banks/{id}/contributions',
      'POST /question-banks/{id}/contributions/{contributionId}/approve',
      'POST /question-banks/{id}/contributions/{contributionId}/reject',
      'PUT /exam-papers/{id}/slots',
      'PUT /exams/{id}/slots'

];

/** Bốn tiền tố thuộc phạm vi lát và lớp controller sở hữu duy nhất kỳ vọng của từng tiền tố. */
const EXPECTED_OWNERS: Record<string, string> = {
  'exam-matrices': 'ExamMatricesController',
  'question-banks': 'QuestionBanksController',
  exams: 'ExamsController',
  'exam-papers': 'ExamPapersAliasController',
};

/**
 * Dựng bảng route + bản đồ sở hữu bằng cách quét tĩnh các file
 * controller trong `apps/api/src/modules`: đọc khai báo `@Controller`
 * của từng lớp và các decorator method của nó. Comment được lột bỏ
 * trước khi quét để các decorator chỉ được nhắc trong TSDoc (ví dụ
 * `@Post(':id/cells')` trong văn bản mô tả) không bị tính là route.
 */
function scanControllers(): { routes: string[]; owners: Map<string, Set<string>> } {
  const modulesDir = join(process.cwd(), 'src', 'modules');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.controller.ts')) files.push(path);
    }
  };
  walk(modulesDir);

  const parsePathSpec = (spec: string): string[] => {
    const trimmed = spec.trim();
    if (trimmed.startsWith('[')) return [...trimmed.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    const single = trimmed.match(/^'([^']*)'$/);
    if (single) return [single[1] ?? ''];
    const obj = trimmed.match(/path:\s*(\[[^\]]*\]|'[^']*')/);
    return obj ? parsePathSpec(obj[1] ?? '') : [];
  };

  const routes: string[] = [];
  const owners = new Map<string, Set<string>>();
  const ctrlRe = /@Controller\((\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|'[^']*')\)(?:\s|\/\*[\s\S]*?\*\/|@\w+(?:\([^)]*\))?)*export class (\w+)/g;
  const methodRe = /@(Get|Post|Patch|Put|Delete|Options|Head)\(\s*(?:'([^']*)')?\s*\)/g;

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const classes: { spec: string; cls: string; start: number; bodyStart: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = ctrlRe.exec(text)) !== null) {
      classes.push({ spec: m[1] ?? '', cls: m[2] ?? '', start: m.index, bodyStart: ctrlRe.lastIndex });
    }
    for (let i = 0; i < classes.length; i++) {
      const current = classes[i];
      if (!current) continue;
      const end = i + 1 < classes.length ? classes[i + 1]?.start : text.length;
      const body = text.slice(current.bodyStart, end);
      const prefixes = parsePathSpec(current.spec);
      for (const prefix of prefixes) {
        if (!owners.has(prefix)) owners.set(prefix, new Set());
        owners.get(prefix)?.add(current.cls);
      }
      let mm: RegExpExecArray | null;
      methodRe.lastIndex = 0;
      while ((mm = methodRe.exec(body)) !== null) {
        const method = (mm[1] ?? '').toUpperCase();
        const sub = (mm[2] ?? '').replace(/^\/+|\/+$/g, '');
        for (const prefix of prefixes) {
          const raw = sub ? `${prefix}/${sub}` : prefix;
          const path = '/' + raw.split('/').map((s) => (s.startsWith(':') ? `{${s.slice(1)}}` : s)).join('/');
          routes.push(`${method} ${path}`);
        }
      }
    }
  }
  return { routes, owners };
}

describe('Hợp đồng bảng route tĩnh (issue #345, #342, #343)', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = await createTestApp();
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('LMS API').setDescription('route table contract probe').setVersion('1.0').build(),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('bảng route các bề mặt đổi tên (issue #345): đúng 8 route canonical và 8 route alias', () => {
    // Tập kỳ vọng viết literal: 8 canonical + 8 alias, dạng path OpenAPI.
    const expected = [
      // Canonical: động từ chuẩn theo danh sách hành động đóng.
      'POST /badges/{id}/copy',
      'POST /competencies/frameworks/{id}/copy',
      'POST /courses/{id}/copy',
      'POST /courses/{id}/sections/{sectionId}/copy',
      'POST /courses/{id}/modules/{cmId}/copy',
      'POST /users/{id}/reactivate',
      'GET /calendar/exports',
      'GET /courses/{courseId}/progress/reports',
      // Alias: segment cũ giữ song song kèm Deprecation/Sunset + log.
      'POST /badges/{id}/duplicate',
      'POST /competencies/frameworks/{id}/duplicate',
      'POST /courses/{id}/duplicate',
      'POST /courses/{id}/sections/{sectionId}/duplicate',
      'POST /courses/{id}/modules/{cmId}/duplicate',
      'POST /users/{id}/unsuspend',
      'GET /calendar/export.ics',
      'GET /courses/{courseId}/progress/report.csv',
    ];

    // Chỉ chọn đúng các bề mặt đổi tên của issue này: các path có
    // segment hành động thuộc tập đang đổi (canonical hoặc alias).
    const surfacePatterns = [
      /^\/badges\/\{[^}]+\}\/(copy|duplicate)$/,
      /^\/competencies\/frameworks\/\{[^}]+\}\/(copy|duplicate)$/,
      /^\/courses\/\{[^}]+\}\/(copy|duplicate)$/,
      /^\/courses\/\{[^}]+\}\/sections\/\{[^}]+\}\/(copy|duplicate)$/,
      /^\/courses\/\{[^}]+\}\/modules\/\{[^}]+\}\/(copy|duplicate)$/,
      /^\/users\/\{[^}]+\}\/(reactivate|unsuspend)$/,
      /^\/calendar\/(exports|export\.ics)$/,
      /^\/courses\/\{[^}]+\}\/progress\/(reports|report\.csv)$/,
    ];
    const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
    const actual: string[] = [];
    for (const [rawPath, pathItem] of Object.entries(document.paths ?? {})) {
      // Chuẩn hoá: bỏ tiền tố /api/v1 nếu tài liệu mang tiền tố đó.
      const path = rawPath.startsWith('/api/v1/') ? rawPath.slice('/api/v1'.length) : rawPath;
      if (!surfacePatterns.some((pattern) => pattern.test(path))) continue;
      for (const method of Object.keys(pathItem ?? {})) {
        if (httpMethods.has(method)) actual.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(actual.sort()).toEqual([...expected].sort());
  });

  it('bảng route bề mặt điểm (issue #342): đúng 13 route canonical và 12 route alias', () => {
    // Tập kỳ vọng viết literal: 13 canonical + 12 alias, dạng path OpenAPI.
    const expected = [
      // Canonical thuộc khoá học.
      'POST /courses/{courseId}/grade-items',
      'GET /courses/{courseId}/grade-items',
      'GET /courses/{courseId}/gradebook',
      'GET /courses/{courseId}/gradebook/report',
      'POST /courses/{courseId}/grade-exports',
      // Canonical gắn với grade item.
      'PATCH /grade-items/{itemId}',
      'DELETE /grade-items/{itemId}',
      'POST /grade-items/{itemId}/grades',
      'PUT /grade-items/{itemId}/posting-policy',
      'POST /grade-items/{itemId}/publish',
      'POST /grade-items/{itemId}/unpublish',
      'GET /grade-items/{itemId}/users/{userId}/history',
      // Canonical gắn với bản ghi điểm.
      'PATCH /grades/{gradeId}',
      // Alias thuộc khoá học.
      'POST /courses/{courseId}/grades/items',
      'GET /courses/{courseId}/grades/items',
      'GET /courses/{courseId}/grades/report',
      'POST /courses/{courseId}/grades/export/vnedu',
      // Alias "phantom" dưới tiền tố courses/grades.
      'PATCH /courses/grades/items/{itemId}',
      'DELETE /courses/grades/items/{itemId}',
      'POST /courses/grades/items/{itemId}/grades',
      'PATCH /courses/grades/grades/{gradeId}',
      'PUT /courses/grades/items/{itemId}/posting-policy',
      'POST /courses/grades/items/{itemId}/publish',
      'POST /courses/grades/items/{itemId}/unpublish',
      'GET /courses/grades/items/{itemId}/users/{userId}/history',
    ];

    const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
    const actual: string[] = [];
    for (const [rawPath, pathItem] of Object.entries(document.paths ?? {})) {
      // Chuẩn hoá: bỏ tiền tố /api/v1 nếu tài liệu mang tiền tố đó.
      const path = rawPath.startsWith('/api/v1/') ? rawPath.slice('/api/v1'.length) : rawPath;
      const segments = path.split('/').filter(Boolean);
      // Chỉ lấy bề mặt điểm của module điểm: các path bắt đầu bằng
      // /courses/, /grade-items/ hoặc /grades/ và có segment điểm —
      // loại các bề mặt khác cũng nhắc tới điểm (ví dụ gradebook của
      // phụ huynh dưới /guardian/).
      const isGradesSurface = (path.startsWith('/courses/') || path.startsWith('/grade-items/') || path.startsWith('/grades/'))
        && (segments.some((segment) => ['grade-items', 'gradebook', 'grade-exports', 'grades'].includes(segment)) || path.includes('/grades/'));
      if (!isGradesSurface) continue;
      for (const method of Object.keys(pathItem ?? {})) {
        if (httpMethods.has(method)) actual.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(actual.sort()).toEqual([...expected].sort());
  });

  it('bảng route qua tài liệu OpenAPI của ba họ ngân hàng bằng đúng bảng trước khi hợp nhất (issue #343)', () => {
    const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
    const actual: string[] = [];
    for (const [rawPath, pathItem] of Object.entries(document.paths ?? {})) {
      const path = rawPath.startsWith('/api/v1/') ? rawPath.slice('/api/v1'.length) : rawPath;
      const first = path.split('/').filter(Boolean)[0] ?? '';
      if (!Object.hasOwn(EXPECTED_OWNERS, first)) continue;
      for (const method of Object.keys(pathItem ?? {})) {
        if (httpMethods.has(method)) actual.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(actual.sort()).toEqual([...EXPECTED_ROUTES].sort());
  });

  it('bảng route bề mặt duyệt đóng góp và bộ hồ sơ (issue #345, giai đoạn 2): đúng 4 canonical, 4 alias board-* và 8 route gương exam-papers', () => {
    // Tập kỳ vọng viết literal: 4 canonical `/exams` + 4 alias
    // `/exams` mang `board-*` + 8 route gương `/exam-papers`.
    const expected = [
      // Canonical `/exams`: một động từ duyệt duy nhất cho cả hai cấp.
      'POST /exams/banks/{bankId}/contributions/{contributionId}/approve',
      'POST /exams/banks/{bankId}/contributions/{contributionId}/reject',
      'POST /exams/dossiers/{dossierId}/approve',
      'POST /exams/dossiers/{dossierId}/reject',
      // Alias `/exams`: segment cũ giữ song song kèm Deprecation/Sunset + log.
      'POST /exams/banks/{bankId}/contributions/{contributionId}/board-approve',
      'POST /exams/banks/{bankId}/contributions/{contributionId}/board-reject',
      'POST /exams/dossiers/{dossierId}/board-approve',
      'POST /exams/dossiers/{dossierId}/board-reject',
      // Gương `/exam-papers` của cụm alias #343: giữ đủ cả hai dạng.
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/approve',
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/reject',
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/board-approve',
      'POST /exam-papers/banks/{bankId}/contributions/{contributionId}/board-reject',
      'POST /exam-papers/dossiers/{dossierId}/approve',
      'POST /exam-papers/dossiers/{dossierId}/reject',
      'POST /exam-papers/dossiers/{dossierId}/board-approve',
      'POST /exam-papers/dossiers/{dossierId}/board-reject',
    ];

    // Chỉ chọn đúng hai bề mặt duyệt của giai đoạn 2: đóng góp và bộ
    // hồ sơ, với động từ thuộc tập đang hợp nhất.
    const surfacePatterns = [
      /^\/(exams|exam-papers)\/banks\/\{[^}]+\}\/contributions\/\{[^}]+\}\/(approve|reject|board-approve|board-reject)$/,
      /^\/(exams|exam-papers)\/dossiers\/\{[^}]+\}\/(approve|reject|board-approve|board-reject)$/,
    ];
    const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
    const actual: string[] = [];
    for (const [rawPath, pathItem] of Object.entries(document.paths ?? {})) {
      const path = rawPath.startsWith('/api/v1/') ? rawPath.slice('/api/v1'.length) : rawPath;
      if (!surfacePatterns.some((pattern) => pattern.test(path))) continue;
      for (const method of Object.keys(pathItem ?? {})) {
        if (httpMethods.has(method)) actual.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(actual.sort()).toEqual([...expected].sort());
  });
});

describe('Hợp đồng bảng route tĩnh — phép quét tĩnh cây nguồn (issue #343)', () => {
  it('mỗi tiền tố của ba họ ngân hàng có đúng một lớp controller sở hữu (issue #343)', () => {
    const { owners } = scanControllers();
    for (const [prefix, expectedClass] of Object.entries(EXPECTED_OWNERS)) {
      expect([...(owners.get(prefix) ?? [])]).toEqual([expectedClass]);
    }
  });

  it('bảng route quét tĩnh từ khai báo controller của ba họ ngân hàng bằng đúng bảng trước khi hợp nhất (issue #343)', () => {
    const { routes } = scanControllers();
    const familyRoutes = routes.filter((r) => {
      const first = r.split(' ')[1]?.split('/')[1] ?? '';
      return Object.hasOwn(EXPECTED_OWNERS, first);
    });
    expect(familyRoutes.sort()).toEqual([...EXPECTED_ROUTES].sort());
  });
});
