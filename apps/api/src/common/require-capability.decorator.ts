import { SetMetadata } from '@nestjs/common';
export const REQUIRE_CAPABILITY_KEY = 'requireCapability';
export interface CapabilityRequirement {
  capability: string;
  /** Where to resolve the target context id from. Default: the system context. */
  contextResolver?: 'system' | 'param:contextId' | 'query:contextId' | 'body:contextId' | 'param:userId:userctx';
}
/**
 * Declares the Moodle capability a route requires (report §3.3). Enforced by
 * CapabilityGuard via PermissionEvaluator — capabilities are NEVER read from
 * the JWT; the token only carries identity.
 */
export const RequireCapability = (capability: string, contextResolver: CapabilityRequirement['contextResolver'] = 'system') =>
  SetMetadata(REQUIRE_CAPABILITY_KEY, { capability, contextResolver } satisfies CapabilityRequirement);
