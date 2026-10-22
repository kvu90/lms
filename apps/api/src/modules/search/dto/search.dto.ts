import { IsInt, IsOptional, IsString, MinLength } from 'class-validator';

/** DTO lập chỉ mục thủ công một item của một area đã đăng ký. */
export class IndexItemDto {
  @IsString() area!: string;
  @IsInt() itemid!: number;
}
/** DTO chèn tài liệu thô (chỉ phục vụ indexer nội bộ và kiểm thử index sót). */
export class IndexRawDto {
  @IsString() area!: string;
  @IsInt() itemid!: number;
  @IsString() @MinLength(1) title!: string;
  @IsString() content!: string;
  @IsInt() contextid!: number;
  @IsOptional() @IsInt() ownerid?: number;
}
