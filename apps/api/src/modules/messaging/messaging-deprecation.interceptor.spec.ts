import { Logger } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessagingDeprecationInterceptor } from './messaging-deprecation.interceptor';

/**
 * Kiểm chứng interceptor alias của cụm messaging/notifications
 * (issue #344, cụm R6-A2): lượt gọi qua path alias cũ phải được gắn
 * header Deprecation/Sunset và sinh đúng một bản ghi log có cấu trúc
 * `deprecated_route_alias` trỏ từ alias sang canonical; lượt gọi qua
 * path canonical không bị gắn header và không sinh log alias. Đây là
 * lưới cho điều kiện gỡ alias (dựa trên log alias) nên cặp
 * alias/canonical trong log phải khớp đúng bảng mẫu path của bề mặt
 * alias, và path trong log phải là path cụ thể không kèm query string.
 */
describe('MessagingDeprecationInterceptor', () => {
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

  it('marks a message alias URL with Deprecation/Sunset headers and one structured warn log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new MessagingDeprecationInterceptor();
    const { context, next, headers } = buildContext('/api/v1/messages/messages/01900000-0000-7000-8000-000000000001?foo=bar', 'PATCH');

    await lastValueFrom(interceptor.intercept(context, next));

    expect(headers.get('Deprecation')).toBe('true');
    expect(headers.get('Sunset')).toBe('Sun, 01 Feb 2027 00:00:00 GMT');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged.event).toBe('deprecated_route_alias');
    expect(logged.method).toBe('PATCH');
    expect(logged.alias).toBe('messages/messages/:id');
    expect(logged.canonical).toBe('messages/:id');
    // Path trong log là path cụ thể của lượt gọi, không kèm query string.
    expect(logged.path).toBe('/api/v1/messages/messages/01900000-0000-7000-8000-000000000001');
  });

  it('classifies the literal bulk-remove alias URL under its own pattern, not the :id one', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new MessagingDeprecationInterceptor();
    const { context, next } = buildContext('/api/v1/messages/messages/bulk-remove', 'POST');

    await lastValueFrom(interceptor.intercept(context, next));

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged.alias).toBe('messages/messages/bulk-remove');
    expect(logged.canonical).toBe('messages/bulk-remove');
  });

  it('classifies the notifications read-all alias URL under the mark-read canonical', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new MessagingDeprecationInterceptor();
    const { context, next, headers } = buildContext('/api/v1/notifications/read-all', 'POST');

    await lastValueFrom(interceptor.intercept(context, next));

    expect(headers.get('Deprecation')).toBe('true');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged.alias).toBe('notifications/read-all');
    expect(logged.canonical).toBe('notifications/mark-read');
  });

  it('leaves a canonical URL untouched: no headers, no warn log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new MessagingDeprecationInterceptor();
    const { context, next, headers } = buildContext('/api/v1/messages/01900000-0000-7000-8000-000000000001/recall', 'POST');

    await lastValueFrom(interceptor.intercept(context, next));

    expect(headers.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
