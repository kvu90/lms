import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  createMessagingDistributionService,
  createMessagingDistributionStore,
  type MessagingDistributionService,
} from '@lms/messaging';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Redis from 'ioredis';
import type { relations } from './db/relations';
import { createMessagingRealtimeEmitter, type MessagingRealtimeEmitterHandle } from './messaging-realtime-emitter';

type Database = NodePgDatabase<typeof relations>;

/**
 * Runtime của consumer phân phối realtime messaging ở worker
 * (issue #521): sở hữu các tài nguyên sống theo tiến trình mà
 * processor cần — tầng phân phối dùng chung của `@lms/messaging`
 * (dựng trên kết nối DB của worker), connection Redis giữ dấu
 * đã-phân-phối theo `outboxId`, và cổng phát realtime qua Redis
 * adapter — rồi đóng tất cả khi module tắt, để không rò connection
 * qua các vòng boot (nhất là trong test boot module nhiều lần).
 */
@Injectable()
export class MessagingRealtimeRuntime implements OnModuleDestroy {
  /** Tầng phân phối dùng chung (luật ở `@lms/messaging`). */
  readonly distribution: MessagingDistributionService;
  /** Connection Redis giữ dấu đã-phân-phối của consumer. */
  readonly redis: Redis;
  private readonly emitterHandle: MessagingRealtimeEmitterHandle;

  constructor(
    @InjectDrizzle() db: Database,
    @Inject(ConfigService) config: ConfigService,
  ) {
    const logger = new Logger('MessagingDistribution');
    const redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.emitterHandle = createMessagingRealtimeEmitter(redisUrl);
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.redis.on('error', (error: Error) => {
      logger.warn(`Redis của consumer phân phối messaging lỗi: ${error.message}`);
    });
    this.distribution = createMessagingDistributionService({
      store: createMessagingDistributionStore(db),
      emitter: this.emitterHandle.emitter,
      logger: {
        warn: (message) => logger.warn(message),
        error: (message) => logger.error(message),
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.emitterHandle.close();
    await this.redis.quit().catch(() => undefined);
  }
}
