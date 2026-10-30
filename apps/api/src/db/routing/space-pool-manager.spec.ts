import { describe, expect, it } from 'vitest';
import { SpacePoolManager, type ManagedPool, type SpacePoolHandle } from './space-pool-manager';

/**
 * Ca đơn vị của trình quản lý pool theo database (issue #581): pool
 * được thay bằng vật giả có bộ đếm kết nối điều khiển được và đồng
 * hồ điều khiển bằng tay — các ca khoá ba kỷ luật ngân sách: tạo
 * lười theo kho, đóng pool khi nhàn rỗi quá ngưỡng (nhưng không
 * đóng pool còn kết nối đang được mượn), và tổng kết nối cộng đúng
 * trên các pool đang sống; cộng bất biến danh tính: pool bị buộc
 * theo danh tính kết nối đã phân giải mà nó được tạo bằng, sổ đổi
 * danh tính thì pool bị thay.
 */

class FakePool implements ManagedPool {
  totalCount = 0;
  idleCount = 0;
  ended = false;
  private readonly acquireListeners: Array<() => void> = [];

  async end(): Promise<void> {
    this.ended = true;
    this.totalCount = 0;
    this.idleCount = 0;
  }

  on(event: 'acquire', listener: () => void): this {
    if (event === 'acquire') this.acquireListeners.push(listener);
    return this;
  }

  /** Giả lập pool cho mượn một kết nối (sự kiện acquire của pg). */
  acquire(): void {
    for (const listener of this.acquireListeners) listener();
  }
}

/** Dựng trình quản lý với nhà máy đếm số handle đã tạo và đồng hồ điều khiển được. */
function makeManager(idleTimeoutMs = 1_000) {
  let created = 0;
  let now = 0;
  const closedNotifications: string[] = [];
  const manager = new SpacePoolManager<string>({
    idleTimeoutMs,
    now: () => now,
    onPoolClosed: (databaseName) => closedNotifications.push(databaseName),
  });
  const create = (databaseName: string): SpacePoolHandle<string> => {
    created += 1;
    return { databaseName, pool: new FakePool(), db: `db:${databaseName}` };
  };
  return {
    manager,
    create,
    created: () => created,
    closedNotifications,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('Trình quản lý pool theo database', () => {
  it('tạo lười: chưa lấy handle thì chưa tạo pool nào; lấy lại cùng kho dùng lại đúng handle đã tạo', () => {
    const { manager, create, created } = makeManager();
    expect(manager.size).toBe(0);
    expect(created()).toBe(0);
    const first = manager.getHandle('kho_a', create);
    const second = manager.getHandle('kho_a', create);
    expect(second).toBe(first);
    expect(created()).toBe(1);
    expect(manager.size).toBe(1);
  });

  it('mỗi kho một pool riêng: lấy handle của kho khác thì tạo thêm pool', () => {
    const { manager, create, created } = makeManager();
    manager.getHandle('kho_a', create);
    manager.getHandle('kho_b', create);
    expect(created()).toBe(2);
    expect(manager.size).toBe(2);
  });

  it('pool chưa quá ngưỡng nhàn rỗi thì vòng quét không đóng', async () => {
    const { manager, create, advance } = makeManager(1_000);
    manager.getHandle('kho_a', create);
    advance(999);
    await expect(manager.closeIdlePools()).resolves.toEqual([]);
    expect(manager.size).toBe(1);
  });

  it('pool nhàn rỗi quá ngưỡng và không còn kết nối đang mượn thì bị đóng và gỡ khỏi sổ', async () => {
    const { manager, create, advance, closedNotifications } = makeManager(1_000);
    const handle = manager.getHandle('kho_a', create);
    (handle.pool as FakePool).totalCount = 2;
    (handle.pool as FakePool).idleCount = 2;
    advance(1_000);
    await expect(manager.closeIdlePools()).resolves.toEqual(['kho_a']);
    expect((handle.pool as FakePool).ended).toBe(true);
    expect(manager.size).toBe(0);
    expect(closedNotifications).toEqual(['kho_a']);
    // Sau khi đóng vì nhàn rỗi, lần lấy handle kế tiếp tạo pool mới
    // — đóng pool là trả ngân sách, không phải trạng thái cuối.
    const recreated = manager.getHandle('kho_a', create);
    expect(recreated).not.toBe(handle);
    expect(manager.size).toBe(1);
  });

  it('pool còn kết nối đang được mượn thì vòng quét không đóng, dù đã quá ngưỡng nhàn rỗi', async () => {
    const { manager, create, advance } = makeManager(1_000);
    const handle = manager.getHandle('kho_a', create);
    (handle.pool as FakePool).totalCount = 2;
    (handle.pool as FakePool).idleCount = 1;
    advance(5_000);
    await expect(manager.closeIdlePools()).resolves.toEqual([]);
    expect(manager.size).toBe(1);
    // Khi kết nối được trả hết, vòng quét sau mới đóng.
    (handle.pool as FakePool).idleCount = 2;
    await expect(manager.closeIdlePools()).resolves.toEqual(['kho_a']);
  });

  it('hoạt động mượn kết nối từ pool làm mới mốc traffic: pool đang được dùng liên tục không bị coi là nhàn rỗi', async () => {
    const { manager, create, advance } = makeManager(1_000);
    const handle = manager.getHandle('kho_a', create);
    advance(900);
    (handle.pool as FakePool).acquire();
    advance(900);
    await expect(manager.closeIdlePools()).resolves.toEqual([]);
    advance(101);
    await expect(manager.closeIdlePools()).resolves.toEqual(['kho_a']);
  });

  it('tổng kết nối cộng đúng số kết nối của mọi pool đang sống', () => {
    const { manager, create } = makeManager();
    const a = manager.getHandle('kho_a', create);
    const b = manager.getHandle('kho_b', create);
    (a.pool as FakePool).totalCount = 3;
    (b.pool as FakePool).totalCount = 2;
    expect(manager.totalConnections()).toBe(5);
  });

  it('lấy handle theo danh tính: cùng danh tính thì dùng lại pool, đổi danh tính thì pool cũ bị đóng và thay bằng pool mới mang danh tính mới', async () => {
    const { manager, create, created, closedNotifications } = makeManager();
    const first = manager.getHandleForIdentity('kho_a', 'identity-1', create);
    const same = manager.getHandleForIdentity('kho_a', 'identity-1', create);
    expect(same).toBe(first);
    expect(created()).toBe(1);
    // Sổ đổi role/bí mật của kho: danh tính phân giải đã khác —
    // pool cũ không còn được dùng, phải bị đóng và thay mới.
    const replaced = manager.getHandleForIdentity('kho_a', 'identity-2', create);
    expect(replaced).not.toBe(first);
    expect(created()).toBe(2);
    expect(manager.size).toBe(1);
    // Việc thay pool báo ra như một lần đóng pool để chủ sở hữu
    // đồng bộ các bảng tra cứu theo kho.
    expect(closedNotifications).toEqual(['kho_a']);
    // Pool cũ thật sự bị đóng (đóng chạy nền nên chờ một nhịp).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((first.pool as FakePool).ended).toBe(true);
    expect((replaced.pool as FakePool).ended).toBe(false);
  });

  it('lấy handle không kèm danh tính vẫn dùng lại pool đang sống; pool tạo không kèm danh tính thì nhận danh tính ở lần lấy kèm danh tính đầu tiên thay vì bị thay', () => {
    const { manager, create, created } = makeManager();
    const withIdentity = manager.getHandleForIdentity('kho_a', 'identity-1', create);
    const plain = manager.getHandle('kho_a', create);
    expect(plain).toBe(withIdentity);
    expect(created()).toBe(1);
    // Pool của kho_b tạo qua đường không kèm danh tính: lần lấy
    // kèm danh tính đầu tiên GHI NHẬN danh tính cho pool đó (chưa
    // có căn cứ kết luận nó chạy sai), từ lần đổi danh tính sau
    // đó mới thay pool.
    const untracked = manager.getHandle('kho_b', create);
    const adopted = manager.getHandleForIdentity('kho_b', 'identity-9', create);
    expect(adopted).toBe(untracked);
    expect(created()).toBe(2);
    const replaced = manager.getHandleForIdentity('kho_b', 'identity-10', create);
    expect(replaced).not.toBe(untracked);
    expect(created()).toBe(3);
  });

  it('closeAll đóng mọi pool đang sống và dọn sổ về rỗng', async () => {
    const { manager, create } = makeManager();
    const a = manager.getHandle('kho_a', create);
    const b = manager.getHandle('kho_b', create);
    await manager.closeAll();
    expect((a.pool as FakePool).ended).toBe(true);
    expect((b.pool as FakePool).ended).toBe(true);
    expect(manager.size).toBe(0);
    expect(manager.totalConnections()).toBe(0);
  });
});
