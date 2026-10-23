import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_CAPABILITY_KEY, type CapabilityRequirement } from './require-capability.decorator';
import { ContextsService } from '../modules/access/contexts.service';
import { PermissionEvaluator } from '../modules/access/permission-evaluator.service';
import { CONTEXT_LEVELS } from '../modules/access/domain/capabilities';
import type { AuthenticatedUser } from './current-user.decorator';

/** Enforces @RequireCapability metadata through PermissionEvaluator. Runs after JwtAuthGuard. */
@Injectable()
export class CapabilityGuard {
  constructor(
    private readonly reflector: Reflector,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<CapabilityRequirement>(REQUIRE_CAPABILITY_KEY, [context.getHandler(), context.getClass()]);
    if (!requirement) return true;
    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser; params: Record<string, string>; query: Record<string, string>; body?: Record<string, unknown> }>();
    if (!req.user) throw new ForbiddenException({ message: 'Authentication required for capability check', code: 'access.capability_denied' });
    const contextId = await this.resolveContextId(requirement, req);
    const ok = await this.evaluator.hasCapability(req.user.id, requirement.capability, contextId, { isGuest: req.user.username === 'guest' });
    if (!ok) throw new ForbiddenException({ message: `Missing capability ${requirement.capability}`, code: 'access.capability_denied' });
    return true;
  }
  private async resolveContextId(req: CapabilityRequirement, http: { params: Record<string, string>; query: Record<string, string>; body?: Record<string, unknown> }): Promise<string> {
    switch (req.contextResolver) {
      case 'param:contextId': return http.params.contextId!;
      case 'query:contextId': return http.query.contextId ?? (await this.contexts.ensureSystemContext()).id;
      case 'body:contextId': return String(http.body?.contextId ?? http.body?.contextId ?? (await this.contexts.ensureSystemContext()).id);
      case 'param:userId:userctx': {
        const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.USER, http.params.id!);
        if (ctx) return ctx.id;
        return (await this.contexts.ensureSystemContext()).id;
      }
      default: return (await this.contexts.ensureSystemContext()).id;
    }
  }
}
