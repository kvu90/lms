import { Injectable, Scope } from '@nestjs/common';

/**
 * MUC "request" mode: a plain in-memory Map bound to one request's lifecycle
 * via a REQUEST-scoped provider. Never touches Redis.
 */
@Injectable({ scope: Scope.REQUEST })
export class RequestCacheService {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, value);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}
