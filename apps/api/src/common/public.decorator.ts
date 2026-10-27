import { SetMetadata } from '@nestjs/common';
export const IS_PUBLIC_KEY = 'isPublic';
/** Đánh dấu một route là không yêu cầu xác thực (login, health, refresh, tải file qua liên kết đã ký). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
