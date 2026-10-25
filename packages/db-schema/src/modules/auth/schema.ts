/** Các bảng của bounded context Auth — định nghĩa Drizzle do module auth sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../users/schema';

/**
 * Họ refresh token cho xoay vòng + phát hiện tái sử dụng. Chỉ hash của
 * token được lưu. `ip` + `user_agent` là thông tin máy khách của request
 * lúc cấp họ, ghi MỘT LẦN khi tạo họ và không cập nhật khi xoay vòng —
 * đối chiếu trường `ipAddress`/`userAgent` trên phiên của Better Auth và
 * cột `firstip`/`lastip` trên bảng `sessions` của Moodle — để danh sách
 * phiên của chính user hiển thị đúng thiết bị/địa chỉ của phiên API.
 */
export const refreshTokenFamily = pgTable('refresh_token_family', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  familyId: text('family_id').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ip: text('ip'),
  userAgent: text('user_agent'),
  currentTokenHash: text('current_token_hash').notNull(),
  previousTokenHash: text('previous_token_hash'),
  revoked: boolean('revoked').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('refresh_token_family_user_id_idx').on(table.userId),
  ]);


/**
 * MFA TOTP theo user (Moodle tool_mfa factor_totp): mỗi user tối đa một
 * secret TOTP. Secret KHÔNG bao giờ lưu thô — cột `secret_encrypted` giữ
 * bản mã AES-256-GCM (xem TotpService). `confirmed=false` là trạng thái
 * chờ: secret đã cấp ở bước setup nhưng user chưa chứng minh sở hữu
 * authenticator bằng một mã đúng; chỉ `confirmed=true` mới chặn đăng
 * nhập ở bước MFA.
 */
export const userTotp = pgTable('user_totp', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  secretEncrypted: text('secret_encrypted').notNull(),
  confirmed: boolean('confirmed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
},
  (table) => [
      index('user_totp_user_id_idx').on(table.userId),
  ]);


/**
 * Liên kết đăng nhập ngoài theo user (bảng `auth_oauth2_linked_login` của
 * Moodle): mỗi dòng nối một tài khoản nhà cung cấp (issuer + định danh chủ
 * thể phía provider) với một user nội bộ. Một user có tối đa một liên kết
 * mỗi issuer và một tài khoản provider chỉ nối được với một user — hai
 * ràng buộc duy nhất đó là nền của việc khớp tài khoản ở callback OAuth.
 * `email` là ảnh chụp email của provider tại thời điểm liên kết (phục vụ
 * hiển thị ở trang Linked logins, không dùng để khớp lại sau này).
 */
export const userOauthLinks = pgTable('user_oauth_links', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  issuer: text('issuer').notNull(),
  issuerUserId: text('issuer_user_id').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('user_oauth_links_issuer_subject_unique').on(table.issuer, table.issuerUserId),
      unique('user_oauth_links_user_issuer_unique').on(table.userId, table.issuer),
      index('user_oauth_links_user_id_idx').on(table.userId),
  ]);


/**
 * Các bảng lõi của Better Auth (issue #7, Giai đoạn 1) — tên vật lý dùng
 * đúng tên chuẩn của Better Auth, không tiền tố: bảng `users` hiện hữu là
 * bảng user của nó (thêm cột `email_verified`, `image` ở schema users);
 * bốn bảng dưới đây do Drizzle adapter của Better Auth ghi qua ánh xạ ở
 * `better-auth/better-auth.schema.ts`. Auth tự viết vẫn là đường chính
 * cho tới cutover ở Giai đoạn 2 — các bảng này tồn tại song song.
 */

/** Phiên cookie phía server của Better Auth (model `session`). */
export const authSession = pgTable('session', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('session_user_id_idx').on(table.userId),
  ]);

/** Tài khoản đăng nhập của Better Auth (model `account`): dòng credential giữ hash mật khẩu, dòng OAuth giữ token của nhà cung cấp. */
export const authAccount = pgTable('account', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('account_user_id_idx').on(table.userId),
      // Một user chỉ có tối đa MỘT account cho mỗi nhà cung cấp (điểm
      // giữ lại từ review Giai đoạn 1 của issue #7): dòng credential là
      // duy nhất theo cặp này, và tầng cơ sở dữ liệu tự chặn việc tạo
      // account thứ hai cho cùng một provider — các luồng tạo cặp
      // user + account dựa vào ràng buộc này để phát hiện trùng lặp
      // thay vì kiểm tra rời rạc phía ứng dụng.
      unique('account_user_id_provider_id_unique').on(table.userId, table.providerId),
  ]);

/** Mã xác thực dùng một lần của Better Auth (model `verification`): reset mật khẩu, xác thực email. */
export const authVerification = pgTable('verification', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * TOTP + backup codes của plugin twoFactor của Better Auth (bảng
 * `two_factor`): secret và backup codes do plugin quản; plugin bật ở
 * Giai đoạn 2 — bảng có mặt trong baseline từ Giai đoạn 1 theo issue.
 * Cột `two_factor_enabled` trên `users` thuộc plugin, đến cùng Giai đoạn 2.
 */
export const authTwoFactor = pgTable('two_factor', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('two_factor_user_id_idx').on(table.userId),
  ]);

/**
 * ── Máy chủ OAuth 2.1 cho MCP (issue #163, lát MCP-1) ─────────────────
 * Tám bảng dưới đây thuộc bộ plugin chính chủ của Better Auth 1.7.12
 * (`jwt()` → `jwks`; `mcp()` dựng trên `@better-auth/oauth-provider` →
 * bảy bảng `oauth_*`), được adapter Drizzle ghi qua ánh xạ ở
 * `better-auth/better-auth.schema.ts`. Field/kiểu chốt từ
 * `getAuthTables()` của instance 1.7.12 đã compose đủ ba plugin (spike
 * trên issue #163) — KHÔNG suy đoán. Các bảng chỉ có dữ liệu khi cờ
 * `MCP_AS_ENABLED` bật; baseline mang DDL từ lát này như khuôn GĐ1 đã
 * làm với `two_factor`.
 *
 * HAI ngoại lệ định danh có chủ đích (ADR-017, allowlist tường minh
 * trong spec uuidv7):
 * - `oauth_client.id` là TEXT: field `clientId` của model ánh xạ thẳng
 *   xuống cột `id` (tài liệu plugin: adapters MAY map `client_id` →
 *   `id`; `id` phải chứa được chuỗi dạng UUID lẫn URL — client CIMD
 *   dùng chính URL tài liệu metadata làm client_id). Không thể
 *   `uuidv7()`.
 * - `oauth_client_assertion.id` là TEXT: provider tự cấp id bằng hàm
 *   băm xác định (SHA-256 → base64url khi `generateId` khác `uuid`,
 *   kiểm chứng trong dist 1.7.12) và insert với `forceAllowId` — DB
 *   không sinh, không default.
 * Sáu bảng còn lại giữ khuôn chung: `uuid` + `DEFAULT uuidv7()`.
 */

/** Cặp khoá ký JWT của plugin jwt() (model `jwks`): private key mã hoá AES256-GCM phía plugin. */
export const authJwks = pgTable('jwks', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  alg: text('alg'),
  crv: text('crv'),
});

/**
 * Client OAuth đã đăng ký (model `oauthClient`) — một dòng cho client
 * DCR (client_id ngẫu nhiên) lẫn client CIMD (client_id = URL). Khoá
 * chính `id` TEXT chính là client_id (xem ngoại lệ ADR-017 phía trên);
 * các bảng oauth_* khác tham chiếu tới cột này qua field `clientId`.
 */
export const oauthClient = pgTable('oauth_client', {
  id: text('id').primaryKey(),
  clientSecret: text('client_secret'),
  clientDiscoveryId: text('client_discovery_id'),
  disabled: boolean('disabled').notNull().default(false),
  skipConsent: boolean('skip_consent'),
  enableEndSession: boolean('enable_end_session'),
  subjectType: text('subject_type'),
  scopes: text('scopes').array(),
  clientCredentialsScopes: text('client_credentials_scopes').array().notNull().default(sql`'{}'::text[]`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  name: text('name'),
  uri: text('uri'),
  icon: text('icon'),
  contacts: text('contacts').array(),
  tos: text('tos'),
  policy: text('policy'),
  softwareId: text('software_id'),
  softwareVersion: text('software_version'),
  softwareStatement: text('software_statement'),
  redirectUris: text('redirect_uris').array().notNull(),
  postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
  backchannelLogoutUri: text('backchannel_logout_uri'),
  backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
  applicationType: text('application_type'),
  jwks: text('jwks'),
  jwksUri: text('jwks_uri'),
  grantTypes: text('grant_types').array(),
  responseTypes: text('response_types').array(),
  requirePkce: boolean('require_pkce'),
  dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').notNull().default(false),
  referenceId: text('reference_id'),
  metadata: jsonb('metadata'),
},
  (table) => [
      index('oauth_client_user_id_idx').on(table.userId),
      index('oauth_client_client_discovery_id_idx').on(table.clientDiscoveryId),
  ]);

/** Resource được bảo vệ mà AS phát token cho (model `oauthResource`) — dòng `/mcp` được seed từ cấu hình lúc instance khởi động. */
export const oauthResource = pgTable('oauth_resource', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(),
  customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').notNull().default(false),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  policyVersion: integer('policy_version').notNull().default(1),
  metadata: jsonb('metadata'),
});

/** Liên kết client ↔ resource (model `oauthClientResource`): client chỉ nhận token cho resource đã liên kết. */
export const oauthClientResource = pgTable('oauth_client_resource', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  clientId: text('client_id').notNull().references(() => oauthClient.id, { onDelete: 'cascade' }),
  resourceId: text('resource_id').notNull().references(() => oauthResource.identifier, { onDelete: 'cascade' }),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }),
},
  (table) => [
      unique('oauth_client_resource_client_resource_unique').on(table.clientId, table.resourceId),
      index('oauth_client_resource_client_id_idx').on(table.clientId),
      index('oauth_client_resource_resource_id_idx').on(table.resourceId),
  ]);

/** Refresh token đã phát (model `oauthRefreshToken`): xoay vòng + phát hiện tái sử dụng do provider quản. */
export const oauthRefreshToken = pgTable('oauth_refresh_token', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  token: text('token').notNull().unique(),
  clientId: text('client_id').notNull().references(() => oauthClient.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => authSession.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  referenceId: text('reference_id'),
  authorizationCodeId: text('authorization_code_id'),
  resources: text('resources').array(),
  requestedUserInfoClaims: text('requested_user_info_claims').array(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }),
  revoked: timestamp('revoked', { withTimezone: true }),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  rotationReplayResponse: text('rotation_replay_response'),
  rotationReplayExpiresAt: timestamp('rotation_replay_expires_at', { withTimezone: true }),
  authTime: timestamp('auth_time', { withTimezone: true }),
  confirmation: jsonb('confirmation'),
  scopes: text('scopes').array().notNull(),
},
  (table) => [
      index('oauth_refresh_token_client_id_idx').on(table.clientId),
      index('oauth_refresh_token_session_id_idx').on(table.sessionId),
      index('oauth_refresh_token_user_id_idx').on(table.userId),
  ]);

/** Access token dạng opaque đã phát (model `oauthAccessToken`) — token JWT tự chứa KHÔNG lưu ở đây; bảng phục vụ token opaque/introspection. */
export const oauthAccessToken = pgTable('oauth_access_token', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  token: text('token').unique(),
  clientId: text('client_id').notNull().references(() => oauthClient.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => authSession.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  referenceId: text('reference_id'),
  authorizationCodeId: text('authorization_code_id'),
  resources: text('resources').array(),
  requestedUserInfoClaims: text('requested_user_info_claims').array(),
  refreshId: uuid('refresh_id').references(() => oauthRefreshToken.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }),
  revoked: timestamp('revoked', { withTimezone: true }),
  confirmation: jsonb('confirmation'),
  scopes: text('scopes').array().notNull(),
},
  (table) => [
      index('oauth_access_token_client_id_idx').on(table.clientId),
      index('oauth_access_token_session_id_idx').on(table.sessionId),
      index('oauth_access_token_user_id_idx').on(table.userId),
      index('oauth_access_token_refresh_id_idx').on(table.refreshId),
  ]);

/** Đồng ý của người dùng cho một client (model `oauthConsent`) — ghi khi giáo viên bấm đồng ý ở trang consent. */
export const oauthConsent = pgTable('oauth_consent', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  clientId: text('client_id').notNull().references(() => oauthClient.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  referenceId: text('reference_id'),
  resources: text('resources').array(),
  requestedUserInfoClaims: text('requested_user_info_claims').array(),
  scopes: text('scopes').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
},
  (table) => [
      index('oauth_consent_client_id_idx').on(table.clientId),
      index('oauth_consent_user_id_idx').on(table.userId),
  ]);

/**
 * Bản ghi dùng-một-lần cho `jti` của client assertion `private_key_jwt`
 * (model `oauthClientAssertion`): `id` TEXT do provider tự cấp bằng hàm
 * băm xác định (xem ngoại lệ ADR-017) — chống phát lại ở tầng PK.
 */
export const oauthClientAssertion = pgTable('oauth_client_assertion', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Failed-login bookkeeping for lockout (Moodle authlib lockout semantics). */
export const loginAttempts = pgTable('login_attempts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  username: text('username').notNull(),
  success: boolean('success').notNull(),
  ip: text('ip'),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('login_attempts_user_id_idx').on(table.userId),
  ]);

