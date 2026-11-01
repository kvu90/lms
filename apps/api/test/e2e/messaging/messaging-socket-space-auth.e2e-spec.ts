import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spaceRegistry } from '@lms/db/control-plane';
import { drizzle } from 'drizzle-orm/node-postgres';
import { io, type Socket } from 'socket.io-client';

/**
 * Better Auth phải bật ngay từ lúc AppModule được import (cùng khuôn
 * spec cổng tiền di trú 587): đặt biến môi trường ở đầu file, rồi
 * import helpers ĐỘNG trong beforeAll — import tĩnh helpers sẽ kéo
 * AppModule vào trước khi các biến này được gán.
 */
const BETTER_AUTH_SECRET = 'test-better-auth-secret-at-least-32-chars';
process.env.BETTER_AUTH_ENABLED = 'true';
process.env.BETTER_AUTH_SECRET = BETTER_AUTH_SECRET;
process.env.BETTER_AUTH_TRUSTED_ORIGINS = 'http://localhost:5173';

type Helpers = typeof import('../../support/identity-access-helpers');
let helpers: Helpers;

/**
 * Dựng app test đúng khuôn bootstrap thật (main.ts): mount handler
 * Better Auth TRƯỚC khi init, kèm khung định tuyến kho — cùng khuôn
 * spec cổng tiền di trú 587, vì socket auth đọc phiên qua chính
 * instance Better Auth này.
 */
async function createMountedTestApp(): Promise<INestApplication> {
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../../../src/app.module');
  const { enableTrustedProxy } = await import('../../../src/common/client-ip');
  const { ProblemDetailsFilter } = await import('../../../src/common/problem-details.filter');
  const { mountBetterAuth } = await import('../../../src/modules/auth/better-auth/better-auth.mount');
  const { BetterAuthService: BetterAuthServiceClass } = await import(
    '../../../src/modules/auth/better-auth/better-auth.service'
  );
  const { SpaceDatabaseService: SpaceDatabaseServiceClass } = await import(
    '../../../src/db/routing/space-database.service'
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  enableTrustedProxy(app as NestExpressApplication);
  const betterAuth = app.get(BetterAuthServiceClass);
  const spaceDb = app.get(SpaceDatabaseServiceClass, { strict: false });
  mountBetterAuth(app as NestExpressApplication, betterAuth.requireAuth(), spaceDb);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  return app;
}

/**
 * Ký giá trị cookie phiên Better Auth đúng định dạng mà handler của
 * nó kiểm chứng khi đọc (cùng khuôn spec 587): cookie không ký thì
 * `getSession` trả null ngay trước khi tra bảng phiên.
 */
function signedBetterAuthCookie(token: string): string {
  const signature = createHmac('sha256', BETTER_AUTH_SECRET).update(token).digest('base64');
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

/**
 * Ca đầu-cuối của SOCKET AUTH PHÂN GIẢI KHÔNG GIAN THEO HOST (tiền
 * điều kiện Phần B của issue #587, PR-TĐ2): ứng dụng thật chạy với
 * một trung tâm kiểm chứng ở kho riêng dựng riêng cho đợt này —
 * database mới trên cùng cụm test, role ứng dụng riêng, CONNECT của
 * PUBLIC bị thu hồi, baseline nghiệp vụ áp bằng role chủ kho; sổ
 * đăng ký nằm ở database control plane riêng mà ứng dụng đọc qua
 * biến `CONTROL_PLANE_DATABASE_URL` đặt trước khi ứng dụng khởi
 * động. Tài khoản kiểm chứng chính được sao vào kho riêng rồi XOÁ
 * khỏi kho chung — trạng thái sau di trú mà phía kho chung không
 * còn dấu vết nào để đường auth có thể "ăn gian" bằng kho chung.
 * Địa chỉ của trung tâm là tên miền con mang slug theo quy ước địa
 * chỉ của hệ; socket.io-client gửi đúng địa chỉ đó qua header `Host`
 * của handshake. BẮT BUỘC dùng transport websocket: header `Host`
 * qua polling XHR bị tầng XHR lược như một header cấm, nên ca dùng
 * polling sẽ âm thầm rơi về đường kho chung và cho kết quả giả —
 * websocket giữ nguyên header `Host` tự đặt (đã kiểm chứng bằng
 * handshake upgrade thật).
 *
 * Các ca khoá đúng §1.3 của đặc tả tiền điều kiện (chỉ phần thuộc
 * lớp auth của handshake — trao đổi tin nhắn realtime đầy đủ qua
 * gateway còn cần phạm vi kho ở các handler sau auth, xem ghi chú
 * trong thân PR):
 * (1) tài khoản chỉ ở kho riêng, phiên cookie chỉ ở kho riêng, nối
 *     socket tại địa chỉ trung tâm → kết nối thành công, gateway
 *     chạy hết handleConnection (ảnh chụp presence được phát);
 * (2) tài khoản chỉ ở kho riêng, token mang claim trung tâm khớp
 *     địa chỉ → kết nối thành công;
 * (3) phiên chỉ tồn tại ở kho chung đem tới địa chỉ trung tâm kho
 *     riêng → bị ngắt, không được phục vụ lặng lẽ từ kho chung;
 * (4) trung tâm kho chung / địa chỉ không mang trung tâm: hành vi
 *     socket hiện tại không đổi (phiên kho chung nối thành công).
 */
const CP_DATABASE = 'lms_test_cp_587td2';
const CP_ROLE = 'lms_cp_test_587td2';
const CP_PASSWORD = 'cp-test-587td2';
const CENTRE_DATABASE = 'lms_test_centre_587td2';
const CENTRE_ROLE = 'lms_centre_587td2_app';
const CENTRE_PASSWORD = 'centre-test-587td2';
const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const CENTRE_SLUG = `trung-tam-td2-${RUN_SUFFIX}`;
const HOST_CENTRE = `${CENTRE_SLUG}.test.local`;

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/** Dựng URL kết nối tới một database trên cùng cụm với database nghiệp vụ test. */
function clusterUrl(database: string, username?: string, secret?: string): string {
  const base = new URL(process.env.DATABASE_URL!);
  base.pathname = `/${database}`;
  if (username) base.username = username;
  if (secret) base.password = secret;
  return base.toString();
}

/** Bọc một định danh Postgres trong dấu nháy kép cho các câu lệnh quản trị của ca test. */
function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Áp một file migration SQL (tách theo dấu phân đoạn của Drizzle) lên một database qua kết nối cho trước. */
async function applySqlFile(connectionString: string, filePath: string, withUuidShim: boolean): Promise<void> {
  await withClient(connectionString, async (client) => {
    if (withUuidShim) {
      const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
      if (Number(version.rows[0]!.server_version_num) < 180000) {
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await client.query(UUIDV7_SHIM);
      }
    }
    const sqlText = readFileSync(filePath, 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  });
}

/** Áp bộ migration riêng của control plane từ rỗng (đọc chính các file SQL đã sinh trong repo). */
async function applyControlPlaneMigrations(connectionString: string): Promise<void> {
  const outDir = join(__dirname, '..', '..', '..', 'drizzle-control-plane');
  const folders = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    await applySqlFile(connectionString, join(outDir, folder, 'migration.sql'), true);
  }
}

/** Áp baseline nghiệp vụ vào một kho riêng bằng kết nối của chính role chủ kho đó. */
async function applyBusinessBaseline(connectionString: string): Promise<void> {
  const baseline = join(__dirname, '..', '..', '..', 'drizzle', '20261025163710_baseline', 'migration.sql');
  await applySqlFile(connectionString, baseline, true);
}

/**
 * Sao một dòng (đọc từ kho chung) vào cùng bảng ở kho đích với
 * nguyên bộ cột — mô phỏng phần dữ kiện đã di trú của trung tâm.
 */
async function copyRow(
  sourceUrl: string,
  targetUrl: string,
  table: string,
  whereColumn: string,
  whereValue: string,
): Promise<void> {
  const row = await withClient(sourceUrl, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query(`SELECT * FROM ${quoted(table)} WHERE ${quoted(whereColumn)} = $1`, [
      whereValue,
    ]);
    return result.rows[0] as Record<string, unknown> | undefined;
  });
  if (!row) throw new Error(`Không tìm thấy dòng nguồn ${table}.${whereColumn}=${whereValue}`);
  const columns = Object.keys(row);
  await withClient(targetUrl, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    await client.query(
      `INSERT INTO ${quoted(table)} (${columns.map(quoted).join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  });
}

/** Đếm dòng theo một cột định danh trong một bảng ở một kho (nền platform tường minh). */
async function countRows(
  connectionString: string,
  table: string,
  column: string,
  value: string,
): Promise<number> {
  return withClient(connectionString, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query<{ count: string }>(
      `SELECT count(*) FROM ${quoted(table)} WHERE ${quoted(column)} = $1`,
      [value],
    );
    return Number(result.rows[0]!.count);
  });
}

/** Gieo một phiên Better Auth (bảng `session`) cho một tài khoản vào đúng một kho. */
async function seedSession(connectionString: string, token: string, userId: string): Promise<void> {
  await withClient(connectionString, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    await client.query(
      `INSERT INTO "session" (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [token, userId],
    );
  });
}

describe('Socket auth phân giải không gian theo Host (đầu-cuối, issue #587)', () => {
  let app: INestApplication;
  let base: string;
  let tenantId = '';
  let registryId = '';
  let dedicatedOnlyId = '';
  let dedicatedSessionToken = '';
  let sharedOnlySessionToken = '';
  let sharedOnlyId = '';
  const sockets: Socket[] = [];

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const must = async (res: { status: number; body: unknown }, what: string) => {
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as never;
  };

  /** Nối socket, chờ 'connect'; server ngắt sau xác thực thì chờ 'disconnect'/'connect_error' thay vì treo. */
  async function connectSocket(opts: {
    host?: string;
    cookie?: string;
    token?: string;
  }): Promise<{ socket: Socket; outcome: string }> {
    const extraHeaders: Record<string, string> = {};
    if (opts.host) extraHeaders['Host'] = opts.host;
    if (opts.cookie) extraHeaders['Cookie'] = opts.cookie;
    const socket = io(`${base}/messaging`, {
      auth: opts.token ? { token: opts.token } : undefined,
      extraHeaders,
      // Xem chú thích ở đầu file: chỉ websocket giữ header Host tự đặt.
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    sockets.push(socket);
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 15000);
      socket.once('connect', () => {
        // Server có thể accept ở tầng transport rồi mới ngắt sau xác
        // thực: 'connect' chưa đủ, chờ thêm ảnh chụp presence (phát
        // cuối handleConnection) hoặc ngắt trong cửa sổ ngắn.
        const settle = setTimeout(() => resolve('connected'), 3000);
        socket.once('disconnect', () => { clearTimeout(settle); resolve('disconnected'); });
        socket.once('connect_error', () => { clearTimeout(settle); resolve('connect_error'); });
        socket.once('presence.snapshot', () => { clearTimeout(settle); clearTimeout(timer); resolve('connected'); });
      });
      socket.once('disconnect', () => { clearTimeout(timer); resolve('disconnected'); });
      socket.once('connect_error', () => { clearTimeout(timer); resolve('connect_error'); });
    });
    return { socket, outcome };
  }

  beforeAll(async () => {
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
      await admin.query(`CREATE ROLE ${CP_ROLE} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${CENTRE_ROLE} LOGIN PASSWORD '${CENTRE_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${CP_DATABASE} OWNER ${CP_ROLE}`);
      await admin.query(`CREATE DATABASE ${CENTRE_DATABASE} OWNER ${CENTRE_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CP_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CP_DATABASE} TO ${CP_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CENTRE_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CENTRE_DATABASE} TO ${CENTRE_ROLE}`);
    });
    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD));
    await applyBusinessBaseline(clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD));

    process.env.CONTROL_PLANE_DATABASE_URL = clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD);
    process.env.SPACE_TEST_TD2_URL = clusterUrl('postgres', CENTRE_ROLE, CENTRE_PASSWORD);

    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      const cpDb = drizzle({ client });
      const inserted = await cpDb
        .insert(spaceRegistry)
        .values([
          {
            slug: CENTRE_SLUG,
            name: 'Trung tâm TD2',
            kind: 'center',
            status: 'active',
            databaseName: CENTRE_DATABASE,
            storageMode: 'dedicated',
            connectionRoleRef: CENTRE_ROLE,
            secretRef: 'env:SPACE_TEST_TD2_URL',
            schemaVersion: 'v1',
          },
        ])
        .returning({ id: spaceRegistry.id });
      registryId = inserted[0]!.id;
    });

    helpers = await import('../../support/identity-access-helpers');
    app = await createMountedTestApp();
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const adminToken = (await helpers.login(app, 'admin', 'Admin123!')).accessToken;

    const created = (await must(
      await helpers.http(app).post('/api/v1/tenants').set(auth(adminToken)).send({
        name: 'Trung tâm TD2 (spec socket)',
        slug: CENTRE_SLUG,
        kind: 'school',
      }),
      'create tenant',
    )) as { id: string };
    tenantId = created.id;
    await copyRow(
      process.env.DATABASE_URL!,
      clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD),
      'tenants',
      'id',
      tenantId,
    );

    // Tài khoản chỉ còn ở kho riêng: tạo ở kho chung, thêm
    // membership, sao user + membership vào kho đích, rồi xoá khỏi
    // kho chung (membership trước, user sau).
    const dedicatedOnly = await helpers.createUserViaApi(app, adminToken);
    dedicatedOnlyId = dedicatedOnly.id;
    await must(
      await helpers.http(app).post(`/api/v1/tenants/${tenantId}/members`).set(auth(adminToken)).send({ userId: dedicatedOnlyId }),
      'add dedicated-only user to tenant',
    );
    const centreUrl = clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD);
    await copyRow(process.env.DATABASE_URL!, centreUrl, 'users', 'id', dedicatedOnlyId);
    const membershipRow = await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ id: string }>(
        'SELECT id FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, dedicatedOnlyId],
      );
      return result.rows[0];
    });
    if (!membershipRow) throw new Error('membership của tài khoản ở tenant TD2 không tồn tại');
    await copyRow(process.env.DATABASE_URL!, centreUrl, 'tenant_memberships', 'id', membershipRow.id);
    await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query('DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [
        tenantId,
        dedicatedOnlyId,
      ]);
      await client.query('DELETE FROM users WHERE id = $1', [dedicatedOnlyId]);
    });

    // Phiên cookie của tài khoản chỉ ở kho riêng: gieo thẳng vào
    // bảng `session` ở kho đích (không gieo ở kho chung).
    dedicatedSessionToken = `td2-${RUN_SUFFIX}-${randomUUID()}`;
    await seedSession(centreUrl, dedicatedSessionToken, dedicatedOnlyId);

    // Tài khoản chỉ ở kho chung + phiên chỉ ở kho chung: ca phủ
    // định (3) và ca hành vi không đổi (4) dùng chung tài khoản này.
    const sharedOnly = await helpers.createUserViaApi(app, adminToken);
    sharedOnlyId = sharedOnly.id;
    sharedOnlySessionToken = `td2-shared-${RUN_SUFFIX}-${randomUUID()}`;
    await seedSession(process.env.DATABASE_URL!, sharedOnlySessionToken, sharedOnlyId);
  }, 300_000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await app?.close().catch(() => undefined);
    delete process.env.SPACE_TEST_TD2_URL;
    delete process.env.CONTROL_PLANE_DATABASE_URL;
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
    }).catch(() => undefined);
  });

  it('tài khoản chỉ ở kho riêng, phiên cookie chỉ ở kho riêng, nối socket tại địa chỉ trung tâm thành công', async () => {
    expect(await countRows(process.env.DATABASE_URL!, 'users', 'id', dedicatedOnlyId)).toBe(0);
    expect(await countRows(process.env.DATABASE_URL!, 'session', 'user_id', dedicatedOnlyId)).toBe(0);
    const centreUrl = clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD);
    expect(await countRows(centreUrl, 'users', 'id', dedicatedOnlyId)).toBe(1);
    expect(await countRows(centreUrl, 'session', 'user_id', dedicatedOnlyId)).toBe(1);

    const { socket, outcome } = await connectSocket({
      host: HOST_CENTRE,
      cookie: signedBetterAuthCookie(dedicatedSessionToken),
    });
    expect(outcome).toBe('connected');
    expect(socket.connected).toBe(true);
  });

  it('tài khoản chỉ ở kho riêng, token mang claim trung tâm khớp địa chỉ, nối socket thành công', async () => {
    const jwtService = app.get(JwtService);
    const token = await jwtService.signAsync({
      sub: dedicatedOnlyId,
      username: 'dedicated-td2',
      sid: randomUUID(),
      tid: tenantId,
      centre_id: registryId,
    });
    const { socket, outcome } = await connectSocket({ host: HOST_CENTRE, token });
    expect(outcome).toBe('connected');
    expect(socket.connected).toBe(true);
  });

  it('phiên chỉ tồn tại ở kho chung đem tới địa chỉ trung tâm kho riêng bị ngắt, không phục vụ từ kho chung', async () => {
    expect(await countRows(process.env.DATABASE_URL!, 'session', 'user_id', sharedOnlyId)).toBe(1);
    const centreUrl = clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD);
    expect(await countRows(centreUrl, 'session', 'user_id', sharedOnlyId)).toBe(0);

    const { socket, outcome } = await connectSocket({
      host: HOST_CENTRE,
      cookie: signedBetterAuthCookie(sharedOnlySessionToken),
    });
    expect(['disconnected', 'connect_error']).toContain(outcome);
    expect(socket.connected).toBe(false);
  });

  it('địa chỉ không mang trung tâm: phiên kho chung nối socket thành công như trước', async () => {
    const { socket, outcome } = await connectSocket({
      cookie: signedBetterAuthCookie(sharedOnlySessionToken),
    });
    expect(outcome).toBe('connected');
    expect(socket.connected).toBe(true);
  });
});
