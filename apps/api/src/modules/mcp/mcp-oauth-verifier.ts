import { AsyncLocalStorage } from 'node:async_hooks';
import { createMcpProtectedRequestHandler } from '@better-auth/mcp';

/**
 * BỘ KIỂM TOKEN CỦA RS ở lát MCP-1 (issue #163): gói
 * `createMcpProtectedRequestHandler` của `@better-auth/mcp` — đường
 * kiểm chính chủ của plugin: xác thực chữ ký JWT qua JWKS của AS
 * (plugin jwt() phục vụ tại `<issuer>/jwks`), ép đúng `iss` + `aud`
 * (= resource `/mcp`) + hạn token. Cầu HS256 của MCP-0
 * (mcp-bridge-auth.ts) chỉ còn là đường lùi khi AS chưa bật.
 *
 * Plugin trả Response thành phẩm (401/403 kèm challenge
 * WWW-Authenticate) khi token không đạt; tầng mount của LMS lại cần
 * lỗi JSON-RPC đồng dạng lớp 0 của MCP-0 (-32001/-32003) — nên
 * verifier chạy handler của plugin với một callback chỉ GHI LẠI
 * claims (qua AsyncLocalStorage để các request đồng thời không lẫn
 * nhau; handler của plugin giữ cache JWKS dùng chung nên verifier
 * phải là instance duy nhất của tiến trình) rồi mount tự quyết định
 * hình lỗi + các cổng tiếp theo (scope theo tool, rate limit) như cũ.
 */
export interface McpOAuthIdentity {
  /** `sub` của access token = id người dùng LMS (AS phát cho chính giáo viên). */
  userId: string;
  /** `client_id` trên token — định danh client THẬT do AS cấp (khác clientInfo tự giới thiệu ở kỷ nguyên cầu auth). */
  clientId: string;
  /** Scope trên token (claim `scope` tách theo dấu cách) — trần quyền của phiên gọi. */
  scopes: string[];
  /** Tenant của phiên (claim `tid`) khi AS có phát kèm (TENANT-1, #196); không có → null, mount phân giải từ membership. */
  tenantId: string | null;
}

export type McpOAuthVerifyResult =
  | { ok: true; identity: McpOAuthIdentity }
  | { ok: false; status: number; wwwAuthenticate: string | null };

interface ClaimsCapture {
  claims?: { sub?: unknown; client_id?: unknown; scope?: unknown; tid?: unknown };
}

export class McpOAuthVerifier {
  private readonly capture = new AsyncLocalStorage<ClaimsCapture>();
  private readonly handler: (request: Request) => Promise<Response>;

  constructor(options: { issuer: string; audience: string; jwksUrl: string }) {
    this.handler = createMcpProtectedRequestHandler(
      { issuer: options.issuer, audience: options.audience, jwksUrl: options.jwksUrl },
      async (_request, claims) => {
        const store = this.capture.getStore();
        if (store) store.claims = claims;
        // Response mồi: mount không dùng thân này — claims đã ghi lại
        // trong store của đúng request đang chạy.
        return new Response(null, { status: 204 });
      },
    );
  }

  /** Kiểm một Web Request mang header Authorization; không ném lỗi ra ngoài — mọi thất bại đều về nhánh challenge. */
  async verify(request: Request): Promise<McpOAuthVerifyResult> {
    const store: ClaimsCapture = {};
    const response = await this.capture.run(store, () => this.handler(request));
    const claims = store.claims;
    if (!claims) {
      return {
        ok: false,
        status: response.status,
        wwwAuthenticate: response.headers.get('www-authenticate'),
      };
    }
    return {
      ok: true,
      identity: {
        userId: typeof claims.sub === 'string' ? claims.sub : '',
        clientId: typeof claims.client_id === 'string' ? claims.client_id : 'unknown',
        scopes: typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [],
        tenantId: typeof claims.tid === 'string' ? claims.tid : null,
      },
    };
  }
}
