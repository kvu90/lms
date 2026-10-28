/**
 * Ánh xạ Drizzle cho adapter của Better Auth (issue #7, Giai đoạn 1).
 *
 * Đây là schema RIÊNG mà Drizzle adapter nhận qua tham số — nó mô tả các
 * model của Better Auth (user/session/account/verification) trên đúng các
 * bảng vật lý mà baseline định nghĩa ở `modules/users/schema.ts` (bảng
 * `users`) và `modules/auth/schema.ts` (bảng `session`/`account`/
 * `verification`). Tên thuộc tính ở đây là tên field của Better Auth; tên
 * cột là tên vật lý — hai phía phải khớp từng cột, và các flow test của
 * Giai đoạn 1 chạy trên chính baseline để chứng minh điều đó.
 *
 * Điểm nối đáng chú ý: model `user` của Better Auth có field `name` bắt
 * buộc trong khi nghiệp vụ giữ `first_name`/`last_name` là chuẩn — field
 * `name` ánh xạ lên cột `first_name` (tên hiển thị đầy đủ ghép
 * firstname + lastname là việc của tầng hiển thị/Giai đoạn 2, không đổi
 * mô hình dữ liệu nghiệp vụ).
 */
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const betterAuthUsers = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('first_name').notNull().default(''),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  username: text('username').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const betterAuthSession = pgTable('session', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id')
    .notNull()
    .references(() => betterAuthUsers.id, { onDelete: 'cascade' }),
});

export const betterAuthAccount = pgTable('account', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => betterAuthUsers.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Ánh xạ model `twoFactor`: bảng vật lý `two_factor` đã có trong
 * baseline từ Giai đoạn 1 (định nghĩa ở packages/db) và hình
 * cột khớp từng field của plugin twoFactor 1.7.12. Ánh xạ được giữ
 * vì adapter khai đủ model của schema, NHƯNG plugin twoFactor chủ
 * đích không được đăng ký (lý do ở khối plugins của factory) và
 * không luồng nào đọc/ghi bảng này: trạng thái MFA + bước hoàn tất
 * đều đi qua `user_totp` — nguồn duy nhất (xem `mfa-gate.ts` và
 * `two-factor-completion.service.ts`).
 */
export const betterAuthTwoFactor = pgTable('two_factor', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id')
    .notNull()
    .references(() => betterAuthUsers.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const betterAuthVerification = pgTable('verification', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Các bảng OAuth của lát MCP-1 (issue #163): định nghĩa vật lý ở
 * `packages/db` (mục OAuth trong auth.schema.ts), ở đây
 * chỉ là lớp ánh xạ field cho adapter — property là TÊN FIELD của
 * model Better Auth, chuỗi trong ngoặc là TÊN CỘT vật lý.
 *
 * Điểm khác khuôn GĐ1: model `oauthClient` có HAI định danh tách
 * bạch theo khuôn generator của plugin — property `id` (khoá chính
 * nội bộ, text, PostgreSQL sinh bằng DEFAULT `gen_random_uuid()::text`
 * vì instance chạy `generateId: false`) và property `clientId` ánh xạ
 * cột `client_id` (định danh công khai: UUID với DCR, URL với CIMD).
 * KHÔNG gộp `clientId` xuống cột `id`: schema check
 * của adapter Drizzle 1.7.12 nội quan schema theo tên property và
 * luôn đòi property `id` riêng (lỗi `SCHEMA_MISMATCH oauthClient.id`
 * bắt tại e2e lúc nối lại MCP-1). Model `oauthClientAssertion` thì
 * `id` là text do provider tự cấp.
 */
export const betterAuthJwks = pgTable('jwks', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  alg: text('alg'),
  crv: text('crv'),
});

export const betterAuthOAuthClient = pgTable('oauth_client', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  clientId: text('client_id').notNull().unique(),
  clientSecret: text('client_secret'),
  clientDiscoveryId: text('client_discovery_id'),
  disabled: boolean('disabled').notNull().default(false),
  skipConsent: boolean('skip_consent'),
  enableEndSession: boolean('enable_end_session'),
  subjectType: text('subject_type'),
  scopes: text('scopes').array(),
  clientCredentialsScopes: text('client_credentials_scopes').array().notNull().default(sql`'{}'::text[]`),
  userId: uuid('user_id'),
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
  requirePKCE: boolean('require_pkce'),
  dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').notNull().default(false),
  referenceId: text('reference_id'),
  metadata: jsonb('metadata'),
});

export const betterAuthOAuthResource = pgTable('oauth_resource', {
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

export const betterAuthOAuthClientResource = pgTable('oauth_client_resource', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  clientId: text('client_id').notNull(),
  resourceId: text('resource_id').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

export const betterAuthOAuthRefreshToken = pgTable('oauth_refresh_token', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  token: text('token').notNull().unique(),
  clientId: text('client_id').notNull(),
  sessionId: uuid('session_id'),
  userId: uuid('user_id').notNull(),
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
});

export const betterAuthOAuthAccessToken = pgTable('oauth_access_token', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  token: text('token').unique(),
  clientId: text('client_id').notNull(),
  sessionId: uuid('session_id'),
  userId: uuid('user_id'),
  referenceId: text('reference_id'),
  authorizationCodeId: text('authorization_code_id'),
  resources: text('resources').array(),
  requestedUserInfoClaims: text('requested_user_info_claims').array(),
  refreshId: uuid('refresh_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }),
  revoked: timestamp('revoked', { withTimezone: true }),
  confirmation: jsonb('confirmation'),
  scopes: text('scopes').array().notNull(),
});

export const betterAuthOAuthConsent = pgTable('oauth_consent', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id'),
  referenceId: text('reference_id'),
  resources: text('resources').array(),
  requestedUserInfoClaims: text('requested_user_info_claims').array(),
  scopes: text('scopes').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

export const betterAuthOAuthClientAssertion = pgTable('oauth_client_assertion', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Schema object theo đúng hình adapter của Better Auth yêu cầu (khoá là tên model). */
export const betterAuthSchema = {
  user: betterAuthUsers,
  session: betterAuthSession,
  account: betterAuthAccount,
  verification: betterAuthVerification,
  twoFactor: betterAuthTwoFactor,
  jwks: betterAuthJwks,
  oauthClient: betterAuthOAuthClient,
  oauthResource: betterAuthOAuthResource,
  oauthClientResource: betterAuthOAuthClientResource,
  oauthAccessToken: betterAuthOAuthAccessToken,
  oauthRefreshToken: betterAuthOAuthRefreshToken,
  oauthConsent: betterAuthOAuthConsent,
  oauthClientAssertion: betterAuthOAuthClientAssertion,
};
