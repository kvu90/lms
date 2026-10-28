import { describe, expect, it, vi } from 'vitest';
import { createOAuthMfaGateHook, type OAuthMfaGateDeps } from './oauth-mfa-gate';

/**
 * Cổng MFA của callback OAuth (issue #7, chặng 2.3) — kỷ luật
 * FAIL-CLOSED khi không xác minh được trạng thái MFA:
 *
 * - Tra cứu bản ghi two-factor LỖI (cơ sở dữ liệu/adapter lỗi đúng
 *   lúc callback) tuyệt đối không được hiểu là "chưa bật MFA": cổng
 *   phải ghi log lỗi, huỷ phiên vừa tạo ở cả hai tầng (cookie phiên
 *   khỏi response + xoá dòng session + setNewSession(null)) rồi ném
 *   lỗi dừng đăng nhập — không đường nào để lỗi tra cứu để lại một
 *   phiên sống.
 * - Tra cứu THÀNH CÔNG giữ nguyên hành vi cũ: không có bản ghi hoặc
 *   bản ghi chưa verify = chưa bật MFA (đi qua, không đụng phiên);
 *   bản ghi đã verify hoặc cờ `twoFactorEnabled` = đã bật (cổng kích
 *   hoạt: huỷ phiên, phát dấu chờ bước hai, ném redirect).
 * - Đường không phải callback OAuth: hook đi qua, không tra cứu.
 *
 * Đổi kỷ luật (nuốt lỗi tra cứu thành "chưa bật MFA") thì ca đầu
 * tiên phải đỏ.
 */
describe('OAuthMfaGate — fail-closed khi tra cứu MFA lỗi', () => {
  const SESSION_TOKEN = 'session-token-1';
  const USER_ID = 'user-1';

  function buildCtx(opts: { path?: string; user?: Record<string, unknown> } = {}) {
    const calls = {
      deleteSession: vi.fn(async (_token: string) => {}),
      setNewSession: vi.fn((_value: unknown) => {}),
      createVerificationValue: vi.fn(async (_value: unknown) => ({})),
      logError: vi.fn((_message: string) => {}),
      adapterFindOne: vi.fn(async () => null),
    };
    const ctx = {
      path: opts.path ?? '/callback/google',
      headers: new Headers(),
      responseHeaders: new Headers(),
      setCookie: vi.fn(),
      getSignedCookie: vi.fn(async () => undefined),
      setSignedCookie: vi.fn(async () => {}),
      redirect: (url: string) => ({ name: 'GateRedirect', url }),
      context: {
        newSession: {
          session: { token: SESSION_TOKEN },
          user: { id: USER_ID, ...(opts.user ?? {}) },
        },
        secret: 's'.repeat(32),
        baseURL: 'http://localhost:3100',
        returned: undefined,
        logger: { error: calls.logError },
        options: { account: {} },
        oauthConfig: { storeStateStrategy: 'database' },
        authCookies: {
          sessionToken: { name: 'better-auth.session_token', attributes: {} },
          sessionData: { name: 'better-auth.session_data', attributes: {} },
          accountData: { name: 'better-auth.account_data', attributes: {} },
          dontRememberToken: { name: 'better-auth.dont_remember', attributes: {} },
        },
        createAuthCookie: (name: string, cookieOpts?: { maxAge?: number }) => ({
          name: `better-auth.${name}`,
          attributes: cookieOpts?.maxAge ? { maxAge: cookieOpts.maxAge } : {},
        }),
        setNewSession: calls.setNewSession,
        internalAdapter: {
          deleteSession: calls.deleteSession,
          createVerificationValue: calls.createVerificationValue,
          findVerificationValue: vi.fn(async () => null),
          deleteVerificationByIdentifier: vi.fn(async () => {}),
        },
        adapter: { findOne: calls.adapterFindOne },
      },
    };
    return { ctx, calls };
  }

  it('tra cứu two-factor lỗi: phiên bị huỷ ở cả hai tầng, có log, đăng nhập bị dừng bằng lỗi oauth_mfa_status_unavailable', async () => {
    const { ctx, calls } = buildCtx();
    const deps: OAuthMfaGateDeps = {
      lookupTwoFactorRecord: vi.fn(async () => {
        throw new Error('database connection lost');
      }),
    };
    const hook = createOAuthMfaGateHook(deps);

    const failure = await hook(ctx as never).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeTruthy();
    expect((failure as { body?: { code?: string } }).body?.code).toBe('oauth_mfa_status_unavailable');
    expect(calls.deleteSession).toHaveBeenCalledTimes(1);
    expect(calls.deleteSession).toHaveBeenCalledWith(SESSION_TOKEN);
    expect(calls.setNewSession).toHaveBeenCalledTimes(1);
    expect(calls.setNewSession).toHaveBeenCalledWith(null);
    expect(calls.logError).toHaveBeenCalledTimes(1);
    // Không phát dấu chờ bước hai: đây là dừng đăng nhập, không phải
    // chuyển sang bước hai.
    expect(calls.createVerificationValue).not.toHaveBeenCalled();
  });

  it('tra cứu thành công, không có bản ghi two-factor: đi qua, không đụng phiên', async () => {
    const { ctx, calls } = buildCtx();
    const hook = createOAuthMfaGateHook({ lookupTwoFactorRecord: vi.fn(async () => null) });

    await expect(hook(ctx as never)).resolves.toBeUndefined();

    expect(calls.deleteSession).not.toHaveBeenCalled();
    expect(calls.setNewSession).not.toHaveBeenCalled();
    expect(calls.logError).not.toHaveBeenCalled();
  });

  it('bản ghi two-factor chưa verify: vẫn tính là chưa bật MFA, đi qua', async () => {
    const { ctx, calls } = buildCtx();
    const hook = createOAuthMfaGateHook({
      lookupTwoFactorRecord: vi.fn(async () => ({ verified: false })),
    });

    await expect(hook(ctx as never)).resolves.toBeUndefined();

    expect(calls.deleteSession).not.toHaveBeenCalled();
    expect(calls.setNewSession).not.toHaveBeenCalled();
  });

  it('bản ghi two-factor đã verify: cổng kích hoạt — huỷ phiên, phát dấu chờ bước hai, ném redirect', async () => {
    const { ctx, calls } = buildCtx();
    const hook = createOAuthMfaGateHook({
      lookupTwoFactorRecord: vi.fn(async () => ({ verified: true })),
    });

    const thrown = await hook(ctx as never).then(
      () => null,
      (error: unknown) => error,
    );

    // Redirect của tầng middleware là APIError trạng thái FOUND
    // (302) mang location về callbackURL kèm cờ twoFactorRedirect=true.
    const redirectError = thrown as { status?: string; headers?: Headers };
    expect(redirectError.status).toBe('FOUND');
    expect(redirectError.headers?.get('location')).toContain('twoFactorRedirect=true');
    expect(calls.deleteSession).toHaveBeenCalledWith(SESSION_TOKEN);
    expect(calls.setNewSession).toHaveBeenCalledWith(null);
    // Hai dấu của plugin: verification chờ + bộ đếm lần thử.
    expect(calls.createVerificationValue).toHaveBeenCalledTimes(2);
  });

  it('cờ twoFactorEnabled=true: cổng kích hoạt ngay, không cần tra cứu bản ghi', async () => {
    const { ctx, calls } = buildCtx({ user: { twoFactorEnabled: true } });
    const lookup = vi.fn(async () => {
      throw new Error('không được gọi tới');
    });
    const hook = createOAuthMfaGateHook({ lookupTwoFactorRecord: lookup });

    const thrown = await hook(ctx as never).then(
      () => null,
      (error: unknown) => error,
    );

    expect((thrown as { status?: string }).status).toBe('FOUND');
    expect(lookup).not.toHaveBeenCalled();
    expect(calls.deleteSession).toHaveBeenCalledWith(SESSION_TOKEN);
  });

  it('đường không phải callback OAuth: hook đi qua dù có phiên mới', async () => {
    const { ctx, calls } = buildCtx({ path: '/sign-in/email' });
    const lookup = vi.fn(async () => ({ verified: true }));
    const hook = createOAuthMfaGateHook({ lookupTwoFactorRecord: lookup });

    await expect(hook(ctx as never)).resolves.toBeUndefined();

    expect(lookup).not.toHaveBeenCalled();
    expect(calls.deleteSession).not.toHaveBeenCalled();
  });
});
