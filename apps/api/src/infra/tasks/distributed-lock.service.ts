import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

/**
 * Redis distributed lock (self-built on the Redis client BullMQ already
 * requires): SET key token PX ttl NX. Release only deletes our own token.
 */
@Injectable()
export class DistributedLockService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
  }

  /** Returns an ownership token, or null when another holder owns the lock. */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.client.set(
      `lms:lock:${key}`, token, 'PX', ttlMs, 'NX',
    );
    return result === 'OK' ? token : null;
  }

  async release(key: string, token: string): Promise<void> {
    await this.client.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      `lms:lock:${key}`,
      token,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
