import { z } from 'zod';
import type { DashboardNewResultView } from './dashboard.js';

/**
 * Contracts của bề mặt phụ huynh chỉ-xem (PH-1, issue #130 — Đợt 6, xây
 * trên PH-0 #116 và DASH1 #121). Oracle: research phụ huynh/HS mục 4.3
 * (bốn khối rút gọn có chủ đích) + 5.1 (nguyên tắc cứng: chỉ-xem, chỉ con
 * mình, chỉ dữ liệu ĐÃ CÔNG BỐ, không xếp hạng/so sánh/trung bình lớp,
 * không hiện 0 thay cho chưa chấm, không hành động thay con).
 */

/** Một việc của con trong tóm tắt tuần (chỉ hiển thị — không có hành động thay con). */
export interface GuardianWeeklyItemView {
  courseId: string;
  courseName: string;
  cmId: string;
  /** quiz | assignment. */
  kind: 'quiz' | 'assignment';
  name: string;
  /** Hạn nộp (ISO). */
  dueAt: string;
  status: 'submitted' | 'not_submitted' | 'overdue';
}

/** Khối (a): tóm tắt tuần của con — việc đã nộp / chưa nộp / quá hạn. */
export interface GuardianWeeklySummaryView {
  /** Đầu tuần hiện tại (ISO, thứ Hai 00:00 UTC). */
  weekStart: string;
  /** Cuối tuần hiện tại (ISO, Chủ nhật 23:59:59.999 UTC). */
  weekEnd: string;
  /** Số việc có hạn trong tuần này. */
  dueThisWeek: number;
  /** Trong số việc đến hạn tuần này: đã nộp. */
  submitted: number;
  /** Trong số việc đến hạn tuần này: chưa nộp, chưa quá hạn. */
  notSubmitted: number;
  /** Mọi việc chưa nộp đã quá hạn (bất kể hạn thuộc tuần nào). */
  overdue: number;
  /** Danh sách việc: việc của tuần này + mọi việc quá hạn chưa nộp. */
  items: GuardianWeeklyItemView[];
}

/**
 * Khối (c): một thông báo lớp liên quan tới khoá của con (bản thông báo đã
 * gửi cho chính học sinh). Thông báo điểm (grade_updated) bị loại ở server
 * để cổng công bố là tuyệt đối — nội dung thông báo vốn không chứa điểm số.
 */
export interface GuardianAnnouncementView {
  id: string;
  courseId: string;
  courseName: string;
  subject: string;
  body: string;
  /** Thời điểm thông báo được tạo (ISO). */
  createdAt: string;
}

/** Khối (d): tiến độ học theo khoá — đúng ngữ nghĩa hoàn thành của K2. */
export interface GuardianCourseProgressView {
  courseId: string;
  courseName: string;
  /** Số mục học có theo dõi hoàn thành trong khoá. */
  total: number;
  /** Số mục con đã hoàn thành (trạng thái khác 0). */
  completed: number;
  /** % hoàn thành; null khi khoá chưa có mục nào được theo dõi (không hiện 0 giả). */
  percent: number | null;
}

/** Toàn bộ bề mặt tổng quan của phụ huynh cho MỘT con trong MỘT response. */
export interface GuardianStudentOverviewView {
  student: { id: string; firstName: string; lastName: string };
  /** Thời điểm server tính khối này (ISO). */
  generatedAt: string;
  /** Mốc xem trước của chính phụ huynh cho con này (ISO); null ở lần xem đầu. */
  previousSeenAt: string | null;
  weekly: GuardianWeeklySummaryView;
  /** Khối (b): kết quả ĐÃ CÔNG BỐ mới kể từ mốc xem trước của phụ huynh. */
  newResults: DashboardNewResultView[];
  announcements: GuardianAnnouncementView[];
  courseProgress: GuardianCourseProgressView[];
}

/** Kết quả một học kì ĐÃ CÔNG BỐ của con trong một sổ VN (một môn). */
export interface GuardianTermResultView {
  bookId: string;
  /** hk1 | hk2. */
  term: string;
  /** score | comment. */
  assessmentMode: string;
  /** ĐTB môn học kì (môn điểm số); null khi chưa đủ cột để tính — không hiện 0 giả. */
  dtbHk: number | null;
  /** Đạt | Chưa đạt (môn chỉ-nhận-xét); null ở môn điểm số. */
  commentResult: string | null;
  /** Nhận xét tổng kỳ của giáo viên đi kèm bản chốt; null khi chưa chốt/không có. */
  comment: string | null;
}

/** Kết quả học tập đã công bố của con trong một khoá/môn. */
export interface GuardianCourseResultsView {
  courseId: string;
  courseName: string;
  terms: GuardianTermResultView[];
  /** Kết quả cả năm đã công bố; null khi chưa công bố. */
  year: { dtbYear: number | null; comment: string | null } | null;
  /**
   * Điểm tổng khoá đã qua cổng công bố PH-0 (tổng bị che khi còn điểm
   * chưa công bố trong khoá); null khi chưa có/không được thấy.
   */
  courseTotal: { finalGrade: number | null; gradeMax: number } | null;
}

/** Bề mặt kết quả học tập đã công bố của con, theo từng khoá/môn. */
export interface GuardianStudentResultsView {
  student: { id: string; firstName: string; lastName: string };
  courses: GuardianCourseResultsView[];
}

/**
 * PH-2 (issue #159): digest phụ huynh — tần suất tổng hợp đẩy ra cho
 * từng cặp (phụ huynh, con). Mặc định `weekly` theo research mục 1.4
 * (không push từng điểm lẻ); `daily` là tuỳ chọn của phụ huynh; `off`
 * chỉ tắt digest ĐỊNH KỲ. Đẩy riêng quá hạn ≥7 ngày là ngoại lệ tách
 * khỏi digest (research điểm chính sách 6) nên vẫn chạy bất kể tần
 * suất — kể cả khi phụ huynh chọn `off`.
 */
export type GuardianDigestFrequency = 'weekly' | 'daily' | 'off';

/** Tuỳ chọn digest của chính phụ huynh cho một con. */
export interface GuardianDigestPreferenceView {
  studentId: string;
  frequency: GuardianDigestFrequency;
}

/** Thân PUT tuỳ chọn digest: chỉ tần suất, không trường nào khác. */
export const guardianDigestPreferenceSchema = z.strictObject({
  frequency: z.enum(['weekly', 'daily', 'off']),
});
export type GuardianDigestPreferenceInput = z.infer<typeof guardianDigestPreferenceSchema>;
