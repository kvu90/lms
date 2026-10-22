import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MinLength } from 'class-validator';
export class CreateContextDto {
  @IsInt() contextlevel!: number;
  @IsInt() instanceid!: number;
  @IsOptional() @IsInt() parentId?: number;
}
export class CreateRoleDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) shortname!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() archetype?: string;
}
export class UpdateRoleDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
}
export class AssignRoleDto {
  @IsInt() userid!: number;
  @IsInt() roleid!: number;
  @IsInt() contextid!: number;
}
export class OverrideCapabilityDto {
  @IsInt() roleid!: number;
  @IsString() capability!: string;
  @IsInt() contextid!: number;
  @IsInt() permission!: number;
}
export class HasCapabilityQueryDto {
  @Type(() => Number) @IsInt() userid!: number;
  @IsString() capability!: string;
  @Type(() => Number) @IsInt() contextid!: number;
}
