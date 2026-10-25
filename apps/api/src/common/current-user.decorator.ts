import { createParamDecorator, ExecutionContext } from '@nestjs/common';
export interface AuthenticatedUser { id: string; username: string; sessionId?: string; isSiteAdmin?: boolean; /** Tenant hiệu lực khai trong claim `tid` của access token (TENANT-0, #168); TenantGuard kiểm chứng lại với DB. */ tenantId?: string }
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const req = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
  return req.user;
});
