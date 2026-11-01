import { forwardRef, Module, ServiceUnavailableException } from '@nestjs/common';
import { ControlPlaneRepository } from '@lms/db/repositories/control-plane';
import { AccessModule } from '../access/access.module';
import { ControlPlaneConnection } from './control-plane.connection';
import { ControlPlaneController } from './control-plane.controller';
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
 *
 * Từ pilot Kysely (issue #640), repository sống ở `@lms/db` (lớp
 * thuần, không phụ thuộc Nest) nên module lắp nó bằng factory
 * provider: handle lấy từ adapter `ControlPlaneConnection`, và hàm
 * dựng lỗi chưa-cấu-hình là `ServiceUnavailableException` mang mã
 * `control_plane.not_configured` — đúng hình dạng lỗi 503 mà đường
 * Drizzle trước đây ném từ trong repository.
 */
@Module({
  // forwardRef ở cạnh AccessModule: module này thuộc vòng module
  // tường minh AccessModule → SpaceRoutingModule →
  // ControlPlaneModule → AccessModule kể từ khi AccessModule
  // import SpaceRoutingModule cho PermissionEvaluator (issue
  // #587, tiền điều kiện TĐ6) — forwardRef ở mọi cạnh của vòng
  // như khuôn AuthModule ↔ UsersModule (xem access.module.ts).
  imports: [forwardRef(() => AccessModule)],
  controllers: [ControlPlaneController],
  providers: [
    ControlPlaneConnection,
    {
      provide: ControlPlaneRepository,
      useFactory: (connection: ControlPlaneConnection) =>
        new ControlPlaneRepository(connection.kysely, () =>
          new ServiceUnavailableException({
            message: 'Control plane database is not configured',
            code: 'control_plane.not_configured',
          }),
        ),
      inject: [ControlPlaneConnection],
    },
    ControlPlaneRegistryService,
  ],
  exports: [ControlPlaneRegistryService, ControlPlaneConnection, ControlPlaneRepository],
})
export class ControlPlaneModule {}
