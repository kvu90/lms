import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, gte, lt } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { guardianDigests, notifications } from '../../db/schema';

/** Một hàng vết lượt digest phụ huynh (bảng guardian_digests). */
export type GuardianDigestRow = typeof guardianDigests.$inferSelect;

/**
 * Kho dữ liệu của lát digest phụ huynh (PH-2, issue #159): vết lượt
 * digest do worker chốt (bảng guardian_digests) + các thông báo lớp đã
 * gửi cho học sinh trong cửa sổ. Mọi truy vấn đều khoá theo cặp
 * (phụ huynh, học sinh) đã qua cổng liên kết ở service — repository
 * không tự quyết quyền.
 */
@Injectable()
export class GuardianDigestRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Vết lượt digest theo id (worker đã chốt khi phát sự kiện). */
  async getDigest(id: string): Promise<GuardianDigestRow | undefined> {
    const [row] = await this.db.select().from(guardianDigests).where(eq(guardianDigests.id, id));
    return row;
  }

  /** Chốt kết quả một lượt digest: trạng thái + số đếm tóm tắt + notification đã sinh. */
  async finishDigest(id: string, patch: {
    status: string;
    newResultsCount?: number;
    announcementsCount?: number;
    overdueCount?: number;
    upcomingCount?: number;
    notificationId?: string | null;
    sentAt?: Date | null;
  }): Promise<void> {
    await this.db.update(guardianDigests)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(guardianDigests.id, id));
  }

  /**
   * Thông báo đã gửi cho học sinh trong cửa sổ [start, end) — nguyên
   * liệu khối thông báo lớp của digest; service lọc tiếp theo khoá/loại
   * đúng quy tắc PH-1 (loại thông báo điểm).
   */
  async notificationsInWindow(studentUserId: string, start: Date, end: Date) {
    return this.db
      .select({
        id: notifications.id,
        eventType: notifications.eventType,
        contextUrl: notifications.contextUrl,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(and(
        eq(notifications.userIdTo, studentUserId),
        gte(notifications.createdAt, start),
        lt(notifications.createdAt, end),
      ));
  }
}
