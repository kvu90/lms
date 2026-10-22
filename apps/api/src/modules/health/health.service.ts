import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { healthStatusSchema, type HealthStatus } from '@lms/contracts';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import type { Database } from '../../db/database';

/**
 * Structured runtime checks in the spirit of Moodle's Check API:
 * each dependency reports up/down independently; the payload is validated
 * against the shared contract before it leaves the process.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
  }

  private async probe(check: () => Promise<boolean>): Promise<'up' | 'down'> {
    try {
      return (await check()) ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }

  async check(): Promise<HealthStatus> {
    const database = await this.probe(async () => {
      await this.db.execute(sql`select 1`);
      return true;
    });
    const redis = await this.probe(async () => (await this.redis.ping()) === 'PONG');
    return healthStatusSchema.parse({
      status: database === 'up' && redis === 'up' ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      checks: { database, redis },
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
