import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { AccessRepository, type ContextRow } from './access.repository';
import { CONTEXT_LEVELS } from './domain/capabilities';
import type { DbTx } from '../../db/database';

@Injectable()
/**
 * Quản lý cây context (hệ thống → danh mục → khoá học → module → block → user).
 * Bất biến: path là danh sách id tổ tiên vật chất hoá, luôn kết thúc bằng id của chính context;
 * mọi thay đổi cấu trúc cây đều bump version để PermissionEvaluator không dùng cache cũ.
 * Đối chiếu Moodle: lib/accesslib.php (context::instance_by_id, build path).
 */
export class ContextsService {
  constructor(private readonly repo: AccessRepository) {}

  /** Context hệ thống (level 10, instance null) được tạo lười (lazy) và là gốc của mọi path. */
  /**
   * Đảm bảo context hệ thống (level CONTEXT_SYSTEM, instance 0) tồn tại; idempotent.
   */
  async ensureSystemContext(tx?: DbTx): Promise<ContextRow> {
    const existing = await this.repo.getContextByLevelInstance(CONTEXT_LEVELS.SYSTEM, null, tx);
    if (existing) return existing;
    const row = await this.repo.insertContext({ contextLevel: CONTEXT_LEVELS.SYSTEM, instanceId: null, path: '', depth: 0 }, tx);
    const path = `/${row.id}`;
    await this.repo.updateContextPath(row.id, path, 1, tx);
    return { ...row, path, depth: 1 };
  }

  /**
   * Đảm bảo context TENANT (level 20) của một tenant tồn tại — mỗi tenant
   * đúng MỘT context tenant, instance_id = tenants.id, cha là context hệ
   * thống (TENANT-0, #168). Mọi context thuộc tenant (danh mục gốc,
   * cohort…) neo dưới context này nên cây của tenant tách hẳn khỏi cây
   * của tenant khác; PermissionEvaluator dùng nó làm neo cổng membership.
   */
  async ensureTenantContext(tenantId: string): Promise<ContextRow> {
    const existing = await this.repo.getContextByLevelInstance(CONTEXT_LEVELS.TENANT, tenantId);
    if (existing) return existing;
    const system = await this.ensureSystemContext();
    return this.createContext(CONTEXT_LEVELS.TENANT, tenantId, system.id);
  }

  /** Context tenant của một tenant; undefined nếu chưa được tạo. */
  async getTenantContext(tenantId: string): Promise<ContextRow | undefined> {
    return this.getByLevelInstance(CONTEXT_LEVELS.TENANT, tenantId);
  }

  /**
   * Tạo context con dưới một context cha, tính path/depth; cha không tồn tại → lỗi access.parent_context_not_found.
   */
  async createContext(contextLevel: number, instanceId: string, parentId?: string, tx?: DbTx): Promise<ContextRow> {
    const existing = await this.repo.getContextByLevelInstance(contextLevel, instanceId, tx);
    if (existing) return existing;
    const parent = contextLevel === CONTEXT_LEVELS.SYSTEM
      ? undefined
      : await this.repo.getContextById(parentId ?? (await this.ensureSystemContext(tx)).id, tx);
    if (contextLevel !== CONTEXT_LEVELS.SYSTEM && !parent) throw new BadRequestException({ message: 'Parent context not found', code: 'access.parent_context_not_found' });
    const row = await this.repo.insertContext({ contextLevel, instanceId, path: '', depth: 0 }, tx);
    const path = parent ? `${parent.path}/${row.id}` : `/${row.id}`;
    const depth = parent ? parent.depth + 1 : 1;
    await this.repo.updateContextPath(row.id, path, depth, tx);
    return { ...row, path, depth };
  }

  /**
   * Lấy context theo id; ném NotFound khi vắng. Id không phải UUID thì
   * chắc chắn không tồn tại context nào mang nó (khoá chính là uuid) —
   * trả NotFound thay vì để DB ném lỗi cú pháp uuid: các guard chạy
   * trước pipe validate nên id thô trên URL tới được đây.
   */
  async getContext(id: string, tx?: DbTx): Promise<ContextRow> {
    const row = uuidIdSchema.safeParse(id).success ? await this.repo.getContextById(id, tx) : undefined;
    if (!row) throw new NotFoundException({ message: `Context ${id} not found`, code: 'access.context_not_found' });
    return row;
  }
  /**
   * Lấy context theo (level, instance); undefined nếu chưa được tạo.
   * Cột `instanceId` là uuid nên một giá trị không phải UUID chắc chắn
   * không khớp context nào — trả undefined thay vì để DB ném lỗi cú pháp
   * uuid. Điểm này bắt buộc vì CapabilityGuard chạy TRƯỚC pipe validate:
   * param thô trên URL (vd `:id` của user) tới được đây khi chưa qua
   * kiểm tra định dạng, và hợp đồng API đòi id sai định dạng → 400 ở
   * pipe chứ không phải 500 ở guard (nhóm test hợp đồng API).
   */
  async getByLevelInstance(contextLevel: number, instanceId: string): Promise<ContextRow | undefined> {
    if (!uuidIdSchema.safeParse(instanceId).success) return undefined;
    return this.repo.getContextByLevelInstance(contextLevel, instanceId);
  }
  /**
   * Context của NHIỀU instance cùng một level trong một truy vấn
   * (DL-07, issue #489): bản theo lô của `getByLevelInstance` — id
   * không đúng định dạng uuid bị loại khỏi lô như đường lẻ trả
   * undefined cho từng id đó.
   */
  async getByLevelInstances(contextLevel: number, instanceIds: string[]): Promise<ContextRow[]> {
    const valid = instanceIds.filter((id) => uuidIdSchema.safeParse(id).success);
    if (!valid.length) return [];
    return this.repo.getContextsByLevelInstances(contextLevel, valid);
  }
  /**
   * Lấy nhiều context theo danh sách id trong MỘT truy vấn — phục vụ các
   * đường đọc theo lô (ảnh chụp quyền hợp nhất cây tổ tiên của nhiều gán
   * vai): tránh một truy vấn cho mỗi context như khi gọi getContext lặp lại.
   */
  async getContextsByIds(ids: string[]): Promise<ContextRow[]> { return this.repo.getContextsByIds(ids); }
  /**
   * Liệt kê toàn bộ context.
   */
  async listContexts(): Promise<ContextRow[]> { return this.repo.listContexts(); }
  /** Xoá một context (dùng khi instance sở hữu nó — category/course/cm — bị xoá). Các assignment/override bị xoá theo kiểu cascade. */
  /**
   * Xoá context và dọn override quyền gắn với nó.
   */
  async deleteContext(id: string): Promise<void> { await this.repo.deleteContext(id); }
  /**
   * Xoá context theo (level, instance) — dùng khi entity chủ (khoá học/module) bị xoá.
   */
  async deleteByLevelInstance(contextLevel: number, instanceId: string): Promise<void> {
    const row = await this.repo.getContextByLevelInstance(contextLevel, instanceId);
    if (row) await this.repo.deleteContext(row.id);
  }

  /** Chuỗi tổ tiên gồm cả chính context đó, sắp theo thứ tự lá → gốc, đi theo `path`. */
  /**
   * Trả các context tổ tiên của một context (kèm chính nó) theo thứ tự từ gốc xuống.
   */
  async getPathContexts(ctx: ContextRow): Promise<ContextRow[]> {
    const ids = ctx.path.split('/').filter(Boolean);
    const rows = await this.repo.getContextsByIds(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.slice().reverse().map((id) => byId.get(id)!).filter(Boolean);
  }

  /** Di chuyển một context (và toàn bộ cây con của nó) xuống dưới một context cha mới, viết lại path/depth. Dùng khi một category được di chuyển. */
  /**
   * Di chuyển context sang cha mới và viết lại path cho cả cây con.
   */
  async reparentContext(id: string, newParentId: string): Promise<void> {
    const ctx = await this.getContext(id);
    const parent = await this.getContext(newParentId);
    const oldPath = ctx.path;
    const newPath = `${parent.path}/${ctx.id}`;
    const depthDelta = parent.depth + 1 - ctx.depth;
    const all = await this.repo.listContexts();
    for (const c of all) {
      if (c.path === oldPath || c.path.startsWith(`${oldPath}/`)) {
        await this.repo.updateContextPath(c.id, newPath + c.path.slice(oldPath.length), c.depth + depthDelta);
      }
    }
  }

  /** Đánh dấu dirty: mọi thay đổi quyền trong một context đều vô hiệu hoá kết quả đã cache của nó và của mọi context con cháu. */
  /**
   * Đánh dấu cây context đã đổi để các cache phụ thuộc phải tính lại.
   */
  async markContextDirty(contextId: string, tx?: DbTx): Promise<void> {
    const ctx = await this.repo.getContextById(contextId, tx);
    if (ctx) await this.repo.bumpContextVersions(ctx.path, tx);
  }
  /** Dấu cache cho path của một context: thay đổi mỗi khi bất kỳ context nào trên path (hoặc gốc hệ thống) bị đánh dấu dirty. */
  /**
   * Dấu version hiện tại của cây context, gắn vào kết quả đánh giá quyền để phát hiện cache cũ.
   */
  pathVersionStamp(pathContexts: ContextRow[]): string {
    return pathContexts.map((c) => `${c.id}:${c.version}`).join('|');
  }
}
