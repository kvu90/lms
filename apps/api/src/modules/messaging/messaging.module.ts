import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { SiteConfigModule } from '../site-config/site-config.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { BetterAuthModule } from '../auth/better-auth/better-auth.module';
import { MessagingController, NotificationsController } from './messaging.controller';
import { MessagingGateway } from './messaging.gateway';

import { MessagingRealtimeService } from './messaging-realtime.service';
import { MessagingRepository } from '@lms/db/repositories/messaging';
import { createMessagingStore } from '@lms/messaging';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
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
    // Tiền điều kiện Phần B (issue #587, hạng mục 1): lớp auth của
    // gateway và gateway phân giải không gian theo Host của
    // handshake và đọc dữ kiện theo kết nối trong kho của trung
    // tâm — cần SpaceDatabaseService (SpaceRoutingModule) và
    // TenantsService cho ngoại lệ phiên vận hành platform của
    // đường token (TenantsModule).
    SpaceRoutingModule, TenantsModule,
    BullModule.registerQueue({ name: NOTIFICATION_DISPATCH_QUEUE }),
  ],
  controllers: [MessagingController, NotificationsController],
  providers: [
    {
      // MessagingRepository nay là repository Kysely của `@lms/db`
      // (issue #658): provider dựng bằng factory với handle kho
      // trung tâm ĐÃ ĐỊNH TUYẾN THEO KHÔNG GIAN (`routedKysely`
      // của SpaceDatabaseService) và cài đặt của cổng store dùng
      // chung do `@lms/messaging` cấp trên cùng handle đó —
      // repository uỷ quyền các phép đọc dùng chung qua cổng, nên
      // `@lms/db` không phụ thuộc ngược vào `@lms/messaging`.
      provide: MessagingRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new MessagingRepository(
        spaceDb.routedKysely,
        createMessagingStore(spaceDb.routedKysely),
      ),
      inject: [SpaceDatabaseService],
    },
    MessagingService, NotificationUnreadStreamService,
    // Throttle gửi tin theo người dùng bằng Redis (lát M2, issue #212).
    MessagingSendThrottleService,
    // Realtime (issue #33): gateway Socket.IO + lớp auth mỏng + tầng
    // realtime phía kết nối (Redis adapter, presence/typing).
    MessagingSocketAuth, MessagingRealtimeService, MessagingGateway,
    // Cả hai consumer quét outbox đều đã chuyển sang worker: phân
    // phối sự kiện messaging qua hàng đợi `messaging-realtime`
    // (issue con #521 của #491; consumer hàng đợi ở worker, luật
    // phân phối ở `@lms/messaging`) và thông báo sự kiện nghiệp vụ
    // qua hàng đợi `notification-events` (issue con #520 của
    // #491). Phía API không còn consumer polling nào đọc trực
    // tiếp bảng outbox.
  ],
  exports: [MessagingService],
})
/** Module nhắn tin và thông báo. */
export class MessagingModule {}
