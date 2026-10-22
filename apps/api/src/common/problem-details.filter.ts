import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ProblemDetails } from '@lms/contracts';
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
      }
    } else {
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
      detail = 'An unexpected error occurred';
    }

    const problem: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      detail,
      instance: request?.url,
      code,
      ...(errors ? { errors } : {}),
    };

    response
      .status(status)
      .type('application/problem+json')
      .json(problem);
  }
}
