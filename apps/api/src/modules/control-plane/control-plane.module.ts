import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { ControlPlaneConnection } from './control-plane.connection';
import { ControlPlaneController } from './control-plane.controller';
import { ControlPlaneRepository } from './control-plane.repository';
import { ControlPlaneRegistryService } from './control-plane.service';

/**
 * ControlPlaneModule (issue #580): sổ đăng ký không gian + registry
 * phiên bản schema trên database control plane riêng. Import
 * AccessModule để dùng PermissionEvaluator/ContextsService cho cổng
 * quản trị platform; xuất ControlPlaneRegistryService để SeedModule
 * gieo hai không gian hiện hữu khi khởi động, và xuất
 * ControlPlaneConnection để khung định tuyến theo trung tâm (issue
 * #581) đọc sổ đăng ký qua đúng một kết nối control plane của tiến
 * trình thay vì tự mở kết nối thứ hai. Từ issue #587 (hạng mục 3)
 * module còn xuất ControlPlaneRepository: thư mục định tuyến của
 * không gian kho riêng (thành viên + mã tham gia lớp) nằm trong
 * cùng repository của control plane để các module nghiệp vụ
 * (tenants, classes) đọc/ghi thư mục qua đúng một điểm truy cập
 * của database này.
 */
@Module({
  imports: [AccessModule],
  controllers: [ControlPlaneController],
  providers: [ControlPlaneConnection, ControlPlaneRepository, ControlPlaneRegistryService],
  exports: [ControlPlaneRegistryService, ControlPlaneConnection, ControlPlaneRepository],
})
export class ControlPlaneModule {}
