import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { VersioningType, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Lát MCP-1 (issue #163) — máy chủ OAuth cho MCP bằng plugin Better
 * Auth + bộ tool batch/stimulus/publish/tra YCCĐ. Spec chạy với CẢ HAI
 * cờ BETTER_AUTH_ENABLED + MCP_AS_ENABLED bật và kiểm các cổng bắt
 * buộc của issue trên HTTP thật:
 *  - discovery: AS metadata + JWKS + PRM trỏ issuer của BA.
 *  - luồng DCR (kỷ nguyên legacy): register → sign-in phiên BA →
 *    authorize → consent → token PKCE; JWT đúng iss/aud/client_id/
 *    scope, TTL 3600s. Client MCP gọi tool ở CẢ hai kỷ nguyên.
 *  - bộ tool MCP-1: batch từng-item + idempotency từng câu, nhóm ngữ
 *    liệu NGUYÊN TỬ (một câu lỗi → không gì được tạo), publish
 *    draft→ready + publish_not_draft, search_questions,
 *    check_duplicates, search_curriculum_outcomes, submit_contribution
 *    hồi quy trên đường AS.
 *  - ca scope hẹp dựng được: token chỉ lms.questions.read → tạo câu
 *    và publish đều 403 insufficient_scope (-32003) ở tầng mount.
 *  - token cầu auth cũ (JWT hệ thống HS256) bị RS từ chối 401; token
 *    bị sửa chữ ký → 401; không token → 401.
 *  - refresh token xoay vòng: refresh cũ dùng lại bị chặn
 *    (refreshTokenReuseInterval = 0).
 *  - luồng CIMD (kỷ nguyên 2026-07-28): client_id là URL tài liệu
 *    metadata (app riêng có transport CIMD được tiêm để chạy loopback)
 *    authorize → token → gọi tool đạt.
 *
 * Biến môi trường phải tồn tại TRƯỚC khi AppModule được nạp nên mọi
 * import của app đều là import động trong beforeAll (mẫu của spec
 * better-auth-flow).
 */
process.env.BETTER_AUTH_ENABLED = 'true';
process.env.MCP_AS_ENABLED = 'true';
process.env.BETTER_AUTH_SECRET = ['mcp-as-spec', 'secret', '0123456789abcdef'].join('-');
process.env.BETTER_AUTH_TRUSTED_ORIGINS = 'http://localhost:3100';

const ORIGIN = 'http://localhost:3100';
const ISSUER = `${ORIGIN}/api/v1/auth`;
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT_URI = 'http://127.0.0.1:8765/callback';
const BA_PASSWORD = ['McpAs', '!234567'].join('');
const ALL_SCOPES = 'lms.questions.read lms.questions.draft lms.questions.write lms.banks.contribute';

type Helpers = typeof import('./identity-access-helpers');
let helpers: Helpers;

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'mcp-as-spec', version: '0.1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

interface McpReply {
  status: number;
  jsonrpcError?: { code: number; message: string };
  wwwAuthenticate?: string;
  isError: boolean;
  structured?: Record<string, any>;
  text: string;
}

function parseMcpBody(raw: string): { result?: any; error?: { code: number; message: string } } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
  }
  throw new Error(`Unparseable MCP response: ${raw.slice(0, 300)}`);
}

async function mcpCall(
  app: INestApplication,
  token: string | null,
  method: string,
  params: Record<string, unknown>,
  era: 'modern' | 'legacy' = 'modern',
): Promise<McpReply> {
  let req = helpers.http(app).post('/mcp').set('Content-Type', 'application/json');
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  const bodyParams = { ...params };
  if (era === 'modern') {
    bodyParams._meta = MODERN_META;
    req = req.set('MCP-Protocol-Version', '2026-07-28').set('Mcp-Method', method);
    if (method === 'tools/call' && typeof params.name === 'string') req = req.set('Mcp-Name', params.name);
  } else {
    req = req.set('Accept', 'application/json, text/event-stream');
  }
  const res = await req.send({ jsonrpc: '2.0', id: 1, method, params: bodyParams });
  const parsed = parseMcpBody(res.text);
  const wwwAuthenticate = res.headers['www-authenticate'] as string | undefined;
  if (parsed.error) {
    return { status: res.status, jsonrpcError: parsed.error, wwwAuthenticate, isError: true, text: parsed.error.message };
  }
  const result = parsed.result ?? {};
  return {
    status: res.status,
    wwwAuthenticate,
    isError: result.isError === true,
    structured: result.structuredContent as Record<string, any> | undefined,
    text: (result.content?.[0]?.text as string) ?? '',
  };
}

const callTool = (
  app: INestApplication,
  token: string,
  name: string,
  args: Record<string, unknown>,
  era: 'modern' | 'legacy' = 'modern',
) => mcpCall(app, token, 'tools/call', { name, arguments: args }, era);

function decodeJwtPayload(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomUUID() + randomUUID();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function sessionCookieFrom(setCookie: string[] | undefined): string {
  const raw = (setCookie ?? []).find((value) => value.includes('better-auth.session_token='));
  if (!raw) throw new Error(`no Better Auth session cookie in: ${JSON.stringify(setCookie)}`);
  return raw.split(';')[0]!;
}

/** Đăng nhập phiên Better Auth bằng username (đường của trang /mcp-login). */
async function signInBetterAuth(app: INestApplication, username: string): Promise<string> {
  const res = await helpers
    .http(app)
    .post('/api/v1/auth/sign-in/username')
    .set('Origin', ORIGIN)
    .send({ username, password: BA_PASSWORD });
  expect(res.status, `sign-in failed: ${res.text.slice(0, 300)}`).toBe(200);
  return sessionCookieFrom(res.headers['set-cookie'] as unknown as string[] | undefined);
}

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

/**
 * Chạy trọn luồng authorize cho một client đã biết (DCR hoặc CIMD):
 * authorize (kèm cookie phiên) → consent accept → token PKCE.
 * `clientId` của CIMD là URL tài liệu metadata.
 */
async function runAuthorizeFlow(
  app: INestApplication,
  cookie: string,
  clientId: string,
  scope: string,
  options?: { offlineAccess?: boolean },
): Promise<TokenSet> {
  // `offline_access` là scope GIAO THỨC phía AS (không phải scope
  // quyền LMS): plugin oauth-provider CHỈ cấp refresh token khi
  // authorize xin scope này (kiểm chứng trong dist 1.7.12) — luồng
  // chính xin kèm để có refresh token mà xoay vòng. Access token
  // mang offline_access trong claim scope (resource không ghim
  // allowedScopes — xem better-auth.instance.ts); RS bỏ qua scope
  // này khi gác theo tool.
  const requestedScope = options?.offlineAccess ? `${scope} offline_access` : scope;
  const { verifier, challenge } = pkcePair();
  const authorizeParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: requestedScope,
    state: 'spec-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
  });
  const authorizeRes = await helpers
    .http(app)
    .get(`/api/v1/auth/oauth2/authorize?${authorizeParams.toString()}`)
    .set('Cookie', cookie)
    .redirects(0);
  expect(
    authorizeRes.status,
    `authorize did not redirect: ${authorizeRes.status} ${authorizeRes.text.slice(0, 300)}`,
  ).toBe(302);
  const location = authorizeRes.headers.location as string;
  let callbackUrl: URL;
  if (location.startsWith(REDIRECT_URI)) {
    // AS BỎ QUA trang consent khi consent đã lưu của (user, client)
    // bao phủ scope đang xin (kiểm chứng chạy thật: lượt authorize
    // thứ hai cho cùng client chuyển thẳng về callback kèm code) —
    // client thật phải chấp nhận cả hai hình redirect này.
    callbackUrl = new URL(location);
  } else {
    expect(location).toContain('/mcp-consent');
    // Chuỗi query authorize đã ký mà AS gắn vào URL consent — gửi lại
    // nguyên văn làm oauth_query (đúng cách trang web consent làm):
    // plugin đóng gói TOÀN BỘ query authorize vào một tham số
    // `oauth_query` đã ký; trang consent không tự tách từng tham số.
    const consentUrl = new URL(location, ORIGIN);
    const packed = consentUrl.searchParams.get('oauth_query');
    const oauthQuery = packed ?? consentUrl.search.replace(/^\?/, '');

    const consentRes = await helpers
      .http(app)
      .post('/api/v1/auth/oauth2/consent')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .send({ accept: true, scope: requestedScope, oauth_query: oauthQuery });
    expect(consentRes.status, `consent failed: ${consentRes.text.slice(0, 300)}`).toBe(200);
    const redirectTarget = (consentRes.body as { url?: string }).url;
    expect(redirectTarget, `consent response: ${JSON.stringify(consentRes.body).slice(0, 300)}`).toBeTruthy();
    expect(redirectTarget!.startsWith(REDIRECT_URI), `consent did not return callback: ${redirectTarget!.slice(0, 300)}`).toBe(true);
    callbackUrl = new URL(redirectTarget!);
  }
  const code = callbackUrl.searchParams.get('code');
  expect(code, `callback without code: ${callbackUrl.toString().slice(0, 300)}`).toBeTruthy();

  const tokenRes = await helpers
    .http(app)
    .post('/api/v1/auth/oauth2/token')
    .set('Origin', ORIGIN)
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
  expect(tokenRes.status, `token exchange failed: ${tokenRes.text.slice(0, 400)}`).toBe(200);
  const body = tokenRes.body as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    scope: body.scope,
  };
}

/** Đăng ký client qua DCR (đường legacy) — public client + PKCE. */
async function registerClient(app: INestApplication, name: string): Promise<string> {
  const res = await helpers
    .http(app)
    .post('/api/v1/auth/oauth2/register')
    .set('Origin', ORIGIN)
    .send({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      // Client đăng ký cả `offline_access`: authorize validate scope
      // xin theo ĐÚNG tập scope client đã đăng ký (client.scopes của
      // plugin), và refresh token chỉ được cấp khi offline_access
      // nằm trong scope đã duyệt — client thật muốn phiên dài đều
      // đăng ký như vậy.
      scope: `${ALL_SCOPES} offline_access`,
    });
  expect(res.status, `DCR failed: ${res.text.slice(0, 400)}`).toBe(201);
  const clientId = (res.body as { client_id?: string }).client_id;
  expect(clientId).toBeTruthy();
  return clientId!;
}

async function createAsApp(cimdFetch?: (input: unknown, init?: unknown) => Promise<Response>): Promise<INestApplication> {
  const { AppModule } = await import('../src/app.module');
  const { enableTrustedProxy } = await import('../src/common/client-ip');
  const { ProblemDetailsFilter } = await import('../src/common/problem-details.filter');
  const { mountBetterAuth } = await import('../src/modules/auth/better-auth/better-auth.mount');
  const { BetterAuthService } = await import('../src/modules/auth/better-auth/better-auth.service');
  const { createBetterAuth } = await import('../src/modules/auth/better-auth/better-auth.instance');
  const { mountMcp } = await import('../src/modules/mcp/mcp.mount');
  const { McpDepsService } = await import('../src/modules/mcp/mcp-deps.service');
  const { getDrizzleToken } = await import('@nestjs/drizzle');
  const { PasswordService } = await import('../src/modules/users/password.service');

  let moduleBuilder = Test.createTestingModule({ imports: [AppModule] });
  if (cimdFetch) {
    // App CIMD: thay instance BA bằng bản có transport CIMD tiêm riêng
    // (transport Node chính chủ chặn loopback theo chính sách SSRF —
    // spec chạy metadata server trên 127.0.0.1 nên phải tiêm fetch).
    moduleBuilder = moduleBuilder.overrideProvider(BetterAuthService).useFactory({
      factory: (db: unknown, passwordService: InstanceType<typeof PasswordService>) => {
        const mcpAs = {
          resource: RESOURCE,
          loginPage: '/mcp-login',
          consentPage: '/mcp-consent',
          cimdFetch: cimdFetch as never,
        };
        const auth = createBetterAuth({
          db: db as never,
          secret: process.env.BETTER_AUTH_SECRET!,
          baseURL: ORIGIN,
          trustedOrigins: [ORIGIN],
          passwordService,
          mcpAs,
        });
        return {
          enabled: true,
          mcpAsEnabled: true,
          auth,
          mcpAs,
          requireAuth: () => auth,
        };
      },
      inject: [getDrizzleToken(), PasswordService],
    });
  }
  const moduleRef = await moduleBuilder.compile();
  const app = moduleRef.createNestApplication();
  enableTrustedProxy(app as NestExpressApplication);
  const betterAuth = app.get(BetterAuthService);
  mountBetterAuth(app as NestExpressApplication, betterAuth.requireAuth());
  mountMcp(app as NestExpressApplication, app.get(McpDepsService).createMountDeps());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  // RS kiểm access token bằng JWKS lấy qua HTTP THẬT từ issuer
  // (http://localhost:3100/api/v1/auth/jwks — đường
  // createMcpProtectedRequestHandler của plugin): app phải NGHE ở
  // đúng cổng của issuer thì fetch JWKS mới tới nơi; chỉ init +
  // supertest in-process là JWKS fetch chết ECONNREFUSED và mọi
  // tool call đều bị RS bác (kiểm chứng chạy thật lúc nối lại).
  await app.listen(3100);
  return app;
}

describe('MCP-1: máy chủ OAuth (AS) + RS + bộ tool mới (issue #163)', () => {
  let app: INestApplication;
  let pg: Client;
  let adminLegacy = '';
  let teacherId = '';
  let teacherUsername = '';
  let cookie = '';
  let clientId = '';
  let tokens: TokenSet;
  let bankId = '';
  let categoryId = '';
  let createdQuestionId = '';
  let batchQuestionId = '';

  async function sqlOne<T>(sqlText: string, params: unknown[] = []): Promise<T> {
    const res = await pg.query(sqlText, params);
    return res.rows[0] as T;
  }

  beforeAll(async () => {
    helpers = await import('./identity-access-helpers');
    app = await createAsApp();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    adminLegacy = await helpers.adminToken(app);

    // Giáo viên có credential Better Auth (cầu nối của GĐ1) + vai
    // teacher tại hệ thống để có bank cá nhân như giáo viên thật.
    const { CredentialBridgeService } = await import('../src/modules/auth/better-auth/credential-bridge.service');
    const bridge = app.get(CredentialBridgeService);
    teacherUsername = helpers.uniqueName('mcpteacher');
    const created = await bridge.createUserWithCredential({
      email: `${teacherUsername}@example.com`,
      username: teacherUsername,
      firstName: 'MCP',
      lastName: 'Teacher',
      password: BA_PASSWORD,
    });
    teacherId = created.id;
    await helpers.assignRole(
      app,
      adminLegacy,
      teacherId,
      await helpers.roleIdByShortname(app, adminLegacy, 'teacher'),
      await helpers.systemContextId(app, adminLegacy),
    );
    cookie = await signInBetterAuth(app, teacherUsername);
    clientId = await registerClient(app, 'MCP AS spec client');
    tokens = await runAuthorizeFlow(app, cookie, clientId, ALL_SCOPES, { offlineAccess: true });
  });

  afterAll(async () => {
    await pg?.end();
    await app?.close();
  });

  it('discovery: AS metadata + JWKS công khai + PRM trỏ issuer của Better Auth', async () => {
    const metadata = await helpers.http(app).get('/api/v1/auth/.well-known/oauth-authorization-server');
    expect(metadata.status).toBe(200);
    expect((metadata.body as { issuer?: string }).issuer).toBe(ISSUER);
    expect((metadata.body as { jwks_uri?: string }).jwks_uri).toBe(`${ISSUER}/jwks`);

    const jwks = await helpers.http(app).get('/api/v1/auth/jwks');
    expect(jwks.status).toBe(200);
    expect(((jwks.body as { keys?: unknown[] }).keys ?? []).length).toBeGreaterThan(0);

    const prm = await helpers.http(app).get('/.well-known/oauth-protected-resource');
    expect(prm.status).toBe(200);
    expect((prm.body as { resource?: string }).resource).toBe(RESOURCE);
    expect((prm.body as { authorization_servers?: string[] }).authorization_servers).toEqual([ISSUER]);
  });

  it('authorize không có phiên BA → bị chuyển về trang login của MCP', async () => {
    const { challenge } = pkcePair();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: ALL_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    const res = await helpers.http(app).get(`/api/v1/auth/oauth2/authorize?${params.toString()}`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location as string).toContain('/mcp-login');
  });

  it('token qua DCR + PKCE mang đúng iss/aud/client_id/scope và TTL 3600s', () => {
    const claims = decodeJwtPayload(tokens.accessToken);
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(RESOURCE);
    expect(claims.sub).toBe(teacherId);
    expect(claims.client_id).toBe(clientId);
    // Claim scope = 4 scope quyền + offline_access (scope giao thức
    // đi kèm để vòng đời refresh token xoay vòng được — xem
    // better-auth.instance.ts mục resources).
    expect(new Set((claims.scope as string).split(' '))).toEqual(
      new Set([...ALL_SCOPES.split(' '), 'offline_access']),
    );
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600);
    expect(tokens.expiresIn).toBe(3600);
    expect(tokens.refreshToken).toBeTruthy();
  });

  it('tools/list + resources/list + prompts/list phơi đủ bề mặt MCP-1 ở kỷ nguyên modern', async () => {
    const raw = await helpers
      .http(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Mcp-Method', 'tools/list')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: MODERN_META } });
    const toolNames = (JSON.parse(raw.text).result.tools as { name: string }[]).map((t) => t.name);
    for (const expected of [
      'list_my_banks', 'list_categories', 'create_question', 'get_question', 'submit_contribution',
      'create_questions_batch', 'create_stimulus_with_questions', 'publish_questions',
      'search_questions', 'check_duplicates', 'search_curriculum_outcomes',
    ]) {
      expect(toolNames).toContain(expected);
    }
    const resources = await helpers
      .http(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Mcp-Method', 'resources/list')
      .send({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: { _meta: MODERN_META } });
    const resourceUris = (JSON.parse(resources.text).result.resources as { uri: string }[]).map((r) => r.uri);
    expect(resourceUris).toContain('lms://guide/question-authoring');
    const prompts = await helpers
      .http(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Mcp-Method', 'prompts/list')
      .send({ jsonrpc: '2.0', id: 1, method: 'prompts/list', params: { _meta: MODERN_META } });
    const promptNames = (JSON.parse(prompts.text).result.prompts as { name: string }[]).map((p) => p.name);
    expect(promptNames).toContain('tao_cau_hoi_theo_yccd');
  });

  it('create_question bằng access token OAuth: draft + source_ref là client_id THẬT; chạy ở cả hai kỷ nguyên', async () => {
    const banks = await callTool(app, tokens.accessToken, 'list_my_banks', {});
    expect(banks.isError).toBe(false);
    const personal = (banks.structured!.banks as any[]).find((b) => b.scope === 'personal');
    expect(personal, 'teacher must have a personal bank').toBeTruthy();
    bankId = personal.id;
    categoryId = personal.defaultCategoryId;

    const modern = await callTool(app, tokens.accessToken, 'create_question', {
      bankId,
      categoryId,
      qtype: 'multichoice',
      name: helpers.uniqueName('mcpAsQ'),
      questionText: 'Thủ đô của Việt Nam là gì?',
      answers: [
        { text: 'Hà Nội', fraction: 1 },
        { text: 'Huế', fraction: 0 },
      ],
      idempotencyKey: helpers.uniqueName('key'),
    });
    expect(modern.isError, modern.text).toBe(false);
    expect(modern.structured!.status).toBe('created');
    expect(modern.structured!.questionStatus).toBe('draft');
    createdQuestionId = modern.structured!.questionId as string;

    const row = await sqlOne<{ source_kind: string; source_ref: string; status: string }>(
      `select q.source_kind, q.source_ref, e.status from question q
         join question_bank_entries e on e.question_id = q.id where q.id = $1`,
      [createdQuestionId],
    );
    expect(row.source_kind).toBe('ai');
    // Khác kỷ nguyên cầu auth (clientInfo tự giới thiệu): source_ref
    // mang client_id do AS cấp, đã xác thực trên token.
    expect(row.source_ref).toBe(`client:${clientId}`);
    expect(row.status).toBe('draft');

    const legacy = await callTool(
      app,
      tokens.accessToken,
      'create_question',
      {
        bankId,
        categoryId,
        qtype: 'essay',
        name: helpers.uniqueName('mcpAsLegacy'),
        questionText: 'Trình bày vai trò của sông Hồng trong lịch sử Thăng Long.',
        idempotencyKey: helpers.uniqueName('key'),
      },
      'legacy',
    );
    expect(legacy.isError, legacy.text).toBe(false);
    expect(legacy.structured!.status).toBe('created');
  });

  it('batch: từng-item (created + duplicate_exact + stimulusRef) và idempotency từng câu khi phát lại', async () => {
    const key = helpers.uniqueName('batch');
    const payload = {
      bankId,
      categoryId,
      stimuli: [{ ref: 'doan-van', content: 'Đoạn văn mẫu về đồng bằng sông Hồng dùng cho hai câu hỏi.' }],
      items: [
        {
          clientItemId: 'cau-1',
          qtype: 'multichoice',
          name: helpers.uniqueName('batchQ1'),
          questionText: 'Đồng bằng sông Hồng được bồi đắp bởi sông nào?',
          answers: [
            { text: 'Sông Hồng', fraction: 1 },
            { text: 'Sông Cửu Long', fraction: 0 },
          ],
          stimulusRef: 'doan-van',
        },
        {
          clientItemId: 'cau-2',
          qtype: 'multichoice',
          name: 'Trùng với câu đã tạo',
          questionText: 'Thủ đô của Việt Nam là gì?',
          answers: [
            { text: 'Hà Nội', fraction: 1 },
            { text: 'Huế', fraction: 0 },
          ],
        },
        {
          clientItemId: 'cau-3',
          qtype: 'truefalse',
          name: helpers.uniqueName('batchQ3'),
          questionText: 'Sông Hồng chảy qua Hà Nội.',
          answers: [
            { text: 'True', fraction: 1 },
            { text: 'False', fraction: 0 },
          ],
          stimulusRef: 'doan-van',
        },
      ],
      idempotencyKey: key,
    };
    const first = await callTool(app, tokens.accessToken, 'create_questions_batch', payload);
    expect(first.isError, first.text).toBe(false);
    const out = first.structured!;
    expect(out.stimuli).toHaveLength(1);
    expect(out.stimuli[0].status).toBe('created');
    const byItem = new Map((out.results as any[]).map((r) => [r.clientItemId, r]));
    expect(byItem.get('cau-1')!.status).toBe('created');
    expect(byItem.get('cau-2')!.status).toBe('duplicate_exact');
    expect(byItem.get('cau-2')!.existingQuestionId).toBe(createdQuestionId);
    expect(byItem.get('cau-3')!.status).toBe('created');
    batchQuestionId = byItem.get('cau-1')!.questionId as string;
    // Câu batch bám đúng ngữ liệu đã khai trong lô.
    const link = await sqlOne<{ stimulus_id: string | null }>(
      'select stimulus_id from question_versions where question_id = $1',
      [batchQuestionId],
    );
    expect(link.stimulus_id).toBe(out.stimuli[0].stimulusId);

    const countBefore = await sqlOne<{ n: number }>(
      'select count(*)::int as n from question where created_by = $1',
      [teacherId],
    );
    const replay = await callTool(app, tokens.accessToken, 'create_questions_batch', payload);
    expect(replay.isError, replay.text).toBe(false);
    const replayByItem = new Map((replay.structured!.results as any[]).map((r) => [r.clientItemId, r]));
    expect(replayByItem.get('cau-1')!.questionId).toBe(batchQuestionId);
    const countAfter = await sqlOne<{ n: number }>(
      'select count(*)::int as n from question where created_by = $1',
      [teacherId],
    );
    expect(countAfter.n).toBe(countBefore.n);
  });

  it('nhóm ngữ liệu nguyên tử: một câu lỗi → KHÔNG gì được tạo; nhóm đúng → ngữ liệu + câu cùng draft', async () => {
    const countBefore = await sqlOne<{ n: number }>(
      'select count(*)::int as n from question where created_by = $1',
      [teacherId],
    );
    const stimuliBefore = await sqlOne<{ n: number }>(
      'select count(*)::int as n from stimuli where created_by = $1',
      [teacherId],
    );
    const bad = await callTool(app, tokens.accessToken, 'create_stimulus_with_questions', {
      bankId,
      categoryId,
      stimulusContent: 'Đoạn văn nguyên tử — không được tồn tại sau ca lỗi.',
      questions: [
        { qtype: 'essay', name: helpers.uniqueName('atomicOk'), questionText: 'Câu đúng trong nhóm lỗi.' },
        {
          qtype: 'truefalse',
          name: helpers.uniqueName('atomicBad'),
          questionText: 'Câu truefalse sai định dạng đáp án.',
          answers: [{ text: 'Đúng', fraction: 1 }],
        },
      ],
      idempotencyKey: helpers.uniqueName('atomic'),
    });
    expect(bad.isError).toBe(true);
    expect(bad.structured!.error.code).toBe('question.bad_answer_data');
    const countAfterBad = await sqlOne<{ n: number }>(
      'select count(*)::int as n from question where created_by = $1',
      [teacherId],
    );
    const stimuliAfterBad = await sqlOne<{ n: number }>(
      'select count(*)::int as n from stimuli where created_by = $1',
      [teacherId],
    );
    expect(countAfterBad.n).toBe(countBefore.n);
    expect(stimuliAfterBad.n).toBe(stimuliBefore.n);

    const good = await callTool(app, tokens.accessToken, 'create_stimulus_with_questions', {
      bankId,
      categoryId,
      stimulusContent: 'Đoạn văn nguyên tử — nhóm đúng phải có đúng một ngữ liệu.',
      questions: [
        { qtype: 'essay', name: helpers.uniqueName('atomicGood1'), questionText: 'Câu 1 của nhóm nguyên tử.' },
        { qtype: 'essay', name: helpers.uniqueName('atomicGood2'), questionText: 'Câu 2 của nhóm nguyên tử.' },
      ],
      idempotencyKey: helpers.uniqueName('atomic'),
    });
    expect(good.isError, good.text).toBe(false);
    expect(good.structured!.created).toBe(2);
    const stimulusId = good.structured!.stimulusId as string;
    const attached = await sqlOne<{ n: number }>(
      'select count(*)::int as n from question_versions where stimulus_id = $1',
      [stimulusId],
    );
    expect(attached.n).toBe(2);
  });

  it('publish_questions: draft → ready; chạy lại với key mới → publish_not_draft; submit_contribution hồi quy trên đường AS', async () => {
    const publish = await callTool(app, tokens.accessToken, 'publish_questions', {
      questionIds: [createdQuestionId],
      idempotencyKey: helpers.uniqueName('pub'),
    });
    expect(publish.isError, publish.text).toBe(false);
    expect(publish.structured!.results[0].status).toBe('published');
    const row = await sqlOne<{ status: string }>(
      'select status from question_bank_entries where question_id = $1',
      [createdQuestionId],
    );
    expect(row.status).toBe('ready');

    const again = await callTool(app, tokens.accessToken, 'publish_questions', {
      questionIds: [createdQuestionId],
      idempotencyKey: helpers.uniqueName('pub'),
    });
    expect(again.isError).toBe(false);
    expect(again.structured!.results[0].status).toBe('failed');
    expect(again.structured!.results[0].code).toBe('question.publish_not_draft');

    const { QuestionBanksService } = await import('../src/modules/questions/question-banks.service');
    const banksService = app.get(QuestionBanksService);
    const schoolBank = await banksService.ensureSchoolBank(teacherId);
    const submit = await callTool(app, tokens.accessToken, 'submit_contribution', {
      targetBankId: schoolBank.id,
      questionIds: [createdQuestionId],
      note: 'Đóng góp kiểm hồi quy MCP-1',
      idempotencyKey: helpers.uniqueName('key'),
    });
    expect(submit.isError, submit.text).toBe(false);
    expect(submit.structured!.results[0].status).toBe('pending');
  });

  it('search_questions + check_duplicates + search_curriculum_outcomes', async () => {
    const search = await callTool(app, tokens.accessToken, 'search_questions', {
      bankId,
      query: 'Thủ đô của Việt Nam',
    });
    expect(search.isError, search.text).toBe(false);
    expect((search.structured!.questions as any[]).some((q) => q.id === createdQuestionId)).toBe(true);

    const dup = await callTool(app, tokens.accessToken, 'check_duplicates', {
      bankId,
      items: [
        {
          clientItemId: 'soi-1',
          qtype: 'multichoice',
          questionText: 'Thủ đô của Việt Nam là gì?',
          answers: [
            { text: 'Hà Nội', fraction: 1 },
            { text: 'Huế', fraction: 0 },
          ],
        },
        { clientItemId: 'soi-2', qtype: 'essay', questionText: 'Một câu hoàn toàn mới chưa từng có.' },
      ],
    });
    expect(dup.isError, dup.text).toBe(false);
    const verdicts = new Map((dup.structured!.results as any[]).map((r) => [r.clientItemId, r.verdict]));
    expect(verdicts.get('soi-1')).toBe('exact');
    expect(verdicts.get('soi-2')).toBe('none');

    // YCCĐ gieo thẳng SQL vào context hệ thống (môn Toán lớp 5) — giáo
    // viên đọc được qua curriculum:view như bề mặt chương trình thật.
    const systemContextId = await helpers.systemContextId(app, adminLegacy);
    const subject = await sqlOne<{ id: string }>(
      `insert into subjects (context_id, name, slug) values ($1, $2, $3) returning id`,
      [systemContextId, 'Toán MCP-1', helpers.uniqueName('toan-mcp1')],
    );
    const curriculum = await sqlOne<{ id: string }>(
      'insert into curricula (subject_id, grade) values ($1, 5) returning id',
      [subject.id],
    );
    const node = await sqlOne<{ id: string }>(
      `insert into curriculum_nodes (curriculum_id, title, kind, position) values ($1, 'Số thập phân', 'topic', 1) returning id`,
      [curriculum.id],
    );
    await pg.query(
      `insert into learning_outcomes (node_id, content, position, source_ref) values ($1, $2, 1, 'MCP1-YCCD-1')`,
      [node.id, 'Viết được số thập phân gồm phần nguyên và phần thập phân'],
    );
    const outcomes = await callTool(app, tokens.accessToken, 'search_curriculum_outcomes', {
      query: 'số thập phân',
      gradeLevel: 5,
    });
    expect(outcomes.isError, outcomes.text).toBe(false);
    const found = (outcomes.structured!.outcomes as any[]).find((o) => o.sourceRef === 'MCP1-YCCD-1');
    expect(found, `outcomes: ${JSON.stringify(outcomes.structured).slice(0, 400)}`).toBeTruthy();
    expect(found.subjectName).toBe('Toán MCP-1');
    expect(found.grade).toBe(5);
  });

  it('ca scope hẹp: token chỉ lms.questions.read → đọc được, tạo/publish bị 403 insufficient_scope ở mount', async () => {
    const narrow = await runAuthorizeFlow(app, cookie, clientId, 'lms.questions.read');
    expect(decodeJwtPayload(narrow.accessToken).scope).toBe('lms.questions.read');

    const read = await callTool(app, narrow.accessToken, 'list_my_banks', {});
    expect(read.isError).toBe(false);

    const create = await callTool(app, narrow.accessToken, 'create_question', {
      bankId,
      categoryId,
      qtype: 'essay',
      name: helpers.uniqueName('narrowQ'),
      questionText: 'Câu này không được phép tạo bằng token chỉ đọc.',
      idempotencyKey: helpers.uniqueName('key'),
    });
    expect(create.status).toBe(403);
    expect(create.jsonrpcError!.code).toBe(-32003);
    expect(create.wwwAuthenticate ?? '').toContain('insufficient_scope');

    const publish = await callTool(app, narrow.accessToken, 'publish_questions', {
      questionIds: [batchQuestionId],
      idempotencyKey: helpers.uniqueName('pub'),
    });
    expect(publish.status).toBe(403);
    expect(publish.jsonrpcError!.code).toBe(-32003);
  });

  it('RS chặn: token cầu auth cũ (JWT hệ thống) → 401; token bị sửa chữ ký → 401; không token → 401', async () => {
    const legacySystemToken = await helpers.adminToken(app);
    const viaBridge = await callTool(app, legacySystemToken, 'list_my_banks', {});
    expect(viaBridge.status).toBe(401);
    expect(viaBridge.jsonrpcError!.code).toBe(-32001);

    const parts = tokens.accessToken.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}xx`;
    const forged = await callTool(app, tampered, 'list_my_banks', {});
    expect(forged.status).toBe(401);

    const anonymous = await mcpCall(app, null, 'tools/list', {});
    expect(anonymous.status).toBe(401);
    expect(anonymous.jsonrpcError!.code).toBe(-32001);
  });

  it('refresh token xoay vòng: refresh cũ dùng lại bị chặn (reuse interval = 0)', async () => {
    const res = await helpers
      .http(app)
      .post('/api/v1/auth/oauth2/token')
      .set('Origin', ORIGIN)
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: clientId,
        resource: RESOURCE,
      });
    expect(res.status, `refresh failed: ${res.text.slice(0, 300)}`).toBe(200);
    const rotated = res.body as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(tokens.refreshToken);

    const reuse = await helpers
      .http(app)
      .post('/api/v1/auth/oauth2/token')
      .set('Origin', ORIGIN)
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: clientId,
        resource: RESOURCE,
      });
    expect(reuse.status).toBeGreaterThanOrEqual(400);
    expect((reuse.body as { error?: string }).error).toBeTruthy();

    // Access token mới từ refresh vẫn gọi tool được.
    const probe = await callTool(app, rotated.access_token, 'list_my_banks', {});
    expect(probe.isError).toBe(false);
    tokens = { ...tokens, accessToken: rotated.access_token, refreshToken: rotated.refresh_token };
  });
});

describe('MCP-1: luồng CIMD — client_id là URL tài liệu metadata (issue #163)', () => {
  let app: INestApplication;
  let metadataServer: Server;
  let pg: Client;
  let cookie = '';

  afterAll(async () => {
    await pg?.end();
    await app?.close();
    if (metadataServer) await new Promise<void>((resolve) => metadataServer.close(() => resolve()));
  });

  it('authorize bằng client CIMD (không đăng ký trước) → token → gọi tool đạt', async () => {
    helpers = await import('./identity-access-helpers');
    // Metadata server tí hon: tài liệu CIMD của client, client_id
    // chính là URL của tài liệu (hồ sơ mcp-2026-07-28).
    let clientUrl = '';
    metadataServer = createServer((req, res) => {
      if (req.url === '/client.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            client_id: clientUrl,
            client_name: 'CIMD Spec Client',
            redirect_uris: [REDIRECT_URI],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            scope: ALL_SCOPES,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => metadataServer.listen(0, '127.0.0.1', resolve));
    const address = metadataServer.address();
    if (!address || typeof address === 'string') throw new Error('metadata server has no port');
    // Plugin CIMD 1.7.12 CHỈ phân giải client_id là URL HTTPS trỏ
    // host CÔNG KHAI (validateClientIdUrl chặn https-thiếu/loopback/
    // private ở tầng chính sách TRƯỚC cả fetch, kiểm chứng trong
    // dist) — client_id vì thế là một URL https trên tên miền công
    // khai dạng văn bản; fetch tiêm riêng ÁNH XẠ URL đó về metadata
    // server loopback của spec (tài liệu vẫn do server tí hon này
    // phục vụ, client_id trong tài liệu khớp URL https).
    clientUrl = 'https://mcp-cimd-spec.example.com/client.json';
    const localMetadataUrl = `http://127.0.0.1:${address.port}/client.json`;

    app = await createAsApp((input, init) => {
      if (String(input) === clientUrl) return fetch(localMetadataUrl, init as never);
      return fetch(input as never, init as never);
    });
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const adminLegacy = await helpers.adminToken(app);
    const { CredentialBridgeService } = await import('../src/modules/auth/better-auth/credential-bridge.service');
    const bridge = app.get(CredentialBridgeService);
    const username = helpers.uniqueName('mcpCimdTeacher');
    const created = await bridge.createUserWithCredential({
      email: `${username}@example.com`,
      username,
      firstName: 'CIMD',
      lastName: 'Teacher',
      password: BA_PASSWORD,
    });
    await helpers.assignRole(
      app,
      adminLegacy,
      created.id,
      await helpers.roleIdByShortname(app, adminLegacy, 'teacher'),
      await helpers.systemContextId(app, adminLegacy),
    );
    cookie = await signInBetterAuth(app, username);

    const cimdTokens = await runAuthorizeFlow(app, cookie, clientUrl, ALL_SCOPES);
    const claims = decodeJwtPayload(cimdTokens.accessToken);
    expect(claims.client_id).toBe(clientUrl);
    expect(claims.aud).toBe(RESOURCE);

    const banks = await callTool(app, cimdTokens.accessToken, 'list_my_banks', {});
    expect(banks.isError, banks.text).toBe(false);
    const personal = (banks.structured!.banks as any[]).find((b) => b.scope === 'personal');
    expect(personal).toBeTruthy();
    const created2 = await callTool(app, cimdTokens.accessToken, 'create_question', {
      bankId: personal.id,
      categoryId: personal.defaultCategoryId,
      qtype: 'essay',
      name: helpers.uniqueName('cimdQ'),
      questionText: 'Câu hỏi tạo qua client CIMD.',
      idempotencyKey: helpers.uniqueName('key'),
    });
    expect(created2.isError, created2.text).toBe(false);
    const row = await pg.query('select source_ref from question where id = $1', [created2.structured!.questionId]);
    expect(row.rows[0].source_ref).toBe(`client:${clientUrl}`);
  });
});
