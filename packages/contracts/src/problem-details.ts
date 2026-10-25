import { z } from 'zod';

/** RFC 7807 Problem Details — the single error shape for the whole API. */
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
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
