import { IsBoolean, IsInt, IsObject, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateCategoryDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() idnumber?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() parent?: number;
  @IsOptional() @IsBoolean() visible?: boolean;
}
export class UpdateCategoryDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() idnumber?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() visible?: boolean;
  @IsOptional() @IsInt() parent?: number;
}
export class CreateCourseDto {
  @IsString() @MinLength(1) fullname!: string;
  @IsString() @MinLength(1) shortname!: string;
  @IsInt() category!: number;
  @IsOptional() @IsString() idnumber?: string;
  @IsOptional() @IsString() summary?: string;
  @IsOptional() @IsString() format?: string;
  @IsOptional() @IsBoolean() visible?: boolean;
  @IsOptional() @IsString() startdate?: string;
  @IsOptional() @IsString() enddate?: string;
  @IsOptional() @IsInt() groupmode?: number;
  @IsOptional() @IsObject() formatOptions?: Record<string, string>;
  @IsOptional() @IsObject() customFields?: Record<string, string>;
}
export class UpdateCourseDto {
  @IsOptional() @IsString() fullname?: string;
  @IsOptional() @IsString() shortname?: string;
  @IsOptional() @IsInt() category?: number;
  @IsOptional() @IsString() idnumber?: string;
  @IsOptional() @IsString() summary?: string;
  @IsOptional() @IsString() format?: string;
  @IsOptional() @IsBoolean() visible?: boolean;
  @IsOptional() @IsString() startdate?: string | null;
  @IsOptional() @IsString() enddate?: string | null;
  @IsOptional() @IsInt() groupmode?: number;
  @IsOptional() @IsObject() formatOptions?: Record<string, string>;
  @IsOptional() @IsObject() customFields?: Record<string, string>;
}
export class CreateSectionDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() summary?: string;
  @IsOptional() @IsBoolean() visible?: boolean;
  @IsOptional() availability?: unknown;
}
export class UpdateSectionDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() summary?: string;
  @IsOptional() @IsBoolean() visible?: boolean;
  @IsOptional() availability?: unknown;
}
export class CreateCmDto {
  @IsInt() sectionId!: number;
  @IsString() @MinLength(1) component!: string;
  @IsOptional() @IsInt() instanceid?: number;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsBoolean() visible?: boolean;
  @IsOptional() @IsInt() groupmode?: number;
  @IsOptional() availability?: unknown;
  @IsOptional() @IsInt() completion?: number;
  @IsOptional() @IsBoolean() completionview?: boolean;
  @IsOptional() @IsBoolean() completionusegrade?: boolean;
  @IsOptional() @IsBoolean() completionmanual?: boolean;
  @IsOptional() @IsString() completionexpected?: string;
}
export class UpdateCmDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsBoolean() visible?: boolean;
  @IsOptional() @IsInt() groupmode?: number;
  @IsOptional() availability?: unknown;
  @IsOptional() @IsInt() completion?: number;
  @IsOptional() @IsBoolean() completionview?: boolean;
  @IsOptional() @IsBoolean() completionusegrade?: boolean;
  @IsOptional() @IsBoolean() completionmanual?: boolean;
  @IsOptional() @IsString() completionexpected?: string | null;
  @IsOptional() @IsInt() sectionId?: number;
}
