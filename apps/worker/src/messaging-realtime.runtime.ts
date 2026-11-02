import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createMessagingDistributionService,
  createMessagingDistributionStore,
  type MessagingDistributionService,
} from '@lms/messaging';
import Redis from 'ioredis';
import { SpaceDatabaseService } from './db/routing/space-database.service';
import { createMessagingRealtimeEmitter, type MessagingRealtimeEmitterHandle } from './messaging-realtime-emitter';

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
    spaceDb: SpaceDatabaseService,
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
      // Tầng store dùng chung nay nhận handle Kysely (issue #658):
      // truyền facade định tuyến theo không gian của worker —
      // cùng handle mà các processor của job hiện hành dùng qua
      // SpaceJobRunner, nên ngữ cảnh kho/GUC của lượt phân phối
      // không đổi so với đường cũ trước đây.
      store: createMessagingDistributionStore(spaceDb.routedKysely),
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
