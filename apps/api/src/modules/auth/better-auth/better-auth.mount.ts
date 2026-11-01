import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import type { SpaceDatabaseService } from '../../../db/routing/space-database.service';
import { tenantAls } from '../../tenants/tenant-als';
import { resolveDedicatedSpace } from '../../tenants/space-resolution';
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
/**
 * Khung định tuyến tối thiểu mà đường ghi Better Auth cần: chỉ
 * phân giải đích và chuẩn bị kho — mount không tự mở pool hay đọc
 * sổ đăng ký trực tiếp.
 */
export type BetterAuthSpaceRouting = Pick<SpaceDatabaseService, 'resolveTarget' | 'getDatabaseForSpace'>;

/**
 * Mount handler của Better Auth (xem chú thích ở đầu file về thứ tự
 * mount).
 *
 * Đường GHI theo địa chỉ (Phần A, issue #587 — B1): handler này
 * chạy thẳng trên Express, ngoài chuỗi guard của Nest, nên không
 * có guard nào ghim trung tâm cho nó như đường đọc cookie
 * (`BetterAuthSessionGuard`). Không định tuyến ở đây thì mọi lần
 * ghi của Better Auth — kiểm chứng credential và ghi phiên khi
 * đăng nhập — đều đi qua handle định tuyến mà ngữ cảnh ALS lúc đó
 * không mang slug, tức rơi về kho chung: tại địa chỉ của trung tâm
 * ở kho riêng, tài khoản chỉ sống ở kho riêng sẽ đăng nhập thất
 * bại, và dù tài khoản có ở cả hai kho thì phiên cũng ghi vào kho
 * chung rồi guard đọc cookie (đã định tuyến đúng) không tìm thấy
 * phiên ở kho đích. Vì vậy, khi `spaceDb` được truyền vào, handler
 * này tự phân giải không gian từ `Host` đúng khuôn đường đọc
 * (`resolveDedicatedSpace`): địa chỉ thuộc trung tâm ở kho riêng
 * thì chuẩn bị kho đích trước rồi chạy handler trong ngữ cảnh ALS
 * mang slug đó, để handle định tuyến của adapter chọn đúng kho
 * đích cho mọi lần đọc/ghi của lượt đăng nhập. Địa chỉ còn lại
 * (không thuộc trung tâm kho riêng nào) giữ nguyên đường kho
 * chung. Lỗi phân giải/chuẩn bị kho đích thì fail-closed qua
 * `next(err)` — tuyệt đối không rơi lặng về kho chung cho một
 * lượt ghi đăng nhập. Khi không truyền `spaceDb` (đường kiểm chứng
 * tối thiểu của nền Better Auth), handler chạy như trước.
 */
export function mountBetterAuth(
  app: NestExpressApplication,
  auth: BetterAuthInstance,
  spaceDb?: BetterAuthSpaceRouting,
): void {
  const server = app.getHttpAdapter().getInstance() as {
    all: (path: string, handler: (req: Request, res: Response, next: NextFunction) => void) => void;
    get: (path: string, handler: (req: Request, res: Response) => void) => void;
  };
  const handler = toNodeHandler(auth);
  server.all(`${BETTER_AUTH_BASE_PATH}/*splat`, async (req: Request, res: Response, next: NextFunction) => {
    const segment = req.path.slice(BETTER_AUTH_BASE_PATH.length + 1).split('/')[0];
    if (segment && LEGACY_AUTH_SEGMENTS.has(segment)) {
      next();
      return;
    }
    if (!spaceDb) {
      handler(req, res);
      return;
    }
    let space: Awaited<ReturnType<typeof resolveDedicatedSpace>>;
    try {
      space = await resolveDedicatedSpace(spaceDb, req.headers.host);
    } catch (err) {
      next(err);
      return;
    }
    if (!space) {
      handler(req, res);
      return;
    }
    try {
      await spaceDb.getDatabaseForSpace(space.slug);
    } catch (err) {
      next(err);
      return;
    }
    // Handler của Better Auth là dạng callback (req, res), không
    // trả promise để await: bọc lời gọi của nó trong `tenantAls.run`
    // để mọi tác vụ bất đồng bộ mà handler khởi tạo bên trong lời
    // gọi này — kể cả các lần truy vấn của adapter — đều thừa hưởng
    // ngữ cảnh mang slug, đúng khuôn các điểm bọc handler khác của
    // hệ. Bước chuẩn bị ở trên đã ghi handle kho đích vào bảng
    // đã-chuẩn-bị nên handle định tuyến tra được kho đích ngay.
    tenantAls.run({ spaceSlug: space.slug }, () => {
      handler(req, res);
    });
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
