import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';

export class CreateGradeCategoryDto {
  @IsString() @MinLength(1) fullname!: string;
  @IsOptional() @IsInt() parentId?: number;
  @IsOptional() @IsString() aggregation?: string;
  @IsOptional() @IsInt() droplow?: number;
  @IsOptional() @IsInt() keephigh?: number;
  @IsOptional() @IsBoolean() aggregateonlygraded?: boolean;
  @IsOptional() @IsBoolean() hidden?: boolean;
}
export class UpdateGradeCategoryDto {
  @IsOptional() @IsString() fullname?: string;
  @IsOptional() @IsString() aggregation?: string;
  @IsOptional() @IsInt() droplow?: number;
  @IsOptional() @IsInt() keephigh?: number;
  @IsOptional() @IsBoolean() aggregateonlygraded?: boolean;
  @IsOptional() @IsBoolean() hidden?: boolean;
  @IsOptional() @IsInt() parentId?: number | null;
}
export class CreateGradeItemDto {
  @IsString() @MinLength(1) itemname!: string;
  @IsOptional() @IsString() itemtype?: string; // manual | mod
  @IsOptional() @IsInt() categoryId?: number;
  @IsOptional() @IsInt() cmId?: number; // for itemtype=mod
  @IsOptional() @IsNumber() grademax?: number;
  @IsOptional() @IsNumber() grademin?: number;
  @IsOptional() @IsNumber() gradepass?: number;
  @IsOptional() @IsInt() scaleId?: number;
  @IsOptional() @IsBoolean() weightoverride?: boolean;
  @IsOptional() @IsNumber() weight?: number;
  @IsOptional() @IsBoolean() extracredit?: boolean;
  @IsOptional() @IsNumber() multiplicator?: number;
  @IsOptional() @IsNumber() plusfactor?: number;
  @IsOptional() @IsBoolean() hidden?: boolean;
}
export class UpdateGradeItemDto {
  @IsOptional() @IsString() itemname?: string;
  @IsOptional() @IsInt() categoryId?: number;
  @IsOptional() @IsNumber() grademax?: number;
  @IsOptional() @IsNumber() grademin?: number;
  @IsOptional() @IsNumber() gradepass?: number;
  @IsOptional() @IsBoolean() weightoverride?: boolean;
  @IsOptional() @IsNumber() weight?: number;
  @IsOptional() @IsBoolean() extracredit?: boolean;
  @IsOptional() @IsNumber() multiplicator?: number;
  @IsOptional() @IsNumber() plusfactor?: number;
  @IsOptional() @IsBoolean() hidden?: boolean;
  @IsOptional() @IsBoolean() locked?: boolean;
}
export class SetGradeDto {
  @IsInt() userid!: number;
  @IsOptional() @IsNumber() rawgrade?: number | null;
  @IsOptional() @IsString() feedback?: string;
}
export class UpdateGradeDto {
  @IsOptional() @IsBoolean() overridden?: boolean;
  @IsOptional() @IsNumber() finalgrade?: number | null;
  @IsOptional() @IsBoolean() locked?: boolean;
  @IsOptional() @IsBoolean() excluded?: boolean;
  @IsOptional() @IsBoolean() hidden?: boolean;
  @IsOptional() @IsBoolean() frozen?: boolean;
  @IsOptional() @IsString() feedback?: string;
}
export class LetterDto {
  @IsString() @MinLength(1) letter!: string;
  @IsNumber() lowerboundary!: number;
}
export class SetLettersDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => LetterDto) letters!: LetterDto[];
}
export class CreateScaleDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) scale!: string;
  @IsOptional() @IsString() description?: string;
}
