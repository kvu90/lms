import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccessRepository, type ContextRow } from './access.repository';
import { CONTEXT_LEVELS } from './domain/capabilities';

@Injectable()
export class ContextsService {
  constructor(private readonly repo: AccessRepository) {}

  /** The system context (level 10, instance 0) is created lazily and is the root of every path. */
  async ensureSystemContext(): Promise<ContextRow> {
    const existing = await this.repo.getContextByLevelInstance(CONTEXT_LEVELS.SYSTEM, 0);
    if (existing) return existing;
    const row = await this.repo.insertContext({ contextlevel: CONTEXT_LEVELS.SYSTEM, instanceid: 0, path: '', depth: 0 });
    const path = `/${row.id}`;
    await this.repo.updateContextPath(row.id, path, 1);
    return { ...row, path, depth: 1 };
  }

  async createContext(contextlevel: number, instanceid: number, parentId?: number): Promise<ContextRow> {
    const existing = await this.repo.getContextByLevelInstance(contextlevel, instanceid);
    if (existing) return existing;
    const parent = contextlevel === CONTEXT_LEVELS.SYSTEM
      ? undefined
      : await this.repo.getContextById(parentId ?? (await this.ensureSystemContext()).id);
    if (contextlevel !== CONTEXT_LEVELS.SYSTEM && !parent) throw new BadRequestException('Parent context not found');
    const row = await this.repo.insertContext({ contextlevel, instanceid, path: '', depth: 0 });
    const path = parent ? `${parent.path}/${row.id}` : `/${row.id}`;
    const depth = parent ? parent.depth + 1 : 1;
    await this.repo.updateContextPath(row.id, path, depth);
    return { ...row, path, depth };
  }

  async getContext(id: number): Promise<ContextRow> {
    const row = await this.repo.getContextById(id);
    if (!row) throw new NotFoundException({ message: `Context ${id} not found`, code: 'access.context_not_found' });
    return row;
  }
  async getByLevelInstance(contextlevel: number, instanceid: number): Promise<ContextRow | undefined> {
    return this.repo.getContextByLevelInstance(contextlevel, instanceid);
  }
  async listContexts(): Promise<ContextRow[]> { return this.repo.listContexts(); }
  /** Remove a context (used when its owning instance — category/course/cm — is deleted). Assignments/overrides cascade. */
  async deleteContext(id: number): Promise<void> { await this.repo.deleteContext(id); }
  async deleteByLevelInstance(contextlevel: number, instanceid: number): Promise<void> {
    const row = await this.repo.getContextByLevelInstance(contextlevel, instanceid);
    if (row) await this.repo.deleteContext(row.id);
  }

  /** Ancestor chain including the context itself, ordered leaf → root, following `path`. */
  async getPathContexts(ctx: ContextRow): Promise<ContextRow[]> {
    const ids = ctx.path.split('/').filter(Boolean).map(Number);
    const rows = await this.repo.getContextsByIds(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.slice().reverse().map((id) => byId.get(id)!).filter(Boolean);
  }

  /** Move a context (and its whole subtree) under a new parent, rewriting path/depth. Used when a category is moved. */
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
  async markContextDirty(contextId: number): Promise<void> {
    const ctx = await this.repo.getContextById(contextId);
    if (ctx) await this.repo.bumpContextVersions(ctx.path);
  }
  /** Cache stamp for a context path: changes whenever any context on the path (or the system root) is dirtied. */
  pathVersionStamp(pathContexts: ContextRow[]): string {
    return pathContexts.map((c) => `${c.id}:${c.version}`).join('|');
  }
}
