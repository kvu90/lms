import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createCentreKysely, type CentreDb } from '@lms/db';
import { spaceRegistry } from '@lms/db/control-plane';
import { databaseConnectionFromEnv } from '../../config/env';
import { tenantAls, type TenantAlsStore } from '../tenant-als';
import { relations } from '../relations';
import { TenantAwarePool } from '../tenant-pool';
import {
  SpaceConnectionResolver,
  SpaceRoutingError,
  type ResolvedSpaceConnection,
  type SpaceRegistryEntry,
} from './space-connection-resolver';
import { SpacePoolManager } from './space-pool-manager';

/** Handle Drizzle của worker — cùng hình với handle mà `worker.module.ts` dựng cho kho chung. */
export type SpaceDatabase = NodePgDatabase<typeof relations>;

/**
 * Khung định tuyến kết nối theo trung tâm cho tác vụ nền (issue
 * #581) — BẢN SAO phía worker của
 * `apps/api/src/db/routing/space-database.service.ts` theo tiền lệ
 * repo (mỗi app giữ bản sao hạ tầng riêng — cùng khuôn với
 * `tenant-als`/`tenant-pool`): hai tiến trình không dùng chung bộ
 * nhớ, nên mỗi phía giữ bộ phân giải, trình quản lý pool và bảng
 * đã-chuẩn-bị của riêng mình, cùng đọc MỘT sổ đăng ký ở control
 * plane và cùng một luật phân giải. Sửa file này PHẢI sửa đồng bộ
 * bản phía API và ngược lại.
 *
 * Ba điểm khác bản API, đều do hình của tiến trình worker:
 * - Worker chưa có kết nối control plane dùng chung, nên service
 *   tự giữ MỘT pool đọc sổ riêng từ cùng biến
 *   `CONTROL_PLANE_DATABASE_URL` (chỉ đọc dòng đăng ký; biến chưa
 *   cấu hình thì phân giải ném `space_routing.not_configured` —
 *   các đường kho chung không qua khung này nên worker vẫn chạy
 *   như cũ khi chưa cấu hình).
 * - Từ issue #582, handle mà các processor/service inject là
 *   handle định tuyến (`routedDatabase`, gắn ở
 *   `worker.module.ts`): ngữ cảnh không mang slug của một trung
 *   tâm đã chuẩn bị ở kho riêng thì handle uỷ thác về handle kho
 *   chung, nên mọi đường chưa qua phiên theo trung tâm chạy đúng
 *   như hiện tại; phiên theo trung tâm cho job được mở qua
 *   `SpaceJobRunner`/`withSpaceDatabase(slug, fn)`.
 * - Chỉ bản worker có `listRegisteredSpaces`: relay outbox quét
 *   thêm outbox của từng trung tâm ở kho riêng theo danh sách
 *   này (issue #582); phía API không có đường quét tương đương
 *   nên không cần hàm này.
 *
 * Kỷ luật pool và GUC giống hệt phía API: pool theo database tạo
 * lười, có trần, đóng khi nhàn rỗi; pool kho riêng cũng là
 * `TenantAwarePool` để chính sách RLS tiếp tục fail-closed theo
 * tenant của ngữ cảnh; không kết nối "siêu quyền" cho đường nền.
 */
@Injectable()
export class SpaceDatabaseService implements OnModuleDestroy {
  private readonly resolver: SpaceConnectionResolver;
  private readonly pools: SpacePoolManager<SpaceDatabase>;
  private readonly poolMax: number;
  private readonly ssl: boolean;
  /** Pool đọc sổ đăng ký ở control plane; null khi worker chưa cấu hình biến kết nối control plane. */
  private readonly registryPool: Pool | null;
  /** Handle Drizzle đọc sổ — dựng trên `registryPool`, không gắn schema (repository đọc bảng trực tiếp). */
  private readonly registryDb: NodePgDatabase | null;
  /** Handle kho chung do `worker.module.ts` gắn vào lúc khởi động; null cho tới khi được gắn. */
  private sharedDatabase: SpaceDatabase | null = null;
  /** Các trung tâm đã chuẩn bị xong: slug → handle + kho của handle (bảng tra đồng bộ cho `routedDatabase`). */
  private readonly prepared = new Map<string, { db: SpaceDatabase; databaseName: string }>();
  /**
   * Các slug mà lần chuẩn bị gần nhất kết luận đang ở chế độ KHO
   * RIÊNG — cùng vai trò với bản phía API: bảng này KHÔNG bị
   * `onPoolClosed` xoá theo mục đã-chuẩn-bị, để `currentDatabase`
   * phân biệt "slug chưa từng chuẩn bị" (được rơi về kho chung
   * theo hợp đồng) với "slug đã chuẩn bị ở kho riêng nhưng mục
   * đã-chuẩn-bị đã bị thu hồi" (phải fail-closed). Mục của một
   * slug bị xoá khi lần chuẩn bị sau kết luận slug đó ở kho chung.
   */
  private readonly dedicatedSlugs = new Set<string>();

  /** Handle định tuyến theo ngữ cảnh ALS — cùng hợp đồng với phía API, xem mô tả lớp. */
  readonly routedDatabase: SpaceDatabase;

  /**
   * Handle Kysely của kho chung cho đường định tuyến Kysely; null
   * cho tới khi được gắn — cùng vai trò với `sharedDatabase` phía
   * Drizzle. Nhà cung cấp kết nối gắn nó bằng cùng pool kho chung
   * nên hai handle chia sẻ ngân sách kết nối của kho chung; instance
   * Kysely này KHÔNG được `destroy()` riêng (huỷ nó sẽ đóng luôn
   * pool chung) — vòng đời của nó đi theo vòng đời pool.
   */
  private sharedKysely: CentreDb | null = null;
  /**
   * Các trung tâm đã chuẩn bị xong phía Kysely — bản song song của
   * bảng `prepared` phía Drizzle, tra bởi `routedKysely` (mỗi
   * facade có pool manager riêng nên vòng đời thu hồi độc lập).
   */
  private readonly preparedKysely = new Map<string, { db: CentreDb; databaseName: string }>();
  /**
   * Trình quản lý pool cho các handle Kysely của kho riêng — cùng
   * kỷ luật với trình quản lý phía Drizzle (tạo lười, trần theo
   * kho, đóng khi nhàn rỗi, thay pool khi danh tính kết nối đổi).
   */
  private readonly kyselyPools: SpacePoolManager<CentreDb>;

  /**
   * Handle định tuyến Kysely theo ngữ cảnh — bản song song của
   * `routedDatabase` cho đường Kysely (issue #639): cùng hợp đồng
   * chuẩn bị-trước và fail-closed như phía API. Ngữ nghĩa uỷ thác
   * qua Proxy được chứng minh bằng spec `routed-kysely` phía
   * worker (transaction, getter `schema`, builder lười).
   */
  readonly routedKysely: CentreDb;

  constructor(config: ConfigService) {
    this.poolMax = config.get<number>('SPACE_DB_POOL_MAX') ?? 5;
    this.ssl = config.get<boolean>('DATABASE_SSL') ?? false;
    const idleTimeoutMs = config.get<number>('SPACE_DB_POOL_IDLE_TIMEOUT_MS') ?? 60_000;
    const registryUrl = config.get<string>('CONTROL_PLANE_DATABASE_URL');
    if (registryUrl) {
      const connection = databaseConnectionFromEnv(registryUrl, this.ssl);
      this.registryPool = new Pool(
        typeof connection === 'string' ? { connectionString: connection } : connection,
      );
      this.registryDb = drizzle({ client: this.registryPool });
    } else {
      this.registryPool = null;
      this.registryDb = null;
    }
    this.resolver = new SpaceConnectionResolver({
      cacheTtlMs: config.get<number>('SPACE_ROUTING_CACHE_TTL_MS') ?? 5_000,
      readRegistry: async (slug) => {
        const db = this.registryDb;
        if (!db) {
          throw new SpaceRoutingError(
            'space_routing.not_configured',
            'Control plane database is not configured',
          );
        }
        const [row] = await db.select().from(spaceRegistry).where(eq(spaceRegistry.slug, slug)).limit(1);
        return row
          ? {
              id: row.id,
              slug: row.slug,
              status: row.status,
              databaseName: row.databaseName,
              storageMode: row.storageMode,
              connectionRoleRef: row.connectionRoleRef,
              secretRef: row.secretRef,
              schemaVersion: row.schemaVersion,
            }
          : undefined;
      },
    });
    this.pools = new SpacePoolManager<SpaceDatabase>({
      idleTimeoutMs,
      // Pool của một kho bị gỡ (đóng vì nhàn rỗi, hoặc bị thay vì
      // sổ đổi danh tính kết nối) thì các trung tâm trỏ vào kho đó
      // cũng hết trạng thái "đã chuẩn bị" — như bản phía API.
      // Đường đồng bộ của `routedDatabase` không chuẩn bị lại
      // được nên với slug đã chuẩn bị ở kho riêng nó fail-closed
      // (xem `dedicatedSlugs` và `currentDatabase`).
      onPoolClosed: (databaseName) => {
        for (const [slug, entry] of [...this.prepared]) {
          if (entry.databaseName === databaseName) this.prepared.delete(slug);
        }
      },
    });
    this.pools.startIdleSweeper(Math.min(30_000, Math.max(1_000, Math.floor(idleTimeoutMs / 2))));
    this.kyselyPools = new SpacePoolManager<CentreDb>({
      idleTimeoutMs,
      // Cùng luật thu hồi với phía Drizzle, nhưng chỉ cho bảng
      // chuẩn bị phía Kysely (xem ghi chú tương ứng phía API).
      onPoolClosed: (databaseName) => {
        for (const [slug, entry] of [...this.preparedKysely]) {
          if (entry.databaseName === databaseName) this.preparedKysely.delete(slug);
        }
      },
    });
    this.kyselyPools.startIdleSweeper(Math.min(30_000, Math.max(1_000, Math.floor(idleTimeoutMs / 2))));
    this.routedDatabase = this.createRoutedHandle(() => this.currentDatabase());
    this.routedKysely = this.createRoutedHandle(() => this.currentKysely());
  }

  /** Gắn handle kho chung — `worker.module.ts` gọi đúng một lần lúc khởi động sau khi dựng pool kho chung. */
  bindSharedDatabase(db: SpaceDatabase): void {
    this.sharedDatabase = db;
  }

  /**
   * Gắn handle Kysely kho chung — `worker.module.ts` gọi đúng một
   * lần lúc khởi động, cùng nhịp với `bindSharedDatabase`, bằng
   * handle dựng trên cùng pool kho chung.
   */
  bindSharedKysely(db: CentreDb): void {
    this.sharedKysely = db;
  }

  /** Phân giải đích kết nối của một trung tâm (không mở pool). */
  async resolveTarget(slug: string): Promise<ResolvedSpaceConnection> {
    return this.resolver.resolve(slug);
  }

  /** Xoá đệm phân giải của một slug (hoặc toàn bộ). */
  invalidate(slug?: string): void {
    this.resolver.invalidate(slug);
  }

  /**
   * Lấy handle Drizzle của một trung tâm theo slug: kho chung thì
   * trả handle kho chung đã gắn; kho riêng thì lấy (hoặc tạo lười)
   * pool của kho đó — nối bằng đúng role của kho, trần kết nối
   * theo cấu hình `SPACE_DB_POOL_MAX`. Pool được lấy THEO DANH
   * TÍNH kết nối vừa phân giải như bản phía API: sổ đã đổi
   * role/bí mật thì pool cũ bị thay bằng pool đúng danh tính hiện
   * hành (xem `SpacePoolManager.getHandleForIdentity`). Chế độ
   * kho của lần chuẩn bị này cũng được ghi vào `dedicatedSlugs`
   * (chỉ khi là kho riêng) cho đường định tuyến đồng bộ.
   */
  async getDatabaseForSpace(slug: string): Promise<SpaceDatabase> {
    const target = await this.resolver.resolve(slug);
    if (target.mode === 'shared') {
      const db = this.requireSharedDatabase();
      this.prepared.set(slug, { db, databaseName: target.databaseName });
      this.dedicatedSlugs.delete(slug);
      return db;
    }
    const connectionString = target.connectionString;
    if (!connectionString) {
      throw new SpaceRoutingError(
        'space_routing.secret_missing',
        `Resolved dedicated target for space ${slug} has no connection string`,
      );
    }
    const handle = this.pools.getHandleForIdentity(target.databaseName, connectionString, (databaseName) => {
      const connection = databaseConnectionFromEnv(connectionString, this.ssl);
      const pool = new TenantAwarePool(
        typeof connection === 'string'
          ? { connectionString: connection, max: this.poolMax }
          : { ...connection, max: this.poolMax },
      );
      return { databaseName, pool, db: drizzle({ client: pool, relations }) };
    });
    this.prepared.set(slug, { db: handle.db, databaseName: target.databaseName });
    this.dedicatedSlugs.add(slug);
    return handle.db;
  }

  /**
   * Mở phiên làm việc theo trung tâm cho một tác vụ nền: chuẩn bị
   * handle của trung tâm rồi chạy `fn` trong ngữ cảnh ALS mang
   * slug của trung tâm (hợp thêm tenant/user của tác vụ nếu
   * truyền; truyền tenant thì ngữ cảnh thôi là đường platform).
   * Scheduler/processor gọi đường này khi job mang định danh trung
   * tâm — từ issue #582 qua `SpaceJobRunner` ở các processor tiêu
   * thụ job outbox, và trực tiếp ở lượt quét outbox theo trung
   * tâm của relay.
   */
  async withSpaceDatabase<T>(
    slug: string,
    fn: (db: SpaceDatabase) => Promise<T>,
    context?: { tenantId?: string; userId?: string },
  ): Promise<T> {
    const db = await this.getDatabaseForSpace(slug);
    const parent = tenantAls.getStore();
    const store: TenantAlsStore = { ...parent, ...context, spaceSlug: slug };
    if (context?.tenantId) store.platform = false;
    // Bọc `fn` trong một hàm async ngay bên trong `run` — cùng lý
    // do với bản phía API: truy vấn Drizzle là thenable, điểm
    // await quyết định ngữ cảnh ALS phải nằm trong `run` thì GUC
    // tenant mới được gắn đúng khi kết nối checkout.
    return tenantAls.run(store, async () => fn(db));
  }

  /**
   * Lấy handle Kysely của một trung tâm theo slug — bước chuẩn bị
   * phía Kysely, song song với `getDatabaseForSpace` (cùng luật:
   * kho chung trả handle Kysely kho chung đã gắn; kho riêng lấy
   * hoặc tạo lười pool Kysely theo đúng danh tính kết nối vừa phân
   * giải; chế độ kho ghi chung vào `dedicatedSlugs` với phía
   * Drizzle).
   *
   * @throws SpaceRoutingError khi slug chưa đăng ký, control plane
   *   chưa cấu hình, hoặc bí mật/role của kho riêng lệch sổ đăng ký.
   */
  async getKyselyForSpace(slug: string): Promise<CentreDb> {
    const target = await this.resolver.resolve(slug);
    if (target.mode === 'shared') {
      const db = this.requireSharedKysely();
      this.preparedKysely.set(slug, { db, databaseName: target.databaseName });
      this.dedicatedSlugs.delete(slug);
      return db;
    }
    const connectionString = target.connectionString;
    if (!connectionString) {
      throw new SpaceRoutingError(
        'space_routing.secret_missing',
        `Resolved dedicated target for space ${slug} has no connection string`,
      );
    }
    const handle = this.kyselyPools.getHandleForIdentity(target.databaseName, connectionString, (databaseName) => {
      const connection = databaseConnectionFromEnv(connectionString, this.ssl);
      const pool = new TenantAwarePool(
        typeof connection === 'string'
          ? { connectionString: connection, max: this.poolMax }
          : { ...connection, max: this.poolMax },
      );
      return { databaseName, pool, db: createCentreKysely(pool) };
    });
    this.preparedKysely.set(slug, { db: handle.db, databaseName: target.databaseName });
    this.dedicatedSlugs.add(slug);
    return handle.db;
  }

  /**
   * Mở phiên làm việc theo trung tâm cho một tác vụ nền phía Kysely
   * — bản song song của `withSpaceDatabase` (chuẩn bị handle
   * Kysely rồi chạy `fn` trong ngữ cảnh ALS mang slug của trung
   * tâm, cùng luật hợp ngữ cảnh tenant/user).
   */
  async withSpaceKysely<T>(
    slug: string,
    fn: (db: CentreDb) => Promise<T>,
    context?: { tenantId?: string; userId?: string },
  ): Promise<T> {
    const db = await this.getKyselyForSpace(slug);
    const parent = tenantAls.getStore();
    const store: TenantAlsStore = { ...parent, ...context, spaceSlug: slug };
    if (context?.tenantId) store.platform = false;
    return tenantAls.run(store, async () => fn(db));
  }

  /**
   * Toàn bộ dòng đăng ký không gian ở dạng bộ phân giải cần — chỉ
   * bản worker có hàm này (xem mô tả lớp): relay outbox dùng để
   * quét thêm outbox của từng trung tâm ở kho riêng ở mỗi nhịp
   * (issue #582). Chưa cấu hình control plane thì trả danh sách
   * rỗng — không có trung tâm nào để quét, các đường kho chung
   * không bị ảnh hưởng.
   */
  async listRegisteredSpaces(): Promise<SpaceRegistryEntry[]> {
    const db = this.registryDb;
    if (!db) return [];
    const rows = await db.select().from(spaceRegistry);
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      status: row.status,
      databaseName: row.databaseName,
      storageMode: row.storageMode,
      connectionRoleRef: row.connectionRoleRef,
      secretRef: row.secretRef,
      schemaVersion: row.schemaVersion,
    }));
  }

  /** Handle kho chung đã gắn; chưa gắn là lỗi lập trình ở đường khởi động. */
  private requireSharedDatabase(): SpaceDatabase {
    if (!this.sharedDatabase) {
      throw new SpaceRoutingError(
        'space_routing.shared_not_bound',
        'Shared database handle is not bound yet',
      );
    }
    return this.sharedDatabase;
  }

  /**
   * Handle hiệu lực cho ngữ cảnh hiện tại — cùng hợp đồng với bản
   * phía API: slug chưa từng chuẩn bị ở kho riêng thì về kho
   * chung; slug đã chuẩn bị ở kho riêng mà mục đã-chuẩn-bị đã bị
   * thu hồi (pool đóng vì nhàn rỗi hoặc bị thay vì đổi danh tính)
   * thì ném `SpaceRoutingError`
   * (`space_routing.prepared_revoked`) — fail-closed, tuyệt đối
   * không rơi im lặng về kho chung; bên gọi chuẩn bị lại qua
   * `getDatabaseForSpace`/`withSpaceDatabase` rồi thử lại.
   */
  private currentDatabase(): SpaceDatabase {
    const slug = tenantAls.getStore()?.spaceSlug;
    if (slug) {
      const preparedEntry = this.prepared.get(slug);
      if (preparedEntry) return preparedEntry.db;
      if (this.dedicatedSlugs.has(slug)) {
        throw new SpaceRoutingError(
          'space_routing.prepared_revoked',
          `Space ${slug} was prepared with a dedicated store but that preparation is no longer active; prepare the space again before routing queries to it`,
        );
      }
    }
    return this.requireSharedDatabase();
  }

  /** Handle Kysely kho chung đã gắn; chưa gắn là lỗi lập trình ở đường khởi động. */
  private requireSharedKysely(): CentreDb {
    if (!this.sharedKysely) {
      throw new SpaceRoutingError(
        'space_routing.shared_not_bound',
        'Shared Kysely database handle is not bound yet',
      );
    }
    return this.sharedKysely;
  }

  /**
   * Handle Kysely hiệu lực cho ngữ cảnh hiện tại — cùng hợp đồng
   * với `currentDatabase`, chỉ khác bảng đã-chuẩn-bị tra tới
   * (slug đã chuẩn bị ở kho riêng mà mục Kysely đã bị thu hồi thì
   * ném `space_routing.prepared_revoked`, fail-closed).
   */
  private currentKysely(): CentreDb {
    const slug = tenantAls.getStore()?.spaceSlug;
    if (slug) {
      const preparedEntry = this.preparedKysely.get(slug);
      if (preparedEntry) return preparedEntry.db;
      if (this.dedicatedSlugs.has(slug)) {
        throw new SpaceRoutingError(
          'space_routing.prepared_revoked',
          `Space ${slug} was prepared with a dedicated store but that preparation is no longer active; prepare the space again before routing queries to it`,
        );
      }
    }
    return this.requireSharedKysely();
  }

  /**
   * Dựng handle định tuyến — cùng cơ chế Proxy uỷ thác theo ngữ
   * cảnh với phía API: mỗi lần đọc thuộc tính đều lấy từ handle
   * hiệu lực của ngữ cảnh TẠI THỜI ĐIỂM ĐÓ và gắn hàm về đúng
   * handle đó (hàm trần không gắn sẽ mất `this` nội bộ của
   * handle). Cả hai facade dùng chung khuôn Proxy này, chỉ khác
   * hàm chọn handle hiệu lực.
   */
  private createRoutedHandle<TDatabase extends object>(current: () => TDatabase): TDatabase {
    return new Proxy({} as TDatabase, {
      get: (_target, property) => {
        const db = current();
        const value = Reflect.get(db as object, property, db);
        return typeof value === 'function' ? value.bind(db) : value;
      },
      has: (_target, property) => property in current(),
      ownKeys: () => Reflect.ownKeys(current()),
      getOwnPropertyDescriptor: (_target, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(current(), property);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    });
  }

  /** Kết thúc vòng đời: ngừng nghe sự kiện đổi sổ, đóng mọi pool kho riêng (cả hai facade) và pool đọc sổ. */
  async onModuleDestroy(): Promise<void> {
    this.resolver.dispose();
    await this.pools.closeAll();
    await this.kyselyPools.closeAll();
    await this.registryPool?.end().catch(() => undefined);
  }
}
