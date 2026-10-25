import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/**
 * Contracts của Dashboard việc cần làm (DASH1, issue #121 — Đợt 6):
 * endpoint tổng hợp cho khối đầu dashboard + tuỳ chọn thẻ khoá cá nhân.
 * Mọi mốc thời gian trong schema route đều là chuỗi ISO (`z.iso.datetime`)
 * — không dùng `z.date()`/`z.coerce.date()` (sẽ làm Swagger createDocument
 * chết lúc boot production).
 */

/** Bảng màu cố định cho thẻ khoá — token màu, không nhận CSS tự do. */
export const COURSE_CARD_COLORS = [
  'red', 'orange', 'amber', 'green', 'teal',
  'blue', 'indigo', 'violet', 'pink', 'slate',
] as const;
export type CourseCardColor = (typeof COURSE_CARD_COLORS)[number];

/** Cửa sổ hạn nộp mặc định của khối việc cần làm (ngày). */
export const DASHBOARD_DUE_WINDOW_DAYS = 7;

/** Query của GET /dashboard/overview — cửa sổ hạn nộp là tham số rõ ràng. */
export const dashboardOverviewQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(30).default(DASHBOARD_DUE_WINDOW_DAYS),
});
export type DashboardOverviewQuery = z.infer<typeof dashboardOverviewQuerySchema>;

/** Body của PUT /dashboard/course-cards/:courseId — null = xoá giá trị đó. */
export const upsertCourseCardPrefSchema = z.strictObject({
  color: z.enum(COURSE_CARD_COLORS).nullable().optional(),
  nickname: z.string().trim().max(60).nullable().optional(),
});
export type UpsertCourseCardPref = z.infer<typeof upsertCourseCardPrefSchema>;

/** Một việc sắp đến hạn của học sinh trong khối tổng hợp. */
export interface DashboardDueItemView {
  courseId: string;
  courseName: string;
  cmId: string;
  /** quiz | assignment. */
  kind: 'quiz' | 'assignment';
  name: string;
  /** Hạn nộp (ISO). */
  dueAt: string;
  status: 'not_started' | 'in_progress' | 'overdue';
}

/** Một kết quả ĐÃ CÔNG BỐ mới kể từ mốc xem trước của học sinh. */
export interface DashboardNewResultView {
  courseId: string;
  courseName: string;
  /** grade_item: điểm/phản hồi của một grade item; vn_term/vn_year: kết quả VN. */
  kind: 'grade_item' | 'vn_term' | 'vn_year';
  /** Chỉ có ở kind grade_item. */
  itemId: string | null;
  itemName: string | null;
  finalGrade: number | null;
  gradeMax: number | null;
  feedback: string | null;
  /** Mốc thay đổi/công bố (ISO). */
  changedAt: string;
}

/** Một hàng trong hàng đợi chấm của giáo viên (gộp theo khoá). */
export interface DashboardGradingQueueView {
  courseId: string;
  courseName: string;
  pendingCount: number;
  assignmentPending: number;
  quizPending: number;
  /** Bài chờ lâu nhất (ISO); null khi hàng đợi rỗng. */
  oldestPendingAt: string | null;
}

/** Toàn bộ khối đầu dashboard trong MỘT response. */
export interface DashboardOverviewView {
  /** Thời điểm server tính khối này (ISO) — client neo hiển thị theo mốc này. */
  generatedAt: string;
  /** Mốc xem trước đã dùng để tính newResults (ISO); null ở lần xem đầu. */
  previousSeenAt: string | null;
  dueItems: DashboardDueItemView[];
  newResults: DashboardNewResultView[];
  gradingQueue: DashboardGradingQueueView[];
}

/** Tuỳ chọn thẻ khoá của chính người dùng cho một khoá. */
export interface CourseCardPrefView {
  courseId: string;
  color: CourseCardColor | null;
  nickname: string | null;
}

export const courseCardPrefParamsSchema = z.strictObject({ courseId: uuidIdSchema });
