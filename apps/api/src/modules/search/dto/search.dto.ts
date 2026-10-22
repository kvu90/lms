import { z } from 'zod';
import { searchIndexItemSchema, type SearchIndexItem } from '@lms/contracts';

/**
 * Validation của Search dùng Zod qua Standard Schema (xem ADR Zod-only):
 * schema nền ở `@lms/contracts`, file này chỉ re-export và extend cho nhu cầu
 * riêng của server.
 */
export { searchIndexItemSchema };
export type IndexItemDto = SearchIndexItem;

/**
 * Schema chèn tài liệu thô — EXTEND từ schema nền ở contracts: các field
 * `title/content/contextid/ownerid` chỉ tồn tại phía server (indexer nội bộ và
 * kiểm thử index sót), không thuộc bề mặt contract công khai.
 */
export const indexRawDocumentSchema = searchIndexItemSchema.extend({
  title: z.string().min(1),
  content: z.string(),
  contextid: z.number().int(),
  ownerid: z.number().int().optional(),
});
export type IndexRawDto = z.infer<typeof indexRawDocumentSchema>;
