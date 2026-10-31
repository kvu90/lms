import { createParamDecorator, ExecutionContext } from '@nestjs/common';
export interface AuthenticatedUser { id: string; username: string; sessionId?: string; isSiteAdmin?: boolean; /** Tenant hiệu lực khai trong claim `tid` của access token (TENANT-0, #168); TenantGuard kiểm chứng lại với DB. */ tenantId?: string; /** Định danh đăng ký của trung tâm mà phiên thuộc về, khai trong claim `centre_id` của access token (issue #582) — chỉ có khi tenant hiệu lực của phiên là trung tâm ở kho riêng; SpaceContextGuard đối chiếu với trung tâm tại địa chỉ request. */ centreId?: string }
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const req = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
  return req.user;
});
