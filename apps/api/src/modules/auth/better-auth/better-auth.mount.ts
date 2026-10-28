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
  // HOTFIX #196 vòng 2 (sự cố triển khai TENANT-1): hai segment của
  // AuthController từng THIẾU trong danh sách này — khi Better Auth
  // được mount (production bật MCP_AS_ENABLED), `GET /auth/tenants`
  // và `POST /auth/switch-tenant/:tenantId` bị handler Better Auth
  // nuốt và trả 404 rỗng, trong khi tiến trình seed (không mount
  // Better Auth) vẫn trả 200 — đúng triệu chứng live sau triển khai
  // PR #236. Danh sách phải phủ MỌI segment đầu của route auth tự
  // viết; thêm route con mới dưới `/auth` là phải thêm segment vào đây.
  'tenants',
  'switch-tenant',
  // Segment của bước hoàn tất MFA: endpoint verify của Better Auth
  // theo quy ước nằm tại `/auth/two-factor/*`, nhưng ở hệ này bước
  // hoàn tất do Nest xử lý để kiểm mã thẳng vào nguồn trạng thái
  // MFA duy nhất `user_totp` (plugin twoFactor chủ đích không đăng
  // ký — xem `two-factor-completion.service.ts` và khối plugins
  // trong factory). Controller Nest tương ứng ở cùng thư mục
  // better-auth.
  'two-factor',
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
 *
 * Cầu discovery của AS (Refs #7, vá proxy discovery MCP AS): metadata
 * AS (RFC 8414) của plugin oauth-provider chỉ khớp hai dạng
 * `/.well-known/oauth-authorization-server{issuerPath}` và
 * `{issuerPath}/.well-known/oauth-authorization-server` với
 * `issuerPath = /api/v1/auth` — dạng gốc
 * `/.well-known/oauth-authorization-server` không nằm trong tập khớp
 * nên phải neo về dạng hậu tố, còn dạng chèn-đường-dẫn chuyển nguyên
 * trạng. Hai route cầu này KHÔNG qua cổng LEGACY_AUTH_SEGMENTS (chúng
 * không thuộc không gian `/api/v1/auth`). Nếu AS tắt (không compose
 * plugin mcp) thì handler trả 404 — hành vi ròng như trước khi vá.
 */
export function mountBetterAuth(app: NestExpressApplication, auth: BetterAuthInstance): void {
  const server = app.getHttpAdapter().getInstance() as {
    all: (path: string, handler: (req: Request, res: Response, next: NextFunction) => void) => void;
    get: (path: string, handler: (req: Request, res: Response) => void) => void;
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
  // Dạng gốc: GET|HEAD — rewrite về dạng hậu tố đã kiểm chứng 200,
  // giữ nguyên query string. Express tự phục vụ HEAD từ route GET.
  server.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    const queryIndex = req.url.indexOf('?');
    const query = queryIndex >= 0 ? req.url.slice(queryIndex) : '';
    const rewritten = `${BETTER_AUTH_BASE_PATH}/.well-known/oauth-authorization-server${query}`;
    req.url = rewritten;
    (req as Request & { originalUrl?: string }).originalUrl = rewritten;
    handler(req, res);
  });
  // Dạng chèn-đường-dẫn: chuyển NGUYÊN TRẠNG cho handler — hook của
  // oauth-provider khớp đúng dạng này và trả metadata; hậu tố lạ khác
  // thì handler trả 404 như đúng thiết kế.
  server.all('/.well-known/oauth-authorization-server/*splat', (req: Request, res: Response) => {
    handler(req, res);
  });
}
