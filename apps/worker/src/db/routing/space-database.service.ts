import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { spaceRegistry } from '@lms/db/control-plane';
import { databaseConnectionFromEnv } from '../../config/env';
import { tenantAls, type TenantAlsStore } from '../tenant-als';
import { relations } from '../relations';
import { TenantAwarePool } from '../tenant-pool';
import {
  SpaceConnectionResolver,
  SpaceRoutingError,
  type ResolvedSpaceConnection,
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
 * Hai điểm khác bản API, đều do hình của tiến trình worker:
 * - Worker chưa có kết nối control plane dùng chung, nên service
 *   tự giữ MỘT pool đọc sổ riêng từ cùng biến
 *   `CONTROL_PLANE_DATABASE_URL` (chỉ đọc dòng đăng ký; biến chưa
 *   cấu hình thì phân giải ném `space_routing.not_configured` —
 *   các đường kho chung không qua khung này nên worker vẫn chạy
 *   như cũ khi chưa cấu hình).
 * - Worker không thay handle mà các processor/service hiện hữu
 *   inject (chúng giữ handle kho chung như hiện tại); khung ở đây
 *   phơi đường mở phiên theo trung tâm cho tác vụ nền:
 *   `withSpaceDatabase(slug, fn)` chuẩn bị handle của đúng kho của
 *   trung tâm và chạy `fn` trong ngữ cảnh ALS mang slug đó. Việc
 *   áp khung vào từng job cụ thể thuộc issue kế tiếp.
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
    this.routedDatabase = this.createRoutedDatabase();
  }

  /** Gắn handle kho chung — `worker.module.ts` gọi đúng một lần lúc khởi động sau khi dựng pool kho chung. */
  bindSharedDatabase(db: SpaceDatabase): void {
    this.sharedDatabase = db;
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
   * tâm — việc áp vào từng job cụ thể thuộc issue kế tiếp.
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

  /** Dựng handle định tuyến — cùng cơ chế Proxy uỷ thác theo ngữ cảnh với phía API. */
  private createRoutedDatabase(): SpaceDatabase {
    const current = () => this.currentDatabase();
    return new Proxy({} as SpaceDatabase, {
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

  /** Kết thúc vòng đời: ngừng nghe sự kiện đổi sổ, đóng mọi pool kho riêng và pool đọc sổ. */
  async onModuleDestroy(): Promise<void> {
    this.resolver.dispose();
    await this.pools.closeAll();
    await this.registryPool?.end().catch(() => undefined);
  }
}
