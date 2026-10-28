/** Bảng của bounded context MCP — định nghĩa Drizzle do module mcp sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Khoá idempotency của các tool GHI qua MCP (issue #110, hồ sơ research
 * Phần 3.4): đặc tả MCP 2026-07-28 bỏ SSE resumability — stream đứt là
 * client phát hành lại request mới, nên server phải tự chống nhân đôi.
 * Một dòng = một (giáo viên, idempotencyKey): cùng key + cùng
 * request_hash → trả lại response đã lưu, KHÔNG tạo mới; cùng key +
 * hash khác → lỗi `question.idempotency_conflict`. TTL 24 giờ: dòng hết
 * hạn bị coi như không tồn tại và bị xoá khi chạm tới (dọn định kỳ để
 * sau — lát này không thêm job nền mới).
 */
export const mcpIdempotencyKeys = pgTable(
  'mcp_idempotency_keys',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id').notNull(),
    key: text('key').notNull(),
    tool: text('tool').notNull(),
    requestHash: text('request_hash').notNull(),
    responseJson: jsonb('response_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('mcp_idempotency_keys_user_key_unique').on(table.userId, table.key),
    index('mcp_idempotency_keys_expires_idx').on(table.expiresAt),
  ],
);
