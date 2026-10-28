import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { assignGrades, assignSubmissionFiles, assignSubmissions, files } from '../../db/schema';

export type FileRow = typeof files.$inferSelect;

/**
 * Hình chiếu tối thiểu của một bài nộp mà chốt xoá tệp cần: bài nộp nào,
 * của ai, đang ở trạng thái vòng đời nào và thuộc lần nộp thứ mấy — đủ để
 * đường xoá dùng chung áp đúng khoá bài nộp của module Bài tập mà không
 * phải nạp toàn bộ bản ghi bài nộp.
 */
export interface LinkedSubmissionRow {
  submissionId: string;
  assignmentId: string;
  userId: string;
  status: string;
  attemptNumber: number;
}

@Injectable()
/**
 * Kho dữ liệu metadata file (bảng files kiểu Moodle): mỗi bản ghi là một file tại (context, component, fileArea, itemId, filePath, fileName).
 * Nội dung vật lý được deduplicate theo contentHash; refcount suy ra từ số bản ghi cùng hash.
 */
export class FilesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  /**
   * Chèn bản ghi file mới.
   */
  async insert(v: typeof files.$inferInsert): Promise<FileRow> {
    const [row] = await this.db.insert(files).values(v).returning(); return row!;
  }
  /**
   * Lấy bản ghi theo id.
   */
  async getById(id: string): Promise<FileRow | undefined> {
    const [row] = await this.db.select().from(files).where(eq(files.id, id)); return row;
  }
  /**
   * Xoá bản ghi theo id.
   */
  async deleteById(id: string): Promise<void> { await this.db.delete(files).where(eq(files.id, id)); }
  /** Refcount = số bản ghi logic trỏ tới một contentHash (ngữ nghĩa Moodle: dữ liệu vật lý còn sống khi refcount > 0). */
  /**
   * Đếm bản ghi cùng contentHash (refcount nội dung vật lý).
   */
  async countByHash(contentHash: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(files).where(eq(files.contentHash, contentHash));
    return row?.n ?? 0;
  }
  /**
   * Liệt kê file trong một context.
   */
  async listByContext(contextId: string): Promise<FileRow[]> {
    return this.db.select().from(files).where(eq(files.contextId, contextId)).orderBy(files.id);
  }
  /**
   * Các bài nộp đang gắn với một tệp qua bảng liên kết của module Bài tập
   * (`assign_submission_files`): tệp bài nộp nào cũng có đúng một dòng
   * liên kết tại đây. Đường xoá dùng chung dùng kết quả này để biết tệp
   * có đang chịu khoá bài nộp hay không trước khi xoá.
   */
  async listSubmissionLinks(fileId: string): Promise<LinkedSubmissionRow[]> {
    return this.db.select({
      submissionId: assignSubmissions.id,
      assignmentId: assignSubmissions.assignmentId,
      userId: assignSubmissions.userId,
      status: assignSubmissions.status,
      attemptNumber: assignSubmissions.attemptNumber,
    }).from(assignSubmissionFiles)
      .innerJoin(assignSubmissions, eq(assignSubmissionFiles.submissionId, assignSubmissions.id))
      .where(eq(assignSubmissionFiles.fileId, fileId));
  }
  /**
   * Một bài nộp theo id, ở hình chiếu tối thiểu của chốt xoá tệp — dùng
   * khi bản ghi tệp tự khai là tệp bài nộp (component/file area của
   * module Bài tập, item id là id bài nộp) nhưng dòng liên kết vắng mặt.
   */
  async getSubmission(submissionId: string): Promise<LinkedSubmissionRow | undefined> {
    const [row] = await this.db.select({
      submissionId: assignSubmissions.id,
      assignmentId: assignSubmissions.assignmentId,
      userId: assignSubmissions.userId,
      status: assignSubmissions.status,
      attemptNumber: assignSubmissions.attemptNumber,
    }).from(assignSubmissions).where(eq(assignSubmissions.id, submissionId));
    return row;
  }
  /**
   * Gói chấm hiện hành của một học viên cho một bài tập (trạng thái +
   * lần nộp mà gói thuộc về): chốt xoá tệp so lần nộp của gói với lần
   * nộp hiện hành của bài nộp để biết bài đã được TRẢ BÀI hay chưa,
   * đúng ngữ nghĩa "gói chấm của lần nộp hiện hành" của module Bài tập.
   */
  async getGradeForSubmission(assignmentId: string, userId: string): Promise<{ status: string; attemptNumber: number } | undefined> {
    const [row] = await this.db.select({ status: assignGrades.status, attemptNumber: assignGrades.attemptNumber })
      .from(assignGrades)
      .where(and(eq(assignGrades.assignmentId, assignmentId), eq(assignGrades.userId, userId)));
    return row;
  }
}
