import { forwardRef, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import type { CentreDb } from '@lms/db';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { tenantAls } from '../../modules/tenants/tenant-als';
import { EventLogWriter } from './event-log-writer.service';
import { OutboxService } from './outbox.service';

/**
 * Hàm phân giải handle Kysely theo ngữ cảnh cho các đường ghi
 * KHÔNG mang transaction của phía gọi (standalone của outbox,
 * writer event log): ngữ cảnh mang slug thì chuẩn bị phía Kysely
 * cho đúng slug đó qua `getKyselyForSpace` (hàm chuẩn bị không
 * tác dụng phụ khi đã chuẩn bị — trả đúng handle đã chốt), ngữ
 * cảnh không mang slug thì dùng facade định tuyến (kho chung).
 * Lý do phải chuẩn bị tường minh: facade Kysely fail-closed cho
 * trung tâm kho riêng chưa được chuẩn bị trong phiên, và các
 * đường ghi không mang transaction không đi qua bước chuẩn bị
 * của tầng gắn ngữ cảnh.
 */
function spaceKyselyResolver(spaceDb: SpaceDatabaseService): () => Promise<CentreDb> {
  return async () => {
    const slug = tenantAls.getStore()?.spaceSlug;
    return slug ? spaceDb.getKyselyForSpace(slug) : spaceDb.routedKysely;
  };
}

/**
 * Module hạ tầng sự kiện: outbox giao dịch và writer phản chiếu
 * event log. Sau chuyển đổi Kysely (D1, issue #653) cả hai service
 * nhận handle Kysely kho trung tâm qua factory trên facade định
 * tuyến theo không gian (`SpaceDatabaseService.routedKysely`) —
 * cùng khuôn lắp repository của các module đã chuyển — kèm hàm
 * phân giải handle theo ngữ cảnh cho các đường ghi không mang
 * transaction của phía gọi (xem `spaceKyselyResolver`). Cạnh
 * import SpaceRoutingModule dùng forwardRef vì module này nằm
 * trong vòng module tường minh AccessModule → EventsModule →
 * SpaceRoutingModule → ControlPlaneModule → AccessModule (cùng
 * khuôn các cạnh còn lại của vòng).
 */
@Module({
  imports: [EventEmitterModule.forRoot(), forwardRef(() => SpaceRoutingModule)],
  providers: [
    {
      provide: OutboxService,
      useFactory: (spaceDb: SpaceDatabaseService) =>
        new OutboxService(spaceDb.routedKysely, spaceKyselyResolver(spaceDb)),
      inject: [SpaceDatabaseService],
    },
    {
      provide: EventLogWriter,
      useFactory: (spaceDb: SpaceDatabaseService) =>
        new EventLogWriter(spaceDb.routedKysely, spaceKyselyResolver(spaceDb)),
      inject: [SpaceDatabaseService],
    },
  ],
  exports: [OutboxService, EventLogWriter],
})
export class EventsModule {}
