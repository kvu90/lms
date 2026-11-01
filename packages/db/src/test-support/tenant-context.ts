/**
 * Pool test gắn ngữ cảnh tenant theo ĐÚNG hợp đồng của
 * `TenantAwarePool` phía `apps/api` (`apps/api/src/db/tenant-pool.ts`),
 * phục vụ các spec cần chứng minh hành vi GUC/RLS khi đi qua Kysely.
 *
 * Vì sao package giữ một bản phục vụ test thay vì import bản thật:
 * ranh giới package cấm `packages/db` import từ `apps/*` (xem luật
 * package trong `AGENTS.md` của package). Bản này tái lập trung thực
 * hợp đồng của bản thật:
 *
 *   - Một AsyncLocalStorage mang `{ tenantId?, platform? }` — cùng
 *     hình dạng store mà `tenantAls` phía app dùng.
 *   - Mỗi client được checkout được bọc `query`: câu truy vấn đầu
 *     tiên trên client đó chạy trước một
 *     `select set_config('app.tenant_id', $1, false), set_config('app.platform', $2, false)`
 *     với ánh xạ: ngữ cảnh platform tường minh → `('', 'on')`; ngữ
 *     cảnh tenant → `(<tenantId>, 'off')`; ngoài ngữ cảnh →
 *     `('', 'off')` (fail-closed).
 *   - Client trả về pool rồi checkout lại thì gắn lại từ đầu theo
 *     ngữ cảnh mới — GUC của ngữ cảnh trước không rò sang ngữ cảnh
 *     sau.
 *
 * Bằng chứng với `TenantAwarePool` THẬT nằm ở spec tích hợp phía
 * `apps/api` (`test/integration/db/kysely-foundation.int-spec.ts`),
 * nơi app được phép import cả hai phía; file này chỉ lo phần chứng
 * minh nằm trong ranh giới package.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

/** Hình dạng ngữ cảnh tenant của pool test — khớp `TenantAlsStore` phía app ở các trường pool đọc. */
export interface TestTenantStore {
  /** Tenant hiệu lực; vắng mặt khi ngữ cảnh là đường platform hoặc ngoài request. */
  tenantId?: string;
  /** Đường platform tường minh: kết nối được gắn cờ `app.platform = 'on'`. */
  platform?: boolean;
}

/** ALS ngữ cảnh tenant của harness test — các spec tự nạp qua hai hàm `runIn…` dưới đây. */
export const testTenantAls = new AsyncLocalStorage<TestTenantStore>();

/** Chạy `fn` trong ngữ cảnh tenant `tenantId` (GUC `app.tenant_id` gắn ở checkout đầu tiên bên trong). */
export function runInTestTenantContext<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return testTenantAls.run({ tenantId }, fn);
}

/** Chạy `fn` trong ngữ cảnh platform tường minh (GUC `app.platform = 'on'`). */
export function runInTestPlatformContext<T>(fn: () => Promise<T>): Promise<T> {
  return testTenantAls.run({ platform: true }, fn);
}

interface TenantTagState {
  tagged: boolean;
  tenantId: string;
  platform: string;
  rawQuery: (...args: unknown[]) => Promise<unknown>;
}

const TAG_STATE = Symbol('testTenantTagState');

/**
 * Pool `pg` gắn GUC tenant theo hợp đồng mô tả ở đầu file. Cách dùng
 * giống hệt pool thường: truyền thẳng vào `createCentreKysely(pool)`
 * (hoặc `createTestKysely`) — Kysely checkout client qua pool này nên
 * mọi truy vấn đều đi qua lớp gắn GUC.
 */
export class TestTenantPool extends Pool {
  constructor(config: PoolConfig) {
    super(config);
  }

  /** Chuẩn bị state gắn GUC cho một client vừa checkout theo ngữ cảnh ALS hiện tại. */
  private prepareClient(client: PoolClient): PoolClient {
    const store = testTenantAls.getStore();
    const tenantId = store?.platform ? '' : (store?.tenantId ?? '');
    const platform = store?.platform ? 'on' : 'off';
    const holder = client as PoolClient & { [TAG_STATE]?: TenantTagState };
    const existing = holder[TAG_STATE];
    if (existing) {
      existing.tenantId = tenantId;
      existing.platform = platform;
      existing.tagged = false;
      return client;
    }
    const state: TenantTagState = {
      tagged: false,
      tenantId,
      platform,
      rawQuery: client.query.bind(client) as (...args: unknown[]) => Promise<unknown>,
    };
    holder[TAG_STATE] = state;
    client.query = (async (...args: unknown[]) => {
      if (!state.tagged) {
        await state.rawQuery(
          "select set_config('app.tenant_id', $1, false), set_config('app.platform', $2, false)",
          [state.tenantId, state.platform],
        );
        state.tagged = true;
      }
      return state.rawQuery(...args);
    }) as PoolClient['query'];
    return client;
  }

  override connect(): Promise<PoolClient>;
  override connect(
    callback: (err: Error, client: PoolClient, done: (release?: unknown) => void) => void,
  ): void;
  override connect(
    callback?: (err: Error, client: PoolClient, done: (release?: unknown) => void) => void,
  ): Promise<PoolClient> | void {
    if (callback) {
      super.connect((err, client, done) => {
        if (err || !client)
          return callback(
            err ?? new Error('TestTenantPool: connect failed'),
            client as PoolClient,
            done,
          );
        try {
          this.prepareClient(client);
        } catch (prepError) {
          done(prepError);
          return callback(prepError as Error, client, done);
        }
        return callback(null as unknown as Error, client, done);
      });
      return undefined;
    }
    return super.connect().then((client) => this.prepareClient(client));
  }
}
