import { z } from 'zod';
import { listEventLogsQuerySchema } from '@lms/contracts';

/**
 * Validation của Event Log dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { listEventLogsQuerySchema };

/**
 * Schema phía server cho query nhật ký sự kiện — EXTEND từ schema nền ở
 * contracts: phân trang và mốc thời gian đến từ query string (chuỗi) nên
 * ép kiểu bằng `z.coerce` ở tầng server.
 */
export const listEventLogsQueryServerSchema = listEventLogsQuerySchema.extend({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type ListEventLogsQueryDto = z.infer<typeof listEventLogsQueryServerSchema>;
