import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

/** DTO tạo tài khoản thanh toán. */
export class CreateAccountDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() gateway?: string;
}
/** DTO tạo thanh toán (checkout): amount là số nguyên đơn vị nhỏ nhất. */
export class CreatePaymentDto {
  @IsInt() accountid!: number;
  @IsInt() @Min(1) amount!: number;
  @IsString() @MinLength(3) currency!: string;
  @IsOptional() @IsString() component?: string;
  @IsOptional() @IsInt() itemid?: number;
}
/** DTO webhook từ gateway: idempotent theo externalTransactionId. */
export class WebhookDto {
  @IsString() @MinLength(1) gateway!: string;
  @IsString() @MinLength(1) externalTransactionId!: string;
  @IsInt() paymentId!: number;
  @IsString() status!: string; // succeeded | failed
}
/** DTO hoàn tiền: tạo giao dịch bù trừ riêng. */
export class RefundDto {
  @IsInt() @Min(1) amount!: number;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() externalTransactionId?: string;
}
