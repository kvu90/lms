import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { eventLog } from '../../db/schema';

export type EventLogRow = typeof eventLog.$inferSelect;

export interface EventLogFilters {
  userId?: string;
  relatedUserId?: string;
  courseId?: string;
  contextId?: string;
  component?: string;
  eventType?: string;
  from?: Date;
  to?: Date;
}

/**
 * Truy vấn bảng `event_log` (logstore): các bộ lọc theo cột dùng index sẵn
 * có (user_id, context_id); bộ lọc theo người bị tác động/khoá/component đọc
 * các trường đã chuẩn hoá trong payload do EventLogWriter ghi.
 */
@Injectable()
export class EventLogRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async search(filters: EventLogFilters, page: number, pageSize: number): Promise<{ rows: EventLogRow[]; total: number }> {
    const conds: SQL[] = [];
    if (filters.userId) conds.push(eq(eventLog.userId, filters.userId));
    if (filters.contextId) conds.push(eq(eventLog.contextId, filters.contextId));
    if (filters.eventType) conds.push(eq(eventLog.eventType, filters.eventType));
    if (filters.relatedUserId) conds.push(sql`${eventLog.payload} ->> 'relatedUserId' = ${filters.relatedUserId}`);
    if (filters.courseId) conds.push(sql`${eventLog.payload} ->> 'courseId' = ${filters.courseId}`);
    if (filters.component) conds.push(sql`${eventLog.payload} ->> 'component' = ${filters.component}`);
    if (filters.from) conds.push(gte(eventLog.createdAt, filters.from));
    if (filters.to) conds.push(lte(eventLog.createdAt, filters.to));
    const where = conds.length ? and(...conds) : undefined;

    const rows = await this.db
      .select()
      .from(eventLog)
      .where(where)
      .orderBy(desc(eventLog.seq))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const [totalRow] = await this.db.select({ total: count() }).from(eventLog).where(where);
    return { rows, total: totalRow?.total ?? 0 };
  }
}
