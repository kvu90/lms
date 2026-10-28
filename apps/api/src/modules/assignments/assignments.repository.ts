import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import type { Database, DbTx } from '../../db/database';
import {
  assignAnnotations, assignFeedbackMessages, assignGradeRevisions, assignGrades,
  assignRubricCriteria, assignRubricEvaluations, assignRubricLevels, assignRubrics,
  assignSubmissionFiles, assignSubmissions, assignments, teacherCommentBank,
} from '../../db/schema';

export type AssignmentRow = typeof assignments.$inferSelect;
export type AssignSubmissionRow = typeof assignSubmissions.$inferSelect;
export type AssignSubmissionFileRow = typeof assignSubmissionFiles.$inferSelect;
export type AssignGradeRow = typeof assignGrades.$inferSelect;
export type AssignAnnotationRow = typeof assignAnnotations.$inferSelect;
export type AssignRubricRow = typeof assignRubrics.$inferSelect;
export type AssignRubricCriterionRow = typeof assignRubricCriteria.$inferSelect;
export type AssignRubricLevelRow = typeof assignRubricLevels.$inferSelect;
export type AssignRubricEvaluationRow = typeof assignRubricEvaluations.$inferSelect;
export type AssignGradeRevisionRow = typeof assignGradeRevisions.$inferSelect;
export type AssignFeedbackMessageRow = typeof assignFeedbackMessages.$inferSelect;
export type TeacherCommentBankRow = typeof teacherCommentBank.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu của hoạt động Bài tập nộp tệp/ảnh: bản ghi bài tập
 * (instance của course module), bài nộp của học sinh, quan hệ bài nộp ↔
 * tệp (nội dung vật lý ở module Files) và điểm/lời phê của giáo viên.
 */
export class AssignmentsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /** Chèn bản ghi bài tập. */
  async insertAssignment(v: typeof assignments.$inferInsert, tx?: DbTx): Promise<AssignmentRow> {
    const [row] = await (tx ?? this.db).insert(assignments).values(v).returning(); return row!;
  }
  /** Lấy bài tập theo id. */
  async getAssignment(id: string): Promise<AssignmentRow | undefined> {
    const [row] = await this.db.select().from(assignments).where(eq(assignments.id, id)); return row;
  }
  /** Các bài tập trong một khoá học. */
  async listAssignmentsInCourse(courseId: string): Promise<AssignmentRow[]> {
    return this.db.select().from(assignments).where(eq(assignments.course, courseId)).orderBy(asc(assignments.createdAt), asc(assignments.id));
  }
  /** Cập nhật bài tập. */
  async updateAssignment(id: string, patch: Partial<AssignmentRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(assignments).set({ ...patch, updatedAt: new Date() }).where(eq(assignments.id, id));
  }
  /** Xoá bài tập (bài nộp, tệp liên kết và điểm cascade theo khoá ngoại). */
  async deleteAssignment(id: string): Promise<void> {
    await this.db.delete(assignments).where(eq(assignments.id, id));
  }

  /** Bài nộp hiện hành của một học sinh cho một bài tập (nếu có). */
  async getSubmission(assignmentId: string, userId: string): Promise<AssignSubmissionRow | undefined> {
    const [row] = await this.db.select().from(assignSubmissions)
      .where(and(eq(assignSubmissions.assignmentId, assignmentId), eq(assignSubmissions.userId, userId)));
    return row;
  }
  /** Mọi bài nộp của một bài tập. */
  async listSubmissions(assignmentId: string): Promise<AssignSubmissionRow[]> {
    return this.db.select().from(assignSubmissions).where(eq(assignSubmissions.assignmentId, assignmentId)).orderBy(asc(assignSubmissions.createdAt), asc(assignSubmissions.id));
  }
  /** Chèn bài nộp mới. */
  async insertSubmission(v: typeof assignSubmissions.$inferInsert, tx?: DbTx): Promise<AssignSubmissionRow> {
    const [row] = await (tx ?? this.db).insert(assignSubmissions).values(v).returning(); return row!;
  }
  /** Cập nhật bài nộp. */
  async updateSubmission(id: string, patch: Partial<AssignSubmissionRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(assignSubmissions).set({ ...patch, updatedAt: new Date() }).where(eq(assignSubmissions.id, id));
  }

  /** Các tệp của một bài nộp theo thứ tự thêm vào. */
  async listSubmissionFiles(submissionId: string): Promise<AssignSubmissionFileRow[]> {
    return this.db.select().from(assignSubmissionFiles).where(eq(assignSubmissionFiles.submissionId, submissionId)).orderBy(asc(assignSubmissionFiles.createdAt), asc(assignSubmissionFiles.id));
  }
  /** Gắn một tệp vào bài nộp. */
  async insertSubmissionFile(v: typeof assignSubmissionFiles.$inferInsert, tx?: DbTx): Promise<AssignSubmissionFileRow> {
    const [row] = await (tx ?? this.db).insert(assignSubmissionFiles).values(v).returning(); return row!;
  }
  /** Gỡ quan hệ tệp ↔ bài nộp (bản ghi files được xoá ở tầng Files). */
  async deleteSubmissionFile(submissionId: string, fileId: string): Promise<void> {
    await this.db.delete(assignSubmissionFiles).where(and(eq(assignSubmissionFiles.submissionId, submissionId), eq(assignSubmissionFiles.fileId, fileId)));
  }

  /** Điểm/lời phê hiện hành của một học sinh cho một bài tập (nếu có). */
  async getGrade(assignmentId: string, userId: string): Promise<AssignGradeRow | undefined> {
    const [row] = await this.db.select().from(assignGrades)
      .where(and(eq(assignGrades.assignmentId, assignmentId), eq(assignGrades.userId, userId)));
    return row;
  }
  /** Mọi điểm/lời phê của một bài tập. */
  async listGrades(assignmentId: string): Promise<AssignGradeRow[]> {
    return this.db.select().from(assignGrades).where(eq(assignGrades.assignmentId, assignmentId));
  }
  /** Ghi hoặc cập nhật gói chấm (một bản ghi hiện hành cho mỗi học sinh). */
  async upsertGrade(v: typeof assignGrades.$inferInsert, tx?: DbTx): Promise<AssignGradeRow> {
    const [row] = await (tx ?? this.db).insert(assignGrades).values(v)
      .onConflictDoUpdate({
        target: [assignGrades.assignmentId, assignGrades.userId],
        set: {
          graderId: v.graderId, attemptNumber: v.attemptNumber,
          grade: v.grade ?? null, level: v.level ?? null,
          feedback: v.feedback ?? null,
          feedbackProgress: v.feedbackProgress ?? null,
          feedbackStrengths: v.feedbackStrengths ?? null,
          feedbackWeaknesses: v.feedbackWeaknesses ?? null,
          status: v.status ?? 'draft',
          releasedAt: v.releasedAt ?? null, releasedBy: v.releasedBy ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  }
  /** Cập nhật một phần gói chấm theo id. */
  async updateGrade(id: string, patch: Partial<AssignGradeRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(assignGrades).set({ ...patch, updatedAt: new Date() }).where(eq(assignGrades.id, id));
  }

  /** Các dấu chấm vector trên một bài nộp, theo thứ tự tạo. */
  async listAnnotations(submissionId: string): Promise<AssignAnnotationRow[]> {
    return this.db.select().from(assignAnnotations).where(eq(assignAnnotations.submissionId, submissionId))
      .orderBy(asc(assignAnnotations.createdAt), asc(assignAnnotations.id));
  }
  /** Một dấu chấm theo id. */
  async getAnnotation(id: string): Promise<AssignAnnotationRow | undefined> {
    const [row] = await this.db.select().from(assignAnnotations).where(eq(assignAnnotations.id, id)); return row;
  }
  /** Thêm một dấu chấm. */
  async insertAnnotation(v: typeof assignAnnotations.$inferInsert, tx?: DbTx): Promise<AssignAnnotationRow> {
    const [row] = await (tx ?? this.db).insert(assignAnnotations).values(v).returning(); return row!;
  }
  /** Sửa một dấu chấm. */
  async updateAnnotation(id: string, patch: Partial<AssignAnnotationRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(assignAnnotations).set({ ...patch, updatedAt: new Date() }).where(eq(assignAnnotations.id, id));
  }
  /** Xoá một dấu chấm. */
  async deleteAnnotation(id: string): Promise<void> {
    await this.db.delete(assignAnnotations).where(eq(assignAnnotations.id, id));
  }

  /** Bảng chấm của một bài tập (nếu có). */
  async getRubric(assignmentId: string): Promise<AssignRubricRow | undefined> {
    const [row] = await this.db.select().from(assignRubrics).where(eq(assignRubrics.assignmentId, assignmentId)); return row;
  }
  /** Tạo bảng chấm mới. */
  async insertRubric(v: typeof assignRubrics.$inferInsert, tx?: DbTx): Promise<AssignRubricRow> {
    const [row] = await (tx ?? this.db).insert(assignRubrics).values(v).returning(); return row!;
  }
  /** Xoá bảng chấm của bài (tiêu chí/mức/đánh giá cascade theo khoá ngoại). */
  async deleteRubricByAssignment(assignmentId: string): Promise<void> {
    await this.db.delete(assignRubrics).where(eq(assignRubrics.assignmentId, assignmentId));
  }
  /** Các tiêu chí của một bảng chấm theo thứ tự hiển thị. */
  async listCriteria(rubricId: string): Promise<AssignRubricCriterionRow[]> {
    return this.db.select().from(assignRubricCriteria).where(eq(assignRubricCriteria.rubricId, rubricId))
      .orderBy(asc(assignRubricCriteria.sortOrder), asc(assignRubricCriteria.id));
  }
  /** Thêm một tiêu chí. */
  async insertCriterion(v: typeof assignRubricCriteria.$inferInsert, tx?: DbTx): Promise<AssignRubricCriterionRow> {
    const [row] = await (tx ?? this.db).insert(assignRubricCriteria).values(v).returning(); return row!;
  }
  /** Các mức của một tiêu chí theo thứ tự hiển thị. */
  async listLevels(criterionId: string): Promise<AssignRubricLevelRow[]> {
    return this.db.select().from(assignRubricLevels).where(eq(assignRubricLevels.criterionId, criterionId))
      .orderBy(asc(assignRubricLevels.sortOrder), asc(assignRubricLevels.id));
  }
  /** Thêm một mức cho tiêu chí. */
  async insertLevel(v: typeof assignRubricLevels.$inferInsert, tx?: DbTx): Promise<AssignRubricLevelRow> {
    const [row] = await (tx ?? this.db).insert(assignRubricLevels).values(v).returning(); return row!;
  }

  /** Kết quả theo tiêu chí của một gói chấm. */
  async listEvaluations(gradeId: string): Promise<AssignRubricEvaluationRow[]> {
    return this.db.select().from(assignRubricEvaluations).where(eq(assignRubricEvaluations.gradeId, gradeId))
      .orderBy(asc(assignRubricEvaluations.createdAt), asc(assignRubricEvaluations.id));
  }
  /** Ghi/cập nhật kết quả của một tiêu chí trong gói chấm. */
  async upsertEvaluation(v: typeof assignRubricEvaluations.$inferInsert, tx?: DbTx): Promise<AssignRubricEvaluationRow> {
    const [row] = await (tx ?? this.db).insert(assignRubricEvaluations).values(v)
      .onConflictDoUpdate({
        target: [assignRubricEvaluations.gradeId, assignRubricEvaluations.criterionId],
        set: { levelId: v.levelId ?? null, score: v.score ?? null, note: v.note ?? null, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }
  /** Xoá toàn bộ kết quả theo tiêu chí của gói chấm (khi giáo viên gửi lại bộ đánh giá mới). */
  async deleteEvaluations(gradeId: string): Promise<void> {
    await this.db.delete(assignRubricEvaluations).where(eq(assignRubricEvaluations.gradeId, gradeId));
  }

  /** Ghi một dòng vết kiểm toán sửa gói chấm sau trả bài. */
  async insertRevision(v: typeof assignGradeRevisions.$inferInsert, tx?: DbTx): Promise<AssignGradeRevisionRow> {
    const [row] = await (tx ?? this.db).insert(assignGradeRevisions).values(v).returning(); return row!;
  }
  /** Các dòng vết kiểm toán của một gói chấm, cũ → mới. */
  async listRevisions(gradeId: string): Promise<AssignGradeRevisionRow[]> {
    return this.db.select().from(assignGradeRevisions).where(eq(assignGradeRevisions.gradeId, gradeId))
      .orderBy(asc(assignGradeRevisions.createdAt), asc(assignGradeRevisions.id));
  }

  /** Hội thoại phản hồi của một gói chấm, cũ → mới. */
  async listMessages(gradeId: string): Promise<AssignFeedbackMessageRow[]> {
    return this.db.select().from(assignFeedbackMessages).where(eq(assignFeedbackMessages.gradeId, gradeId))
      .orderBy(asc(assignFeedbackMessages.createdAt), asc(assignFeedbackMessages.id));
  }
  /** Thêm một tin nhắn vào hội thoại phản hồi. */
  async insertMessage(v: typeof assignFeedbackMessages.$inferInsert, tx?: DbTx): Promise<AssignFeedbackMessageRow> {
    const [row] = await (tx ?? this.db).insert(assignFeedbackMessages).values(v).returning(); return row!;
  }

  /** Ngân hàng lời phê của một giáo viên, mới nhất trước. */
  async listCommentBank(ownerId: string): Promise<TeacherCommentBankRow[]> {
    return this.db.select().from(teacherCommentBank).where(eq(teacherCommentBank.ownerId, ownerId))
      .orderBy(asc(teacherCommentBank.createdAt), asc(teacherCommentBank.id));
  }
  /** Thêm một câu vào ngân hàng lời phê. */
  async insertCommentBankEntry(v: typeof teacherCommentBank.$inferInsert, tx?: DbTx): Promise<TeacherCommentBankRow> {
    const [row] = await (tx ?? this.db).insert(teacherCommentBank).values(v).returning(); return row!;
  }
  /** Xoá một câu khỏi ngân hàng lời phê của chính chủ sở hữu. */
  async deleteCommentBankEntry(id: string, ownerId: string): Promise<void> {
    await this.db.delete(teacherCommentBank).where(and(eq(teacherCommentBank.id, id), eq(teacherCommentBank.ownerId, ownerId)));
  }
}
