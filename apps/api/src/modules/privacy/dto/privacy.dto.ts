import { IsIn, IsInt, IsOptional } from 'class-validator';

/** DTO người dùng tự gửi yêu cầu privacy cho chính mình (hoặc admin gửi hộ). */
export class CreatePrivacyRequestDto {
  @IsIn(['export', 'delete']) type!: 'export' | 'delete';
  @IsOptional() @IsInt() userid?: number;
}
/** DTO phê duyệt/từ chối yêu cầu. */
export class DecidePrivacyRequestDto {
  @IsIn(['approved', 'rejected']) decision!: 'approved' | 'rejected';
}
