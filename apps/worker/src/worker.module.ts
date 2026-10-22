import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DrizzleModule } from '@nestjs/drizzle';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { drizzle } from 'drizzle-orm/node-postgres';
import { redisConnectionFromUrl, validateEnv } from './config/env';
import { relations } from './db/relations';
import { OutboxRelayScheduler } from './outbox-relay.scheduler';
import { SampleProcessor } from './processors/sample.processor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DrizzleModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        drizzle,
        connection: config.getOrThrow<string>('DATABASE_URL'),
        relations,
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnectionFromUrl(config.getOrThrow<string>('REDIS_URL')),
      }),
    }),
    BullModule.registerQueue({ name: 'sample' }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
  ],
  providers: [SampleProcessor, OutboxRelayScheduler],
})
export class WorkerModule {}
