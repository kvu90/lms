import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SessionCacheService } from '../../infra/cache/session-cache.service';

/** Siêu dữ liệu trình bày của một phiên web (bảng phiên của report_usersessions: thiết bị, IP, lần truy cập cuối). */
export interface WebSessionClientInfo { ip?: string; userAgent?: string }

export interface WebSession extends WebSessionClientInfo {
  userId: string;
  username: string;
  createdAt: string;
  /** Lần cuối phiên còn được xác thực thành công — cập nhật tiết kiệm qua `touch` (tối đa một lần ghi mỗi phút). */
  lastActivityAt: string;
  loginAs?: { byUserId: string };
}

/** Một phiên web đang sống kèm định danh của nó, dùng cho trang quản lý phiên của chính user. */
export interface ListedWebSession { id: string; session: WebSession }

/** Ngưỡng tiết kiệm ghi khi chạm hoạt động: lần truy cập cuối chỉ cần chính xác tới phút. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * SessionModule (nằm trong AuthModule theo report §3.7): phiên web phía server
 * trong namespace cache *session* của Redis. Cookie chỉ mang id;
 * đăng nhập sẽ xoay vòng id (chống fixation) và phiên của người dùng bị đình chỉ/đã xoá
 * sẽ ngừng hợp lệ vì AuthService kiểm tra lại trạng thái tài khoản ở
 * mỗi lần đọc phiên.
 *
 * Ngoài bản ghi phiên, service duy trì một chỉ mục nhẹ theo user
 * (`webindex:<userId>` → danh sách session id) để trang "Phiên đăng nhập"
 * (mẫu report_usersessions của Moodle) liệt kê và thu hồi được các phiên
 * web của chính user; chỉ mục được dọn lười khi liệt kê (id nào không còn
 * bản ghi thì bị loại).
 */
@Injectable()
/**
 * Phiên đăng nhập phía server (kho phiên trong Redis): tạo, đọc, huỷ, xoay
 * id phiên và liệt kê/thu hồi theo user phục vụ quản lý phiên cá nhân.
 * Session id là giá trị ngẫu nhiên khó đoán, chỉ lưu phía server.
 */
export class SessionService {
  constructor(private readonly store: SessionCacheService) {}

  private indexKey(userId: string): string { return `webindex:${userId}`; }

  /** Thêm session id vào chỉ mục của user (đọc–ghi toàn bộ danh sách; tần suất đăng nhập thấp nên không cần khoá). */
  private async indexAdd(userId: string, id: string): Promise<void> {
    const ids = (await this.store.get<string[]>(this.indexKey(userId))) ?? [];
    if (!ids.includes(id)) await this.store.set(this.indexKey(userId), [...ids, id]);
  }

  /** Loại session id khỏi chỉ mục của user; xoá luôn khoá chỉ mục khi rỗng. */
  private async indexRemove(userId: string, id: string): Promise<void> {
    const ids = (await this.store.get<string[]>(this.indexKey(userId))) ?? [];
    const next = ids.filter((x) => x !== id);
    if (next.length === ids.length) return;
    if (next.length === 0) await this.store.delete(this.indexKey(userId));
    else await this.store.set(this.indexKey(userId), next);
  }

  /**
   * Tạo phiên mới cho user và trả session id thô.
   */
  async create(data: Omit<WebSession, 'createdAt' | 'lastActivityAt'>): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.store.set(`web:${id}`, { ...data, createdAt: now, lastActivityAt: now } satisfies WebSession);
    await this.indexAdd(data.userId, id);
    return id;
  }
  /**
   * Lấy phiên theo session id thô.
   */
  async get(id: string): Promise<WebSession | undefined> { return this.store.get<WebSession>(`web:${id}`); }
  /**
   * Chạm hoạt động: cập nhật `lastActivityAt` nếu lần chạm trước đã quá
   * ngưỡng tiết kiệm; việc ghi lại bản ghi cũng làm mới TTL của kho phiên
   * (phiên trượt theo hoạt động, gần với timeout phiên của Moodle).
   */
  async touch(id: string): Promise<void> {
    const session = await this.get(id);
    if (!session) return;
    if (Date.now() - new Date(session.lastActivityAt).getTime() < TOUCH_INTERVAL_MS) return;
    await this.store.set(`web:${id}`, { ...session, lastActivityAt: new Date().toISOString() });
  }
  /**
   * Huỷ phiên (đăng xuất hoặc thu hồi từ trang quản lý phiên).
   */
  async destroy(id: string): Promise<void> {
    const session = await this.get(id);
    await this.store.delete(`web:${id}`);
    if (session) await this.indexRemove(session.userId, id);
  }
  /** Xoay vòng: huỷ id cũ (nếu có) và cấp một id mới cho cùng một danh tính. */
  /**
   * Xoay session id (sau đăng nhập/leo quyền) để chống fixation; phiên cũ bị huỷ.
   */
  async rotate(oldId: string | undefined, data: Omit<WebSession, 'createdAt' | 'lastActivityAt'>): Promise<string> {
    if (oldId) await this.destroy(oldId);
    return this.create(data);
  }
  /**
   * Mọi phiên web đang sống của user, kèm dọn lười chỉ mục (id chết bị loại khỏi danh sách trả về và khỏi chỉ mục).
   */
  async listForUser(userId: string): Promise<ListedWebSession[]> {
    const ids = (await this.store.get<string[]>(this.indexKey(userId))) ?? [];
    const alive: ListedWebSession[] = [];
    for (const id of ids) {
      const session = await this.get(id);
      if (session && session.userId === userId) alive.push({ id, session });
    }
    const aliveIds = new Set(alive.map((x) => x.id));
    for (const id of ids) if (!aliveIds.has(id)) await this.indexRemove(userId, id);
    return alive;
  }
  /**
   * Huỷ mọi phiên web của user ngoại trừ `keepId` (phiên hiện tại khi
   * người dùng bấm "huỷ mọi phiên khác"); trả số phiên đã huỷ.
   */
  async destroyOthersForUser(userId: string, keepId?: string): Promise<number> {
    const listed = await this.listForUser(userId);
    let destroyed = 0;
    for (const { id } of listed) {
      if (id === keepId) continue;
      await this.destroy(id);
      destroyed += 1;
    }
    return destroyed;
  }
}
