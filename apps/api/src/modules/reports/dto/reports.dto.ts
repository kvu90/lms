import { IsArray, IsIn, IsObject, IsOptional, IsString, MinLength } from 'class-validator';

/** DTO tạo báo cáo: datasource là entity đã đăng ký, columns/filters là cấu hình. */
export class CreateReportDto {
  @IsString() @MinLength(1) name!: string;
  @IsIn(['enrolments', 'grades', 'completion']) datasource!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) columns?: string[];
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
  @IsOptional() @IsArray() audienceUserIds?: number[];
  @IsOptional() @IsArray() @IsString({ each: true }) audienceRoles?: string[];
}
/** DTO đặt lịch chạy báo cáo. */
export class CreateScheduleDto {
  @IsOptional() @IsString() cron?: string;
}
