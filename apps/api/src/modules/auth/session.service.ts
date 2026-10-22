import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SessionCacheService } from '../../infra/cache/session-cache.service';

export interface WebSession { userId: number; username: string; createdAt: string; loginAs?: { byUserId: number } }

/**
 * SessionModule (inside AuthModule per report §3.7): server-side web sessions
 * in the Redis *session* cache namespace. The cookie carries only the id;
 * login rotates the id (fixation protection) and suspended/deleted users'
 * sessions stop validating because AuthService re-checks account status on
 * every session read.
 */
@Injectable()
export class SessionService {
  constructor(private readonly store: SessionCacheService) {}
  async create(data: Omit<WebSession, 'createdAt'>): Promise<string> {
    const id = randomUUID();
    await this.store.set(`web:${id}`, { ...data, createdAt: new Date().toISOString() } satisfies WebSession);
    return id;
  }
  async get(id: string): Promise<WebSession | undefined> { return this.store.get<WebSession>(`web:${id}`); }
  async destroy(id: string): Promise<void> { await this.store.delete(`web:${id}`); }
  /** Rotate: destroy the old id (if any) and issue a fresh one for the same identity. */
  async rotate(oldId: string | undefined, data: Omit<WebSession, 'createdAt'>): Promise<string> {
    if (oldId) await this.destroy(oldId);
    return this.create(data);
  }
}
