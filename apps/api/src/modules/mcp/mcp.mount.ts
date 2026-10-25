import { createMcpHandler, type AuthInfo, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { McpBridgeAuth } from './mcp-bridge-auth';
import type { McpActor } from './mcp.context';
import type { McpOAuthVerifier } from './mcp-oauth-verifier';
import { McpRateLimiter } from './mcp-rate-limit';
import { createLmsMcpServer } from './mcp.server';
import type { McpToolDeps } from './mcp.tools';
import { tenantAls } from '../tenants/tenant-als';

/**
 * Mount MCP server của LMS (MCP-0, issue #110) lên express instance của
 * Nest — cùng tiền lệ Better Auth (better-auth.mount.ts): đăng ký TRƯỚC
 * route + body parser của Nest để request tới /mcp đến tay handler ở
 * dạng thô. MCP có không gian URL riêng, KHÔNG nằm dưới /api/v1:
 *
 *   POST /mcp — endpoint Streamable HTTP duy nhất, một endpoint hai kỷ
 *     nguyên (modern 2026-07-28 stateless + legacy 2025-11-25) qua
 *     createMcpHandler của SDK v2 (`legacy: 'stateless'`).
 *   GET /.well-known/oauth-protected-resource[/mcp] — Protected Resource
 *     Metadata (RFC 9728) trỏ tới issuer cấu hình (MCP_AUTH_ISSUER;
 *     mặc định = chính origin này — AS đầy đủ là lát MCP-1).
 *
 * Lớp vận chuyển (validate lớp 0, hồ sơ research Phần 3.1) do mount
 * chịu trước khi request chạm handler: body ≤ 256 KB, JSON parse được,
 * header Mcp-Method/Mcp-Name (client modern gửi) phải khớp method/tên
 * tool trong body (lệch → lỗi -32020 HeaderMismatchError), token cầu
 * auth hợp lệ mới tới được bất kỳ tool nào (401 + WWW-Authenticate
 * trỏ PRM), tool có scope riêng mà trần scope không có → 403
 * `insufficient_scope` + challenge step-up (lát MCP-2), rate limit theo
 * (giáo viên, nhóm tool) vượt hạn → 429.
 */

const MAX_BODY_BYTES = 256 * 1024;
const MCP_SCOPES = ['lms.questions.read', 'lms.questions.draft', 'lms.questions.write', 'lms.banks.contribute'] as const;

/**
 * Tập scope kỷ nguyên CẦU AUTH cấp cho token hệ thống (authInfo.scopes):
 * chỉ các scope đã có tool thật sau lưng — read + draft của MCP-0 và
 * contribute của lát MCP-2 (issue #110 mở lại). `lms.questions.write`
 * KHÔNG nằm ở đây: publish là tool của MCP-1 và chỉ gọi được bằng
 * access token OAuth thật (cầu auth cấp trần đồng nhất không dựng
 * được ca thiếu scope — chính là động cơ của lát này). Khi AS bật,
 * scope lấy từ access token qua McpOAuthVerifier; `deps.grantedScopes`
 * vẫn là đường ghi đè cho test ở cả hai kỷ nguyên.
 */
const BRIDGE_SCOPES: readonly string[] = ['lms.questions.read', 'lms.questions.draft', 'lms.banks.contribute'];

/**
 * Scope riêng của TỪNG tool (lát MCP-1 hoàn thiện bản đồ của MCP-0):
 * thiếu scope → 403 `insufficient_scope` + challenge step-up (research
 * Phần 2.2). Scope chỉ là TRẦN của token — quyền nghiệp vụ thật vẫn do
 * capability tại context của bank quyết ở tầng tool như REST.
 */
const TOOL_REQUIRED_SCOPES: Record<string, string> = {
  list_my_banks: 'lms.questions.read',
  list_categories: 'lms.questions.read',
  get_question: 'lms.questions.read',
  search_questions: 'lms.questions.read',
  check_duplicates: 'lms.questions.read',
  search_curriculum_outcomes: 'lms.questions.read',
  create_question: 'lms.questions.draft',
  create_questions_batch: 'lms.questions.draft',
  create_stimulus_with_questions: 'lms.questions.draft',
  publish_questions: 'lms.questions.write',
  submit_contribution: 'lms.banks.contribute',
};

interface JsonRpcEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: {
    name?: unknown;
    arguments?: unknown;
    _meta?: Record<string, unknown>;
    clientInfo?: { name?: unknown };
  } & Record<string, unknown>;
}

function jsonRpcError(res: Response, status: number, id: unknown, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** client_id từ clientInfo client tự giới thiệu (chỉ để truy vết — không tin cậy, xem research 3.3). */
function clientIdOf(body: JsonRpcEnvelope): string {
  const meta = body.params?._meta?.['io.modelcontextprotocol/clientInfo'] as { name?: unknown } | undefined;
  const raw = meta?.name ?? body.params?.clientInfo?.name;
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
  const cleaned = raw.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

function readRawBody(req: Request): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

export interface McpMountDeps {
  bridgeAuth: McpBridgeAuth;
  rateLimiter: McpRateLimiter;
  /** Origin công khai của chính API (PRM `resource` + authorization_servers mặc định). */
  publicBaseUrl: string | null;
  issuer: string | null;
  /**
   * Bộ kiểm access token OAuth của AS (lát MCP-1). Có giá trị → mount
   * đi đường RS THẬT: token được kiểm chữ ký JWKS + iss/aud bởi
   * verifier của plugin và scope lấy từ chính token; cầu bridge KHÔNG
   * được dùng nữa. Null/thiếu → đường lùi cầu auth của MCP-0 như cũ.
   */
  oauthVerifier?: McpOAuthVerifier | null;
  /**
   * Phân giải `sub` của access token thành actor còn hiệu lực (chỉ
   * dùng ở đường OAuth): null = tài khoản đã xoá/treo → 401, cùng
   * nghĩa với kiểm tra tài khoản trong cầu bridge. `tenantId` là
   * tenant mặc định của user theo membership (TENANT-1, #196) —
   * nguồn tenant của phiên khi token AS không mang claim `tid`.
   */
  resolveActor?: (userId: string) => Promise<{ username: string; tenantId?: string | null } | null>;
  /**
   * Trần scope hiệu lực cho mọi request qua mount này. Mặc định (khi
   * không truyền) = BRIDGE_SCOPES của kỷ nguyên cầu auth; AS OAuth sẽ
   * truyền scope của từng token. Test dùng trường này để dựng phiên
   * thiếu scope.
   */
  grantedScopes?: readonly string[];
  /** Deps của tools (services dùng chung với REST — không có đường nghiệp vụ riêng cho MCP). */
  toolDeps: McpToolDeps;
}

export function mountMcp(app: NestExpressApplication, deps: McpMountDeps): void {
  const server = app.getHttpAdapter().getInstance() as {
    all: (path: string, handler: (req: Request, res: Response, next: NextFunction) => void) => void;
    get: (path: string, handler: (req: Request, res: Response) => void) => void;
  };

  const handler: McpHttpHandler = createMcpHandler(
    (ctx) => {
      const extra = (ctx.authInfo?.extra ?? {}) as { userId?: string; username?: string; ip?: string | null; tenantId?: string | null };
      const actor: McpActor = {
        userId: extra.userId ?? '',
        username: extra.username ?? '',
        tenantId: extra.tenantId ?? null,
        clientId: ctx.authInfo?.clientId ?? 'unknown',
        ip: extra.ip ?? null,
        era: ctx.era,
        scopes: ctx.authInfo?.scopes ?? [],
      };
      return createLmsMcpServer(actor, deps.toolDeps);
    },
    {
      legacy: 'stateless',
      maxRequestBodySize: MAX_BODY_BYTES,
      onerror: (error) => {
        // Chỉ ghi nhận phía server; response cho client do handler quyết.
        console.error('[mcp] handler error:', error.message);
      },
    },
  );

  const baseOf = (req: Request): string =>
    deps.publicBaseUrl ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`;

  const prm = (req: Request): Record<string, unknown> => {
    const base = baseOf(req);
    return {
      resource: `${base}/mcp`,
      authorization_servers: [deps.issuer ?? base],
      bearer_methods_supported: ['header'],
      scopes_supported: [...MCP_SCOPES],
    };
  };
  server.get('/.well-known/oauth-protected-resource', (req, res) => {
    res.json(prm(req));
  });
  server.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
    res.json(prm(req));
  });

  server.all('/mcp', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      if (req.method !== 'POST') {
        // Kỷ nguyên modern không có GET stream riêng; legacy stateless
        // trả 405 cho GET/DELETE — uỷ cho handler của SDK quyết định.
        const webRes = await handler.fetch(toWebRequest(req, null), {});
        return pipeWebResponse(webRes, res);
      }
      const raw = await readRawBody(req);
      if (raw === null) {
        return jsonRpcError(res, 413, null, -32000, 'Request body too large (limit 256 KB)');
      }
      let body: JsonRpcEnvelope;
      try {
        body = JSON.parse(raw.toString('utf8')) as JsonRpcEnvelope;
      } catch {
        return jsonRpcError(res, 400, null, -32700, 'Parse error: request body is not valid JSON');
      }
      if (typeof body !== 'object' || body === null || typeof body.method !== 'string') {
        return jsonRpcError(res, 400, null, -32600, 'Invalid Request: missing JSON-RPC method');
      }
      // Lớp 0: header Mcp-Method/Mcp-Name (bắt buộc ở kỷ nguyên
      // 2026-07-28) khi client gửi thì PHẢI khớp body — lệch là
      // HeaderMismatchError -32020 theo đặc tả Streamable HTTP.
      const headerMethod = req.get('mcp-method');
      if (headerMethod !== undefined && headerMethod !== body.method) {
        return jsonRpcError(res, 400, body.id, -32020, 'HeaderMismatchError: Mcp-Method header does not match the request method');
      }
      if (body.method === 'tools/call') {
        const headerName = req.get('mcp-name');
        const toolName = typeof body.params?.name === 'string' ? body.params.name : undefined;
        if (headerName !== undefined && toolName !== undefined && headerName !== toolName) {
          return jsonRpcError(res, 400, body.id, -32020, 'HeaderMismatchError: Mcp-Name header does not match the tool name');
        }
      }
      // Token phải hợp lệ trước khi bất kỳ tool nào chạy (research 3.1 lớp 0).
      // Hai đường auth, chọn theo deps (lát MCP-1):
      // - AS bật (deps.oauthVerifier): RS thật — verifier của plugin
      //   kiểm chữ ký JWKS + iss/aud + hạn; scope + client_id lấy từ
      //   CHÍNH token; tài khoản phải còn hoạt động qua resolveActor
      //   (cùng nghĩa kiểm tra trong cầu bridge).
      // - AS tắt: đường lùi cầu auth MCP-0 (token JWT hệ thống HS256,
      //   trần scope = BRIDGE_SCOPES) — giữ nguyên hành vi MCP-0.
      let identity: { userId: string; username: string; tenantId: string | null };
      let tokenScopes: readonly string[];
      let verifiedClientId: string | null = null;
      if (deps.oauthVerifier) {
        const verdict = await deps.oauthVerifier.verify(toWebRequest(req, raw));
        if (!verdict.ok) {
          res.setHeader(
            'WWW-Authenticate',
            verdict.wwwAuthenticate ??
              `Bearer resource_metadata="${baseOf(req)}/.well-known/oauth-protected-resource", error="invalid_token"`,
          );
          const forbidden = verdict.status === 403;
          return jsonRpcError(
            res,
            forbidden ? 403 : 401,
            body.id,
            forbidden ? -32003 : -32001,
            forbidden
              ? 'Insufficient scope: the access token does not carry the required scope'
              : 'Unauthorized: a valid LMS access token is required',
          );
        }
        const actor = deps.resolveActor ? await deps.resolveActor(verdict.identity.userId) : null;
        if (!actor || verdict.identity.userId.length === 0) {
          res.setHeader(
            'WWW-Authenticate',
            `Bearer resource_metadata="${baseOf(req)}/.well-known/oauth-protected-resource", error="invalid_token"`,
          );
          return jsonRpcError(res, 401, body.id, -32001, 'Unauthorized: the token subject is not an active LMS user');
        }
        identity = {
          userId: verdict.identity.userId,
          username: actor.username,
          // TENANT-1 (#196): tenant của phiên — claim `tid` trên token
          // AS nếu có, không thì tenant mặc định theo membership do
          // resolveActor phân giải.
          tenantId: verdict.identity.tenantId ?? actor.tenantId ?? null,
        };
        tokenScopes = verdict.identity.scopes;
        verifiedClientId = verdict.identity.clientId;
      } else {
        const bridgeIdentity = await deps.bridgeAuth.authenticate(req.get('authorization'));
        if (!bridgeIdentity) {
          res.setHeader(
            'WWW-Authenticate',
            `Bearer resource_metadata="${baseOf(req)}/.well-known/oauth-protected-resource", error="invalid_token"`,
          );
          return jsonRpcError(res, 401, body.id, -32001, 'Unauthorized: a valid LMS access token is required');
        }
        identity = bridgeIdentity;
        tokenScopes = BRIDGE_SCOPES;
      }
      const effectiveScopes = deps.grantedScopes ?? tokenScopes;
      if (body.method === 'tools/call') {
        const toolName = typeof body.params?.name === 'string' ? body.params.name : undefined;
        // Cổng scope ở tầng mount (cùng họ 401/429): tool có scope
        // riêng mà trần hiệu lực không có → 403 + challenge step-up
        // gồm đủ scope còn thiếu trong một lần (research Phần 2.2).
        const requiredScope = toolName ? TOOL_REQUIRED_SCOPES[toolName] : undefined;
        if (requiredScope && !effectiveScopes.includes(requiredScope)) {
          res.setHeader(
            'WWW-Authenticate',
            `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${baseOf(req)}/.well-known/oauth-protected-resource"`,
          );
          return jsonRpcError(res, 403, body.id, -32003, `Insufficient scope: this tool requires "${requiredScope}"`);
        }
        // Batch tính rate-limit theo SỐ ITEM (hồ sơ 3.3: hạn mức tạo
        // tính theo câu), các tool khác một lượt gọi = một đơn vị.
        const args = body.params?.arguments;
        const cost =
          toolName === 'create_questions_batch' &&
          typeof args === 'object' &&
          args !== null &&
          Array.isArray((args as { items?: unknown }).items)
            ? ((args as { items: unknown[] }).items.length ?? 1)
            : 1;
        const decision = deps.rateLimiter.check(identity.userId, McpRateLimiter.bucketForTool(toolName), Date.now(), cost);
        if (!decision.allowed) {
          res.setHeader('Retry-After', String(decision.retryAfterSeconds));
          return jsonRpcError(res, 429, body.id, -32029, 'Rate limit exceeded for this tool; retry later');
        }
      }
      const authInfo: AuthInfo = {
        token: (req.get('authorization') ?? '').slice('Bearer '.length),
        // Đường OAuth: client_id ĐÃ ĐƯỢC AS XÁC THỰC trên token. Đường
        // cầu auth: chỉ còn clientInfo tự giới thiệu (truy vết).
        clientId: verifiedClientId ?? clientIdOf(body),
        scopes: [...effectiveScopes],
        extra: { userId: identity.userId, username: identity.username, ip: req.ip ?? null, tenantId: identity.tenantId },
      };
      // TENANT-1 (#196): toàn lượt thực thi tool chạy trong ngữ cảnh
      // tenant của PHIÊN (ALS) — pool gắn GUC theo ALS nên RLS
      // fail-closed giới hạn mọi truy vấn của tool trong tenant này;
      // bank đích của các tool ghi phân giải trong đúng tenant của
      // phiên. Phiên không phân giải được tenant → store không có
      // tenantId = fail-closed (chỉ thấy dữ liệu platform).
      const webRes = await tenantAls.run(
        { tenantId: identity.tenantId ?? undefined, userId: identity.userId },
        () => handler.fetch(toWebRequest(req, raw), { authInfo }),
      );
      return pipeWebResponse(webRes, res);
    })().catch((err: unknown) => {
      console.error('[mcp] mount error:', err);
      if (!res.headersSent) jsonRpcError(res, 500, null, -32603, 'Internal error');
    });
  });
}

function toWebRequest(req: Request, rawBody: Buffer | null): globalThis.Request {
  const protocol = req.protocol ?? 'http';
  const host = req.get('host') ?? 'localhost';
  const url = `${protocol}://${host}${req.originalUrl ?? req.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (['host', 'content-length', 'connection'].includes(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  if (req.method === 'POST' && rawBody !== null) {
    return new globalThis.Request(url, { method: 'POST', headers, body: new Uint8Array(rawBody) });
  }
  return new globalThis.Request(url, { method: req.method, headers });
}

async function pipeWebResponse(webRes: globalThis.Response, res: Response): Promise<void> {
  res.status(webRes.status);
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-length') return;
    res.setHeader(key, value);
  });
  if (!webRes.body) {
    res.end();
    return;
  }
  const reader = webRes.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) res.write(Buffer.from(value));
  }
  res.end();
}
