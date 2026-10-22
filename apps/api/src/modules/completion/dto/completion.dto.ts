import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';

export class CriterionDto {
  @IsString() criteriatype!: string;
  @IsOptional() @IsInt() moduleinstance?: number;
  @IsOptional() @IsString() date?: string;
}
export class SetCriteriaDto {
  @IsOptional() @IsInt() method?: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => CriterionDto) criteria!: CriterionDto[];
}
export class MarkManualDto {
  @IsInt() userid!: number;
  @IsBoolean() complete!: boolean;
}
