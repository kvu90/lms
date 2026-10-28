import { Logger } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeprecatedRouteAliasInterceptor } from './deprecated-route-alias.interceptor';

/**
 * Kiểm chứng interceptor alias dùng chung cho các path đổi tên theo
 * danh sách hành động đóng (issue #345) và path làm phẳng (issue #346):
 * lượt gọi qua path cũ phải
 * được gắn header Deprecation/Sunset và sinh đúng một bản ghi log có
 * cấu trúc `deprecated_route_alias` trỏ từ alias sang canonical; lượt
 * gọi qua path canonical không bị gắn header và không sinh log alias.
 * Đây là lưới cho điều kiện gỡ alias (dựa trên log alias) nên cặp
 * alias/canonical trong log phải khớp đúng bảng đích của từng bề mặt.
 */
describe('DeprecatedRouteAliasInterceptor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Dựng ngữ cảnh HTTP giả: request mang url/method cho trước, response ghi lại các header được gắn. */
  function buildContext(url: string, method = 'GET') {
    const headers = new Map<string, string>();
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ url, method }),
        getResponse: () => ({ setHeader: (name: string, value: string) => { headers.set(name, value); } }),
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(null) };
    return { context, next, headers };
  }

  /** Các cặp alias → canonical của việc áp danh sách hành động đóng: [url cụ thể, method, alias mẫu, canonical mẫu] — tám cặp giai đoạn 1 ngoài module exams cộng bốn cặp giai đoạn 2 trong module exams (`board-*` → `approve`/`reject`) cộng một cặp làm phẳng của issue #346 (gradebook của phụ huynh). */
  const aliasCases: [string, string, string, string][] = [
    ['/api/v1/badges/01900000-0000-7000-8000-000000000001/duplicate', 'POST', 'badges/:id/duplicate', 'badges/:id/copy'],
    ['/api/v1/competencies/frameworks/01900000-0000-7000-8000-000000000001/duplicate', 'POST', 'competencies/frameworks/:id/duplicate', 'competencies/frameworks/:id/copy'],
    ['/api/v1/courses/01900000-0000-7000-8000-000000000001/duplicate', 'POST', 'courses/:id/duplicate', 'courses/:id/copy'],
    ['/api/v1/courses/01900000-0000-7000-8000-000000000001/sections/01900000-0000-7000-8000-000000000002/duplicate', 'POST', 'courses/:id/sections/:sectionId/duplicate', 'courses/:id/sections/:sectionId/copy'],
    ['/api/v1/courses/01900000-0000-7000-8000-000000000001/modules/01900000-0000-7000-8000-000000000002/duplicate', 'POST', 'courses/:id/modules/:cmId/duplicate', 'courses/:id/modules/:cmId/copy'],
    ['/api/v1/users/01900000-0000-7000-8000-000000000001/unsuspend', 'POST', 'users/:id/unsuspend', 'users/:id/reactivate'],
    ['/api/v1/calendar/export.ics', 'GET', 'calendar/export.ics', 'calendar/exports?format=ics'],
    ['/api/v1/courses/01900000-0000-7000-8000-000000000001/progress/report.csv', 'GET', 'courses/:courseId/progress/report.csv', 'courses/:courseId/progress/reports?format=csv'],
    ['/api/v1/exams/banks/01900000-0000-7000-8000-000000000001/contributions/01900000-0000-7000-8000-000000000002/board-approve', 'POST', 'exams/banks/:bankId/contributions/:contributionId/board-approve', 'exams/banks/:bankId/contributions/:contributionId/approve'],
    ['/api/v1/exams/banks/01900000-0000-7000-8000-000000000001/contributions/01900000-0000-7000-8000-000000000002/board-reject', 'POST', 'exams/banks/:bankId/contributions/:contributionId/board-reject', 'exams/banks/:bankId/contributions/:contributionId/reject'],
    ['/api/v1/exams/dossiers/01900000-0000-7000-8000-000000000001/board-approve', 'POST', 'exams/dossiers/:dossierId/board-approve', 'exams/dossiers/:dossierId/approve'],
    ['/api/v1/exams/dossiers/01900000-0000-7000-8000-000000000001/board-reject', 'POST', 'exams/dossiers/:dossierId/board-reject', 'exams/dossiers/:dossierId/reject'],
    // Cặp làm phẳng của issue #346 (path gradebook cũ của phụ huynh).
    ['/api/v1/guardian/students/01900000-0000-7000-8000-000000000001/courses/01900000-0000-7000-8000-000000000002/gradebook', 'GET', 'guardian/students/:studentId/courses/:courseId/gradebook', 'guardian/students/:studentId/gradebooks/:courseId'],
  ];

  it.each(aliasCases)('marks alias URL %s with Deprecation/Sunset headers and one structured warn log', async (url, method, alias, canonical) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new DeprecatedRouteAliasInterceptor();
    const { context, next, headers } = buildContext(`${url}?foo=bar`, method);

    await lastValueFrom(interceptor.intercept(context, next));

    expect(headers.get('Deprecation')).toBe('true');
    expect(headers.get('Sunset')).toBe('Sun, 01 Feb 2027 00:00:00 GMT');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged.event).toBe('deprecated_route_alias');
    expect(logged.method).toBe(method);
    expect(logged.alias).toBe(alias);
    expect(logged.canonical).toBe(canonical);
    // Path trong log là path cụ thể của lượt gọi, không kèm query string.
    expect(logged.path).toBe(url);
  });

  it.each([
    '/api/v1/badges/01900000-0000-7000-8000-000000000001/copy',
    '/api/v1/courses/01900000-0000-7000-8000-000000000001/copy',
    '/api/v1/users/01900000-0000-7000-8000-000000000001/reactivate',
    '/api/v1/calendar/exports?format=ics',
    '/api/v1/courses/01900000-0000-7000-8000-000000000001/progress/reports?format=csv',
    '/api/v1/exams/banks/01900000-0000-7000-8000-000000000001/contributions/01900000-0000-7000-8000-000000000002/approve',
    '/api/v1/exams/dossiers/01900000-0000-7000-8000-000000000001/reject',
    '/api/v1/guardian/students/01900000-0000-7000-8000-000000000001/gradebooks/01900000-0000-7000-8000-000000000002',
  ])('leaves canonical URL %s untouched: no headers, no warn log', async (url) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new DeprecatedRouteAliasInterceptor();
    const { context, next, headers } = buildContext(url, 'POST');

    await lastValueFrom(interceptor.intercept(context, next));

    expect(headers.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
