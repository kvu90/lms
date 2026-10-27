import { SetMetadata } from '@nestjs/common';
export const REQUIRE_CAPABILITY_KEY = 'requireCapability';
export interface CapabilityRequirement {
  capability: string;
  /** Nơi phân giải id của context đích. Mặc định: context hệ thống. */
  contextResolver?: 'system' | 'param:contextId' | 'query:contextId' | 'body:contextId' | 'param:userId:userctx';
}
/**
 * Khai báo capability kiểu Moodle mà một route yêu cầu (report §3.3). Được thực thi bởi
 * CapabilityGuard thông qua PermissionEvaluator — capability KHÔNG BAO GIỜ được đọc từ
 * JWT; token chỉ mang danh tính.
 */
export const RequireCapability = (capability: string, contextResolver: CapabilityRequirement['contextResolver'] = 'system') =>
  SetMetadata(REQUIRE_CAPABILITY_KEY, { capability, contextResolver } satisfies CapabilityRequirement);
