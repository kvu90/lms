import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpOAuthVerifier } from './mcp-oauth-verifier';

/**
 * Kiểm chứng bộ kiểm token RS của lát MCP-1 (issue #163) ở mức đơn
 * vị: một AS tí hon (JWKS tự phục vụ + khoá RS256 ký bằng node:crypto)
 * phát token cho verifier thật (createMcpProtectedRequestHandler của
 * plugin). Các ca chặn bắt buộc của issue — sai audience, sai chữ ký,
 * hết hạn — đều phải về 401; token đúng phải cho danh tính + scope +
 * client_id nguyên vẹn.
 */
// Plugin bắt resource/issuer dùng HTTPS, trừ localhost/loopback cho
// môi trường phát triển — spec dùng luôn dạng localhost như app thật ở dev/test.
const ISSUER = 'http://localhost:4891/api/v1/auth';
const AUDIENCE = 'http://localhost:4891/mcp';

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('McpOAuthVerifier (lát MCP-1, issue #163)', () => {
  let server: Server;
  let jwksUrl: string;
  let privateKey: KeyObject;
  let otherPrivateKey: KeyObject;
  let verifier: McpOAuthVerifier;

  function signToken(
    key: KeyObject,
    claims: Record<string, unknown>,
    overrides: { header?: Record<string, unknown> } = {},
  ): string {
    const header = { alg: 'RS256', typ: 'at+jwt', kid: 'test-key-1', ...overrides.header };
    const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(key).toString('base64url');
    return `${signingInput}.${signature}`;
  }

  function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: '11111111-2222-4333-8444-555555555555',
      client_id: 'client-abc',
      scope: 'lms.questions.read lms.questions.draft',
      iat: now,
      exp: now + 3600,
      jti: 'token-1',
      ...overrides,
    };
  }

  function requestWith(token: string | null): Request {
    return new Request(AUDIENCE, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  beforeAll(async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey;
    otherPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const jwks = {
      keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'test-key-1', n: jwk.n, e: jwk.e }],
    };
    server = createServer((req, res) => {
      if (req.url === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jwks));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('JWKS server has no port');
    jwksUrl = `http://127.0.0.1:${address.port}/jwks`;
    verifier = new McpOAuthVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUrl });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts a well-formed token and surfaces sub/client_id/scopes', async () => {
    const result = await verifier.verify(requestWith(signToken(privateKey, validClaims())));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.userId).toBe('11111111-2222-4333-8444-555555555555');
      expect(result.identity.clientId).toBe('client-abc');
      expect(result.identity.scopes).toEqual(['lms.questions.read', 'lms.questions.draft']);
    }
  });

  it('rejects a token for a different audience', async () => {
    const token = signToken(privateKey, validClaims({ aud: 'http://localhost:4891/other-resource' }));
    const result = await verifier.verify(requestWith(token));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects a token from a different issuer', async () => {
    const token = signToken(privateKey, validClaims({ iss: 'http://localhost:9999/api/v1/auth' }));
    const result = await verifier.verify(requestWith(token));
    expect(result.ok).toBe(false);
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(privateKey, validClaims({ iat: now - 7200, exp: now - 3600 }));
    const result = await verifier.verify(requestWith(token));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects a token signed with a different key', async () => {
    const token = signToken(otherPrivateKey, validClaims());
    const result = await verifier.verify(requestWith(token));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects a request without an Authorization header', async () => {
    const result = await verifier.verify(requestWith(null));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.wwwAuthenticate).toContain('Bearer');
    }
  });
});
