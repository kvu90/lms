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
/**
 * Phiên đăng nhập phía server (bảng sessions): tạo, đọc, huỷ và xoay id phiên.
 * Session id là giá trị ngẫu nhiên khó đoán, chỉ lưu hash phía server.
 */
export class SessionService {
  constructor(private readonly store: SessionCacheService) {}
  /**
   * Tạo phiên mới cho user và trả session id thô.
   */
  async create(data: Omit<WebSession, 'createdAt'>): Promise<string> {
    const id = randomUUID();
    await this.store.set(`web:${id}`, { ...data, createdAt: new Date().toISOString() } satisfies WebSession);
    return id;
  }
  /**
   * Lấy phiên theo session id thô (so khớp qua hash).
   */
  async get(id: string): Promise<WebSession | undefined> { return this.store.get<WebSession>(`web:${id}`); }
  /**
   * Huỷ phiên (đăng xuất).
   */
  async destroy(id: string): Promise<void> { await this.store.delete(`web:${id}`); }
  /** Rotate: destroy the old id (if any) and issue a fresh one for the same identity. */
  /**
   * Xoay session id (sau đăng nhập/leo quyền) để chống fixation; phiên cũ bị huỷ.
   */
  async rotate(oldId: string | undefined, data: Omit<WebSession, 'createdAt'>): Promise<string> {
    if (oldId) await this.destroy(oldId);
    return this.create(data);
  }
}
