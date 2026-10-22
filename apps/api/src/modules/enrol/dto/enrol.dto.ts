import { IsInt, IsOptional, IsString } from 'class-validator';

export class CreateEnrolInstanceDto {
  @IsString() method!: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() roleShortname?: string;
  @IsOptional() @IsInt() status?: number;
  @IsOptional() @IsInt() enrolperiod?: number;
  @IsOptional() @IsInt() cohortId?: number;
  @IsOptional() @IsInt() groupId?: number;
  @IsOptional() @IsString() onCohortLeave?: 'suspend' | 'unenrol';
  /** Fee enrol: số tiền nguyên nhỏ nhất + mã tiền tệ + tài khoản thanh toán. */
  @IsOptional() @IsInt() cost?: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsInt() paymentAccountId?: number;
}
export class UpdateEnrolInstanceDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsInt() status?: number;
  @IsOptional() @IsInt() enrolperiod?: number;
  @IsOptional() @IsString() onCohortLeave?: 'suspend' | 'unenrol';
  @IsOptional() @IsInt() groupId?: number;
}
export class EnrolUserDto {
  @IsInt() userid!: number;
  @IsOptional() @IsString() timestart?: string;
  @IsOptional() @IsString() timeend?: string;
}
