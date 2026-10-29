import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { SiteConfigModule } from '../site-config/site-config.module';
import { UsersModule } from '../users/users.module';
import { BetterAuthModule } from '../auth/better-auth/better-auth.module';
import { MessagingController, NotificationsController } from './messaging.controller';
import { MessagingGateway } from './messaging.gateway';
import { MessagingOutboxConsumer } from './messaging-outbox.consumer';
import { MessagingRealtimeService } from './messaging-realtime.service';
import { MessagingRepository } from './messaging.repository';
import { MessagingSendThrottleService } from './messaging-send-throttle.service';
import { MessagingService, NOTIFICATION_DISPATCH_QUEUE } from './messaging.service';
import { MessagingSocketAuth } from './messaging-socket-auth';
import { NotificationUnreadStreamService } from './notification-unread-stream.service';

/**
 * Facade của MessagingModule: MessagingService (conversations, messages,
 * notifications, tuỳ chọn provider, blocked contacts). Các module khác
 * thông báo cho người dùng CHỈ thông qua facade này (report §3.12).
 * Bên trong, MessagingService là facade uỷ quyền cho năm service cụm
 * theo ca sử dụng (tách cụm, issue #295) — wiring của module không đổi.
 */
@Module({
  imports: [
    AccessModule, UsersModule, EventsModule, SiteConfigModule,
    // GĐ5 (issue #7): lớp auth của gateway nhận thêm phiên cookie
    // Better Auth — cần BetterAuthService (instance tự tắt khi cờ off).
    BetterAuthModule,
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
    MessagingSocketAuth, MessagingRealtimeService, MessagingGateway, MessagingOutboxConsumer,
    // Consumer thông báo sự kiện không còn nằm ở API: mười loại sự
    // kiện nghiệp vụ được relay outbox phát sang hàng đợi ở worker
    // và xử lý ở đó (issue con #520 của #491). API chỉ giữ consumer
    // realtime ở trên cho tới khi consumer đó chuyển ở issue #521.
  ],
  exports: [MessagingService],
})
/** Module nhắn tin và thông báo. */
export class MessagingModule {}
