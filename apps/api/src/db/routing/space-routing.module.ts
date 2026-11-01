import { forwardRef, Module } from '@nestjs/common';
import { ControlPlaneModule } from '../../modules/control-plane/control-plane.module';
import { SpaceDatabaseService } from './space-database.service';

/**
 * SpaceRoutingModule (issue #581): khung định tuyến kết nối theo
 * trung tâm ở tầng dữ kiện. Import ControlPlaneModule để dùng chung
 * kết nối control plane (nguồn đọc sổ đăng ký của bộ phân giải);
 * xuất `SpaceDatabaseService` cho nhà cung cấp kết nối của API
 * (`app.module.ts` gắn handle kho chung và nhận handle định tuyến)
 * và cho các tầng gắn ngữ cảnh/trình nền ở các issue kế tiếp.
 */
@Module({
  // forwardRef ở cạnh ControlPlaneModule: module này thuộc vòng
  // module tường minh AccessModule → SpaceRoutingModule →
  // ControlPlaneModule → AccessModule kể từ khi AccessModule
  // import ngược module này cho PermissionEvaluator (issue #587,
  // tiền điều kiện TĐ6) — forwardRef ở mọi cạnh của vòng như
  // khuôn AuthModule ↔ UsersModule (xem access.module.ts).
  imports: [forwardRef(() => ControlPlaneModule)],
  providers: [SpaceDatabaseService],
  exports: [SpaceDatabaseService],
})
export class SpaceRoutingModule {}
