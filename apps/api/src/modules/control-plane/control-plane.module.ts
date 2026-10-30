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
 * trình thay vì tự mở kết nối thứ hai.
 */
@Module({
  imports: [AccessModule],
  controllers: [ControlPlaneController],
  providers: [ControlPlaneConnection, ControlPlaneRepository, ControlPlaneRegistryService],
  exports: [ControlPlaneRegistryService, ControlPlaneConnection],
})
export class ControlPlaneModule {}
