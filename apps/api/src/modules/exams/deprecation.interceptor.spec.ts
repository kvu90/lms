import { Logger } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExamPapersDeprecationInterceptor } from './deprecation.interceptor';

/**
 * Kiểm chứng interceptor alias của cụm đề (issue #343): lượt gọi qua
 * alias `/exam-papers` phải được gắn header Deprecation/Sunset và
 * sinh đúng một bản ghi log có cấu trúc `deprecated_route_alias` trỏ
 * từ alias sang canonical; lượt gọi qua path canonical không bị gắn
 * header và không sinh log alias. Đây là lưới cho điều kiện gỡ alias
 * (dựa trên log alias) nên cặp alias/canonical trong log phải khớp
 * đúng bảng mẫu path của bề mặt alias.
 */
describe('ExamPapersDeprecationInterceptor', () => {
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

  it('marks an alias URL of the exams surface with Deprecation/Sunset headers and one structured warn log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new ExamPapersDeprecationInterceptor();
    const { context, next, headers } = buildContext('/api/v1/exam-papers/banks/01900000-0000-7000-8000-000000000001/exams?foo=bar');

    await lastValueFrom(interceptor.intercept(context, next));

    expect(headers.get('Deprecation')).toBe('true');
    expect(headers.get('Sunset')).toBe('Sun, 01 Feb 2027 00:00:00 GMT');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged.event).toBe('deprecated_route_alias');
    expect(logged.method).toBe('GET');
    expect(logged.alias).toBe('exam-papers/banks/:bankId/exams');
    expect(logged.canonical).toBe('exams/banks/:bankId/exams');
    // Path trong log là path cụ thể của lượt gọi, không kèm query string.
    expect(logged.path).toBe('/api/v1/exam-papers/banks/01900000-0000-7000-8000-000000000001/exams');
  });

  it('classifies a dossiers alias URL under the :id/dossiers pattern, not the dossiers/:dossierId one', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new ExamPapersDeprecationInterceptor();
    const { context, next, headers } = buildContext('/api/v1/exam-papers/01900000-0000-7000-8000-000000000001/dossiers', 'POST');

    await lastValueFrom(interceptor.intercept(context, next));

    expect(headers.get('Deprecation')).toBe('true');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged.alias).toBe('exam-papers/:id/dossiers');
    expect(logged.canonical).toBe('exams/:id/dossiers');
    expect(logged.method).toBe('POST');
  });

  it('classifies the literal dossiers/mine alias URL under its own pattern', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new ExamPapersDeprecationInterceptor();
    const { context, next } = buildContext('/api/v1/exam-papers/dossiers/mine');

    await lastValueFrom(interceptor.intercept(context, next));

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged.alias).toBe('exam-papers/dossiers/mine');
    expect(logged.canonical).toBe('exams/dossiers/mine');
  });

  it('maps a board-* alias URL to the merged approve canonical (issue #345, giai đoạn 2)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new ExamPapersDeprecationInterceptor();
    const { context, next, headers } = buildContext('/api/v1/exam-papers/banks/01900000-0000-7000-8000-000000000001/contributions/01900000-0000-7000-8000-000000000002/board-approve', 'POST');

    await lastValueFrom(interceptor.intercept(context, next));

    expect(headers.get('Deprecation')).toBe('true');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged.alias).toBe('exam-papers/banks/:bankId/contributions/:contributionId/board-approve');
    // Đích canonical sau hợp nhất là `approve`, không còn `board-approve`.
    expect(logged.canonical).toBe('exams/banks/:bankId/contributions/:contributionId/approve');
  });

  it('leaves a canonical URL untouched: no headers, no warn log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new ExamPapersDeprecationInterceptor();
    const { context, next, headers } = buildContext('/api/v1/exams/banks/01900000-0000-7000-8000-000000000001/exams');

    await lastValueFrom(interceptor.intercept(context, next));

    expect(headers.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
