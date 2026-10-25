import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, lte } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { mcpIdempotencyKeys } from '../../db/schema';

export type McpIdempotencyKeyRow = typeof mcpIdempotencyKeys.$inferSelect;

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Truy cập bảng `mcp_idempotency_keys` (xem schema.ts): tra cứu có xét
 * hạn — dòng hết hạn bị xoá ngay khi chạm tới và coi như không tồn tại,
 * để client dùng lại key sau 24 giờ không va phải response cũ.
 */
@Injectable()
export class McpIdempotencyRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async find(userId: string, key: string): Promise<McpIdempotencyKeyRow | null> {
    const [row] = await this.db
      .select()
      .from(mcpIdempotencyKeys)
      .where(and(eq(mcpIdempotencyKeys.userId, userId), eq(mcpIdempotencyKeys.key, key)));
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.db.delete(mcpIdempotencyKeys).where(eq(mcpIdempotencyKeys.id, row.id));
      return null;
    }
    return row;
  }

  async store(input: {
    userId: string;
    key: string;
    tool: string;
    requestHash: string;
    response: Record<string, unknown>;
  }): Promise<void> {
    const now = new Date();
    await this.db.insert(mcpIdempotencyKeys).values({
      userId: input.userId,
      key: input.key,
      tool: input.tool,
      requestHash: input.requestHash,
      responseJson: input.response,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    });
  }

  /** Xoá mọi dòng đã hết hạn (gọi cơ hội khi tra cứu; job dọn định kỳ để lát sau). */
  async purgeExpired(): Promise<void> {
    await this.db.delete(mcpIdempotencyKeys).where(lte(mcpIdempotencyKeys.expiresAt, new Date()));
  }
}
