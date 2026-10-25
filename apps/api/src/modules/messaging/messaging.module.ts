import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { SiteConfigModule } from '../site-config/site-config.module';
import { UsersModule } from '../users/users.module';
import { MessagingController, NotificationsController } from './messaging.controller';
import { MessagingGateway } from './messaging.gateway';
import { MessagingOutboxConsumer } from './messaging-outbox.consumer';
import { NotificationEventsConsumer } from './notification-events.consumer';
import { MessagingRealtimeService } from './messaging-realtime.service';
import { MessagingRepository } from './messaging.repository';
import { MessagingSendThrottleService } from './messaging-send-throttle.service';
import { MessagingService, NOTIFICATION_DISPATCH_QUEUE } from './messaging.service';
import { JwtMessagingSocketAuth } from './messaging-socket-auth';
import { NotificationUnreadStreamService } from './notification-unread-stream.service';

/**
 * MessagingModule facade: MessagingService (conversations, messages,
 * notifications, provider preferences, blocked contacts). Other modules
 * notify users ONLY through this facade (report §3.12).
 */
@Module({
  imports: [
    AccessModule, UsersModule, EventsModule, SiteConfigModule,
    BullModule.registerQueue({ name: NOTIFICATION_DISPATCH_QUEUE }),
  ],
  controllers: [MessagingController, NotificationsController],
  providers: [
    MessagingRepository, MessagingService, NotificationUnreadStreamService,
    // Throttle gửi tin theo người dùng bằng Redis (lát M2, issue #212).
    MessagingSendThrottleService,
    // Realtime (issue #33): gateway Socket.IO + lớp auth mỏng + tầng
    // phân phối (Redis adapter, presence/typing) + consumer quét
    // outbox để phân phối sự kiện đã commit.
    JwtMessagingSocketAuth, MessagingRealtimeService, MessagingGateway, MessagingOutboxConsumer,
    // Nối dây thông báo (issue #49): consumer quét outbox biến sự kiện
    // nghiệp vụ (điểm mới / hoàn thành khoá / sắp hết hạn ghi danh /
    // tin nhắn mới) thành notification qua MessagingService.notify().
    NotificationEventsConsumer,
  ],
  exports: [MessagingService],
})
/** Module nhắn tin và thông báo. */
export class MessagingModule {}
