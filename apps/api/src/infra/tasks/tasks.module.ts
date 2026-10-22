import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DistributedLockService } from './distributed-lock.service';
import { SAMPLE_QUEUE, SampleProducerService } from './sample.producer';
import { SampleScheduledService } from './sample.scheduled';

@Module({
  imports: [BullModule.registerQueue({ name: SAMPLE_QUEUE })],
  providers: [DistributedLockService, SampleProducerService, SampleScheduledService],
  exports: [DistributedLockService, SampleProducerService, SampleScheduledService],
})
export class TasksModule {}
