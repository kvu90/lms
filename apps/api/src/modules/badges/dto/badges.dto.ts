import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';

export class CreateBadgeDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() type?: number; // 1=site, 2=course
  @IsOptional() @IsInt() courseid?: number;
  @IsOptional() @IsString() issuername?: string;
  @IsOptional() @IsString() issuerurl?: string;
  @IsOptional() @IsString() issuercontact?: string;
  @IsOptional() @IsString() expiredate?: string;
  @IsOptional() @IsInt() expireperiod?: number;
  @IsOptional() @IsString() version?: string;
}
export class UpdateBadgeDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() issuername?: string;
  @IsOptional() @IsInt() expireperiod?: number;
}
export class SetStatusDto { @IsInt() status!: number; }
export class CriteriaLeafDto {
  @IsString() criteriatype!: string;
  @IsOptional() params?: Record<string, unknown>;
  @IsOptional() @IsString() description?: string;
}
export class SetCriteriaDto {
  @IsInt() method!: number; // 1=ALL, 2=ANY
  @IsArray() @ValidateNested({ each: true }) @Type(() => CriteriaLeafDto) criteria!: CriteriaLeafDto[];
}
export class ManualAwardDto { @IsInt() userId!: number; }
export class EvaluateDto { @IsInt() userId!: number; }
