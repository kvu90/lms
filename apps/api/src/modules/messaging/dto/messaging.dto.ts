import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MinLength, IsArray } from 'class-validator';

export class CreateConversationDto {
  @IsOptional() @IsInt() type?: number; // 1=individual, 2=group
  @IsArray() @IsInt({ each: true }) memberIds!: number[];
  @IsOptional() @IsString() name?: string;
}
export class SendMessageDto {
  @IsString() @MinLength(1) text!: string;
  @IsOptional() @IsString() subject?: string;
}
export class SetPreferenceDto {
  @IsString() @MinLength(1) provider!: string;
  @IsIn(['popup', 'email', 'push']) channel!: 'popup' | 'email' | 'push';
  @IsIn(['loggedin', 'loggedoff']) state!: 'loggedin' | 'loggedoff';
  @IsBoolean() enabled!: boolean;
}
export class NotifyDto {
  @IsInt() userId!: number;
  @IsString() @MinLength(1) provider!: string;
  @IsString() @MinLength(1) subject!: string;
  @IsString() @MinLength(1) body!: string;
  @IsOptional() @IsString() contextUrl?: string;
}
