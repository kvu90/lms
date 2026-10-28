import { INestApplication, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BetterAuthService } from '../../src/modules/auth/better-auth/better-auth.service';
import type { CredentialBridgeService } from '../../src/modules/auth/better-auth/credential-bridge.service';
import type { MailMessage } from '../../src/modules/mail/mail.types';
import type { ResendMailService } from '../../src/modules/mail/resend-mail.service';

/**
 * Flow test của lát BA-2 (issue #7, chặng 2.5): mail auth qua Resend +
 * reset mật khẩu end-to-end + đăng nhập bằng email OTP.
 *
 * Cách kiểm chứng "mailer giả lập": transport ResendMailService bị
 * thay hàm `send` bằng bản ghi lại (không gọi Resend thật — env test
 * cũng không có RESEND_API_KEY), nhưng MỌI mắt xích còn lại là đồ
 * thật: endpoint Better Auth → callback → AuthMailService ghi outbox
 * → AuthMailConsumer quét outbox → transport. Mail "đã gửi" được đọc
 * từ bản ghi đó để lấy liên kết reset / mã OTP như người dùng thật
 * nhận qua email.
 *
 * Các cổng nghiệp vụ được chứng minh: reset đủ vòng (mail chứa liên
 * kết → đặt mật khẩu mới → mật khẩu cũ chết, phiên cũ bị thu hồi,
 * token dùng một lần); email không tồn tại nhận đáp ứng trung tính và
 * không phát mail; mật khẩu yếu bị chính sách của dự án chặn TRƯỚC
 * khi token bị tiêu thụ; OTP đăng nhập đủ vòng (mã sai bị từ chối, mã
 * đúng tạo phiên dùng được ngay trên route nghiệp vụ, mã dùng một
 * lần); email lạ KHÔNG tự thành tài khoản qua OTP (disableSignUp đã
 * ghim ở plugin như toàn hệ) và nhận đáp ứng trung tính chống lộ thông
 * tin; đặt lại mật khẩu bằng OTP; tài khoản bị đình chỉ vẫn bị chặn ở
 * guard dù đăng nhập OTP thành công.
 *
 * BA-1 — chốt semantics revokeUnprovenAccountAccess (comment
 * 6405565755 trên #7, thi công cùng PR này): user do cầu nối tạo là
 * user do bên tin cậy tạo cho mailbox đã biết nên được tạo với
 * email_verified = true, và instance ghim generateId "uuid" (id
 * thường vẫn do PostgreSQL tự sinh UUIDv7 vì adapter drizzle khai
 * supportsUUIDs; chỉ id tất định của verification lock mới đổi sang
 * dạng UUID, hết lỗi 22P02). Nhờ đó đăng nhập OTP cho user bridge
 * không còn chạy đường revoke xoá credential: ca bên dưới khẳng định
 * credential mật khẩu còn nguyên và đăng nhập username/mật khẩu vẫn
 * chạy sau khi đăng nhập OTP.
 *
 * Biến môi trường phải tồn tại TRƯỚC khi AppModule được nạp — như
 * spec nền better-auth-flow.
 */
process.env.BETTER_AUTH_ENABLED = 'true';
process.env.BETTER_AUTH_SECRET = 'e2e-better-auth-secret-0123456789abcdef';
const TRUSTED_ORIGIN = 'http://localhost:5173';
process.env.BETTER_AUTH_TRUSTED_ORIGINS = TRUSTED_ORIGIN;

const OLD_PASSWORD = 'BridgePass123';
const NEW_PASSWORD = 'NewBridgePass456';
const OTP_RESET_PASSWORD = 'OtpResetPass789';
/** Qua được độ dài tối thiểu của Better Auth nhưng thiếu chữ hoa — chính sách của dự án phải chặn. */
const POLICY_WEAK_PASSWORD = 'alllowercase1';

type Helpers = typeof import('../support/identity-access-helpers');
let helpers: Helpers;

function http(app: INestApplication) {
  return request(app.getHttpServer());
}

async function createMountedTestApp(): Promise<INestApplication> {
  const { AppModule } = await import('../../src/app.module');
  const { enableTrustedProxy } = await import('../../src/common/client-ip');
  const { ProblemDetailsFilter } = await import('../../src/common/problem-details.filter');
  const { mountBetterAuth } = await import('../../src/modules/auth/better-auth/better-auth.mount');
  const { BetterAuthService: BetterAuthServiceClass } = await import(
    '../../src/modules/auth/better-auth/better-auth.service'
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  enableTrustedProxy(app as NestExpressApplication);
  const betterAuth: BetterAuthService = app.get(BetterAuthServiceClass);
  mountBetterAuth(app as NestExpressApplication, betterAuth.requireAuth());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  return app;
}

function sessionCookieFrom(setCookie: string[] | undefined): string {
  const raw = (setCookie ?? []).find((value) => value.includes('better-auth.session_token='));
  if (!raw) throw new Error(`no Better Auth session cookie in: ${JSON.stringify(setCookie)}`);
  return raw.split(';')[0]!;
}

describe('Better Auth mail: reset + email OTP (issue #7 phase 2.5)', () => {
  let app: INestApplication;
  let bridge: CredentialBridgeService;
  let pg: Client;
  /** Mọi mail transport "đã gửi" trong spec này (mailer giả lập ghi lại). */
  const sentMails: MailMessage[] = [];

  async function createMailUser(prefix: string): Promise<{ id: string; username: string; email: string }> {
    const username = helpers.uniqueName(prefix);
    const email = `${username}@example.com`;
    const created = await bridge.createUserWithCredential({
      email,
      username,
      firstName: 'Mail',
      lastName: 'Flow',
      password: OLD_PASSWORD,
    });
    return { id: created.id, username, email };
  }

  /** Đưa user về trạng thái đã chứng minh quyền sở hữu email (như sau một luồng xác minh email thành công). */
  async function markEmailVerified(userId: string): Promise<void> {
    await pg.query('update users set email_verified = true where id = $1', [userId]);
  }

  /** Chờ consumer outbox xả tới khi có mail gửi cho địa chỉ này (nhịp quét 1 giây + dự phòng). */
  async function waitForMailTo(email: string, timeoutMs = 9000): Promise<MailMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = sentMails.find((mail) => mail.to === email);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`no mail captured for ${email}; captured: ${JSON.stringify(sentMails.map((m) => m.to))}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async function signInByUsername(username: string, password: string) {
    return http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ username, password });
  }

  beforeAll(async () => {
    helpers = await import('../support/identity-access-helpers');
    app = await createMountedTestApp();
    const { CredentialBridgeService: BridgeClass } = await import(
      '../../src/modules/auth/better-auth/credential-bridge.service'
    );
    const { ResendMailService: MailerClass } = await import('../../src/modules/mail/resend-mail.service');
    bridge = app.get(BridgeClass);
    const mailer: ResendMailService = app.get(MailerClass);
    vi.spyOn(mailer, 'send').mockImplementation(async (message: MailMessage) => {
      sentMails.push(message);
      return { status: 'sent', providerId: 'fake-resend-id' };
    });
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });

  afterAll(async () => {
    await pg?.end();
    await app?.close();
  });

  it('reset password end-to-end: mail link resets, old password dies, sessions are revoked, token is single-use', async () => {
    const user = await createMailUser('bamailreset');
    // Phiên sống trước reset — phải bị thu hồi bởi reset.
    const before = await signInByUsername(user.username, OLD_PASSWORD);
    expect(before.status).toBe(200);
    const cookieBefore = sessionCookieFrom(before.headers['set-cookie'] as unknown as string[]);
    expect((await http(app).get('/api/v1/users/me').set('Cookie', cookieBefore)).status).toBe(200);

    const requested = await http(app)
      .post('/api/v1/auth/request-password-reset')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, redirectTo: `${TRUSTED_ORIGIN}/reset-password` });
    expect(requested.status).toBe(200);
    expect(requested.body.status).toBe(true);

    // Yêu cầu đã đi qua outbox thật (không gửi đồng bộ trong request).
    const outbox = await pg.query(
      "select count(*)::int as n from outbox_events where type = 'auth_mail_requested' and payload->>'to' = $1 and payload->>'kind' = 'password_reset'",
      [user.email],
    );
    expect(outbox.rows[0].n).toBeGreaterThanOrEqual(1);

    const mail = await waitForMailTo(user.email);
    expect(mail.subject).toBe('Đặt lại mật khẩu tài khoản LMS');
    const token = /\/reset-password\/([A-Za-z0-9_-]+)\?/.exec(mail.text)?.[1];
    expect(token).toBeTruthy();

    const reset = await http(app)
      .post('/api/v1/auth/reset-password')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ newPassword: NEW_PASSWORD, token });
    expect(reset.status).toBe(200);
    expect(reset.body.status).toBe(true);

    // Mọi phiên trước reset bị thu hồi (revokeSessionsOnPasswordReset).
    const sessionAfter = await http(app).get('/api/v1/auth/get-session').set('Cookie', cookieBefore);
    expect(sessionAfter.body ?? null).toBeNull();
    expect((await http(app).get('/api/v1/users/me').set('Cookie', cookieBefore)).status).toBe(401);

    // Mật khẩu cũ chết, mật khẩu mới sống.
    expect((await signInByUsername(user.username, OLD_PASSWORD)).status).toBe(401);
    expect((await signInByUsername(user.username, NEW_PASSWORD)).status).toBe(200);

    // Token dùng một lần: dùng lại bị từ chối.
    const reuse = await http(app)
      .post('/api/v1/auth/reset-password')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ newPassword: OTP_RESET_PASSWORD, token });
    expect(reuse.status).toBe(400);
  });

  it('reset request for an unknown email answers neutrally and sends no mail', async () => {
    const ghost = `${helpers.uniqueName('bamailghost')}@example.com`;
    const res = await http(app)
      .post('/api/v1/auth/request-password-reset')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: ghost, redirectTo: `${TRUSTED_ORIGIN}/reset-password` });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    // Neo chốt qua chính consumer: phát một yêu cầu đặt lại THẬT cho
    // người dùng có thật NGAY SAU yêu cầu lạ và chờ mail của họ tới.
    // Consumer thư xử lý outbox theo seq tăng dần nên khi mail thật
    // đã được gửi, lượt quét đã đi qua cửa sổ của yêu cầu lạ — nếu yêu
    // cầu lạ có sinh mail thì mail đó đã phải nằm trong hộp thư stub.
    // Thay sleep cố định 1.600ms "cho consumer vài nhịp quét".
    const sentinel = await createMailUser('bamailchotreset');
    await http(app)
      .post('/api/v1/auth/request-password-reset')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: sentinel.email, redirectTo: `${TRUSTED_ORIGIN}/reset-password` });
    await waitForMailTo(sentinel.email);
    expect(sentMails.some((mail) => mail.to === ghost)).toBe(false);
    const outbox = await pg.query(
      "select count(*)::int as n from outbox_events where type = 'auth_mail_requested' and payload->>'to' = $1",
      [ghost],
    );
    expect(outbox.rows[0].n).toBe(0);
  });

  it('a policy-weak new password is rejected before the token is consumed', async () => {
    const user = await createMailUser('bamailweak');
    const requested = await http(app)
      .post('/api/v1/auth/request-password-reset')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, redirectTo: `${TRUSTED_ORIGIN}/reset-password` });
    expect(requested.status).toBe(200);
    const mail = await waitForMailTo(user.email);
    const token = /\/reset-password\/([A-Za-z0-9_-]+)\?/.exec(mail.text)?.[1];
    expect(token).toBeTruthy();

    const weak = await http(app)
      .post('/api/v1/auth/reset-password')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ newPassword: POLICY_WEAK_PASSWORD, token });
    expect(weak.status).toBe(400);

    // Cùng token, mật khẩu đạt chính sách → đặt lại thành công.
    const strong = await http(app)
      .post('/api/v1/auth/reset-password')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ newPassword: NEW_PASSWORD, token });
    expect(strong.status).toBe(200);
    expect((await signInByUsername(user.username, NEW_PASSWORD)).status).toBe(200);
  });

  it('email OTP sign-in end-to-end: wrong code rejected, right code creates a working session, code is single-use', async () => {
    const user = await createMailUser('bamailotp');
    // User đã chứng minh email (trạng thái sau xác minh) — đường
    // đăng nhập OTP chuẩn. User bridge nay được tạo với
    // email_verified = true (chốt semantics BA-1), nên đường này
    // không còn chạm revokeUnprovenAccountAccess.
    await markEmailVerified(user.id);
    const sent = await http(app)
      .post('/api/v1/auth/email-otp/send-verification-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, type: 'sign-in' });
    expect(sent.status).toBe(200);
    expect(sent.body.success).toBe(true);

    const mail = await waitForMailTo(user.email);
    expect(mail.subject).toBe('Mã đăng nhập LMS của bạn');
    const otp = /\b(\d{6})\b/.exec(mail.text)?.[1];
    expect(otp).toBeTruthy();

    const wrong = await http(app)
      .post('/api/v1/auth/sign-in/email-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, otp: '000000' });
    expect(wrong.status).toBe(400);

    const ok = await http(app)
      .post('/api/v1/auth/sign-in/email-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, otp });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe(user.email);
    const cookie = sessionCookieFrom(ok.headers['set-cookie'] as unknown as string[]);
    const me = await http(app).get('/api/v1/users/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe(user.username);

    // Mã dùng một lần.
    const reuse = await http(app)
      .post('/api/v1/auth/sign-in/email-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, otp });
    expect(reuse.status).toBe(400);
  });

  it('OTP for an unknown email neither sends a code nor creates an account (sign-up stays closed)', async () => {
    const ghost = `${helpers.uniqueName('bamailotpnew')}@example.com`;
    const res = await http(app)
      .post('/api/v1/auth/email-otp/send-verification-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: ghost, type: 'sign-in' });
    // Đáp ứng trung tính 200 như email có thật (chống lộ thông tin
    // tài khoản nào tồn tại) — nhưng KHÔNG có mail nào được gửi.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Neo chốt qua chính consumer (cùng lập luận với ca đặt lại mật
    // khẩu cho email lạ ở trên): gửi OTP thật cho người dùng có thật
    // ngay sau yêu cầu lạ và chờ mail OTP của họ — consumer đã quét
    // qua cửa sổ của yêu cầu lạ thì mới gửi được mail này. Thay sleep
    // cố định 1.600ms.
    const sentinel = await createMailUser('bamailchototp');
    await http(app)
      .post('/api/v1/auth/email-otp/send-verification-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: sentinel.email, type: 'sign-in' });
    await waitForMailTo(sentinel.email);
    expect(sentMails.some((mail) => mail.to === ghost)).toBe(false);
    const users = await pg.query('select count(*)::int as n from users where email = $1', [ghost]);
    expect(users.rows[0].n).toBe(0);
    // Và không có mã nào đăng nhập được cho email lạ (không tài khoản nào được tự tạo).
    const attempt = await http(app)
      .post('/api/v1/auth/sign-in/email-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: ghost, otp: '123456' });
    expect(attempt.status).toBe(400);
  });

  // BA-1 — chốt semantics revokeUnprovenAccountAccess (comment
  // 6405565755 trên #7): user do cầu nối tạo là user do bên tin cậy
  // tạo cho mailbox đã biết nên được tạo với email_verified = true;
  // đường revoke của Better Auth thành no-op với user đó. Ca này
  // (trước đây ghim bằng it.fails vì blocker generateId) giờ là
  // test thường và siết thêm hai assertion bảo vệ semantics: sau
  // đăng nhập OTP, credential mật khẩu của user vẫn còn nguyên trong
  // bảng account và đăng nhập bằng username/mật khẩu vẫn chạy — tức
  // OTP không xoá credential đã migrate.
  it('OTP sign-in for a bridged user succeeds and keeps the password credential (BA-1 semantics)', async () => {
    const user = await createMailUser('bamailotpunv');
    const sent = await http(app)
      .post('/api/v1/auth/email-otp/send-verification-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, type: 'sign-in' });
    expect(sent.status).toBe(200);
    const mail = await waitForMailTo(user.email);
    const otp = /\b(\d{6})\b/.exec(mail.text)?.[1];
    expect(otp).toBeTruthy();
    const ok = await http(app)
      .post('/api/v1/auth/sign-in/email-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, otp });
    expect(ok.status).toBe(200);
    const accounts = await pg.query(
      "select count(*)::int as n from account where user_id = $1 and provider_id = 'credential'",
      [user.id],
    );
    expect(accounts.rows[0].n).toBe(1);
    expect((await signInByUsername(user.username, OLD_PASSWORD)).status).toBe(200);
  });

  it('password reset by email OTP works with the same mail pipeline', async () => {
    const user = await createMailUser('bamailotpreset');
    const sent = await http(app)
      .post('/api/v1/auth/email-otp/request-password-reset')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email });
    expect(sent.status).toBe(200);

    const mail = await waitForMailTo(user.email);
    expect(mail.subject).toBe('Mã đặt lại mật khẩu LMS');
    const otp = /\b(\d{6})\b/.exec(mail.text)?.[1];
    expect(otp).toBeTruthy();

    const reset = await http(app)
      .post('/api/v1/auth/email-otp/reset-password')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, otp, password: OTP_RESET_PASSWORD });
    expect(reset.status).toBe(200);
    expect((await signInByUsername(user.username, OTP_RESET_PASSWORD)).status).toBe(200);
    expect((await signInByUsername(user.username, OLD_PASSWORD)).status).toBe(401);
  });

  it('a suspended user who signs in by OTP is still blocked at the guard', async () => {
    const user = await createMailUser('bamailotpsusp');
    await markEmailVerified(user.id);
    const sent = await http(app)
      .post('/api/v1/auth/email-otp/send-verification-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, type: 'sign-in' });
    expect(sent.status).toBe(200);
    const mail = await waitForMailTo(user.email);
    const otp = /\b(\d{6})\b/.exec(mail.text)?.[1];
    const ok = await http(app)
      .post('/api/v1/auth/sign-in/email-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, otp });
    expect(ok.status).toBe(200);
    const cookie = sessionCookieFrom(ok.headers['set-cookie'] as unknown as string[]);
    expect((await http(app).get('/api/v1/users/me').set('Cookie', cookie)).status).toBe(200);

    await pg.query('update users set suspended = true where id = $1', [user.id]);
    try {
      expect((await http(app).get('/api/v1/users/me').set('Cookie', cookie)).status).toBe(401);
    } finally {
      await pg.query('update users set suspended = false where id = $1', [user.id]);
    }
    expect((await http(app).get('/api/v1/users/me').set('Cookie', cookie)).status).toBe(200);
  });
});
