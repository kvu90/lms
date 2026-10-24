import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq, gt, lt, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { enrol, outboxEvents, userEnrolments } from '../db/schema';
import { TaskLogService } from '../task-log.service';

type Database = NodePgDatabase<typeof relations>;

export interface EnrolExpiryResult { checkedAt: string; suspendedIds: string[]; warnedIds: string[] }

/**
 * Cửa sổ cảnh báo sắp hết hạn ghi danh (ngày): ghi danh ACTIVE có
 * timeEnd rơi vào (hiện tại, hiện tại + cửa sổ] được phát MỘT sự kiện
 * outbox `enrol_expiry_warning` duy nhất — phía API (NotificationEvents
 * Consumer, lát N1 issue #49) biến sự kiện thành thông báo
 * `enrol_expiry_warning` cho học sinh. Chống trùng ngay tại phía phát:
 * đã có sự kiện cảnh báo cho đúng enrolment đó thì không phát lại
 * (quét lại mỗi 5 phút không được spam). Moodle cũng cảnh báo TRƯỚC
 * khi hết hạn theo ngưỡng cấu hình; ở đây ngưỡng là hằng số sản phẩm.
 */
export const ENROL_EXPIRY_WARNING_WINDOW_DAYS = 7;

/**
 * Enrolment expiry: ACTIVE user_enrolments whose timeEnd has passed
 * are flipped to SUSPENDED and a user_enrolment_suspended outbox event is
 * written in the same transaction per row. Access is ALSO denied at read
 * time by the API's isEnrolled(onlyActive) time-window check, so a delayed
 * sweep never opens a window of access — the sweep only normalises state.
 */
@Processor('enrol-expiry')
/**
 * Xử lý job hết hạn ghi danh: quét các ghi danh quá hạn và áp hành động hết hạn của instance.
 */
export class EnrolExpiryProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database, private readonly taskLog: TaskLogService) { super(); }

  /**
   * Xử lý một job của queue tương ứng. Mỗi lượt quét (tác vụ định kỳ 5 phút)
   * được ghi vào task_log qua TaskLogService.
   */
  async process(_job: Job): Promise<EnrolExpiryResult> {
    void _job;
    return this.taskLog.run('enrol-expiry', () => this.sweep(), (r) => `suspended ${r.suspendedIds.length} enrolment(s), warned ${r.warnedIds.length}`);
  }

  private async sweep(): Promise<EnrolExpiryResult> {
    const now = new Date();
    const expired = await this.db.select().from(userEnrolments)
      .where(and(eq(userEnrolments.status, 0), lt(userEnrolments.timeEnd, now)));
    const suspendedIds: string[] = [];
    for (const ue of expired) {
      await this.db.transaction(async (tx) => {
        await tx.update(userEnrolments).set({ status: 1, updatedAt: now }).where(eq(userEnrolments.id, ue.id));
        await tx.insert(outboxEvents).values({
          aggregate: 'enrol', type: 'user_enrolment_suspended',
          payload: { userId: ue.userId, enrolmentId: ue.id, enrolId: ue.enrolId, reason: 'expired' },
        });
      });
      suspendedIds.push(ue.id);
    }
    const warnedIds = await this.warnExpiring(now);
    return { checkedAt: now.toISOString(), suspendedIds, warnedIds };
  }

  /**
   * Lượt quét cảnh báo: ghi danh ACTIVE sắp hết hạn trong cửa sổ
   * ENROL_EXPIRY_WARNING_WINDOW_DAYS mà chưa từng được cảnh báo thì
   * phát sự kiện `enrol_expiry_warning` (kèm courseId lấy từ instance
   * và mốc timeEnd) để phía API tạo thông báo. Trả về id các ghi danh
   * vừa được cảnh báo trong lượt này.
   */
  private async warnExpiring(now: Date): Promise<string[]> {
    const windowEnd = new Date(now.getTime() + ENROL_EXPIRY_WARNING_WINDOW_DAYS * 24 * 3600_000);
    const expiring = await this.db.select().from(userEnrolments)
      .where(and(
        eq(userEnrolments.status, 0),
        gt(userEnrolments.timeEnd, now),
        lte(userEnrolments.timeEnd, windowEnd),
      ));
    const warnedIds: string[] = [];
    for (const ue of expiring) {
      if (!ue.timeEnd) continue;
      const [already] = await this.db.select({ id: outboxEvents.id }).from(outboxEvents)
        .where(and(
          eq(outboxEvents.type, 'enrol_expiry_warning'),
          sql`${outboxEvents.payload}->>'enrolmentId' = ${ue.id}`,
        ))
        .limit(1);
      if (already) continue;
      const [instance] = await this.db.select({ courseId: enrol.courseId }).from(enrol)
        .where(eq(enrol.id, ue.enrolId));
      if (!instance) continue;
      await this.db.insert(outboxEvents).values({
        aggregate: 'enrol', type: 'enrol_expiry_warning',
        payload: {
          userId: ue.userId, enrolmentId: ue.id, enrolId: ue.enrolId,
          courseId: instance.courseId, timeEnd: ue.timeEnd.toISOString(),
        },
      });
      warnedIds.push(ue.id);
    }
    return warnedIds;
  }
}
