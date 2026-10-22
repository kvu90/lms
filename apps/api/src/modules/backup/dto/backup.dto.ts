import { IsBoolean, IsIn, IsInt, IsOptional } from 'class-validator';

/** DTO tạo backup job cho một khoá. */
export class CreateBackupDto {
  @IsInt() courseId!: number;
  @IsOptional() @IsBoolean() anonymize?: boolean;
}
/** DTO restore từ một backup job đã hoàn thành. */
export class RestoreDto {
  @IsInt() backupJobId!: number;
  @IsIn(['new', 'merge', 'replace']) mode!: 'new' | 'merge' | 'replace';
  @IsOptional() @IsInt() targetCourseId?: number;
}
