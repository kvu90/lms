import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import { BETTER_AUTH_BASE_PATH, type BetterAuthInstance } from './better-auth.instance';

/**
 * Các segment đầu của route auth TỰ VIẾT hiện tại dưới cùng tiền tố
 * `/api/v1/auth` (AuthController + OAuthController). Trong thời gian hai
 * hệ cùng tồn tại (Giai đoạn 1–2 của issue #7), request nào thuộc các
 * segment này phải đi tiếp xuống Nest như chưa từng có Better Auth —
 * "đường cũ xử lý như hiện tại" là cổng đạt của giai đoạn. Danh sách này
 * là của chính hệ thống (không phải của Better Auth) nên ổn định; nó bị
 * xoá cùng lúc với các route cũ tại cutover ở cuối Giai đoạn 2.
 *
 * Lưu ý điểm giao nhau thật: `change-password` tồn tại ở CẢ hai hệ —
 * trong giai đoạn cùng tồn tại, bản của hệ hiện tại thắng (hành vi live
 * không đổi); bản của Better Auth tiếp quản khi route cũ bị gỡ.
 */
const LEGACY_AUTH_SEGMENTS = new Set([
  'login',
  'token',
  'mfa',
  'refresh',
  'logout',
  'change-password',
  'login-as',
  'session',
  'sessions',
  'oauth',
]);

/**
 * Mount handler của Better Auth lên express instance của Nest tại
 * `/api/v1/auth/*` (issue #7). Không có tích hợp NestJS chính chủ của
 * Better Auth — đây là điểm nối tay đã chốt trong thiết kế.
 *
 * Bắt buộc gọi SAU `NestFactory.create` và TRƯỚC `app.init()`/`listen()`:
 * handler phải được express đăng ký trước route và body parser của Nest
 * để request tới đường auth của Better Auth đến tay nó ở dạng thô
 * (Better Auth tự đọc body/cookie của nó). Cả bootstrap thật (main.ts)
 * lẫn spec e2e đều đi qua hàm này để không lệch nhau.
 */
export function mountBetterAuth(app: NestExpressApplication, auth: BetterAuthInstance): void {
  const server = app.getHttpAdapter().getInstance() as {
    all: (path: string, handler: (req: Request, res: Response, next: NextFunction) => void) => void;
  };
  const handler = toNodeHandler(auth);
  server.all(`${BETTER_AUTH_BASE_PATH}/*splat`, (req: Request, res: Response, next: NextFunction) => {
    const segment = req.path.slice(BETTER_AUTH_BASE_PATH.length + 1).split('/')[0];
    if (segment && LEGACY_AUTH_SEGMENTS.has(segment)) {
      next();
      return;
    }
    handler(req, res);
  });
}
