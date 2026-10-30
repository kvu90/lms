import { INestApplication, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderAuthMail, type AuthMailPayload } from '@lms/contracts';
import type { CredentialBridgeService } from '../../../src/modules/auth/better-auth/credential-bridge.service';
import type { MailMessage } from '../../../src/modules/mail/mail.types';

/**
 * Flow test của chặng chuẩn bị cutover (issue #7, chặng 2.6 + phần
 * 2.7-prep): app chạy ở cửa sổ bake — `BETTER_AUTH_ENABLED=true` và
 * `AUTH_CUTOVER_STAGE=bake`. Các cổng nghiệp vụ được chứng minh:
 *
 * - login-as phát PHIÊN Better Auth qua cookie đã ký thay cho cặp
 *   token (đáp ứng không mang token nào; cookie trần bị từ chối;
 *   phiên thuộc về user đích; actor thiếu capability bị 403 và
 *   KHÔNG có phiên nào được tạo — cổng capability + lý do + audit là
 *   của đường login-as hiện hành, dùng chung cả hai chặng).
 * - Mọi điểm ghi mật khẩu phía hệ cũ đều có credential đi kèm: tạo
 *   user qua API admin → đăng nhập Better Auth được ngay không cần
 *   nối tay; admin đặt lại mật khẩu → mật khẩu mới đăng nhập được ở
 *   cả hai hệ, mật khẩu cũ chết ở cả hai hệ.
 * - Điểm nối của seed (`syncCredentialPassword` — cùng lời gọi mà
 *   review-seed chạy cho tài khoản mẫu đã tồn tại): nối lần đầu có
 *   tác dụng, chạy lại là no-op, và một credential lệch (hash phía
 *   hệ cũ đã đổi) được cập nhật theo.
 * - DIỄN TẬP ROLLBACK (cổng bắt buộc trước bước B theo §3.2 của kế
 *   hoạch GĐ2): trong cửa sổ bake, đổi mật khẩu qua Better Auth
 *   (change-password) và đặt lại qua link reset trong mail đều đồng
 *   bộ ngược hash về `users.password_hash` — bằng chứng là đăng nhập
 *   HỆ CŨ bằng mật khẩu mới thành công ngay sau đó (tắt cờ về 'off'
 *   là quay lại hệ cũ trọn vẹn). Hash ở hai kho phải TRÙNG NHAU
 *   (chép nguyên hash, không băm lại).
 *
 * Biến môi trường phải tồn tại TRƯỚC khi AppModule được nạp nên các
 * import của AppModule/helpers đều là import động trong beforeAll.
 */
process.env.BETTER_AUTH_ENABLED = 'true';
process.env.BETTER_AUTH_SECRET = 'cutover-e2e-secret-0123456789abcdef';
process.env.AUTH_CUTOVER_STAGE = 'bake';
const TRUSTED_ORIGIN = 'http://localhost:5173';
process.env.BETTER_AUTH_TRUSTED_ORIGINS = TRUSTED_ORIGIN;

const CHANGED_PASSWORD = 'Bake!Changed-234';
const RESET_PASSWORD = 'Bake!Reset-345';
const STALE_PASSWORD = 'Bake!Stale-456';

type Helpers = typeof import('../../support/identity-access-helpers');
let helpers: Helpers;

function http(app: INestApplication) {
  return request(app.getHttpServer());
}

async function createMountedTestApp(): Promise<INestApplication> {
  const { AppModule } = await import('../../../src/app.module');
  const { enableTrustedProxy } = await import('../../../src/common/client-ip');
  const { ProblemDetailsFilter } = await import('../../../src/common/problem-details.filter');
  const { mountBetterAuth } = await import('../../../src/modules/auth/better-auth/better-auth.mount');
  const { BetterAuthService: BetterAuthServiceClass } = await import(
    '../../../src/modules/auth/better-auth/better-auth.service'
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  enableTrustedProxy(app as NestExpressApplication);
  const betterAuth = app.get(BetterAuthServiceClass);
  mountBetterAuth(app as NestExpressApplication, betterAuth.requireAuth());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  return app;
}

/** Lấy cookie phiên Better Auth (dạng `name=value`) từ header set-cookie. */
function sessionCookieFrom(setCookie: string[] | undefined): string {
  const raw = (setCookie ?? []).find((value) => value.includes('better-auth.session_token='));
  if (!raw) throw new Error(`no Better Auth session cookie in: ${JSON.stringify(setCookie)}`);
  return raw.split(';')[0]!;
}

describe('Chuẩn bị cutover Better Auth — cửa sổ bake (issue #7 giai đoạn 2.6 + 2.7-prep)', () => {
  let app: INestApplication;
  let bridge: CredentialBridgeService;
  let pg: Client;
  /** Mail đã bắt được (dựng từ dòng outbox, xem waitForMailTo). */
  const sentMails: MailMessage[] = [];
  /** Id các dòng outbox đã dựng thành mail, tránh bắt trùng một dòng hai lần. */
  const capturedRowIds = new Set<string>();

  async function signInByUsername(username: string, password: string) {
    return http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ username, password });
  }

  async function legacyLogin(username: string, password: string) {
    return http(app).post('/api/v1/auth/token').send({ username, password });
  }

  async function passwordHashes(userId: string): Promise<{ legacy: string | null; credential: string | null }> {
    const user = await pg.query('select password_hash from users where id = $1', [userId]);
    const account = await pg.query(
      "select password from account where user_id = $1 and provider_id = 'credential'",
      [userId],
    );
    return {
      legacy: user.rows[0]?.password_hash ?? null,
      credential: account.rows[0]?.password ?? null,
    };
  }

  /**
   * Chờ tới khi có mail gửi cho địa chỉ này: nội dung mail được dựng
   * từ dòng outbox `auth_mail_requested` của chính địa chỉ đó bằng
   * `renderAuthMail` dùng chung ở `@lms/contracts` — hàm mà
   * processor ở phía worker gọi khi gửi thật (khâu gửi đã chuyển
   * sang hàng đợi ở worker, issue #517; dòng outbox được ghi đồng bộ
   * trong request nên thường có ngay).
   */
  async function waitForMailTo(email: string, timeoutMs = 9000): Promise<MailMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = sentMails.find((mail) => mail.to === email);
      if (found) return found;
      const rows = await pg.query(
        "select id, payload from outbox_events where type = 'auth_mail_requested' and payload->>'to' = $1 order by seq desc limit 1",
        [email],
      );
      const row = rows.rows[0] as { id: string; payload: AuthMailPayload } | undefined;
      if (row) {
        const mail = renderAuthMail(row.payload);
        if (!capturedRowIds.has(row.id)) {
          capturedRowIds.add(row.id);
          sentMails.push(mail);
        }
        return mail;
      }
      if (Date.now() > deadline) {
        throw new Error(`no mail captured for ${email}; captured: ${JSON.stringify(sentMails.map((m) => m.to))}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  beforeAll(async () => {
    helpers = await import('../../support/identity-access-helpers');
    app = await createMountedTestApp();
    const { CredentialBridgeService: BridgeClass } = await import(
      '../../../src/modules/auth/better-auth/credential-bridge.service'
    );
    bridge = app.get(BridgeClass);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });

  afterAll(async () => {
    await pg?.end();
    await app?.close();
  });

  it('login-as trong cửa sổ bake cấp cookie phiên Better Auth và không cấp token', async () => {
    const adminAccess = await helpers.adminToken(app);
    const adminMe = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${adminAccess}`);
    const target = await helpers.createUserViaApi(app, adminAccess);

    const res = await http(app)
      .post('/api/v1/auth/login-as')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ userId: target.id, reason: 'Hỗ trợ kỹ thuật (spec bake)' });
    expect(res.status).toBe(201);
    // Chặng bake: đáp ứng KHÔNG mang cặp token của hệ cũ.
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    // Dấu vết mạo danh vẫn ghi như đường cũ.
    expect(res.body.loginAs.byUserId).toBe(adminMe.body.id);
    expect(res.body.user.id).toBe(target.id);

    // Cookie đã ký mở được danh tính ĐÍCH trên route nghiệp vụ.
    const cookie = sessionCookieFrom(res.headers['set-cookie'] as unknown as string[]);
    const me = await http(app).get('/api/v1/users/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(target.id);
    expect(me.body.username).toBe(target.username);

    // Phiên thuộc về user đích trong kho phiên của Better Auth.
    const sessions = await pg.query('select count(*)::int as n from session where user_id = $1', [target.id]);
    expect(sessions.rows[0].n).toBeGreaterThanOrEqual(1);

    // Cookie trần (token không kèm chữ ký) bị từ chối.
    const signedValue = cookie.split('=').slice(1).join('=');
    const rawToken = decodeURIComponent(signedValue).split('.')[0]!;
    const raw = await http(app)
      .get('/api/v1/users/me')
      .set('Cookie', `better-auth.session_token=${rawToken}`);
    expect(raw.status).toBe(401);
  });

  it('login-as thiếu năng lực bị từ chối và không tạo phiên', async () => {
    const adminAccess = await helpers.adminToken(app);
    const actor = await helpers.createUserViaApi(app, adminAccess);
    const target = await helpers.createUserViaApi(app, adminAccess);
    const actorLogin = await legacyLogin(actor.username, helpers.STRONG_PASSWORD);
    expect(actorLogin.status).toBeLessThan(300);

    const before = await pg.query('select count(*)::int as n from session where user_id = $1', [target.id]);
    const denied = await http(app)
      .post('/api/v1/auth/login-as')
      .set('Authorization', `Bearer ${actorLogin.body.accessToken}`)
      .send({ userId: target.id, reason: 'thử mạo danh' });
    expect(denied.status).toBe(403);
    const after = await pg.query('select count(*)::int as n from session where user_id = $1', [target.id]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('người dùng tạo qua admin API đăng nhập qua Better Auth ngay', async () => {
    const adminAccess = await helpers.adminToken(app);
    const created = await helpers.createUserViaApi(app, adminAccess);
    const res = await signInByUsername(created.username, helpers.STRONG_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(created.username);
    // Credential được tạo cùng hash với kho hệ cũ ngay từ đầu.
    const hashes = await passwordHashes(created.id);
    expect(hashes.credential).toBeTruthy();
    expect(hashes.credential).toBe(hashes.legacy);
  });

  it('đặt lại mật khẩu bởi admin lan tới credential: mật khẩu mới chạy ở cả hai hệ, mật khẩu cũ chết ở cả hai', async () => {
    const adminAccess = await helpers.adminToken(app);
    const created = await helpers.createUserViaApi(app, adminAccess);
    const reset = await http(app)
      .patch(`/api/v1/users/${created.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ password: CHANGED_PASSWORD });
    expect(reset.status).toBe(200);

    expect((await signInByUsername(created.username, helpers.STRONG_PASSWORD)).status).toBe(401);
    expect((await signInByUsername(created.username, CHANGED_PASSWORD)).status).toBe(200);
    expect((await legacyLogin(created.username, helpers.STRONG_PASSWORD)).status).toBe(401);
    expect((await legacyLogin(created.username, CHANGED_PASSWORD)).status).toBeLessThan(300);

    const hashes = await passwordHashes(created.id);
    expect(hashes.credential).toBe(hashes.legacy);
  });

  it('điểm vào liên kết seed: syncCredentialPassword liên kết một lần, rồi no-op, và sửa credential cũ', async () => {
    const adminAccess = await helpers.adminToken(app);
    const created = await helpers.createUserViaApi(app, adminAccess);
    // Trạng thái của tài khoản mẫu đã tồn tại từ lần seed trước thời
    // đồng bộ: có hash ở hệ cũ, chưa có dòng credential.
    await pg.query("delete from account where user_id = $1 and provider_id = 'credential'", [created.id]);
    expect(await bridge.syncCredentialPassword(created.id)).toBe(true);
    expect(await bridge.syncCredentialPassword(created.id)).toBe(false);
    expect((await signInByUsername(created.username, helpers.STRONG_PASSWORD)).status).toBe(200);

    // Credential lệch: hash phía hệ cũ đổi mà không qua service (mô
    // phỏng một lần ghi cũ còn sót) — lần sync kế tiếp phải cập nhật
    // dòng credential theo, không giữ mật khẩu cũ.
    const { PasswordService: PasswordServiceClass } = await import('../../../src/modules/users/password.service');
    const staleHash = await app.get(PasswordServiceClass).hash(STALE_PASSWORD);
    await pg.query('update users set password_hash = $1 where id = $2', [staleHash, created.id]);
    expect(await bridge.syncCredentialPassword(created.id)).toBe(true);
    expect((await signInByUsername(created.username, STALE_PASSWORD)).status).toBe(200);
    expect((await signInByUsername(created.username, helpers.STRONG_PASSWORD)).status).toBe(401);
  });

  it('diễn tập rollback: mật khẩu đổi qua Better Auth trong cửa sổ bake đăng nhập được qua hệ cũ', async () => {
    const adminAccess = await helpers.adminToken(app);
    const created = await helpers.createUserViaApi(app, adminAccess);

    // Hai phiên Better Auth sống — đổi mật khẩu từ phiên một, thu hồi
    // phiên còn lại (hành vi của endpoint change-password của BA).
    const first = await signInByUsername(created.username, helpers.STRONG_PASSWORD);
    expect(first.status).toBe(200);
    const cookie1 = sessionCookieFrom(first.headers['set-cookie'] as unknown as string[]);
    const second = await signInByUsername(created.username, helpers.STRONG_PASSWORD);
    const cookie2 = sessionCookieFrom(second.headers['set-cookie'] as unknown as string[]);

    // Endpoint /change-password của Better Auth còn bị route legacy
    // cùng tên che ở tầng mount (bản legacy thắng khi cùng tồn tại —
    // điểm giao nhau đã chốt trong kế hoạch; bản BA thắng sau khi gỡ
    // legacy ở chặng 2.7), nên ca này gọi endpoint qua auth.api: vẫn
    // là đúng mã endpoint + đúng chuỗi hook của Better Auth, chỉ bỏ
    // qua tầng mount HTTP. Phần HTTP của đường legacy (đổi mật khẩu
    // qua route cũ → đồng bộ xuôi qua UsersService) đã được ca đặt
    // lại mật khẩu của admin ở trên phủ.
    const { BetterAuthService: BetterAuthServiceClass } = await import(
      '../../../src/modules/auth/better-auth/better-auth.service'
    );
    const auth = app.get(BetterAuthServiceClass).requireAuth();
    await auth.api.changePassword({
      body: { currentPassword: helpers.STRONG_PASSWORD, newPassword: CHANGED_PASSWORD, revokeOtherSessions: true },
      headers: new Headers({ cookie: cookie1, origin: TRUSTED_ORIGIN }),
    });

    // Phiên còn lại bị thu hồi.
    const otherSession = await http(app).get('/api/v1/auth/get-session').set('Cookie', cookie2);
    expect(otherSession.body ?? null).toBeNull();

    // Điều kiện rollback: hash đã đồng bộ ngược nguyên trạng về kho
    // hệ cũ — đăng nhập hệ cũ bằng mật khẩu MỚI được, mật khẩu cũ
    // chết, và hash ở hai kho trùng nhau (chép nguyên, không băm lại).
    const hashes = await passwordHashes(created.id);
    expect(hashes.legacy).toBeTruthy();
    expect(hashes.legacy).toBe(hashes.credential);
    expect((await legacyLogin(created.username, CHANGED_PASSWORD)).status).toBeLessThan(300);
    expect((await legacyLogin(created.username, helpers.STRONG_PASSWORD)).status).toBe(401);
  });

  it('diễn tập rollback: mật khẩu đặt lại qua liên kết mail trong cửa sổ bake cũng đồng bộ ngược về kho cũ', async () => {
    const adminAccess = await helpers.adminToken(app);
    const created = await helpers.createUserViaApi(app, adminAccess);

    const requested = await http(app)
      .post('/api/v1/auth/request-password-reset')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: created.email, redirectTo: `${TRUSTED_ORIGIN}/reset-password` });
    expect(requested.status).toBe(200);

    const mail = await waitForMailTo(created.email);
    const token = /\/reset-password\/([A-Za-z0-9_-]+)\?/.exec(mail.text)?.[1];
    expect(token).toBeTruthy();

    const reset = await http(app)
      .post('/api/v1/auth/reset-password')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ newPassword: RESET_PASSWORD, token });
    expect(reset.status).toBe(200);
    expect(reset.body.status).toBe(true);

    const hashes = await passwordHashes(created.id);
    expect(hashes.legacy).toBe(hashes.credential);
    expect((await legacyLogin(created.username, RESET_PASSWORD)).status).toBeLessThan(300);
    expect((await legacyLogin(created.username, helpers.STRONG_PASSWORD)).status).toBe(401);
    expect((await signInByUsername(created.username, RESET_PASSWORD)).status).toBe(200);
  });
});
