import { Module } from '@nestjs/common';
import { CacheInfraModule } from '../../infra/cache/cache-infra.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessController } from './access.controller';
import { AccessRepository } from './access.repository';
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
  imports: [CacheInfraModule, EventsModule],
  controllers: [AccessController],
  providers: [AccessRepository, ContextsService, RolesService, PermissionEvaluator, PlanLimitsService, RoleSeparationService],
  exports: [ContextsService, RolesService, PermissionEvaluator, PlanLimitsService, RoleSeparationService],
})
/** Module phân quyền: context, capability, role. */
export class AccessModule {}
