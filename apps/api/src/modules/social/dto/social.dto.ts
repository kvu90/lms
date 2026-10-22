import { IsArray, IsIn, IsInt, IsOptional, IsString, MinLength } from 'class-validator';

export class SetItemTagsDto {
  @IsString() component!: string;
  @IsString() itemtype!: string;
  @IsInt() itemid!: number;
  @IsInt() contextid!: number;
  @IsArray() @IsString({ each: true }) tags!: string[];
}
export class AddItemTagDto {
  @IsString() component!: string;
  @IsString() itemtype!: string;
  @IsInt() itemid!: number;
  @IsInt() contextid!: number;
  @IsString() @MinLength(1) tag!: string;
}
export class AddCommentDto {
  @IsInt() contextid!: number;
  @IsString() component!: string;
  @IsString() commentarea!: string;
  @IsInt() itemid!: number;
  @IsString() @MinLength(1) content!: string;
}
export class RateDto {
  @IsInt() contextid!: number;
  @IsString() component!: string;
  @IsString() ratingarea!: string;
  @IsInt() itemid!: number;
  @IsInt() scaleid!: number;
  @IsInt() rating!: number;
}
export class CreatePostDto {
  @IsString() @MinLength(1) subject!: string;
  @IsOptional() @IsString() summary?: string;
  @IsString() content!: string;
  @IsOptional() @IsIn(['draft', 'site']) publishstate?: string;
}
export class UpdatePostDto {
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() summary?: string;
  @IsOptional() @IsString() content?: string;
  @IsOptional() @IsIn(['draft', 'site']) publishstate?: string;
}
export class AssociatePostDto {
  @IsIn(['course', 'coursemodule']) assoctype!: 'course' | 'coursemodule';
  @IsInt() associd!: number;
}
export class CreateNoteDto {
  @IsInt() userid!: number;
  @IsOptional() @IsInt() courseid?: number;
  @IsString() @MinLength(1) content!: string;
  @IsOptional() @IsIn(['draft', 'public', 'site']) publishstate?: string;
  @IsOptional() @IsInt() groupid?: number;
}
