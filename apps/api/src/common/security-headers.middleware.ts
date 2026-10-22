import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Gắn các header bảo mật chuẩn cho mọi phản hồi HTTP (tự xây, cùng tinh
 * thần với ProblemDetailsFilter: Nest không có sẵn cơ chế này).
 * - `nosniff` + `DENY` framing + `no-referrer`: áp cho mọi route.
 * - HSTS: chỉ có nghĩa trên HTTPS nhưng gửi kèm luôn để mọi môi trường
 *   sau reverse proxy đều nhất quán.
 * - CSP chặt (`default-src 'none'`) chỉ áp cho API JSON (`/api/v1/…`):
 *   trang tài liệu Swagger ở `/api/docs` cần nạp script/style của chính
 *   nó nên không nhận CSP này.
 */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // Middleware của Nest nhận req.path đã rút gọn theo route đã khớp;
    // đường đầy đủ của request nằm ở originalUrl (bỏ phần query).
    const fullPath = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (fullPath.startsWith('/api/v1/')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
    next();
  }
}
