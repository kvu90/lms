import { IsInt } from 'class-validator';

/** DTO chạy model phân tích cho một khoá. */
export class RunModelDto {
  @IsInt() courseId!: number;
}
