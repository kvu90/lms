import { z } from 'zod';
import { listEventLogsQuerySchema } from '@lms/contracts';

/**
 * Validation của Event Log dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { listEventLogsQuerySchema };

/**
 * Schema phía server cho query nhật ký sự kiện — EXTEND từ schema nền ở
 * contracts: phân trang đến từ query string (chuỗi) nên ép kiểu bằng
 * `z.coerce` ở tầng server. Mốc thời gian giữ dạng chuỗi ISO 8601 như
 * contracts khai (service chuyển sang `Date` khi gọi repository) —
 * TUYỆT ĐỐI không dùng `z.date()`/`z.coerce.date()` trong schema của
 * route: bootstrap production sinh tài liệu OpenAPI bằng cách chuyển mọi
 * schema sang JSON Schema, mà kiểu Date không biểu diễn được trong JSON
 * Schema nên app chết ngay lúc khởi động (sự cố deploy PR #28).
 */
export const listEventLogsQueryServerSchema = listEventLogsQuerySchema.extend({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type ListEventLogsQueryDto = z.infer<typeof listEventLogsQueryServerSchema>;
