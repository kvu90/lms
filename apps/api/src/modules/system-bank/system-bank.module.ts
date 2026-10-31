import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { QuestionsModule } from '../questions/questions.module';
import { TenantsModule } from '../tenants/tenants.module';
import { SystemBankCentreRepository } from './system-bank-centre.repository';
import { SystemBankConnection } from './system-bank.connection';
import { SystemBankController } from './system-bank.controller';
import { SystemBankDiscoveryController } from './system-bank-discovery.controller';
import { SystemBankPackagesController } from './system-bank-packages.controller';
import { SystemBankRepository } from './system-bank.repository';
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
 */
@Module({
  imports: [AccessModule, QuestionsModule, TenantsModule],
  controllers: [SystemBankController, SystemBankDiscoveryController, SystemBankPackagesController],
  providers: [SystemBankConnection, SystemBankRepository, SystemBankCentreRepository, SystemBankService],
  exports: [SystemBankService, SystemBankConnection],
})
export class SystemBankModule {}
