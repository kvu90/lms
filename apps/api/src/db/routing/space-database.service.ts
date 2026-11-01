import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createCentreKysely, type CentreDb } from '@lms/db';
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
 *      và bước CHUẨN BỊ mà tầng gắn ngữ cảnh — `SpaceContextGuard`
 *      cho request, bộ chạy job theo trung tâm cho job nền, issue
 *      #582 — gọi trước khi xử lý request/job của trung tâm đó).
 *   2. `routedDatabase` — handle định tuyến theo ngữ cảnh: handle
 *      được nhà cung cấp kết nối của API trả cho MỌI điểm inject
 *      hiện hữu (xem `app.module.ts`), mỗi lần dùng sẽ uỷ thác sang
 *      handle của trung tâm mà ngữ cảnh ALS hiện tại mang
 *      (`spaceSlug`) nếu trung tâm đó đã được chuẩn bị và đang ở
 *      kho riêng. Hai trường hợp còn lại PHẢI phân biệt: ngữ cảnh
 *      mang một slug CHƯA từng được chuẩn bị thì uỷ thác về handle
 *      kho chung — hành vi như hiện tại, đúng hợp đồng "phiên chỉ
 *      định tuyến được khi bước chuẩn bị đã chạy trước"; nhưng
 *      slug ĐÃ được chuẩn bị ở kho riêng mà trạng thái chuẩn bị bị
 *      khung thu hồi giữa phiên (pool bị đóng vì nhàn rỗi) thì lần
 *      dùng ném `SpaceRoutingError` (fail-closed) thay vì rơi về
 *      kho chung — bên gọi đã làm đúng nghĩa vụ chuẩn bị, khung
 *      không được im lặng đổi đích dữ kiện của nó sang kho khác.
 *      Nhờ cơ chế này các điểm inject không phải sửa từng điểm
 *      gọi, và ngữ cảnh nào không do tầng gắn ngữ cảnh của issue
 *      #582 nạp `spaceSlug` thì toàn hệ chạy đúng đường kho chung
 *      như trước.
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
 *
 * Đường Kysely (issue #639) là bản song song của ba đường trên,
 * cùng hợp đồng từng điểm: `getKyselyForSpace(slug)` (bước chuẩn
 * bị phía Kysely), `routedKysely` (facade định tuyến qua Proxy),
 * `withSpaceKysely(slug, fn)` (phiên theo trung tâm phía Kysely).
 * Hai facade giữ bảng đã-chuẩn-bị và trình quản lý pool riêng,
 * nhưng chia sẻ bảng `dedicatedSlugs` (một slug chỉ có một chế độ
 * kho thật) — pool Kysely đóng thì chỉ thu hồi trạng thái
 * đã-chuẩn-bị phía Kysely, không động tới handle Drizzle.
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
  /**
   * Các slug mà lần chuẩn bị gần nhất kết luận đang ở chế độ KHO
   * RIÊNG. Bảng này KHÔNG bị `onPoolClosed` xoá theo mục
   * đã-chuẩn-bị: nó là trí nhớ tối thiểu để `currentDatabase`
   * phân biệt "slug chưa từng chuẩn bị" (được rơi về kho chung
   * theo hợp đồng) với "slug đã chuẩn bị ở kho riêng nhưng mục
   * đã-chuẩn-bị đã bị thu hồi" (phải fail-closed) — hai tình huống
   * trông giống hệt nhau nếu chỉ nhìn bảng `prepared`. Mục của
   * một slug bị xoá khi lần chuẩn bị sau kết luận slug đó ở kho
   * chung.
   */
  private readonly dedicatedSlugs = new Set<string>();
  /**
   * Tên database kho riêng đã phân giải gần nhất theo slug — trí
   * nhớ tối thiểu đi cùng `dedicatedSlugs`: mục đã-chuẩn-bị bị
   * thu hồi khi pool đóng, nhưng danh tính kho của một trung tâm
   * đã phân giải kho riêng phải còn tra được (xem
   * `currentContextDatabaseName`) để tầng phía trên gắn đúng
   * danh tính kho cho dữ kiện chỉ có nghĩa trong một kho, thay
   * vì rơi về danh tính kho chung trong cửa sổ
   * đã-chuẩn-bị-bị-thu-hồi. Mục của một slug bị xoá khi lần
   * chuẩn bị sau kết luận slug đó ở kho chung — cùng nhịp với
   * `dedicatedSlugs`.
   */
  private readonly dedicatedDatabaseNames = new Map<string, string>();

  /** Handle định tuyến theo ngữ cảnh — xem mô tả lớp. Tạo một lần, uỷ thác theo ngữ cảnh tại mỗi lần dùng. */
  readonly routedDatabase: Database;

  /**
   * Handle Kysely của kho chung cho đường định tuyến Kysely; null
   * cho tới khi được gắn — cùng vai trò với `sharedDatabase` phía
   * Drizzle. Nhà cung cấp kết nối gắn nó bằng cùng pool kho chung
   * (pool `TenantAwarePool` đã dùng cho handle Drizzle) nên hai
   * handle chia sẻ ngân sách kết nối của kho chung; instance
   * Kysely này KHÔNG được `destroy()` riêng (huỷ nó sẽ đóng luôn
   * pool chung) — vòng đời của nó đi theo vòng đời pool.
   */
  private sharedKysely: CentreDb | null = null;
  /**
   * Các trung tâm đã chuẩn bị xong phía Kysely: slug → handle +
   * kho của handle — bản song song của bảng `prepared` phía
   * Drizzle, tra bởi `routedKysely`. Hai bảng chuẩn bị độc lập vì
   * mỗi facade có pool manager riêng (xem `kyselyPools`): pool
   * Kysely của một kho đóng không thu hồi trạng thái đã-chuẩn-bị
   * của handle Drizzle và ngược lại — mỗi facade fail-closed theo
   * vòng đời pool của chính nó.
   */
  private readonly preparedKysely = new Map<string, { db: CentreDb; databaseName: string }>();
  /**
   * Trình quản lý pool cho các handle Kysely của kho riêng — cùng
   * kỷ luật với trình quản lý phía Drizzle (tạo lười, trần theo
   * kho, đóng khi nhàn rỗi, thay pool khi danh tính kết nối đổi):
   * một kho riêng giữ một pool Kysely riêng trong thời gian cùng
   * tồn tại hai ORM, để mỗi facade tự quản vòng đời pool của nó.
   */
  private readonly kyselyPools: SpacePoolManager<CentreDb>;

  /**
   * Handle định tuyến Kysely theo ngữ cảnh — bản song song của
   * `routedDatabase` cho đường Kysely (issue #639): cùng hợp
   * đồng chuẩn bị-trước và fail-closed (ngữ cảnh mang slug chưa
   * từng chuẩn bị thì về kho chung; slug đã chuẩn bị ở kho riêng
   * mà mục đã-chuẩn-bị đã bị thu hồi thì ném
   * `SpaceRoutingError`, không rơi im lặng về kho chung). Ngữ
   * nghĩa uỷ thác qua Proxy của facade này được chứng minh bằng
   * spec `routed-kysely` (transaction, getter `schema`, builder
   * lười) trên cả api và worker trước khi pilot xây trên nó.
   */
  readonly routedKysely: CentreDb;

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
    this.pools = new SpacePoolManager<Database>({
      idleTimeoutMs,
      // Pool của một kho bị gỡ (đóng vì nhàn rỗi, hoặc bị thay vì
      // sổ đổi danh tính kết nối) thì các trung tâm trỏ vào kho đó
      // cũng hết trạng thái "đã chuẩn bị": handle của pool đã chết
      // không còn được dùng. Việc chuẩn bị lại diễn ra ở lần gọi
      // `getDatabaseForSpace`/`withSpaceDatabase` kế tiếp; riêng
      // đường ĐỒNG BỘ của `routedDatabase` không chuẩn bị lại
      // được, nên với slug đã chuẩn bị ở kho riêng nó fail-closed
      // (xem `dedicatedSlugs` và `currentDatabase`) thay vì chạm
      // vào handle đã chết hoặc rơi về kho chung.
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
    this.kyselyPools = new SpacePoolManager<CentreDb>({
      idleTimeoutMs,
      // Cùng luật thu hồi với phía Drizzle, nhưng chỉ cho bảng
      // chuẩn bị phía Kysely: pool Kysely đóng thì mục
      // đã-chuẩn-bị Kysely của kho đó hết hiệu lực (lần dùng
      // `routedKysely` sau đó fail-closed theo `dedicatedSlugs`
      // dùng chung), còn bảng `prepared` phía Drizzle không bị
      // động tới.
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

  /**
   * Gắn handle kho chung — nhà cung cấp kết nối của API gọi đúng
   * một lần lúc khởi động, sau khi dựng xong pool kho chung như
   * đường hiện hành. Mọi đích `shared` và mọi ngữ cảnh chưa chuẩn
   * bị trung tâm riêng đều uỷ thác về handle này.
   */
  bindSharedDatabase(db: Database): void {
    this.sharedDatabase = db;
  }

  /**
   * Gắn handle Kysely kho chung — nhà cung cấp kết nối của API gọi
   * đúng một lần lúc khởi động, cùng nhịp với
   * `bindSharedDatabase`, bằng handle dựng trên cùng pool kho
   * chung. Mọi đích `shared` và mọi ngữ cảnh chưa chuẩn bị trung
   * tâm riêng đều uỷ thác về handle này qua `routedKysely`.
   */
  bindSharedKysely(db: CentreDb): void {
    this.sharedKysely = db;
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
   *   kết nối theo cấu hình `SPACE_DB_POOL_MAX`. Pool được lấy
   *   THEO DANH TÍNH kết nối vừa phân giải: nếu sổ đã đổi
   *   role/bí mật kể từ khi pool được tạo, trình quản lý pool thay
   *   pool cũ bằng pool mới đúng danh tính hiện hành (xem
   *   `SpacePoolManager.getHandleForIdentity`) — handle trả về
   *   luôn kết nối bằng danh tính sổ chốt ở lần chuẩn bị này.
   * Kết quả được ghi vào bảng đã-chuẩn-bị để `routedDatabase` tra
   * đồng bộ khi ngữ cảnh mang slug này; chế độ kho của lần chuẩn
   * bị này cũng được ghi vào `dedicatedSlugs` (chỉ khi là kho
   * riêng) để đường đồng bộ phân biệt được ca đã-chuẩn-bị-bị-thu
   * hồi với ca chưa từng chuẩn bị.
   *
   * @throws SpaceRoutingError khi slug chưa đăng ký, control plane
   *   chưa cấu hình, hoặc bí mật/role của kho riêng lệch sổ đăng ký.
   */
  /**
   * Trung tâm đã có handle chuẩn bị trong tiến trình này chưa.
   * Đường đọc nhận diện công khai (issue #583) dùng để quyết định
   * có cần chạm control plane không: khi đã chuẩn bị, handle trong
   * bảng đã-chuẩn-bị đủ để đọc kho của trung tâm mà không phân giải
   * lại — nên bề mặt trung tâm vẫn hiển thị đúng nhận diện ngay cả
   * khi control plane ngừng hoạt động sau khi định tuyến đã xong.
   * Khi chưa chuẩn bị (hoặc mục đã-chuẩn-bị đã bị thu hồi), bên
   * gọi phải chuẩn bị qua `getDatabaseForSpace` trước — đọc thẳng
   * qua `routedDatabase` khi chưa chuẩn bị sẽ rơi về kho chung.
   */
  isSpacePrepared(slug: string): boolean {
    return this.prepared.has(slug);
  }

  /**
   * Tên database của kho mà handle định tuyến sẽ phục vụ cho
   * ngữ cảnh ALS hiện tại — bản tra ĐỒNG BỘ lấy cùng quyết định
   * đích với `currentDatabase`, dành cho các tầng cần gắn danh
   * tính kho cho dữ kiện chỉ có nghĩa trong đúng một kho (điển
   * hình: khoá cache của cấu hình `siteadmins` ở
   * PermissionEvaluator, issue #587 TĐ6 — giá trị là id người
   * dùng của một kho, đọc nhầm danh tính kho là áp danh sách
   * admin của kho này cho ngữ cảnh của kho khác):
   * - Ngữ cảnh không mang slug, hoặc slug chưa từng được chuẩn
   *   bị ở kho riêng (kể cả slug chưa chuẩn bị lần nào): trả
   *   `undefined` — handle định tuyến đang phục vụ bằng kho
   *   chung theo hợp đồng chuẩn bị-trước, bên gọi dùng danh
   *   tính kho chung của chính nó.
   * - Slug đã phân giải kho riêng: trả tên database trong sổ
   *   đăng ký mà lần chuẩn bị gần nhất đã chốt cho slug đó —
   *   kể cả khi mục đã-chuẩn-bị đã bị thu hồi vì pool đóng:
   *   lượt đọc qua handle lúc đó fail-closed ở
   *   `currentDatabase`, nhưng danh tính kho của ngữ cảnh vẫn
   *   là kho riêng đó, tuyệt đối không rơi về kho chung.
   *
   * @returns Tên database kho riêng của ngữ cảnh, hoặc
   *   `undefined` khi ngữ cảnh đang được phục vụ bằng kho chung.
   */
  currentContextDatabaseName(): string | undefined {
    const slug = tenantAls.getStore()?.spaceSlug;
    if (!slug || !this.dedicatedSlugs.has(slug)) return undefined;
    return this.dedicatedDatabaseNames.get(slug);
  }

  async getDatabaseForSpace(slug: string): Promise<Database> {
    const target = await this.resolver.resolve(slug);
    if (target.mode === 'shared') {
      const db = this.requireSharedDatabase();
      this.prepared.set(slug, { db, databaseName: target.databaseName });
      this.dedicatedSlugs.delete(slug);
      this.dedicatedDatabaseNames.delete(slug);
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
    this.dedicatedDatabaseNames.set(slug, target.databaseName);
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
    // viết theo kiểu nào. Hợp đồng này là của riêng khung: một
    // callback trả thẳng thenable KHÔNG được `run` bảo vệ nếu
    // không có lớp bọc async như ở đây, nên mọi điểm gọi
    // `tenantAls.run` khác phải tự truyền callback async — khung
    // không khẳng định mọi điểm gọi trong codebase đều đã tuân
    // thủ điều đó.
    return tenantAls.run(store, async () => fn(db));
  }

  /**
   * Lấy handle Kysely của một trung tâm theo slug — bước chuẩn bị
   * phía Kysely, song song với `getDatabaseForSpace`:
   * - Trung tâm ở kho chung: trả chính handle Kysely kho chung đã
   *   gắn (qua `bindSharedKysely`).
   * - Trung tâm ở kho riêng: lấy (hoặc tạo lười) pool Kysely của
   *   kho đó từ trình quản lý pool riêng phía Kysely — pool nối
   *   bằng đúng role của kho, trần kết nối theo cấu hình
   *   `SPACE_DB_POOL_MAX`, lấy THEO DANH TÍNH kết nối vừa phân
   *   giải như phía Drizzle (sổ đổi role/bí mật thì pool cũ bị
   *   thay bằng pool mới đúng danh tính hiện hành).
   * Kết quả ghi vào bảng đã-chuẩn-bị phía Kysely để
   * `routedKysely` tra đồng bộ; chế độ kho ghi chung vào
   * `dedicatedSlugs`/`dedicatedDatabaseNames` với phía Drizzle
   * (một slug chỉ có một chế độ kho thật, dù đi bằng facade nào).
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
      this.dedicatedDatabaseNames.delete(slug);
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
    this.dedicatedDatabaseNames.set(slug, target.databaseName);
    return handle.db;
  }

  /**
   * Mở phiên làm việc theo trung tâm cho tác vụ nền phía Kysely —
   * bản song song của `withSpaceDatabase`: chuẩn bị handle Kysely
   * của trung tâm rồi chạy `fn` trong ngữ cảnh ALS mang slug của
   * trung tâm (cùng luật hợp ngữ cảnh tenant/user và cùng lớp bọc
   * async giữ ngữ cảnh cho callback trả thẳng thenable).
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

  /**
   * Handle hiệu lực cho ngữ cảnh hiện tại:
   * - Ngữ cảnh không mang slug, hoặc slug CHƯA từng được chuẩn bị
   *   ở kho riêng (kể cả slug chưa chuẩn bị lần nào): handle kho
   *   chung — hợp đồng "phiên chỉ định tuyến được khi bước chuẩn
   *   bị đã chạy trước cho slug đó".
   * - Slug đã chuẩn bị và mục đã-chuẩn-bị còn: handle của kho
   *   riêng.
   * - Slug ĐÃ được chuẩn bị ở kho riêng nhưng mục đã-chuẩn-bị đã
   *   bị thu hồi (pool bị đóng vì nhàn rỗi hoặc bị thay vì đổi
   *   danh tính): ném `SpaceRoutingError`
   *   (`space_routing.prepared_revoked`) — fail-closed. Đường này
   *   là đường ĐỒNG BỘ của một lần truy vấn, không thể chuẩn bị
   *   lại tại đây; rơi về kho chung ở ca này là đổi đích dữ kiện
   *   im lặng (kể cả với lệnh ghi) trong khi bên gọi đã làm đúng
   *   nghĩa vụ chuẩn bị — tuyệt đối không được phép. Bên gọi xử
   *   lý bằng cách chuẩn bị lại qua `getDatabaseForSpace`/
   *   `withSpaceDatabase` rồi thử lại.
   */
  private currentDatabase(): Database {
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

  /** Handle Kysely kho chung đã gắn; chưa gắn là lỗi lập trình ở đường khởi động, ném rõ thay vì trả handle rỗng. */
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
   * với `currentDatabase`, chỉ khác bảng đã-chuẩn-bị tra tới:
   * slug chưa từng chuẩn bị ở kho riêng thì về kho chung; slug đã
   * chuẩn bị ở kho riêng mà mục đã-chuẩn-bị Kysely đã bị thu hồi
   * thì ném `space_routing.prepared_revoked` (fail-closed).
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
   * Dựng handle định tuyến: một Proxy không giữ handle thật nào —
   * mỗi lần đọc thuộc tính (kể cả các hàm như `select`/`transaction`
   * và các trường như `query`/`schema`) đều lấy từ handle hiệu lực
   * của ngữ cảnh TẠI THỜI ĐIỂM ĐÓ và gắn hàm về đúng handle đó.
   * Điểm inject giữ một tham chiếu duy nhất suốt vòng đời tiến
   * trình mà vẫn đổi đích theo ngữ cảnh — đó là cơ chế để không
   * phải sửa từng điểm gọi. Cả hai facade (Drizzle và Kysely) dùng
   * chung khuôn Proxy này, chỉ khác hàm chọn handle hiệu lực.
   *
   * Vì sao `get` phải gắn hàm về đúng handle (`value.bind(db)`):
   * các phương thức của handle Kysely/Drizzle đọc trạng thái nội bộ
   * qua `this` (executor, dialect) — trả hàm trần mà không gắn sẽ
   * làm `this` trỏ về Proxy rỗng và mọi truy vấn gãy. Getter
   * (`schema` của Kysely) đi qua cùng đường `get` nên cũng được
   * lấy từ handle hiệu lực tại mỗi lần đọc, không bị đóng băng từ
   * lần đọc đầu.
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

  /** Kết thúc vòng đời: ngừng nghe sự kiện đổi sổ và đóng mọi pool kho riêng đang sống (cả hai facade). */
  async onModuleDestroy(): Promise<void> {
    this.resolver.dispose();
    await this.pools.closeAll();
    await this.kyselyPools.closeAll();
  }
}
