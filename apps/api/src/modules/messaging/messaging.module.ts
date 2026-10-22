import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { UsersModule } from '../users/users.module';
import { MessagingController, NotificationsController } from './messaging.controller';
import { MessagingRepository } from './messaging.repository';
import { MessagingService, NOTIFICATION_DISPATCH_QUEUE } from './messaging.service';

/**
 * MessagingModule facade: MessagingService (conversations, messages,
 * notifications, provider preferences, blocked contacts). Other modules
 * notify users ONLY through this facade (report §3.12).
 */
@Module({
  imports: [
    AccessModule, UsersModule, EventsModule,
    BullModule.registerQueue({ name: NOTIFICATION_DISPATCH_QUEUE }),
  ],
  controllers: [MessagingController, NotificationsController],
  providers: [MessagingRepository, MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
