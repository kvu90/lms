import { z } from 'zod';
import { matrixImportIssueSchema } from './assessment.js';

/** Problem Details theo RFC 7807 — shape lỗi duy nhất cho toàn bộ API. */
export const problemDetailsSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().min(1),
  errors: z
    .array(z.object({ field: z.string().optional(), message: z.string() }))
    .optional(),
  /**
   * Extension member (RFC 7807 §3.2): học sinh chặn một thao tác chốt sổ
   * VN nguyên tử (chốt cả lớp) — `awaiting_makeup` = còn cột chờ kiểm tra
   * bù (Điều 7.4 TT 22), `incomplete` = thiếu cột điểm; `roles` là các vai
   * trò cột liên quan. Chỉ xuất hiện với mã `grades.vn_finalize_book_blocked`.
   */
  blockedStudents: z
    .array(
      z.object({
        userId: z.string().min(1),
        reason: z.enum(['awaiting_makeup', 'incomplete']),
        roles: z.array(z.string()),
      }),
    )
    .optional(),
  /**
   * Extension member (RFC 7807 §3.2): danh sách lỗi cứng ĐỊNH VỊ khi
   * thao tác GHI nhập ma trận từ file bị từ chối (lát I-2, issue
   * #233). Server parse lại chính file tại thời điểm ghi và chạy lại
   * toàn bộ luật hợp lệ của bước xem trước (lát I-1); file bị sửa tay
   * sau xem trước mà vi phạm luật thì ghi bị từ chối NGUYÊN TỬ (không
   * ghi một phần) kèm đúng các lỗi này — cùng một hình dạng
   * `MatrixImportIssue` (sheet/dòng/cột/mã/thông điệp) như trong kết
   * quả xem trước, để web hiển thị lại bảng lỗi định vị cho giáo viên
   * sửa file. Chỉ xuất hiện với mã `quiz.matrix_import_invalid`.
   */
  matrixImportIssues: z.array(matrixImportIssueSchema).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
