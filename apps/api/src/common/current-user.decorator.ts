import { createParamDecorator, ExecutionContext } from '@nestjs/common';
export interface AuthenticatedUser { id: string; username: string; sessionId?: string; isSiteAdmin?: boolean }
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const req = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
  return req.user;
});
