import { onSpaceRegistryChanged } from './space-routing-events';

/**
 * Bộ phân giải đích kết nối theo trung tâm (issue #581) — thành phần
 * đầu tiên của khung định tuyến ở tầng dữ kiện.
 *
 * BẢN SAO của `apps/api/src/db/routing/space-connection-resolver.ts`
 * theo tiền lệ repo (mỗi app giữ bản sao hạ tầng riêng — cùng khuôn
 * với `tenant-als`/`tenant-pool`): sửa file này PHẢI sửa đồng bộ bản
 * gốc phía API và ngược lại, để hai tiến trình phân giải đích theo
 * đúng một luật từ cùng một sổ đăng ký.
 *
 * Luồng phân giải cho một slug không gian:
 * 1. Tra bộ nhớ đệm trong tiến trình: mục đệm còn hạn (TTL ngắn cấu
 *    hình được) thì trả ngay, không chạm database control plane.
 * 2. Hết hạn hoặc chưa có: đọc dòng đăng ký của không gian từ sổ
 *    đăng ký ở control plane — nguồn sự thật DUY NHẤT cho việc một
 *    trung tâm đang dùng database nào (quyết định đã ghi trong issue
 *    #581). Không có dòng đăng ký → lỗi `space_not_found`: định
 *    tuyến fail-closed, tuyệt đối không đoán đích.
 * 3. Từ dòng đăng ký, quyết định đích theo `storageMode`:
 *    - `shared`: trung tâm chưa di trú — đích là kho chung hiện tại,
 *      bộ phân giải chỉ xác nhận chế độ, kết nối thật do tầng gọi
 *      giữ như đường hiện hành.
 *    - `dedicated`: trung tâm đã có kho riêng — đích là database
 *      mang tên `databaseName` trong sổ, kết nối bằng ĐÚNG role của
 *      kho đó. Chuỗi kết nối gốc lấy từ tham chiếu bí mật
 *      (`secretRef`, dạng `env:<TÊN_BIẾN>`) — sổ chỉ giữ tham chiếu,
 *      giá trị bí mật không bao giờ nằm trong database; tên database
 *      trong chuỗi gốc bị thay bằng `databaseName` của sổ vì sổ là
 *      nguồn sự thật cho đích, và role trong chuỗi gốc bắt buộc
 *      khớp `connectionRoleRef` của sổ — lệch là lỗi cấu hình
 *      (`role_mismatch`), không mở kết nối bằng một role khác sổ
 *      đã đăng ký.
 * 4. Kết quả được đệm lại kèm hạn TTL. Đệm bị vô hiệu hoá theo hai
 *    đường: sự kiện đổi sổ (trạng thái/phiên bản/cấu hình định
 *    tuyến của chính slug đó — xem `space-routing-events.ts`) và
 *    hết TTL.
 *
 * Trạng thái vòng đời (`suspended`/`closed`) KHÔNG chặn phân giải:
 * đích vẫn phải phân giải được để đường vận hành (xuất dữ kiện,
 * khôi phục, kiểm đếm) còn vào được kho của trung tâm đã ngưng;
 * việc từ chối traffic NGHIỆP VỤ theo trạng thái là luật của tầng
 * ứng dụng phía trên, kết quả phân giải mang theo `status` để tầng
 * đó quyết.
 */

/** Một dòng đăng ký không gian ở dạng bộ phân giải cần — hình chiếu tối thiểu của dòng sổ đăng ký. */
export interface SpaceRegistryEntry {
  slug: string;
  /** provisioning | active | suspended | closed. */
  status: string;
  databaseName: string;
  /** shared | dedicated. */
  storageMode: string;
  /** Tên role kết nối của kho đích theo sổ đăng ký. */
  connectionRoleRef: string;
  /** Tham chiếu bí mật kết nối (dạng `env:<TÊN_BIẾN>`) hoặc null. */
  secretRef: string | null;
  schemaVersion: string | null;
}

/** Đường đọc sổ đăng ký mà bộ phân giải phụ thuộc — tầng gọi cấp cách đọc thật (control plane). */
export type SpaceRegistryReader = (slug: string) => Promise<SpaceRegistryEntry | undefined>;

/** Đích kết nối đã phân giải cho một không gian. */
export interface ResolvedSpaceConnection {
  slug: string;
  /** Trạng thái vòng đời tại thời điểm phân giải — tầng ứng dụng dùng để chặn traffic nghiệp vụ khi cần. */
  status: string;
  schemaVersion: string | null;
  /** Tên database đích theo sổ đăng ký. */
  databaseName: string;
  /** shared = kho chung hiện tại; dedicated = kho riêng của trung tâm. */
  mode: 'shared' | 'dedicated';
  /** Role kết nối của kho đích theo sổ đăng ký. */
  connectionRole: string;
  /**
   * Chuỗi kết nối tới kho riêng — chỉ có ở chế độ `dedicated`.
   * Đã được chốt đích về `databaseName` của sổ và kiểm chứng role.
   * Giá trị là bí mật kết nối: cấm ghi ra log.
   */
  connectionString?: string;
}

/** Lỗi phân giải định tuyến — mang mã lỗi ổn định để tầng gọi ánh xạ sang ProblemDetails. */
export class SpaceRoutingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpaceRoutingError';
  }
}

/** Các phụ thuộc của bộ phân giải — tách giao diện để kiểm chứng bằng đường đọc giả. */
export interface SpaceConnectionResolverDeps {
  readRegistry: SpaceRegistryReader;
  /** Hạn sống của một mục đệm (mili giây) — lưới dự phòng ngoài kênh sự kiện vô hiệu hoá. */
  cacheTtlMs: number;
  /**
   * Giải một tham chiếu bí mật thành giá trị chuỗi kết nối. Mặc
   * định: chỉ hỗ trợ dạng `env:<TÊN_BIẾN>` đọc từ `process.env` —
   * đúng dạng tham chiếu mà sổ đăng ký đang lưu.
   */
  resolveSecretRef?: (secretRef: string) => string | undefined;
}

/** Giải tham chiếu bí mật mặc định: `env:<TÊN_BIẾN>` → giá trị biến môi trường tương ứng. */
function defaultResolveSecretRef(secretRef: string): string | undefined {
  if (!secretRef.startsWith('env:')) return undefined;
  const name = secretRef.slice('env:'.length);
  return name ? process.env[name] : undefined;
}

interface CacheEntry {
  target: ResolvedSpaceConnection;
  expiresAt: number;
}

export class SpaceConnectionResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly resolveSecretRef: (secretRef: string) => string | undefined;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: SpaceConnectionResolverDeps) {
    this.resolveSecretRef = deps.resolveSecretRef ?? defaultResolveSecretRef;
    // Vô hiệu hoá theo sự kiện: nơi ghi sổ phát sự kiện kèm slug sau
    // mỗi lần commit thay đổi — xoá đúng mục đệm của slug đó để lần
    // phân giải kế tiếp đọc lại sổ.
    this.unsubscribe = onSpaceRegistryChanged((slug) => this.invalidate(slug));
  }

  /** Ngừng nghe sự kiện đổi sổ (gọi khi chủ sở hữu kết thúc vòng đời). */
  dispose(): void {
    this.unsubscribe();
  }

  /**
   * Xoá đệm: truyền slug thì xoá đúng mục của slug đó, không truyền
   * thì xoá toàn bộ (đường vận hành khi nghi ngờ sổ đã đổi hàng loạt
   * ngoài kênh sự kiện).
   */
  invalidate(slug?: string): void {
    if (slug) this.cache.delete(slug);
    else this.cache.clear();
  }

  /**
   * Phân giải đích kết nối cho một không gian theo slug.
   *
   * @param slug - Định danh địa chỉ của không gian trong sổ đăng ký.
   * @returns Đích kết nối (chế độ kho, tên database, role; kèm chuỗi
   *   kết nối nếu là kho riêng).
   * @throws SpaceRoutingError `space_routing.space_not_found` khi
   *   slug chưa có dòng đăng ký; `space_routing.secret_missing` khi
   *   kho riêng thiếu tham chiếu bí mật hoặc biến bí mật chưa được
   *   cấu hình; `space_routing.secret_invalid` khi giá trị bí mật
   *   không phải URL kết nối hợp lệ;
   *   `space_routing.role_mismatch` khi role trong chuỗi kết nối
   *   lệch role sổ đã đăng ký; `space_routing.storage_mode_unknown`
   *   khi sổ mang chế độ kho ngoài hai chế độ đã biết.
   */
  async resolve(slug: string): Promise<ResolvedSpaceConnection> {
    const cached = this.cache.get(slug);
    if (cached && cached.expiresAt > Date.now()) return cached.target;
    const entry = await this.deps.readRegistry(slug);
    if (!entry) {
      throw new SpaceRoutingError('space_routing.space_not_found', `Space slug ${slug} is not registered`);
    }
    const target = this.toTarget(entry);
    this.cache.set(slug, { target, expiresAt: Date.now() + this.deps.cacheTtlMs });
    return target;
  }

  /** Chốt đích kết nối từ một dòng đăng ký — riêng chế độ kho riêng mới cần giải bí mật và kiểm chứng role. */
  private toTarget(entry: SpaceRegistryEntry): ResolvedSpaceConnection {
    const base = {
      slug: entry.slug,
      status: entry.status,
      schemaVersion: entry.schemaVersion,
      databaseName: entry.databaseName,
      connectionRole: entry.connectionRoleRef,
    };
    if (entry.storageMode === 'shared') {
      return { ...base, mode: 'shared' };
    }
    if (entry.storageMode !== 'dedicated') {
      throw new SpaceRoutingError(
        'space_routing.storage_mode_unknown',
        `Space ${entry.slug} has unknown storage mode ${entry.storageMode}`,
      );
    }
    if (!entry.secretRef) {
      throw new SpaceRoutingError(
        'space_routing.secret_missing',
        `Space ${entry.slug} is dedicated but has no connection secret reference`,
      );
    }
    const rawConnection = this.resolveSecretRef(entry.secretRef);
    if (!rawConnection) {
      throw new SpaceRoutingError(
        'space_routing.secret_missing',
        `Connection secret for space ${entry.slug} is not configured`,
      );
    }
    let url: URL;
    try {
      url = new URL(rawConnection);
    } catch {
      throw new SpaceRoutingError(
        'space_routing.secret_invalid',
        `Connection secret for space ${entry.slug} is not a valid connection URL`,
      );
    }
    // Role trong chuỗi kết nối phải đúng role sổ đã đăng ký cho kho
    // này: kết nối bằng role khác (dù kết nối được) là đi chệch sổ —
    // fail-closed tại đây thay vì để tầng dữ kiện chạy bằng quyền
    // không thuộc về kho của trung tâm.
    const role = decodeURIComponent(url.username);
    if (role !== entry.connectionRoleRef) {
      throw new SpaceRoutingError(
        'space_routing.role_mismatch',
        `Connection role for space ${entry.slug} does not match the registered role`,
      );
    }
    // Đích cuối cùng lấy theo sổ: thay tên database trong chuỗi gốc
    // bằng databaseName đã đăng ký (chuỗi gốc có thể trỏ bất kỳ
    // database nào của cụm — thường là database mặc định của role).
    url.pathname = `/${entry.databaseName}`;
    return { ...base, mode: 'dedicated', connectionString: url.toString() };
  }
}
