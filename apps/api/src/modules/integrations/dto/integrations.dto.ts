import { IsArray, IsBoolean, IsInt, IsOptional, IsString, MinLength } from 'class-validator';

/** DTO tạo external service. */
export class CreateServiceDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) shortname!: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) functions?: string[];
}
/** DTO tạo token cho một user trong một service. */
export class CreateTokenDto {
  @IsInt() userid!: number;
  @IsInt() serviceid!: number;
  @IsOptional() @IsString() validuntil?: string;
  @IsOptional() @IsString() iprestriction?: string;
}
/** DTO gọi một external function qua envelope thống nhất. */
export class CallFunctionDto {
  @IsString() @MinLength(1) token!: string;
  @IsString() @MinLength(1) functionName!: string;
  @IsOptional() args?: Record<string, unknown>;
}
