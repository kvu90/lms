import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { assignGrades, assignSubmissionFiles, assignSubmissions, assignments } from '../../db/schema';

export type AssignmentRow = typeof assignments.$inferSelect;
export type AssignSubmissionRow = typeof assignSubmissions.$inferSelect;
export type AssignSubmissionFileRow = typeof assignSubmissionFiles.$inferSelect;
export type AssignGradeRow = typeof assignGrades.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

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
  /** Ghi hoặc cập nhật điểm/lời phê (một bản ghi hiện hành cho mỗi học sinh). */
  async upsertGrade(v: typeof assignGrades.$inferInsert, tx?: DbTx): Promise<AssignGradeRow> {
    const [row] = await (tx ?? this.db).insert(assignGrades).values(v)
      .onConflictDoUpdate({
        target: [assignGrades.assignmentId, assignGrades.userId],
        set: {
          graderId: v.graderId, attemptNumber: v.attemptNumber,
          grade: v.grade ?? null, feedback: v.feedback ?? null, updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  }
}
