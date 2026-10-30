import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { spaceRegistry } from '@lms/db/control-plane';
import { databaseConnectionFromEnv } from '../../config/env';
import { ControlPlaneConnection } from '../../modules/control-plane/control-plane.connection';
import { tenantAls, type TenantAlsStore } from '../../modules/tenants/tenant-als';
import type { Database } from '../database';
import { relations } from '../relations';
import { TenantAwarePool } from '../tenant-pool';
import {
  SpaceConnectionResolver,
  SpaceRoutingError,
  type ResolvedSpaceConnection,
} from './space-connection-resolver';
import { SpacePoolManager } from './space-pool-manager';

/**
 * Khung định tuyến kết nối theo trung tâm ở tầng dữ kiện (issue
 * #581) — điểm vào duy nhất để mọi đường dữ kiện lấy đúng kết nối
 * theo trung tâm.
 *
 * Ba thành phần hợp lại ở đây:
 * - `SpaceConnectionResolver`: đọc sổ đăng ký ở control plane (có
 *   đệm + vô hiệu hoá theo sự kiện đổi sổ), quyết định đích — kho
 *   chung hay kho riêng — và chốt chuỗi kết nối bằng đúng role của
 *   kho đích.
 * - `SpacePoolManager`: pool theo database, tạo lười, có trần, đóng
 *   khi nhàn rỗi — kỷ luật ngân sách kết nối của cụm.
 * - Service này: biến đích đã phân giải thành handle Drizzle, và
 *   phơi ba đường dùng:
 *   1. `getDatabaseForSpace(slug)` — lấy handle của một trung tâm
 *      theo định danh tường minh (đường vận hành, đường kiểm chứng,
 *      và bước CHUẨN BỊ mà tầng gắn ngữ cảnh của issue kế tiếp gọi
 *      trước khi xử lý request/job của trung tâm đó).
 *   2. `routedDatabase` — handle định tuyến theo ngữ cảnh: handle
 *      được nhà cung cấp kết nối của API trả cho MỌI điểm inject
 *      hiện hữu (xem `app.module.ts`), mỗi lần dùng sẽ uỷ thác sang
 *      handle của trung tâm mà ngữ cảnh ALS hiện tại mang
 *      (`spaceSlug`) nếu trung tâm đó đã được chuẩn bị và đang ở
 *      kho riêng; mọi trường hợp còn lại uỷ thác về handle kho
 *      chung — hành vi như hiện tại. Nhờ vậy các điểm inject không
 *      phải sửa từng điểm gọi, và chừng nào chưa có đường nào nạp
 *      `spaceSlug` vào ngữ cảnh (việc của issue kế tiếp) thì toàn
 *      hệ chạy đúng đường kho chung như trước.
 *   3. `withSpaceDatabase(slug, fn)` — đường mở kết nối theo trung
 *      tâm cho tác vụ nền: chuẩn bị handle của trung tâm, rồi chạy
 *      `fn` trong ngữ cảnh ALS mang slug của trung tâm đó (kèm
 *      tenant/user nếu tác vụ truyền), để mọi kết nối checkout
 *      trong `fn` — qua handle được truyền hoặc qua
 *      `routedDatabase` — đều thuộc về đúng kho của trung tâm.
 *
 * GUC tenant trong kho riêng: pool của kho riêng cũng là
 * `TenantAwarePool` như pool kho chung — cơ chế gắn GUC
 * `app.tenant_id`/`app.platform` theo ngữ cảnh ALS giữ nguyên,
 * chính sách RLS trong kho của trung tâm tiếp tục fail-closed theo
 * tenant của ngữ cảnh, không có kết nối "siêu quyền" nào được tạo
 * cho đường nghiệp vụ.
 */
@Injectable()
export class SpaceDatabaseService implements OnModuleDestroy {
  private readonly resolver: SpaceConnectionResolver;
  private readonly pools: SpacePoolManager<Database>;
  private readonly poolMax: number;
  private readonly ssl: boolean;
  /** Handle kho chung do nhà cung cấp kết nối của API gắn vào lúc khởi động; null cho tới khi được gắn. */
  private sharedDatabase: Database | null = null;
  /**
   * Các trung tâm đã chuẩn bị xong: slug → handle + kho của handle.
   * Đây là bảng tra ĐỒNG BỘ mà `routedDatabase` dùng tại thời điểm
   * mỗi lần gọi — phân giải (đọc sổ, mở pool) là thao tác bất đồng
   * bộ nên phải xong từ bước chuẩn bị, không thể chen vào đường
   * đồng bộ của một lần truy vấn.
   */
  private readonly prepared = new Map<string, { db: Database; databaseName: string }>();

  /** Handle định tuyến theo ngữ cảnh — xem mô tả lớp. Tạo một lần, uỷ thác theo ngữ cảnh tại mỗi lần dùng. */
  readonly routedDatabase: Database;

  constructor(config: ConfigService, controlPlane: ControlPlaneConnection) {
    this.poolMax = config.get<number>('SPACE_DB_POOL_MAX') ?? 5;
    this.ssl = config.get<boolean>('DATABASE_SSL') ?? false;
    const idleTimeoutMs = config.get<number>('SPACE_DB_POOL_IDLE_TIMEOUT_MS') ?? 60_000;
    this.resolver = new SpaceConnectionResolver({
      cacheTtlMs: config.get<number>('SPACE_ROUTING_CACHE_TTL_MS') ?? 5_000,
      readRegistry: async (slug) => {
        const db = controlPlane.db;
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
    this.pools = new SpacePoolManager<Database>({
      idleTimeoutMs,
      // Pool của một kho bị đóng vì nhàn rỗi thì các trung tâm trỏ
      // vào kho đó cũng hết trạng thái "đã chuẩn bị": lần dùng sau
      // phải chuẩn bị lại thay vì chạm vào handle của pool đã chết.
      onPoolClosed: (databaseName) => {
        for (const [slug, entry] of [...this.prepared]) {
          if (entry.databaseName === databaseName) this.prepared.delete(slug);
        }
      },
    });
    // Vòng quét đóng pool nhàn rỗi: chu kỳ bằng nửa ngưỡng nhàn rỗi
    // (kẹp trong [1 giây, 30 giây]) để độ trễ đóng pool không vượt
    // quá một ngưỡng rưỡi.
    this.pools.startIdleSweeper(Math.min(30_000, Math.max(1_000, Math.floor(idleTimeoutMs / 2))));
    this.routedDatabase = this.createRoutedDatabase();
  }

  /**
   * Gắn handle kho chung — nhà cung cấp kết nối của API gọi đúng
   * một lần lúc khởi động, sau khi dựng xong pool kho chung như
   * đường hiện hành. Mọi đích `shared` và mọi ngữ cảnh chưa chuẩn
   * bị trung tâm riêng đều uỷ thác về handle này.
   */
  bindSharedDatabase(db: Database): void {
    this.sharedDatabase = db;
  }

  /** Phân giải đích kết nối của một trung tâm (không mở pool) — tầng gắn ngữ cảnh dùng để xét trạng thái/chế độ kho. */
  async resolveTarget(slug: string): Promise<ResolvedSpaceConnection> {
    return this.resolver.resolve(slug);
  }

  /** Xoá đệm phân giải của một slug (hoặc toàn bộ) — đường vận hành khi sổ vừa đổi ngoài kênh sự kiện. */
  invalidate(slug?: string): void {
    this.resolver.invalidate(slug);
  }

  /**
   * Lấy handle Drizzle của một trung tâm theo slug — bước chuẩn bị
   * của mọi đường định tuyến:
   * - Trung tâm ở kho chung: trả chính handle kho chung đã gắn.
   * - Trung tâm ở kho riêng: lấy (hoặc tạo lười) pool của kho đó từ
   *   trình quản lý pool — pool nối bằng đúng role của kho, trần
   *   kết nối theo cấu hình `SPACE_DB_POOL_MAX`.
   * Kết quả được ghi vào bảng đã-chuẩn-bị để `routedDatabase` tra
   * đồng bộ khi ngữ cảnh mang slug này.
   *
   * @throws SpaceRoutingError khi slug chưa đăng ký, control plane
   *   chưa cấu hình, hoặc bí mật/role của kho riêng lệch sổ đăng ký.
   */
  async getDatabaseForSpace(slug: string): Promise<Database> {
    const target = await this.resolver.resolve(slug);
    if (target.mode === 'shared') {
      const db = this.requireSharedDatabase();
      this.prepared.set(slug, { db, databaseName: target.databaseName });
      return db;
    }
    const connectionString = target.connectionString;
    if (!connectionString) {
      // Bộ phân giải luôn cấp chuỗi kết nối cho đích kho riêng; tới
      // được đây là lỗi nội bộ của khung, không phải lỗi cấu hình.
      throw new SpaceRoutingError(
        'space_routing.secret_missing',
        `Resolved dedicated target for space ${slug} has no connection string`,
      );
    }
    const handle = this.pools.getHandle(target.databaseName, (databaseName) => {
      const connection = databaseConnectionFromEnv(connectionString, this.ssl);
      const pool = new TenantAwarePool(
        typeof connection === 'string'
          ? { connectionString: connection, max: this.poolMax }
          : { ...connection, max: this.poolMax },
      );
      return { databaseName, pool, db: drizzle({ client: pool, relations }) };
    });
    this.prepared.set(slug, { db: handle.db, databaseName: target.databaseName });
    return handle.db;
  }

  /**
   * Mở phiên làm việc theo trung tâm cho tác vụ nền: chuẩn bị
   * handle của trung tâm rồi chạy `fn` trong ngữ cảnh ALS mang
   * slug của trung tâm. `context.tenantId`/`context.userId` của tác
   * vụ được hợp vào ngữ cảnh (truyền tenant thì ngữ cảnh thôi là
   * đường platform — GUC tenant của kho đích phải theo tenant của
   * tác vụ); không truyền thì giữ nguyên các trường đó của ngữ
   * cảnh cha.
   */
  async withSpaceDatabase<T>(
    slug: string,
    fn: (db: Database) => Promise<T>,
    context?: { tenantId?: string; userId?: string },
  ): Promise<T> {
    const db = await this.getDatabaseForSpace(slug);
    const parent = tenantAls.getStore();
    const store: TenantAlsStore = { ...parent, ...context, spaceSlug: slug };
    if (context?.tenantId) store.platform = false;
    // Bọc `fn` trong một hàm async ngay bên trong `run`: truy vấn
    // Drizzle là thenable — việc thực thi chỉ bắt đầu tại điểm
    // await, nên nếu `fn` trả thẳng một truy vấn (không tự là
    // async) thì điểm await quyết định ngữ cảnh ALS phải nằm
    // trong `run`, nếu không kết nối được checkout ngoài ngữ cảnh
    // và GUC tenant bị gắn rỗng (fail-closed thành "không thấy dữ
    // kiện"). Lớp bọc này giữ ngữ cảnh cho phiên bất kể `fn` được
    // viết theo kiểu nào — cùng lý do mọi điểm dùng `tenantAls.run`
    // trong codebase đều truyền callback async.
    return tenantAls.run(store, async () => fn(db));
  }

  /** Handle kho chung đã gắn; chưa gắn là lỗi lập trình ở đường khởi động, ném rõ thay vì trả handle rỗng. */
  private requireSharedDatabase(): Database {
    if (!this.sharedDatabase) {
      throw new SpaceRoutingError(
        'space_routing.shared_not_bound',
        'Shared database handle is not bound yet',
      );
    }
    return this.sharedDatabase;
  }

  /** Handle hiệu lực cho ngữ cảnh hiện tại: trung tâm đã chuẩn bị ở kho riêng, hoặc kho chung cho mọi trường hợp còn lại. */
  private currentDatabase(): Database {
    const slug = tenantAls.getStore()?.spaceSlug;
    if (slug) {
      const preparedEntry = this.prepared.get(slug);
      if (preparedEntry) return preparedEntry.db;
    }
    return this.requireSharedDatabase();
  }

  /**
   * Dựng handle định tuyến: một Proxy không giữ handle thật nào —
   * mỗi lần đọc thuộc tính (kể cả các hàm như `select`/`transaction`
   * và các trường như `query`) đều lấy từ handle hiệu lực của ngữ
   * cảnh TẠI THỜI ĐIỂM ĐÓ và gắn hàm về đúng handle đó. Điểm inject
   * giữ một tham chiếu duy nhất suốt vòng đời tiến trình mà vẫn đổi
   * đích theo ngữ cảnh — đó là cơ chế để không phải sửa từng điểm
   * gọi.
   */
  private createRoutedDatabase(): Database {
    const current = () => this.currentDatabase();
    return new Proxy({} as Database, {
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

  /** Kết thúc vòng đời: ngừng nghe sự kiện đổi sổ và đóng mọi pool kho riêng đang sống. */
  async onModuleDestroy(): Promise<void> {
    this.resolver.dispose();
    await this.pools.closeAll();
  }
}
