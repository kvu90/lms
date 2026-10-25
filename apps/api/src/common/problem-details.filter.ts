import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ProblemDetails } from '@lms/contracts';
import { t } from '@nestjs/i18n';
import type { Response } from 'express';

/**
 * Global RFC 7807 Problem Details filter (self-built on Nest's ExceptionFilter
 * primitive — Nest has no built-in Problem Details format).
 */
const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ url?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail: string | undefined;
    let code = 'http.internal_error';
    let errors: ProblemDetails['errors'];
    let blockedStudents: ProblemDetails['blockedStudents'];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      title = STATUS_TITLES[status] ?? 'Error';
      code = `http.${title.toLowerCase().replace(/\s+/g, '_')}`;
      const body = exception.getResponse();
      if (typeof body === 'string') {
        detail = body;
      } else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (Array.isArray(record.message)) {
          detail = 'Validation failed';
          errors = record.message.map((message) => ({
            message: String(message),
          }));
          code = 'http.validation_failed';
        } else if (typeof record.message === 'string') {
          detail = record.message;
        }
        if (typeof record.code === 'string') {
          code = record.code;
        }
        /**
         * Extension member `blocked` của exception nội bộ (chốt cả lớp VN
         * bị chặn) → mang sang problem dưới tên `blockedStudents`, chỉ nhận
         * các phần tử đúng hình dạng đã khai trong contracts — dữ liệu lạ
         * hình bị bỏ thay vì lộ nguyên ra ngoài.
         */
        if (Array.isArray(record.blocked)) {
          const shaped = record.blocked.filter(
            (b): b is { userId: string; reason: 'awaiting_makeup' | 'incomplete'; roles: string[] } =>
              !!b && typeof b === 'object'
              && typeof (b as { userId?: unknown }).userId === 'string'
              && ((b as { reason?: unknown }).reason === 'awaiting_makeup' || (b as { reason?: unknown }).reason === 'incomplete')
              && Array.isArray((b as { roles?: unknown }).roles),
          );
          if (shaped.length > 0) {
            blockedStudents = shaped.map((b) => ({
              userId: b.userId,
              reason: b.reason,
              roles: b.roles.map((r) => String(r)),
            }));
          }
        }
      }
    } else {
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
      detail = 'An unexpected error occurred';
    }

    /**
     * Text hiển thị (detail) tra theo `code` ổn định trong catalog i18n
     * (`errors.<code>`) theo ngôn ngữ của request hiện tại — exception nội bộ
     * chỉ mang mã tiếng Anh, không mang chuỗi hiển thị. Mã nào chưa có trong
     * catalog (module cũ chưa nối i18n) thì giữ nguyên detail gốc; ngoài
     * request context, `t()` trả lại chính khoá nên phép so sánh dưới đây tự
     * vô hiệu hoá.
     */
    try {
      const key = `errors.${code}`;
      const translated = t(key as never);
      if (typeof translated === 'string' && translated !== key) detail = translated;
    } catch {
      /* missingKey='throw' ngoài production: thiếu khoá thì giữ detail gốc. */
    }

    const problem: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      detail,
      instance: request?.url,
      code,
      ...(errors ? { errors } : {}),
      ...(blockedStudents ? { blockedStudents } : {}),
    };

    response
      .status(status)
      .type('application/problem+json')
      .json(problem);
  }
}
