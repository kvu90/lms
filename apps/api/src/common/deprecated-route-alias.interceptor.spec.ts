import { Logger } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeprecatedRouteAliasInterceptor } from './deprecated-route-alias.interceptor';

/**
 * Kiểm chứng interceptor alias dùng chung — triển khai duy nhất của
 * khuôn alias đường-cũ — trên cả bốn bề mặt nó phục vụ: (1) hành
 * động đổi tên theo danh sách hành động đóng (issue #345) và path
 * làm phẳng (issue #346); (2) các path cũ của module điểm (issue
 * #342); (3) bề mặt alias `exam-papers` của cụm đề (issue #343);
 * (4) các path alias cũ của cụm messaging/notifications (issue
 * #344). Trên mọi bề mặt: lượt gọi qua path cũ phải được gắn header
 * Deprecation/Sunset và sinh đúng một bản ghi log có cấu trúc
 * `deprecated_route_alias` trỏ từ alias sang canonical; lượt gọi qua
 * path canonical không bị gắn header và không sinh log alias. Đây
 * là lưới cho điều kiện gỡ alias (dựa trên log alias) nên cặp
 * alias/canonical trong log phải khớp đúng bảng đích của từng bề
 * mặt, và thứ tự khớp (cụ thể trước tổng quát) phải phân loại đúng
 * các ca dễ bị mẫu tổng quát nuốt như `dossiers/mine`,
 * `:id/dossiers` hay `bulk-remove`.
 */
describe('Khối DeprecatedRouteAliasInterceptor', () => {
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

  /** Chạy interceptor trên một URL alias (kèm query string) và khẳng định header Deprecation/Sunset cùng đúng một bản ghi log khớp cả năm trường. */
  async function assertAlias(url: string, method: string, alias: string, canonical: string) {
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
  }

  /** Chạy interceptor trên một URL canonical và khẳng định không gắn header, không sinh log alias. */
  async function assertCanonicalUntouched(url: string, method = 'POST') {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new DeprecatedRouteAliasInterceptor();
    const { context, next, headers } = buildContext(url, method);

    await lastValueFrom(interceptor.intercept(context, next));

    expect(headers.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  }

  describe('Bề mặt đổi tên action và đường dẫn phẳng', () => {
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

    it.each(aliasCases)('đánh dấu URL alias %s bằng header Deprecation/Sunset và một log warn có cấu trúc', async (url, method, alias, canonical) => {
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
    ])('để nguyên URL canonical %s: không header, không log warn', async (url) => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const interceptor = new DeprecatedRouteAliasInterceptor();
      const { context, next, headers } = buildContext(url, 'POST');

      await lastValueFrom(interceptor.intercept(context, next));

      expect(headers.size).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('Bề mặt grades', () => {
    /** Toàn bộ 10 mục của bảng alias module điểm: [url cụ thể, method, alias mẫu, canonical mẫu] — gồm cả họ thuộc khoá học (`courses/:courseId/grades/...`) và họ "phantom" (`courses/grades/...`), theo đúng thứ tự khớp của bảng. */
    const aliasCases: [string, string, string, string][] = [
      ['/api/v1/courses/01900000-0000-7000-8000-000000000001/grades/export/vnedu', 'POST', 'courses/:courseId/grades/export/vnedu', 'courses/:courseId/grade-exports'],
      ['/api/v1/courses/01900000-0000-7000-8000-000000000001/grades/items', 'GET', 'courses/:courseId/grades/items', 'courses/:courseId/grade-items'],
      ['/api/v1/courses/01900000-0000-7000-8000-000000000001/grades/report', 'GET', 'courses/:courseId/grades/report', 'courses/:courseId/gradebook/report'],
      ['/api/v1/courses/grades/items/01900000-0000-7000-8000-000000000001/users/01900000-0000-7000-8000-000000000002/history', 'GET', 'courses/grades/items/:itemId/users/:userId/history', 'grade-items/:itemId/users/:userId/history'],
      ['/api/v1/courses/grades/items/01900000-0000-7000-8000-000000000001/grades', 'POST', 'courses/grades/items/:itemId/grades', 'grade-items/:itemId/grades'],
      ['/api/v1/courses/grades/items/01900000-0000-7000-8000-000000000001/posting-policy', 'PUT', 'courses/grades/items/:itemId/posting-policy', 'grade-items/:itemId/posting-policy'],
      ['/api/v1/courses/grades/items/01900000-0000-7000-8000-000000000001/publish', 'POST', 'courses/grades/items/:itemId/publish', 'grade-items/:itemId/publish'],
      ['/api/v1/courses/grades/items/01900000-0000-7000-8000-000000000001/unpublish', 'POST', 'courses/grades/items/:itemId/unpublish', 'grade-items/:itemId/unpublish'],
      ['/api/v1/courses/grades/items/01900000-0000-7000-8000-000000000001', 'GET', 'courses/grades/items/:itemId', 'grade-items/:itemId'],
      ['/api/v1/courses/grades/grades/01900000-0000-7000-8000-000000000001', 'GET', 'courses/grades/grades/:gradeId', 'grades/:gradeId'],
    ];

    it.each(aliasCases)('đánh dấu URL alias grades %s bằng header Deprecation/Sunset và một log warn có cấu trúc', async (url, method, alias, canonical) => {
      await assertAlias(url, method, alias, canonical);
    });

    it.each([
      '/api/v1/courses/01900000-0000-7000-8000-000000000001/grade-items',
      '/api/v1/courses/01900000-0000-7000-8000-000000000001/gradebook/report',
      '/api/v1/grade-items/01900000-0000-7000-8000-000000000001/users/01900000-0000-7000-8000-000000000002/history',
    ])('để nguyên URL canonical grades %s: không header, không log warn', async (url) => {
      await assertCanonicalUntouched(url);
    });
  });

  describe('Bề mặt exam-papers', () => {
    /** Toàn bộ 28 hậu tố của bảng sinh bề mặt `exam-papers`: [url cụ thể, method, alias mẫu, canonical mẫu] — gồm 4 ca canonical ghi đè `board-*` → `approve`/`reject` và các ca phân loại theo thứ tự khớp (segment chữ trước tham số: `dossiers/mine` theo mẫu chữ của chính nó; `/exam-papers/:id/dossiers` theo mẫu `:id/dossiers` chứ không phải `dossiers/:dossierId`). */
    const aliasCases: [string, string, string, string][] = [
      ['/api/v1/exam-papers/banks/01900000-0000-7000-8000-000000000001/contributions/01900000-0000-7000-8000-000000000002/board-approve', 'POST', 'exam-papers/banks/:bankId/contributions/:contributionId/board-approve', 'exams/banks/:bankId/contributions/:contributionId/approve'],
      ['/api/v1/exam-papers/banks/01900000-0000-7000-8000-000000000001/contributions/01900000-0000-7000-8000-000000000002/board-reject', 'POST', 'exam-papers/banks/:bankId/contributions/:contributionId/board-reject', 'exams/banks/:bankId/contributions/:contributionId/reject'],
      ['/api/v1/exam-papers/banks/01900000-0000-7000-8000-000000000001/contributions/01900000-0000-7000-8000-000000000002/approve', 'POST', 'exam-papers/banks/:bankId/contributions/:contributionId/approve', 'exams/banks/:bankId/contributions/:contributionId/approve'],
      ['/api/v1/exam-papers/banks/01900000-0000-7000-8000-000000000001/contributions/01900000-0000-7000-8000-000000000002/reject', 'POST', 'exam-papers/banks/:bankId/contributions/:contributionId/reject', 'exams/banks/:bankId/contributions/:contributionId/reject'],
      ['/api/v1/exam-papers/banks/01900000-0000-7000-8000-000000000001/contributions', 'GET', 'exam-papers/banks/:bankId/contributions', 'exams/banks/:bankId/contributions'],
      ['/api/v1/exam-papers/banks/01900000-0000-7000-8000-000000000001/dossiers', 'GET', 'exam-papers/banks/:bankId/dossiers', 'exams/banks/:bankId/dossiers'],
      ['/api/v1/exam-papers/banks/01900000-0000-7000-8000-000000000001/exams', 'GET', 'exam-papers/banks/:bankId/exams', 'exams/banks/:bankId/exams'],
      ['/api/v1/exam-papers/dossiers/mine', 'GET', 'exam-papers/dossiers/mine', 'exams/dossiers/mine'],
      ['/api/v1/exam-papers/dossiers/01900000-0000-7000-8000-000000000001/specification/export', 'GET', 'exam-papers/dossiers/:dossierId/specification/export', 'exams/dossiers/:dossierId/specification/export'],
      ['/api/v1/exam-papers/dossiers/01900000-0000-7000-8000-000000000001/specification', 'GET', 'exam-papers/dossiers/:dossierId/specification', 'exams/dossiers/:dossierId/specification'],
      ['/api/v1/exam-papers/dossiers/01900000-0000-7000-8000-000000000001/board-approve', 'POST', 'exam-papers/dossiers/:dossierId/board-approve', 'exams/dossiers/:dossierId/approve'],
      ['/api/v1/exam-papers/dossiers/01900000-0000-7000-8000-000000000001/board-reject', 'POST', 'exam-papers/dossiers/:dossierId/board-reject', 'exams/dossiers/:dossierId/reject'],
      ['/api/v1/exam-papers/dossiers/01900000-0000-7000-8000-000000000001/approve', 'POST', 'exam-papers/dossiers/:dossierId/approve', 'exams/dossiers/:dossierId/approve'],
      ['/api/v1/exam-papers/dossiers/01900000-0000-7000-8000-000000000001/reject', 'POST', 'exam-papers/dossiers/:dossierId/reject', 'exams/dossiers/:dossierId/reject'],
      ['/api/v1/exam-papers/dossiers/01900000-0000-7000-8000-000000000001/submit', 'POST', 'exam-papers/dossiers/:dossierId/submit', 'exams/dossiers/:dossierId/submit'],
      ['/api/v1/exam-papers/dossiers/01900000-0000-7000-8000-000000000001', 'GET', 'exam-papers/dossiers/:dossierId', 'exams/dossiers/:dossierId'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/specification/export', 'GET', 'exam-papers/:id/specification/export', 'exams/:id/specification/export'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/specification', 'GET', 'exam-papers/:id/specification', 'exams/:id/specification'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/dossiers', 'POST', 'exam-papers/:id/dossiers', 'exams/:id/dossiers'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/status', 'PATCH', 'exam-papers/:id/status', 'exams/:id/status'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/withdraw', 'POST', 'exam-papers/:id/withdraw', 'exams/:id/withdraw'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/restore', 'POST', 'exam-papers/:id/restore', 'exams/:id/restore'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/copy', 'POST', 'exam-papers/:id/copy', 'exams/:id/copy'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/swap', 'POST', 'exam-papers/:id/swap', 'exams/:id/swap'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/pins', 'PUT', 'exam-papers/:id/pins', 'exams/:id/pins'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/print', 'GET', 'exam-papers/:id/print', 'exams/:id/print'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/slots', 'PUT', 'exam-papers/:id/slots', 'exams/:id/slots'],
      ['/api/v1/exam-papers/01900000-0000-7000-8000-000000000001', 'GET', 'exam-papers/:id', 'exams/:id'],
    ];

    it.each(aliasCases)('đánh dấu URL alias exam-papers %s bằng header Deprecation/Sunset và một log warn có cấu trúc', async (url, method, alias, canonical) => {
      await assertAlias(url, method, alias, canonical);
    });

    it.each([
      '/api/v1/exams/banks/01900000-0000-7000-8000-000000000001/exams',
      '/api/v1/exams/dossiers/mine',
      '/api/v1/exams/01900000-0000-7000-8000-000000000001',
    ])('để nguyên URL canonical exams %s: không header, không log warn', async (url) => {
      await assertCanonicalUntouched(url);
    });
  });

  describe('Bề mặt messaging và notifications', () => {
    /** Toàn bộ 5 mục của bảng alias messaging/notifications: [url cụ thể, method, alias mẫu, canonical mẫu] — gồm ca phân loại theo thứ tự khớp (`bulk-remove` theo mẫu chữ của chính nó chứ không phải mẫu `:id` trần). */
    const aliasCases: [string, string, string, string][] = [
      ['/api/v1/messages/messages/bulk-remove', 'POST', 'messages/messages/bulk-remove', 'messages/bulk-remove'],
      ['/api/v1/messages/messages/01900000-0000-7000-8000-000000000001/recall', 'POST', 'messages/messages/:id/recall', 'messages/:id/recall'],
      ['/api/v1/messages/messages/01900000-0000-7000-8000-000000000001/hard-delete', 'POST', 'messages/messages/:id/hard-delete', 'messages/:id/hard-delete'],
      ['/api/v1/messages/messages/01900000-0000-7000-8000-000000000001', 'PATCH', 'messages/messages/:id', 'messages/:id'],
      ['/api/v1/notifications/read-all', 'POST', 'notifications/read-all', 'notifications/mark-read'],
    ];

    it.each(aliasCases)('đánh dấu URL alias messaging %s bằng header Deprecation/Sunset và một log warn có cấu trúc', async (url, method, alias, canonical) => {
      await assertAlias(url, method, alias, canonical);
    });

    it.each([
      '/api/v1/messages/01900000-0000-7000-8000-000000000001/recall',
      '/api/v1/notifications/mark-read',
    ])('để nguyên URL canonical messaging %s: không header, không log warn', async (url) => {
      await assertCanonicalUntouched(url);
    });
  });
});
