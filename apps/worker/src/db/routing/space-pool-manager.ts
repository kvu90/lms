/**
 * Trình quản lý pool kết nối theo database (issue #581).
 *
 * BẢN SAO của `apps/api/src/db/routing/space-pool-manager.ts` theo
 * tiền lệ repo (mỗi app giữ bản sao hạ tầng riêng — cùng khuôn với
 * `tenant-als`/`tenant-pool`): mỗi tiến trình giữ ngân sách pool của
 * riêng mình trên cùng cụm; sửa file này PHẢI sửa đồng bộ bản gốc
 * phía API và ngược lại.
 *
 * Vì sao phải có tầng này: kiến trúc đích là mỗi trung tâm một
 * database trên MỘT cụm Postgres chung, mà giới hạn kết nối là ngân
 * sách của cả cụm — không nhân theo số database. Nếu mỗi kho riêng
 * giữ một pool thường trực, tổng kết nối tăng tuyến tính theo số
 * trung tâm kể cả khi đa số trung tâm không có traffic. Trình quản
 * lý này giữ ba kỷ luật ngân sách:
 *
 * - **Tạo lười:** pool của một kho chỉ được tạo ở lần lấy handle đầu
 *   tiên cho kho đó (tức lần traffic đầu tiên), không tạo lúc khởi
 *   động cho mọi kho đã đăng ký.
 * - **Trần theo kho:** trần kết nối của từng pool do nơi tạo pool
 *   chốt qua cấu hình của `pg` Pool (`max`) khi dựng handle; trình
 *   quản lý phơi tổng số kết nối đang mở của mọi pool
 *   (`totalConnections`) để tầng vận hành kiểm chứng ngân sách.
 * - **Đóng khi nhàn rỗi:** một vòng quét định kỳ đóng hẳn pool của
 *   kho không còn traffic quá ngưỡng nhàn rỗi cấu hình được (mốc
 *   "traffic" cập nhật mỗi lần lấy handle và mỗi lần pool cho mượn
 *   một kết nối — sự kiện `acquire` của `pg`). Pool còn kết nối
 *   đang được mượn (chưa trả) thì KHÔNG đóng ở vòng quét này, chờ
 *   vòng sau. Pool đã đóng bị gỡ khỏi sổ của trình quản lý: lần lấy
 *   handle kế tiếp tạo pool mới — đóng pool vì vậy không phải trạng
 *   thái cuối, chỉ là trả ngân sách về cụm.
 */

/** Hình tối thiểu của một pool mà trình quản lý cần — `pg` Pool thoả mãn trực tiếp. */
export interface ManagedPool {
  /** Tổng số kết nối pool đang giữ (đang mượn + đang nhàn). */
  readonly totalCount: number;
  /** Số kết nối đang nhàn trong pool. */
  readonly idleCount: number;
  /** Đóng pool và mọi kết nối của nó. */
  end(): Promise<void>;
  /** Pool thật của `pg` phát sự kiện `acquire` mỗi lần cho mượn một kết nối. */
  on?(event: 'acquire', listener: () => void): unknown;
}

/** Handle của một kho: pool kết nối + handle Drizzle dựng trên pool đó. */
export interface SpacePoolHandle<TDatabase> {
  databaseName: string;
  pool: ManagedPool;
  db: TDatabase;
}

interface PoolEntry<TDatabase> {
  handle: SpacePoolHandle<TDatabase>;
  lastUsedAt: number;
}

/** Các phụ thuộc của trình quản lý pool. */
export interface SpacePoolManagerDeps {
  /** Ngưỡng nhàn rỗi (mili giây): pool không có traffic lâu hơn ngưỡng này bị đóng ở vòng quét. */
  idleTimeoutMs: number;
  /** Đồng hồ — tách ra để kiểm chứng vòng quét bằng thời gian giả. */
  now?: () => number;
  /** Báo cho chủ sở hữu mỗi khi một pool bị đóng vì nhàn rỗi (để đồng bộ các bảng tra cứu theo kho). */
  onPoolClosed?: (databaseName: string) => void;
}

export class SpacePoolManager<TDatabase> {
  private readonly entries = new Map<string, PoolEntry<TDatabase>>();
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SpacePoolManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Lấy handle của một kho, tạo pool ở lần lấy đầu tiên (tạo lười).
   * Hàm tạo chỉ chạy khi kho chưa có pool đang sống — các lần lấy
   * sau dùng lại đúng handle đã tạo và chỉ cập nhật mốc traffic.
   *
   * @param databaseName - Tên database làm khoá pool.
   * @param create - Hàm dựng handle (pool + Drizzle) cho kho, chạy
   *   tối đa một lần cho mỗi vòng đời pool.
   */
  getHandle(databaseName: string, create: (databaseName: string) => SpacePoolHandle<TDatabase>): SpacePoolHandle<TDatabase> {
    const existing = this.entries.get(databaseName);
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing.handle;
    }
    const handle = create(databaseName);
    const entry: PoolEntry<TDatabase> = { handle, lastUsedAt: this.now() };
    this.entries.set(databaseName, entry);
    // Mốc traffic tính cả hoạt động mượn kết nối trực tiếp từ pool
    // (mọi truy vấn qua handle Drizzle đều mượn kết nối ở đây), để
    // một kho đang được dùng liên tục không bị vòng quét coi là
    // nhàn rỗi chỉ vì không có lần lấy handle mới.
    handle.pool.on?.('acquire', () => {
      entry.lastUsedAt = this.now();
    });
    return handle;
  }

  /** Số pool đang sống (số kho đang giữ ngân sách kết nối). */
  get size(): number {
    return this.entries.size;
  }

  /** Tổng số kết nối đang mở của mọi pool — con số đối chiếu với ngân sách kết nối của cụm. */
  totalConnections(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.handle.pool.totalCount;
    return total;
  }

  /**
   * Đóng mọi pool đã nhàn rỗi quá ngưỡng và không còn kết nối đang
   * được mượn. Pool bị đóng được gỡ khỏi sổ TRƯỚC khi `end()` chạy,
   * nên một lần lấy handle đến trong lúc đóng sẽ tạo pool mới thay
   * vì nhận phải pool đang chết.
   *
   * @param at - Mốc thời gian xét nhàn rỗi (mặc định: hiện tại).
   * @returns Tên các database có pool vừa bị đóng.
   */
  async closeIdlePools(at: number = this.now()): Promise<string[]> {
    const closed: string[] = [];
    for (const [databaseName, entry] of [...this.entries]) {
      if (at - entry.lastUsedAt < this.deps.idleTimeoutMs) continue;
      const { pool } = entry.handle;
      // Còn kết nối đang được mượn là còn traffic đang chạy: không
      // đóng giữa chừng, để vòng quét sau xét lại khi đã trả hết.
      if (pool.totalCount !== pool.idleCount) continue;
      this.entries.delete(databaseName);
      await pool.end();
      closed.push(databaseName);
      this.deps.onPoolClosed?.(databaseName);
    }
    return closed;
  }

  /**
   * Bật vòng quét đóng pool nhàn rỗi định kỳ. Timer được `unref` để
   * không giữ tiến trình sống chỉ vì vòng quét.
   *
   * @param intervalMs - Chu kỳ quét.
   */
  startIdleSweeper(intervalMs: number): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      // Lỗi của một vòng quét (ví dụ một pool lỗi khi đóng) không
      // được làm sập tiến trình: bỏ qua vòng này, vòng sau quét lại.
      void this.closeIdlePools().catch(() => undefined);
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  /** Tắt vòng quét định kỳ. */
  stopIdleSweeper(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Đóng mọi pool đang sống (đường tắt tiến trình của chủ sở hữu). */
  async closeAll(): Promise<void> {
    this.stopIdleSweeper();
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.handle.pool.end().catch(() => undefined)));
  }
}
