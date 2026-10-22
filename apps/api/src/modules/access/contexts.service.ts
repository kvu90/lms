import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccessRepository, type ContextRow } from './access.repository';
import { CONTEXT_LEVELS } from './domain/capabilities';

@Injectable()
/**
 * Quản lý cây context (hệ thống → danh mục → khoá học → module → block → user).
 * Bất biến: path là danh sách id tổ tiên vật chất hoá, luôn kết thúc bằng id của chính context;
 * mọi thay đổi cấu trúc cây đều bump version để PermissionEvaluator không dùng cache cũ.
 * Đối chiếu Moodle: lib/accesslib.php (context::instance_by_id, build path).
 */
export class ContextsService {
  constructor(private readonly repo: AccessRepository) {}

  /** The system context (level 10, instance 0) is created lazily and is the root of every path. */
  /**
   * Đảm bảo context hệ thống (level CONTEXT_SYSTEM, instance 0) tồn tại; idempotent.
   */
  async ensureSystemContext(): Promise<ContextRow> {
    const existing = await this.repo.getContextByLevelInstance(CONTEXT_LEVELS.SYSTEM, 0);
    if (existing) return existing;
    const row = await this.repo.insertContext({ contextlevel: CONTEXT_LEVELS.SYSTEM, instanceid: 0, path: '', depth: 0 });
    const path = `/${row.id}`;
    await this.repo.updateContextPath(row.id, path, 1);
    return { ...row, path, depth: 1 };
  }

  /**
   * Tạo context con dưới một context cha, tính path/depth; cha không tồn tại → lỗi access.parent_context_not_found.
   */
  async createContext(contextlevel: number, instanceid: number, parentId?: number): Promise<ContextRow> {
    const existing = await this.repo.getContextByLevelInstance(contextlevel, instanceid);
    if (existing) return existing;
    const parent = contextlevel === CONTEXT_LEVELS.SYSTEM
      ? undefined
      : await this.repo.getContextById(parentId ?? (await this.ensureSystemContext()).id);
    if (contextlevel !== CONTEXT_LEVELS.SYSTEM && !parent) throw new BadRequestException({ message: 'Parent context not found', code: 'access.parent_context_not_found' });
    const row = await this.repo.insertContext({ contextlevel, instanceid, path: '', depth: 0 });
    const path = parent ? `${parent.path}/${row.id}` : `/${row.id}`;
    const depth = parent ? parent.depth + 1 : 1;
    await this.repo.updateContextPath(row.id, path, depth);
    return { ...row, path, depth };
  }

  /**
   * Lấy context theo id; ném NotFound khi vắng.
   */
  async getContext(id: number): Promise<ContextRow> {
    const row = await this.repo.getContextById(id);
    if (!row) throw new NotFoundException({ message: `Context ${id} not found`, code: 'access.context_not_found' });
    return row;
  }
  /**
   * Lấy context theo (level, instance); undefined nếu chưa được tạo.
   */
  async getByLevelInstance(contextlevel: number, instanceid: number): Promise<ContextRow | undefined> {
    return this.repo.getContextByLevelInstance(contextlevel, instanceid);
  }
  /**
   * Liệt kê toàn bộ context.
   */
  async listContexts(): Promise<ContextRow[]> { return this.repo.listContexts(); }
  /** Remove a context (used when its owning instance — category/course/cm — is deleted). Assignments/overrides cascade. */
  /**
   * Xoá context và dọn override quyền gắn với nó.
   */
  async deleteContext(id: number): Promise<void> { await this.repo.deleteContext(id); }
  /**
   * Xoá context theo (level, instance) — dùng khi entity chủ (khoá học/module) bị xoá.
   */
  async deleteByLevelInstance(contextlevel: number, instanceid: number): Promise<void> {
    const row = await this.repo.getContextByLevelInstance(contextlevel, instanceid);
    if (row) await this.repo.deleteContext(row.id);
  }

  /** Ancestor chain including the context itself, ordered leaf → root, following `path`. */
  /**
   * Trả các context tổ tiên của một context (kèm chính nó) theo thứ tự từ gốc xuống.
   */
  async getPathContexts(ctx: ContextRow): Promise<ContextRow[]> {
    const ids = ctx.path.split('/').filter(Boolean).map(Number);
    const rows = await this.repo.getContextsByIds(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.slice().reverse().map((id) => byId.get(id)!).filter(Boolean);
  }

  /** Move a context (and its whole subtree) under a new parent, rewriting path/depth. Used when a category is moved. */
  /**
   * Di chuyển context sang cha mới và viết lại path cho cả cây con.
   */
  async reparentContext(id: number, newParentId: number): Promise<void> {
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

  /** Dirty-marking: any permission change in a context invalidates cached results for it and all descendants. */
  /**
   * Đánh dấu cây context đã đổi để các cache phụ thuộc phải tính lại.
   */
  async markContextDirty(contextId: number): Promise<void> {
    const ctx = await this.repo.getContextById(contextId);
    if (ctx) await this.repo.bumpContextVersions(ctx.path);
  }
  /** Cache stamp for a context path: changes whenever any context on the path (or the system root) is dirtied. */
  /**
   * Dấu version hiện tại của cây context, gắn vào kết quả đánh giá quyền để phát hiện cache cũ.
   */
  pathVersionStamp(pathContexts: ContextRow[]): string {
    return pathContexts.map((c) => `${c.id}:${c.version}`).join('|');
  }
}
