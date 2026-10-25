import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, gt, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  assignGrades,
  assignments,
  assignSubmissions,
  context,
  course,
  courseModules,
  enrol,
  gradeGrades,
  gradeItems,
  gradePublications,
  quizAttempts,
  quizPaperScans,
  quizzes,
  roleAssignments,
  userCourseCardPrefs,
  userDashboardState,
  userEnrolments,
} from '../../db/schema';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';

export type CardPrefRow = typeof userCourseCardPrefs.$inferSelect;

/**
 * Kho dữ liệu Dashboard việc cần làm (DASH1, issue #121): mọi truy vấn đều
 * GOM theo tập khoá của người dùng trong một câu SQL cho mỗi nguồn — không
 * vòng lặp truy vấn theo từng khoá.
 */
@Injectable()
export class DashboardRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Khoá user đang ghi danh hiệu lực (user_enrolments active, chưa hết hạn). */
  async enrolledCourseIds(userId: string, now: Date): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ courseId: enrol.courseId })
      .from(userEnrolments)
      .innerJoin(enrol, eq(enrol.id, userEnrolments.enrolId))
      .where(and(
        eq(userEnrolments.userId, userId),
        eq(userEnrolments.status, 0),
        or(sql`${userEnrolments.timeEnd} is null`, gt(userEnrolments.timeEnd, now)),
      ));
    return rows.map((r) => r.courseId);
  }

  /** Khoá user có gán vai trực tiếp tại context khoá (ứng viên đội giảng dạy). */
  async roleAssignedCourseIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ courseId: context.instanceId })
      .from(roleAssignments)
      .innerJoin(context, eq(context.id, roleAssignments.contextId))
      .where(and(
        eq(roleAssignments.userId, userId),
        eq(context.contextLevel, CONTEXT_LEVELS.COURSE),
        isNotNull(context.instanceId),
      ));
    return rows.map((r) => r.courseId!).filter(Boolean);
  }

  /** Tên hiển thị của một tập khoá: courseId → fullName. */
  async courseNames(courseIds: string[]): Promise<Map<string, string>> {
    if (!courseIds.length) return new Map();
    const rows = await this.db.select({ id: course.id, fullName: course.fullName })
      .from(course).where(inArray(course.id, courseIds));
    return new Map(rows.map((r) => [r.id, r.fullName]));
  }

  /** Quiz có hạn nộp trong tập khoá kèm các attempt của chính user. */
  async quizDueRows(courseIds: string[], userId: string, until: Date) {
    if (!courseIds.length) return [];
    return this.db
      .select({
        cmId: courseModules.id,
        activityId: courseModules.instanceId,
        courseId: courseModules.course,
        name: quizzes.name,
        dueAt: quizzes.timeClose,
        attemptState: quizAttempts.state,
      })
      .from(courseModules)
      .innerJoin(quizzes, eq(quizzes.id, courseModules.instanceId))
      .leftJoin(quizAttempts, and(
        eq(quizAttempts.quizId, quizzes.id),
        eq(quizAttempts.userId, userId),
        eq(quizAttempts.preview, false),
      ))
      .where(and(
        inArray(courseModules.course, courseIds),
        eq(courseModules.component, 'mod_quiz'),
        eq(courseModules.visible, true),
        eq(courseModules.deletionInProgress, false),
        isNotNull(quizzes.timeClose),
        lte(quizzes.timeClose, until),
      ))
      .orderBy(asc(quizzes.timeClose));
  }

  /** Bài tập C2 có hạn nộp trong tập khoá kèm bài nộp hiện hành của chính user. */
  async assignmentDueRows(courseIds: string[], userId: string, until: Date) {
    if (!courseIds.length) return [];
    return this.db
      .select({
        cmId: courseModules.id,
        activityId: courseModules.instanceId,
        courseId: courseModules.course,
        name: assignments.name,
        dueAt: assignments.dueDate,
        submissionStatus: assignSubmissions.status,
      })
      .from(courseModules)
      .innerJoin(assignments, eq(assignments.id, courseModules.instanceId))
      .leftJoin(assignSubmissions, and(
        eq(assignSubmissions.assignmentId, assignments.id),
        eq(assignSubmissions.userId, userId),
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

  /** Điểm của chính user thay đổi sau mốc (chưa lọc công bố — service lọc bằng GradesService). */
  async gradeRowsSince(courseIds: string[], userId: string, since: Date) {
    if (!courseIds.length) return [];
    return this.db
      .select({
        gradeId: gradeGrades.id,
        courseId: gradeItems.courseId,
        itemId: gradeItems.id,
        itemName: gradeItems.itemName,
        itemType: gradeItems.itemType,
        finalGrade: gradeGrades.finalGrade,
        gradeMax: gradeItems.gradeMax,
        feedback: gradeGrades.feedback,
        updatedAt: gradeGrades.updatedAt,
      })
      .from(gradeGrades)
      .innerJoin(gradeItems, eq(gradeItems.id, gradeGrades.itemId))
      .where(and(
        eq(gradeGrades.userId, userId),
        inArray(gradeItems.courseId, courseIds),
        gt(gradeGrades.updatedAt, since),
        sql`(${gradeGrades.finalGrade} is not null or (${gradeGrades.feedback} is not null and ${gradeGrades.feedback} <> ''))`,
      ))
      .orderBy(asc(gradeGrades.updatedAt));
  }

  /**
   * Mọi vết công bố scope item trong tập khoá — service suy ra: (a) hiệu
   * lực công bố hiện tại theo vết mới nhất, (b) ứng viên "mới": điểm chấm
   * TRƯỚC mốc nhưng chỉ được CÔNG BỐ sau mốc thì thời điểm trở nên hiển
   * thị là thời điểm công bố, không phải thời điểm chấm.
   */
  async itemPublications(courseIds: string[]) {
    if (!courseIds.length) return [];
    return this.db
      .select()
      .from(gradePublications)
      .where(and(
        inArray(gradePublications.courseId, courseIds),
        eq(gradePublications.scope, 'item'),
      ))
      .orderBy(asc(gradePublications.createdAt));
  }

  /** Điểm của chính user trên một tập item cụ thể (ứng viên từ vết công bố sau mốc). */
  async gradeRowsForItems(itemIds: string[], userId: string) {
    if (!itemIds.length) return [];
    return this.db
      .select({
        gradeId: gradeGrades.id,
        courseId: gradeItems.courseId,
        itemId: gradeItems.id,
        itemName: gradeItems.itemName,
        itemType: gradeItems.itemType,
        finalGrade: gradeGrades.finalGrade,
        gradeMax: gradeItems.gradeMax,
        feedback: gradeGrades.feedback,
        updatedAt: gradeGrades.updatedAt,
      })
      .from(gradeGrades)
      .innerJoin(gradeItems, eq(gradeItems.id, gradeGrades.itemId))
      .where(and(
        eq(gradeGrades.userId, userId),
        inArray(gradeGrades.itemId, itemIds),
        sql`(${gradeGrades.finalGrade} is not null or (${gradeGrades.feedback} is not null and ${gradeGrades.feedback} <> ''))`,
      ));
  }

  /** Bài nộp C2 đang chờ chấm trong tập khoá kèm trạng thái gói chấm của đúng attempt hiện tại. */
  async assignmentPendingRows(courseIds: string[]) {
    if (!courseIds.length) return [];
    return this.db
      .select({
        courseId: assignments.course,
        submittedAt: assignSubmissions.submittedAt,
        gradeStatus: assignGrades.status,
      })
      .from(assignSubmissions)
      .innerJoin(assignments, eq(assignments.id, assignSubmissions.assignmentId))
      .leftJoin(assignGrades, and(
        eq(assignGrades.assignmentId, assignSubmissions.assignmentId),
        eq(assignGrades.userId, assignSubmissions.userId),
        eq(assignGrades.attemptNumber, assignSubmissions.attemptNumber),
      ))
      .where(and(
        inArray(assignments.course, courseIds),
        eq(assignSubmissions.status, 'submitted'),
      ));
  }

  /** Lượt quiz đã nộp còn câu chờ chấm tay trong tập khoá. */
  async quizPendingRows(courseIds: string[]) {
    if (!courseIds.length) return [];
    return this.db
      .select({
        courseId: quizzes.course,
        timeFinish: quizAttempts.timeFinish,
        timeStart: quizAttempts.timeStart,
      })
      .from(quizAttempts)
      .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
      .where(and(
        inArray(quizzes.course, courseIds),
        eq(quizAttempts.state, 'needsgrading'),
        eq(quizAttempts.preview, false),
      ));
  }

  /**
   * Phiếu giấy CAM-0 đang chờ xử lý trong tập khoá (chỉ hai trạng thái chờ
   * giáo viên: needs_identity + needs_review; ready/recorded KHÔNG tính —
   * ready là đã đủ điều kiện ghi, recorded là đã xong). Trả từng phiếu để
   * service gom số đếm + mốc chờ lâu nhất + quiz đích deep-link.
   */
  async paperPendingRows(courseIds: string[]) {
    if (!courseIds.length) return [];
    return this.db
      .select({
        courseId: quizzes.course,
        quizId: quizPaperScans.quizId,
        createdAt: quizPaperScans.createdAt,
      })
      .from(quizPaperScans)
      .innerJoin(quizzes, eq(quizzes.id, quizPaperScans.quizId))
      .where(and(
        inArray(quizzes.course, courseIds),
        inArray(quizPaperScans.status, ['needs_identity', 'needs_review']),
      ));
  }

  /** Mốc xem trước hiện tại của user; undefined nếu chưa từng xem. */
  async getState(userId: string) {
    const [row] = await this.db.select().from(userDashboardState)
      .where(eq(userDashboardState.userId, userId));
    return row;
  }

  /** Cập nhật (hoặc tạo) mốc xem trước = thời điểm vừa xem xong. */
  async touchState(userId: string, at: Date): Promise<void> {
    await this.db.insert(userDashboardState)
      .values({ userId, lastSeenAt: at })
      .onConflictDoUpdate({
        target: userDashboardState.userId,
        set: { lastSeenAt: at, updatedAt: new Date() },
      });
  }

  /** Mọi pref thẻ khoá của chính user. */
  async listPrefs(userId: string): Promise<CardPrefRow[]> {
    return this.db.select().from(userCourseCardPrefs)
      .where(eq(userCourseCardPrefs.userId, userId))
      .orderBy(asc(userCourseCardPrefs.courseId));
  }

  /** Upsert pref thẻ khoá của chính user cho một khoá. */
  async upsertPref(userId: string, courseId: string, color: string | null, nickname: string | null): Promise<CardPrefRow> {
    const [row] = await this.db.insert(userCourseCardPrefs)
      .values({ userId, courseId, color, nickname })
      .onConflictDoUpdate({
        target: [userCourseCardPrefs.userId, userCourseCardPrefs.courseId],
        set: { color, nickname, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  /** Xoá pref thẻ khoá (khi cả màu lẫn biệt danh đều trống). */
  async deletePref(userId: string, courseId: string): Promise<void> {
    await this.db.delete(userCourseCardPrefs).where(and(
      eq(userCourseCardPrefs.userId, userId),
      eq(userCourseCardPrefs.courseId, courseId),
    ));
  }
}
