import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';

export class RepeatDto {
  @IsIn(['DAILY', 'WEEKLY', 'MONTHLY', 'daily', 'weekly', 'monthly']) freq!: string;
  @IsOptional() @IsInt() count?: number;
  @IsOptional() @IsString() until?: string;
}
export class CreateEventDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() description?: string;
  @IsIn(['site', 'category', 'course', 'group', 'user']) eventtype!: 'site' | 'category' | 'course' | 'group' | 'user';
  @IsOptional() @IsInt() courseid?: number;
  @IsOptional() @IsInt() groupid?: number;
  @IsOptional() @IsInt() categoryid?: number;
  @IsString() timestart!: string;
  @IsOptional() @IsInt() timeduration?: number;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @ValidateNested() @Type(() => RepeatDto) repeat?: RepeatDto;
}
export class CreateExceptionDto {
  @IsOptional() @IsString() name?: string;
  @IsString() timestart!: string;
  @IsOptional() @IsString() description?: string;
}
export class CreateSubscriptionDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() icsdata?: string;
  @IsOptional() @IsIn(['site', 'category', 'course', 'group', 'user']) eventtype?: string;
  @IsOptional() @IsInt() courseid?: number;
  @IsOptional() @IsInt() categoryid?: number;
  @IsOptional() @IsInt() pollinterval?: number;
}
export class RemindDto {
  @IsInt() minutesBefore!: number;
}
