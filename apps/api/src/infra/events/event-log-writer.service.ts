import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { context, eventLog } from '../../db/schema';

/** Hình dạng dòng outbox mà writer phản chiếu (tập con cấu trúc của dòng Drizzle). */
export interface OutboxRowLike {
  id: string;
  seq: number;
  aggregate: string;
  type: string;
  payload: Record<string, unknown> | null;
  /** Tenant của ngữ cảnh phát sinh (cột trên outbox_events, TENANT-0 #168). */
  tenantId?: string | null;
  occurredAt: Date;
}

const COURSE_CONTEXT_LEVEL = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Các khoá payload ứng viên đặt tên cho đối tượng chính của một sự kiện, theo từng aggregate
 * của outbox. Khoá đầu tiên xuất hiện sẽ thắng; giá trị rơi vào trường
 * `objectId` đã chuẩn hoá của payload log đã lưu.
 */
const OBJECT_ID_KEYS: Record<string, string[]> = {
  course: ['courseId'],
  course_category: ['categoryId'],
  course_module: ['cmId'],
  enrol: ['enrolmentId', 'instanceId'],
  grades: ['itemId', 'gradeId'],
  question: ['questionId', 'usageId'],
  stimulus: ['stimulusId'],
  user: ['userId'],
  auth: ['userId'],
  access: ['assignmentId'],
  badges: ['badgeId', 'issuedId'],
  group: ['groupId'],
  grouping: ['groupingId'],
  cohort: ['cohortId'],
  calendar: ['eventId'],
  completion: ['cmId', 'courseId'],
  competency: ['competencyId'],
  messaging: ['conversationId', 'messageId'],
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Observer logstore duy nhất (tương đương logstore_standard của Moodle): mọi
 * dòng outbox đã commit được relay bởi một trong hai relay (API hoặc worker) đều được phản chiếu
 * vào `event_log` — một vết kiểm toán bất biến, truy vấn được — với payload
 * đã chuẩn hoá (component / action / actor / related user / course / object / IP)
 * để API đọc có thể lọc mà không cần biết hình dạng payload thô của từng sự kiện.
 *
 * Việc phản chiếu KHÔNG BAO GIỜ làm hỏng relay: lỗi được ghi log và nuốt,
 * dòng outbox vẫn giữ nguyên trạng thái published như trước (ngữ nghĩa at-least-once của
 * relay không đổi; một lần relay phát lại vì vậy có thể nhân đôi một dòng log,
 * cùng đánh đổi mà đường emit trong tiến trình đã chấp nhận).
 */
@Injectable()
export class EventLogWriter {
  private readonly logger = new Logger(EventLogWriter.name);

  constructor(@InjectDrizzle() private readonly db: Database) {}

  async record(row: OutboxRowLike): Promise<void> {
    try {
      const source = (row.payload ?? {}) as Record<string, unknown>;
      const actorId = str(source.actorId);
      const payloadUserId = str(source.userId);
      const relatedUserId = str(source.relatedUserId)
        ?? (payloadUserId && payloadUserId !== actorId ? payloadUserId : null);
      const courseId = str(source.courseId);
      let contextId = str(source.contextId);
      if (!contextId && courseId) contextId = await this.courseContextId(courseId);
      const objectId = this.objectIdOf(row.aggregate, source);
      const sourceComponent = str(source.component);
      const payload: Record<string, unknown> = {
        ...source,
        // Một số payload đã mang sẵn trường `component` của riêng chúng (component
        // hoạt động của một course module) — giữ nó dưới
        // `sourceComponent`; `component` đã chuẩn hoá là subsystem
        // của sự kiện (aggregate của outbox).
        ...(sourceComponent ? { sourceComponent } : {}),
        component: row.aggregate,
        action: row.type,
        actorId,
        relatedUserId,
        courseId,
        objectId,
        ip: str(source.ip),
        outboxId: row.id,
        outboxSeq: row.seq,
      };
      await this.db.insert(eventLog).values({
        eventType: row.type,
        contextId,
        userId: actorId,
        tenantId: row.tenantId ?? str(source.tenantId),
        payload,
        createdAt: row.occurredAt,
      });
    } catch (err) {
      this.logger.error(`Failed to mirror outbox event ${row.type} (${row.id}) into event_log: ${String(err)}`);
    }
  }

  private objectIdOf(aggregate: string, payload: Record<string, unknown>): string | null {
    const keys = OBJECT_ID_KEYS[aggregate] ?? ['objectId'];
    for (const key of keys) {
      const value = str(payload[key]);
      if (value) return value;
    }
    return str(payload.objectId);
  }

  /** Tra cứu context khoá học chỉ đọc; context vắng thì cột để null (payload vẫn mang courseId). */
  private async courseContextId(courseId: string): Promise<string | null> {
    if (!UUID_RE.test(courseId)) return null;
    const rows = await this.db
      .select({ id: context.id })
      .from(context)
      .where(and(eq(context.contextLevel, COURSE_CONTEXT_LEVEL), eq(context.instanceId, courseId)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
}
