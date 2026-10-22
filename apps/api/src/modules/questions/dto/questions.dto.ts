import { IsArray, IsBoolean, IsInt, IsNumber, IsObject, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateQuestionCategoryDto {
  @IsString() @MinLength(1) name!: string;
  @IsInt() contextid!: number;
  @IsOptional() @IsString() info?: string;
  @IsOptional() @IsInt() parent?: number;
}
export class CreateQuestionDto {
  @IsInt() categoryId!: number;
  @IsString() @MinLength(1) qtype!: string; // truefalse | shortanswer (data-level)
  @IsString() @MinLength(1) name!: string;
  @IsString() questiontext!: string;
  @IsOptional() @IsNumber() defaultmark?: number;
  /** Generic correct-answer data of the version: truefalse {correct:boolean}; shortanswer {answers:string[], casesensitive?:boolean}. */
  @IsObject() answer!: Record<string, unknown>;
}
export class UpdateQuestionDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() questiontext?: string;
  @IsOptional() @IsNumber() defaultmark?: number;
  @IsOptional() @IsObject() answer?: Record<string, unknown>;
}
export class UsageSlotDto {
  @IsInt() questionId!: number;
  @IsOptional() @IsNumber() maxmark?: number;
}
export class CreateUsageDto {
  @IsString() @MinLength(1) component!: string;
  @IsOptional() @IsInt() instanceid?: number;
  @IsOptional() @IsInt() contextid?: number;
  @IsOptional() @IsString() preferredbehaviour?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => UsageSlotDto) slots!: UsageSlotDto[];
}
export class SubmitResponseDto {
  @IsOptional() @IsString() response?: string | null;
  @IsOptional() @IsBoolean() finish?: boolean;
}
