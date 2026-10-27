import { Logger, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminToken, createTestApp, http } from './identity-access-helpers';

/**
 * Lưới an toàn cho việc dọn controller trùng path của ba họ ngân hàng
 * (issue #343, cụm R6-A1): hợp nhất mỗi họ `exam-matrices`,
 * `question-banks`, `exams` về đúng một controller sở hữu và gom
 * toàn bộ bề mặt alias `exam-papers` về một controller alias duy
 * nhất.
 *
 * Ba khẳng định chính:
 * - Phép quét tĩnh khai báo `@Controller` trên cây nguồn: mỗi tiền
 *   tố trong bốn tiền tố (ba họ + alias) có đúng một lớp controller
 *   sở hữu, và bảng route (method + path) dựng từ chính các khai báo
 *   đó bằng đúng bảng đã chụp tại trạng thái trước khi dọn (100
 *   route viết literal dưới đây).
 * - Bảng route chụp qua tài liệu OpenAPI của ứng dụng đã boot cũng
 *   bằng đúng bảng đó — thêm/bớt/đổi bất kỳ route nào của ba họ đều
 *   làm spec này đỏ, kể cả khi các flow nghiệp vụ vẫn chạy.
 * - Hành vi alias: path `/exam-papers` vẫn tới được đúng handler
 *   (kết quả như canonical), response qua alias mang header
 *   Deprecation/Sunset và mỗi lượt gọi alias sinh đúng một bản ghi
 *   log có cấu trúc `deprecated_route_alias`; path canonical không
 *   mang header đó và không sinh log alias. Log alias là căn cứ của
 *   điều kiện gỡ alias (0 lượt gọi trong 14 ngày), nên spec kiểm cả
 *   nội dung bản ghi log, không chỉ kiểm header.
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

describe('Controller consolidation R6-A1 (issue #343) — phép quét tĩnh', () => {
  it('gives each prefix of the three families exactly one owning controller class', () => {
    const { owners } = scanControllers();
    for (const [prefix, expectedClass] of Object.entries(EXPECTED_OWNERS)) {
      expect([...(owners.get(prefix) ?? [])]).toEqual([expectedClass]);
    }
  });

  it('keeps the statically scanned route table of the three families identical to the pre-consolidation table', () => {
    const { routes } = scanControllers();
    const familyRoutes = routes.filter((r) => {
      const first = r.split(' ')[1]?.split('/')[1] ?? '';
      return Object.hasOwn(EXPECTED_OWNERS, first);
    });
    expect(familyRoutes.sort()).toEqual([...EXPECTED_ROUTES].sort());
  });
});

describe('Controller consolidation R6-A1 (issue #343) — OpenAPI và hành vi alias', () => {
  let app: INestApplication;
  let admin: string;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('LMS API').setDescription('controller consolidation probe').setVersion('1.0').build(),
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('documents exactly the pre-consolidation route table for the three families', () => {
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

  it('serves the exam-papers alias with deprecation headers and structured logs while canonical routes stay unmarked', async () => {
    // Bank đề trường để có bankId thật cho route danh sách đề theo bank.
    const bankRes = await http(app).post('/api/v1/question-banks').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Ngân hàng đề trường R6-A1', scope: 'school', bankKind: 'exam' });
    expect(bankRes.status, JSON.stringify(bankRes.body)).toBeLessThan(300);
    const bankId = (bankRes.body as { id: string }).id;

    // Bắt đầu theo dõi log cảnh báo từ đây để các bản ghi bắt được
    // chỉ đến từ các lượt gọi alias bên dưới.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // GET canonical danh sách đề theo bank: 200, tuyệt đối không header sắp bỏ.
    const canonicalList = await http(app).get(`/api/v1/exams/banks/${bankId}/exams`).set('Authorization', `Bearer ${admin}`);
    expect(canonicalList.status).toBe(200);
    expect(canonicalList.headers['deprecation']).toBeUndefined();

    // GET alias cùng bề mặt: 200 với cùng kết quả, kèm header sắp bỏ.
    const aliasList = await http(app).get(`/api/v1/exam-papers/banks/${bankId}/exams`).set('Authorization', `Bearer ${admin}`);
    expect(aliasList.status).toBe(200);
    expect(aliasList.body).toEqual(canonicalList.body);
    expect(aliasList.headers['deprecation']).toBe('true');
    expect(aliasList.headers['sunset']).toContain('2027');

    // GET canonical hồ sơ của tôi: 200, không header sắp bỏ.
    const canonicalMine = await http(app).get('/api/v1/exams/dossiers/mine').set('Authorization', `Bearer ${admin}`);
    expect(canonicalMine.status).toBe(200);
    expect(canonicalMine.headers['deprecation']).toBeUndefined();

    // GET alias bề mặt hồ sơ đề (phần đã gộp từ controller hồ sơ cũ):
    // 200, kèm header sắp bỏ.
    const aliasMine = await http(app).get('/api/v1/exam-papers/dossiers/mine').set('Authorization', `Bearer ${admin}`);
    expect(aliasMine.status).toBe(200);
    expect(aliasMine.body).toEqual(canonicalMine.body);
    expect(aliasMine.headers['deprecation']).toBe('true');

    // Các bản ghi log alias đã sinh phải là JSON có cấu trúc của sự
    // kiện deprecated_route_alias, trỏ đúng cặp alias → canonical
    // cho cả hai bề mặt (đề theo bank và hồ sơ của tôi).
    const aliasLogs = warn.mock.calls
      .map((call) => String(call[0]))
      .flatMap((message) => {
        try {
          return [JSON.parse(message) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .filter((entry) => entry.event === 'deprecated_route_alias');
    expect(aliasLogs.some((entry) => entry.alias === 'exam-papers/banks/:bankId/exams' && entry.canonical === 'exams/banks/:bankId/exams')).toBe(true);
    expect(aliasLogs.some((entry) => entry.alias === 'exam-papers/dossiers/mine' && entry.canonical === 'exams/dossiers/mine')).toBe(true);
  });
});
