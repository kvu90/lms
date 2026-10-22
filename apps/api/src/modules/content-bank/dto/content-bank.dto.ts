import { IsIn, IsInt, IsOptional, IsString, MinLength } from 'class-validator';

/** DTO tạo nội dung Content Bank (loại nội dung là extension point, mặc định file-based). */
export class CreateContentDto {
  @IsString() @MinLength(1) name!: string;
  @IsInt() contextid!: number;
  @IsOptional() @IsString() contenttype?: string;
  @IsOptional() @IsIn(['draft', 'public']) visibility?: string;
  @IsOptional() @IsInt() fileid?: number;
}
/** DTO sửa nội dung. */
export class UpdateContentDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(['draft', 'public']) visibility?: string;
  @IsOptional() @IsInt() fileid?: number;
}
/** DTO upload file cho một nội dung (nội dung file dạng base64 qua JSON để giữ envelope thống nhất). */
export class UploadContentFileDto {
  @IsString() @MinLength(1) filename!: string;
  @IsString() contentBase64!: string;
  @IsOptional() @IsString() mimetype?: string;
}
