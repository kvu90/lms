import { Module } from '@nestjs/common';
import { CacheInfraModule } from '../../infra/cache/cache-infra.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessController } from './access.controller';
import { AccessRepository } from './access.repository';
import { ContextsService } from './contexts.service';
import { PermissionEvaluator } from './permission-evaluator.service';
import { PlanLimitsService } from './plan-limits.service';
import { RolesService } from './roles.service';

/** AccessModule facade: ContextsService, RolesService, PermissionEvaluator. Repositories stay private.
 * PlanLimitsService (thực thi giới hạn slot của gói, issue #189) đặt tại
 * module này vì đây là tầng chung thấp nhất mà mọi bề mặt điểm chặn
 * (access/tenants/users/courses) đều phụ thuộc vào. */
@Module({
  imports: [CacheInfraModule, EventsModule],
  controllers: [AccessController],
  providers: [AccessRepository, ContextsService, RolesService, PermissionEvaluator, PlanLimitsService],
  exports: [ContextsService, RolesService, PermissionEvaluator, PlanLimitsService],
})
/** Module phân quyền: context, capability, role. */
export class AccessModule {}
