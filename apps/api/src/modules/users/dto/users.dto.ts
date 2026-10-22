import { IsBoolean, IsEmail, IsInt, IsObject, IsOptional, IsString, Min, MinLength } from 'class-validator';
export class CreateUserDto {
  @IsString() @MinLength(1) username!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(1) password!: string;
  @IsOptional() @IsString() firstname?: string;
  @IsOptional() @IsString() lastname?: string;
  @IsOptional() @IsBoolean() forcePasswordChange?: boolean;
  @IsOptional() @IsObject() customFields?: Record<string, string>;
}
export class UpdateUserDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() firstname?: string;
  @IsOptional() @IsString() lastname?: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsObject() customFields?: Record<string, string>;
}
export class ListUsersQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsInt() @Min(1) page?: number;
  @IsOptional() @IsInt() @Min(1) pageSize?: number;
}
export class SetPreferenceDto { @IsString() name!: string; @IsOptional() @IsString() value?: string }
