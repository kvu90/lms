import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { healthStatusSchema, type HealthStatus } from '@lms/contracts';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { redisTlsFromUrl } from '../../config/env';
import type { Database } from '../../db/database';

/**
 * Các kiểm tra runtime có cấu trúc theo tinh thần Check API của Moodle:
 * mỗi phụ thuộc báo up/down độc lập; payload được kiểm chứng
 * đối chiếu với contract dùng chung trước khi rời khỏi tiến trình.
 */
@Injectable()
/**
 * Kiểm tra sức khoẻ hệ thống: SELECT 1 tới PostgreSQL và PING Redis, trả trạng thái tổng hợp cho /health.
 */
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @Inject(ConfigService) config: ConfigService,
  ) {
    const redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      ...redisTlsFromUrl(redisUrl),
    });
  }

  private async probe(check: () => Promise<boolean>): Promise<'up' | 'down'> {
    try {
      return (await check()) ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }

  /**
   * Thực thi kiểm tra DB + Redis và dựng kết quả health.
   */
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

  /**
   * Đóng kết nối Redis khi module bị huỷ.
   */
  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
