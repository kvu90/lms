import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';

export class ScaleDto {
  @IsArray() @IsString({ each: true }) values!: string[];
  @IsArray() @IsInt({ each: true }) proficient!: number[];
}
export class CreateFrameworkDto {
  @IsString() @MinLength(1) shortname!: string;
  @IsOptional() @IsString() idnumber?: string;
  @IsOptional() @IsString() description?: string;
  @ValidateNested() @Type(() => ScaleDto) scale!: ScaleDto;
  @IsOptional() @IsBoolean() visible?: boolean;
}
export class CreateCompetencyDto {
  @IsString() @MinLength(1) shortname!: string;
  @IsOptional() @IsString() idnumber?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() parentId?: number;
}
export class LinkCompetencyDto {
  @IsInt() competencyId!: number;
  @IsString() ruleoutcome!: string;
}
export class CreateTemplateDto {
  @IsString() @MinLength(1) shortname!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() duedate?: string;
}
export class AddTemplateCompetencyDto { @IsInt() competencyId!: number; }
export class AddTemplateCohortDto { @IsInt() cohortId!: number; }
export class CreatePlanDto {
  @IsOptional() @IsInt() userId?: number;
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() templateId?: number;
}
export class AddEvidenceDto {
  @IsInt() userId!: number;
  @IsInt() competencyId!: number;
  @IsOptional() @IsInt() planId?: number;
  @IsOptional() @IsInt() courseId?: number;
  @IsString() @MinLength(1) description!: string;
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsInt() grade?: number;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsBoolean() sendForReview?: boolean;
}
export class GradeUsercompDto {
  @IsInt() userId!: number;
  @IsInt() competencyId!: number;
  @IsOptional() @IsInt() planId?: number;
  @IsOptional() @IsInt() courseId?: number;
  @IsInt() grade!: number;
  @IsOptional() @IsString() note?: string;
}
export class ReviewDecisionDto {
  @IsOptional() @IsInt() grade?: number;
  @IsOptional() @IsString() note?: string;
}
export class NoteDto { @IsOptional() @IsString() note?: string; }
export class NumericDto { @IsOptional() @IsNumber() value?: number; }
