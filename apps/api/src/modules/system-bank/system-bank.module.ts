import { Module, ServiceUnavailableException } from '@nestjs/common';
import { SystemBankCentreRepository } from '@lms/db/repositories/system-bank-centre';
import { SystemBankRepository } from '@lms/db/repositories/system-bank';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { AccessModule } from '../access/access.module';
import { QuestionsModule } from '../questions/questions.module';
import { TenantsModule } from '../tenants/tenants.module';
import { SystemBankConnection } from './system-bank.connection';
import { SystemBankController } from './system-bank.controller';
import { SystemBankDiscoveryController } from './system-bank-discovery.controller';
import { SystemBankPackagesController } from './system-bank-packages.controller';
import { SystemBankService } from './system-bank.service';

/**
 * SystemBankModule (issue #585): kho ngân hàng hệ thống trên database
 * riêng phía platform — bản chính tập trung, phiên bản bất biến, giáo
 * viên tìm câu qua API và nhập bản chụp đúng phiên bản vào kho trung
 * tâm. Import AccessModule để dùng PermissionEvaluator/ContextsService
 * cho cổng quản trị platform; xuất SystemBankService để các lát sau
 * (khám phá, nhập bản chụp, gói YCCĐ) và module khác dùng chung, và
 * xuất SystemBankConnection để các công cụ vận hành (di trú dữ kiện)
 * dùng đúng một kết nối kho ngân hàng của tiến trình.
 *
 * Từ hạng mục nhân rộng G10 (issue #650), cả hai repository sống ở
 * `@lms/db` (lớp thuần, không phụ thuộc Nest) nên module lắp chúng
 * bằng factory provider theo khuôn pilot kho control plane:
 * - Repository kho ngân hàng nhận handle Kysely từ adapter
 *   `SystemBankConnection` (kết nối riêng chuyên dụng), kèm hàm dựng
 *   lỗi chưa-cấu-hình là `ServiceUnavailableException` mang mã
 *   `system_bank.not_configured` — đúng hình dạng lỗi 503 mà đường
 *   Drizzle trước đây ném từ trong repository.
 * - Repository phía trung tâm nhận handle Kysely ĐỊNH TUYẾN THEO
 *   KHÔNG GIAN (`SpaceDatabaseService.routedKysely` qua
 *   SpaceRoutingModule): hai handle giữ tách biệt tuyệt đối, không
 *   gộp và không fallback qua nhau.
 */
@Module({
  imports: [AccessModule, QuestionsModule, TenantsModule, SpaceRoutingModule],
  controllers: [SystemBankController, SystemBankDiscoveryController, SystemBankPackagesController],
  providers: [
    SystemBankConnection,
    {
      provide: SystemBankRepository,
      useFactory: (connection: SystemBankConnection) =>
        new SystemBankRepository(connection.kysely, () =>
          new ServiceUnavailableException({
            message: 'System bank is not configured (SYSTEM_BANK_DATABASE_URL is not set)',
            code: 'system_bank.not_configured',
          }),
        ),
      inject: [SystemBankConnection],
    },
    {
      provide: SystemBankCentreRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new SystemBankCentreRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    SystemBankService,
  ],
  exports: [SystemBankService, SystemBankConnection],
})
export class SystemBankModule {}
