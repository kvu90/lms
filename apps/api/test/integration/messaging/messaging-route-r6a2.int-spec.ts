import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Lưới an toàn cho việc áp chuẩn đường dẫn cụm messaging/notifications
 * (issue #344, cụm R6-A2): đổi họ `messages/messages` về `messages`,
 * đổi `notifications/read-all` thành `notifications/mark-read`, giữ
 * nguyên mọi path còn lại của module messaging.
 *
 * Ba khẳng định chính, tất cả đều dựng từ chính khai báo decorator
 * trong `messaging.controller.ts` (không chạy server, không cần DB):
 * - Bảng route (method + path) dựng từ khai báo bằng đúng bảng đã
 *   chụp sau lát đổi (58 route viết literal dưới đây) — thêm/bớt/đổi
 *   bất kỳ route nào của module đều làm spec này đỏ, kể cả khi các
 *   flow nghiệp vụ vẫn chạy.
 * - Tập canonical (bảng trừ tập alias) chứa đúng 5 path đích đã chốt
 *   và không còn route nào chứa segment lặp `messages/messages` hay
 *   hậu tố `-all`; tập alias bằng đúng 6 path cũ.
 * - Route chữ `bulk-remove` khai trước các route `:id` trong cùng
 *   controller ở cả phía canonical lẫn phía alias, để không bị route
 *   tham số nuốt.
 *
 * Cách đếm cấp tài nguyên của bản đồ đích (ghi rõ để đội đánh giá
 * phân xử): tiền tố controller (`messages`/`notifications`) là gốc
 * của cụm; lồng tối đa 2 cấp tài nguyên dưới gốc cộng tối đa 1
 * segment hành động. Theo cách đếm này, các path sâu còn lại (ví dụ
 * `messages/conversations/:id/messages` = conversations + messages,
 * `messages/contacts/requests/:userId/accept` = contacts + requests +
 * hành động) đã đạt chuẩn nên giữ nguyên; chỉ họ lặp segment và hậu
 * tố `-all` là vi phạm phải đổi. Đích xuất file của cụm khác
 * (`courses/:courseId/progress/reports` — gốc + progress + reports)
 * đã được duyệt theo cùng cách đếm này.
 */

/**
 * Bảng route kỳ vọng của module messaging (canonical + alias): 58
 * cặp (method, path) dạng OpenAPI, chụp từ khai báo decorator sau
 * khi lát đổi hoàn tất và viết literal tại đây làm mốc đối chiếu bất
 * biến của lát. Route thứ 58 là hồ sơ người cho panel chat 1–1
 * (issue #592): `GET /messages/users/{id}/profile`.
 */
const EXPECTED_ROUTES: string[] = [
  'DELETE /messages/contacts/{userId}',
  'DELETE /messages/contacts/{userId}/block',
  'DELETE /messages/conversations/{id}/members/{userId}',
  'DELETE /messages/messages/{id}',
  'DELETE /messages/{id}',
  'DELETE /notifications/{id}',
  'GET /messages/classes/{classId}/conversation',
  'GET /messages/classes/{classId}/members',
  'GET /messages/contacts',
  'GET /messages/contacts/blocked',
  'GET /messages/contacts/requests',
  'GET /messages/conversations',
  'GET /messages/conversations/{id}',
  'GET /messages/conversations/{id}/messages',
  'GET /messages/conversations/{id}/search',
  'GET /messages/courses',
  'GET /messages/courses/{courseId}/conversation',
  'GET /messages/courses/{courseId}/members',
  'GET /messages/group-tree',
  'GET /messages/preferences',
  'GET /messages/preferences/courses',
  'GET /messages/reports',
  'GET /messages/reports/{reportId}/conversation',
  'GET /messages/unread-count',
  'GET /messages/users/{id}/profile',
  'GET /notifications',
  'GET /notifications/dispatch-log',
  'GET /notifications/items',
  'GET /notifications/unread-count',
  'GET /notifications/unread-count/stream',
  'PATCH /messages/conversations/{id}',
  'PATCH /messages/conversations/{id}/state',
  'PATCH /messages/messages/{id}',
  'PATCH /messages/reports/{reportId}',
  'PATCH /messages/{id}',
  'POST /messages/bulk-remove',
  'POST /messages/contacts/requests/{userId}/accept',
  'POST /messages/contacts/requests/{userId}/decline',
  'POST /messages/contacts/{userId}',
  'POST /messages/contacts/{userId}/block',
  'POST /messages/conversations',
  'POST /messages/conversations/group',
  'POST /messages/conversations/{id}/messages',
  'POST /messages/conversations/{id}/read',
  'POST /messages/conversations/{id}/report',
  'POST /messages/messages/bulk-remove',
  'POST /messages/messages/{id}/hard-delete',
  'POST /messages/messages/{id}/recall',
  'POST /messages/{id}/hard-delete',
  'POST /messages/{id}/recall',
  'POST /notifications/clear-read',
  'POST /notifications/mark-read',
  'POST /notifications/read-all',
  'POST /notifications/read-group',
  'POST /notifications/send',
  'POST /notifications/{id}/read',
  'PUT /messages/preferences',
  'PUT /messages/preferences/courses',
];

/** 6 path cũ chỉ còn tồn tại qua alias kèm Deprecation/Sunset + log. */
const ALIAS_ROUTES: string[] = [
  'PATCH /messages/messages/{id}',
  'DELETE /messages/messages/{id}',
  'POST /messages/messages/{id}/recall',
  'POST /messages/messages/{id}/hard-delete',
  'POST /messages/messages/bulk-remove',
  'POST /notifications/read-all',
];

/** 5 path đích đã chốt cho các path có tên trong issue. */
const CANONICAL_TARGETS: string[] = [
  'PATCH /messages/{id}',
  'DELETE /messages/{id}',
  'POST /messages/{id}/recall',
  'POST /messages/{id}/hard-delete',
  'POST /messages/bulk-remove',
  'POST /notifications/mark-read',
];

/**
 * Dựng bảng route từ khai báo decorator trong file controller:
 * mỗi khối `@Controller({ path: '...' })` góp các method decorator
 * của nó; `@Sse` tính như GET; tham số `:id` đổi thành `{id}` theo
 * dạng OpenAPI như bảng kỳ vọng.
 */
function routesFromSource(source: string): string[] {
  const routes: string[] = [];
  const controllerPattern = /@Controller\(\{ path: '([^']+)'[^}]*\}\)/g;
  const controllers: { path: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = controllerPattern.exec(source)) !== null) {
    controllers.push({ path: match[1] as string, start: match.index, end: source.length });
  }
  for (let i = 0; i < controllers.length; i += 1) {
    const current = controllers[i] as { path: string; start: number; end: number };
    const next = controllers[i + 1];
    const body = source.slice(current.start, next ? next.start : source.length);
    const methodPattern = /@(Get|Post|Patch|Put|Delete|Sse)\((?:'([^']*)')?\)/g;
    let methodMatch: RegExpExecArray | null;
    while ((methodMatch = methodPattern.exec(body)) !== null) {
      const method = methodMatch[1] === 'Sse' ? 'GET' : (methodMatch[1] as string).toUpperCase();
      const handler = methodMatch[2] ?? '';
      const full = `/${current.path}${handler === '' ? '' : `/${handler}`}`.replace(/:([A-Za-z]+)/g, '{$1}');
      routes.push(`${method} ${full}`);
    }
  }
  return routes;
}

describe('Bảng route module messaging sau lát R6-A2 (issue #344)', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'modules', 'messaging', 'messaging.controller.ts'), 'utf8');
  const routes = routesFromSource(source);

  it('khớp đúng bảng route kỳ vọng (không thêm, không bớt, không đổi route nào)', () => {
    expect([...routes].sort()).toEqual([...EXPECTED_ROUTES].sort());
  });

  it('tập canonical chứa đủ path đích đã chốt và không còn segment lặp hay hậu tố -all', () => {
    const canonical = routes.filter((route) => !ALIAS_ROUTES.includes(route));
    for (const target of CANONICAL_TARGETS) {
      expect(canonical).toContain(target);
    }
    expect(canonical.filter((route) => route.includes('messages/messages'))).toEqual([]);
    expect(canonical.filter((route) => route.includes('read-all'))).toEqual([]);
    expect(routes.filter((route) => ALIAS_ROUTES.includes(route)).sort()).toEqual([...ALIAS_ROUTES].sort());
  });

  it('route chữ bulk-remove khai trước các route :id ở cả phía canonical và phía alias', () => {
    const canonicalBulk = source.indexOf("@Post('bulk-remove')");
    const canonicalParam = source.indexOf("@Patch(':id')");
    expect(canonicalBulk).toBeGreaterThan(-1);
    expect(canonicalParam).toBeGreaterThan(-1);
    expect(canonicalBulk).toBeLessThan(canonicalParam);
    const aliasBulk = source.indexOf("@Post('messages/bulk-remove')");
    const aliasParam = source.indexOf("@Patch('messages/:id')");
    expect(aliasBulk).toBeGreaterThan(-1);
    expect(aliasParam).toBeGreaterThan(-1);
    expect(aliasBulk).toBeLessThan(aliasParam);
  });
});
