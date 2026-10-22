import { IsBoolean, IsInt, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateGroupDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() idnumber?: string;
  @IsOptional() @IsString() description?: string;
}
export class UpdateGroupDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() idnumber?: string;
  @IsOptional() @IsString() description?: string;
}
export class MemberDto { @IsInt() userid!: number }
export class CreateGroupingDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() idnumber?: string;
  @IsOptional() @IsString() description?: string;
}
export class GroupingGroupDto { @IsInt() groupid!: number }
export class CreateCohortDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() idnumber?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() categoryId?: number;
  @IsOptional() @IsBoolean() visible?: boolean;
}
export class UpdateCohortDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() idnumber?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() visible?: boolean;
}
