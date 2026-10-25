import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';

/**
 * Đánh dấu đường alias cũ `/exam-papers` là sắp bỏ (Deprecation +
 * Sunset theo RFC 8594): route canonical là `/exams`, alias giữ
 * song song ít nhất 2 chu kỳ phát hành cho client cũ.
 */
@Injectable()
export class ExamPapersDeprecationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    if (req.url.includes('/exam-papers')) {
      const res = http.getResponse<Response>();
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', 'Sun, 01 Feb 2027 00:00:00 GMT');
    }
    return next.handle();
  }
}
