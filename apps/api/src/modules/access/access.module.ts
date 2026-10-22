import { Module } from '@nestjs/common';
import { CacheInfraModule } from '../../infra/cache/cache-infra.module';
import { AccessController } from './access.controller';
import { AccessRepository } from './access.repository';
import { ContextsService } from './contexts.service';
import { PermissionEvaluator } from './permission-evaluator.service';
import { RolesService } from './roles.service';

/** AccessModule facade: ContextsService, RolesService, PermissionEvaluator. Repositories stay private. */
@Module({
  imports: [CacheInfraModule],
  controllers: [AccessController],
  providers: [AccessRepository, ContextsService, RolesService, PermissionEvaluator],
  exports: [ContextsService, RolesService, PermissionEvaluator],
})
/** Module phân quyền: context, capability, role. */
export class AccessModule {}
