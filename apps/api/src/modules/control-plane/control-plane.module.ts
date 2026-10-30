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
 * gieo hai không gian hiện hữu khi khởi động.
 */
@Module({
  imports: [AccessModule],
  controllers: [ControlPlaneController],
  providers: [ControlPlaneConnection, ControlPlaneRepository, ControlPlaneRegistryService],
  exports: [ControlPlaneRegistryService],
})
export class ControlPlaneModule {}
