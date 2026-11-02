import { forwardRef, Module } from '@nestjs/common';
import { AccessRepository } from '@lms/db/repositories/access';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { CacheInfraModule } from '../../infra/cache/cache-infra.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessController } from './access.controller';
import { ContextsService } from './contexts.service';
import { PermissionEvaluator } from './permission-evaluator.service';
import { PlanLimitsService } from './plan-limits.service';
import { RoleSeparationService } from './role-separation.service';
import { RolesService } from './roles.service';

/** Facade của AccessModule: ContextsService, RolesService, PermissionEvaluator. Các repository giữ ở chế độ private.
 * PlanLimitsService (thực thi giới hạn slot của gói, issue #189) đặt tại
 * module này vì đây là tầng chung thấp nhất mà mọi bề mặt điểm chặn
 * (access/tenants/users/courses) đều phụ thuộc vào.
 * RoleSeparationService (định nghĩa kiểm tra tách vai giáo viên/học viên
 * dùng chung) cũng đặt tại đây vì cả ba funnel ghi danh (enrol, groups,
 * backup) và đường gán vai đều phải gọi về đúng một định nghĩa này. */
@Module({
  imports: [
    CacheInfraModule, EventsModule,
    // SpaceRoutingModule: PermissionEvaluator cần SpaceDatabaseService
    // để lấy danh tính kho của ngữ cảnh hiện tại cho khoá cache
    // `siteadmins` (issue #587, tiền điều kiện TĐ6), và
    // AccessRepository cần handle `routedKysely` của nó (xem
    // provider factory bên dưới). Cạnh này khép
    // vòng module tường minh AccessModule → SpaceRoutingModule →
    // ControlPlaneModule → AccessModule (ControlPlaneModule import
    // module này cho chính PermissionEvaluator/ContextsService), nên
    // forwardRef ở mọi cạnh của vòng như khuôn AuthModule ↔
    // UsersModule (xem space-routing.module.ts và
    // control-plane.module.ts); chuỗi provider của
    // SpaceDatabaseService kết thúc ở ConfigService +
    // ControlPlaneConnection, không phụ thuộc ngược vào module này.
    forwardRef(() => SpaceRoutingModule),
  ],
  controllers: [AccessController],
  providers: [
    {
      // AccessRepository nay là repository Kysely của `@lms/db`
      // (issue #651): provider dựng bằng factory với handle kho
      // trung tâm ĐÃ ĐỊNH TUYẾN THEO KHÔNG GIAN (`routedKysely`
      // của SpaceDatabaseService), cùng khuôn với các repository
      // đã chuyển trước đó. Evaluator đọc cổng tenant qua không
      // gian của request nên handle phải là facade định tuyến,
      // không phải handle kho cố định.
      provide: AccessRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new AccessRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    ContextsService, RolesService, PermissionEvaluator, PlanLimitsService, RoleSeparationService,
  ],
  exports: [ContextsService, RolesService, PermissionEvaluator, PlanLimitsService, RoleSeparationService],
})
/** Module phân quyền: context, capability, role. */
export class AccessModule {}
