import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  assignments,
  assignSubmissions,
  courseModules,
  courseModulesCompletion,
  guardianViewState,
  notifications,
  examAttempts,
  examPins,
  examVersions,
} from '../../db/schema';

/**
 * Kho dữ liệu bề mặt phụ huynh chỉ-xem (PH-1, issue #130): mọi truy vấn
 * đều khóa theo học sinh (con) + tập khoá con ghi danh do service truyền
 * vào sau khi đã qua cổng liên kết giám hộ — repository không tự quyết
 * quyền. Gom theo tập khoá trong một câu SQL cho mỗi nguồn, không vòng lặp
 * truy vấn theo từng khoá (đúng kỷ luật của DashboardRepository).
 */
@Injectable()
export class GuardianViewRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Mốc xem trước của phụ huynh cho một con; undefined nếu chưa từng xem. */
  async getViewState(guardianUserId: string, studentUserId: string) {
    const [row] = await this.db.select().from(guardianViewState)
      .where(and(
        eq(guardianViewState.guardianUserId, guardianUserId),
        eq(guardianViewState.studentUserId, studentUserId),
      ));
    return row;
  }

  /** Cập nhật (hoặc tạo) mốc xem trước của phụ huynh cho một con. */
  async touchViewState(guardianUserId: string, studentUserId: string, at: Date): Promise<void> {
    await this.db.insert(guardianViewState)
      .values({ guardianUserId, studentUserId, lastSeenAt: at })
      .onConflictDoUpdate({
        target: [guardianViewState.guardianUserId, guardianViewState.studentUserId],
        set: { lastSeenAt: at, updatedAt: new Date() },
      });
  }

  /** Quiz có hạn nộp không muộn hơn `until` trong tập khoá kèm các attempt của học sinh. */
  async quizDueRows(courseIds: string[], studentUserId: string, until: Date) {
    if (!courseIds.length) return [];
    return this.db
      .select({
        cmId: courseModules.id,
        courseId: courseModules.course,
        name: sql<string>`coalesce(${examPins.name}, ${examVersions.name})`,
        dueAt: examPins.timeClose,
        attemptState: examAttempts.state,
      })
      .from(courseModules)
      .innerJoin(examPins, eq(examPins.id, courseModules.instanceId))
      .innerJoin(examVersions, eq(examVersions.id, examPins.examVersionId))
      .leftJoin(examAttempts, and(
        eq(examAttempts.pinId, examPins.id),
        eq(examAttempts.userId, studentUserId),
        eq(examAttempts.preview, false),
      ))
      .where(and(
        inArray(courseModules.course, courseIds),
        eq(courseModules.component, 'mod_quiz'),
        eq(courseModules.visible, true),
        eq(courseModules.deletionInProgress, false),
        isNotNull(examPins.timeClose),
        lte(examPins.timeClose, until),
      ))
      .orderBy(asc(examPins.timeClose));
  }

  /** Bài tập C2 có hạn nộp không muộn hơn `until` trong tập khoá kèm bài nộp hiện hành của học sinh. */
  async assignmentDueRows(courseIds: string[], studentUserId: string, until: Date) {
    if (!courseIds.length) return [];
    return this.db
      .select({
        cmId: courseModules.id,
        courseId: courseModules.course,
        name: assignments.name,
        dueAt: assignments.dueDate,
        submissionStatus: assignSubmissions.status,
      })
      .from(courseModules)
      .innerJoin(assignments, eq(assignments.id, courseModules.instanceId))
      .leftJoin(assignSubmissions, and(
        eq(assignSubmissions.assignmentId, assignments.id),
        eq(assignSubmissions.userId, studentUserId),
      ))
      .where(and(
        inArray(courseModules.course, courseIds),
        eq(courseModules.component, 'mod_assign'),
        eq(courseModules.visible, true),
        eq(courseModules.deletionInProgress, false),
        isNotNull(assignments.dueDate),
        lte(assignments.dueDate, until),
      ))
      .orderBy(asc(assignments.dueDate));
  }

  /**
   * Thông báo gần nhất đã gửi cho học sinh (mọi loại, trừ thông báo điểm —
   * loại ở service theo eventType): service lọc tiếp theo khoá từ
   * contextUrl. Chỉ ĐỌC — không bao giờ đánh dấu đã đọc thay học sinh.
   */
  async recentNotificationsForStudent(studentUserId: string, limit: number) {
    return this.db
      .select({
        id: notifications.id,
        subject: notifications.subject,
        fullMessage: notifications.fullMessage,
        eventType: notifications.eventType,
        contextUrl: notifications.contextUrl,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.userIdTo, studentUserId))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit);
  }

  /**
   * Đếm tiến độ theo khoá cho học sinh: tổng = module hiển thị có theo dõi
   * hoàn thành (completion <> 0); đã xong = có trạng thái hoàn thành khác 0
   * — đúng ngữ nghĩa phần trăm của K2 (ContentService.getMyProgress).
   */
  async courseProgressRows(courseIds: string[], studentUserId: string) {
    if (!courseIds.length) return [];
    return this.db
      .select({
        courseId: courseModules.course,
        total: sql<number>`count(*)::int`,
        completed: sql<number>`count(${courseModulesCompletion.id})::int`,
      })
      .from(courseModules)
      .leftJoin(courseModulesCompletion, and(
        eq(courseModulesCompletion.courseModuleId, courseModules.id),
        eq(courseModulesCompletion.userId, studentUserId),
        ne(courseModulesCompletion.completionState, 0),
      ))
      .where(and(
        inArray(courseModules.course, courseIds),
        eq(courseModules.visible, true),
        eq(courseModules.deletionInProgress, false),
        ne(courseModules.completion, 0),
      ))
      .groupBy(courseModules.course);
  }
}
