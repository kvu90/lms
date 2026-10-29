import { and, eq, inArray } from 'drizzle-orm';
import { courseModules, courseModulesCompletion, gradeGrades, gradeItems } from '@lms/db';
import type { EnrolDatabase } from './types';

/**
 * Truy vấn DỮ LIỆU LIÊN QUAN của một người dùng trong một khoá học ở
 * tầng dữ liệu dùng chung — căn cứ quyết định việc gỡ ghi danh giữ
 * dòng `user_enrolments` dạng WITHDRAWN (giữ dữ liệu đóng góp) hay
 * xoá cứng dòng (không còn dữ liệu nào để giữ), đúng sự phân chia
 * của Moodle giữa dữ liệu tham gia hiển thị (được giữ) và tham gia
 * vô hình (bị dọn).
 *
 * Trước đây dữ kiện này tới từ các probe do module nghiệp vụ của
 * API đăng ký vào lúc khởi tạo (CompletionModule báo dữ liệu hoàn
 * thành, GradesModule báo dữ liệu điểm) — cơ chế đăng ký lúc chạy
 * đó chỉ tồn tại trong tiến trình API nên bề mặt vật chất hoá dùng
 * chung không mang theo được. Hai kiểm ở đây là đúng hai truy vấn
 * tồn tại thuần dữ liệu mà hai probe đó thực hiện, viết lại trên
 * schema dùng chung: còn BẤT KỲ dòng dữ liệu nào thuộc hai họ này
 * thì coi là còn dữ liệu liên quan.
 */

/**
 * Người dùng còn dữ liệu HOÀN THÀNH trong khoá học hay không: tồn
 * tại ít nhất một dòng `course_modules_completion` của người dùng
 * trên bất kỳ module chưa bị xoá của khoá (mọi dòng đều tính, kể cả
 * dòng chỉ-ghi-nhận-đã-xem — không lọc theo trạng thái hoàn thành,
 * đúng ngữ nghĩa probe hiện hành).
 *
 * @param db - tay cầm Drizzle của host.
 * @param courseId - khoá học cần kiểm.
 * @param userId - người dùng cần kiểm.
 */
export async function hasCourseCompletionData(db: EnrolDatabase, courseId: string, userId: string): Promise<boolean> {
  const cms = await db
    .select({ id: courseModules.id })
    .from(courseModules)
    .where(and(eq(courseModules.course, courseId), eq(courseModules.deletionInProgress, false)));
  if (!cms.length) return false;
  const rows = await db
    .select({ id: courseModulesCompletion.id })
    .from(courseModulesCompletion)
    .where(and(
      eq(courseModulesCompletion.userId, userId),
      inArray(courseModulesCompletion.courseModuleId, cms.map((c) => c.id)),
    ));
  return rows.length > 0;
}

/**
 * Người dùng còn dữ liệu ĐIỂM trong khoá học hay không: tồn tại ít
 * nhất một dòng `grade_grades` của người dùng trên bất kỳ mục điểm
 * nào của khoá.
 *
 * @param db - tay cầm Drizzle của host.
 * @param courseId - khoá học cần kiểm.
 * @param userId - người dùng cần kiểm.
 */
export async function hasCourseGradeData(db: EnrolDatabase, courseId: string, userId: string): Promise<boolean> {
  const items = await db
    .select({ id: gradeItems.id })
    .from(gradeItems)
    .where(eq(gradeItems.courseId, courseId));
  if (!items.length) return false;
  const rows = await db
    .select({ id: gradeGrades.id })
    .from(gradeGrades)
    .where(and(
      eq(gradeGrades.userId, userId),
      inArray(gradeGrades.itemId, items.map((i) => i.id)),
    ));
  return rows.length > 0;
}

/**
 * Người dùng còn dữ liệu liên quan (hoàn thành hoặc điểm) trong
 * khoá học hay không — hợp của hai kiểm trên, đúng ngữ nghĩa vòng
 * lặp probe hiện hành (bất kỳ probe nào báo có là có).
 *
 * @param db - tay cầm Drizzle của host.
 * @param courseId - khoá học cần kiểm.
 * @param userId - người dùng cần kiểm.
 */
export async function hasRelatedCourseData(db: EnrolDatabase, courseId: string, userId: string): Promise<boolean> {
  if (await hasCourseCompletionData(db, courseId, userId)) return true;
  return hasCourseGradeData(db, courseId, userId);
}
