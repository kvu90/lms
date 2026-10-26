import { queryOptions, useQuery } from '@tanstack/react-query';
import type {
  CourseRosterMember,
  QuestionView,
  QuizAttemptSummary,
  ExamPinOverrideView as QuizOverrideView,
  QuizView,
} from '@lms/contracts';
import { extractRichTextPlainText } from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu trang lần ghim đề (F-01 đợt 1, rà soát #133): lần ghim
 * + nhãn câu của các slot là một query gộp (clientLoader prefetch
 * cùng khoá); ghi đè, thông tin đề nguồn và danh sách thành viên là
 * các query riêng bật theo quyền của người xem như các effect thủ
 * công trước đây. Nhãn câu là TRÍCH ĐOẠN nội dung thân câu — câu hỏi
 * không còn trường tên (quyết 11:28 ngày 26/10/2026).
 */

/** Hình dạng trả về của GET /exam-pins/:id (trang thông tin theo người xem). */
export interface QuizForUser {
  quiz: QuizView;
  myAttempts: QuizAttemptSummary[];
  myGrade: number | null;
  canAttempt: boolean;
  attemptBlockedReason: string | null;
  inProgressAttemptId: string | null;
  /** Cài đặt hiệu lực của chính người xem sau khi hợp nhất ghi đè (API trả sẵn). */
  effective: {
    timeOpen: string | null;
    timeClose: string | null;
    timeLimitSeconds: number | null;
    attemptsAllowed: number;
    passwordRequired: boolean;
    nextAttemptAt: string | null;
  };
  permissions: { manage: boolean; manageOverrides: boolean; grade: boolean; viewReports: boolean; preview: boolean; attempt: boolean };
}

/** Gói trang lần ghim: dữ liệu lần ghim + nhãn câu của từng slot đã ghim. */
export interface ExamPinPageData {
  view: QuizForUser;
  /** Nhãn câu (trích đoạn nội dung) theo id slot; slot không tra được thì vắng mặt (chỉ để hiển thị). */
  slotNames: Record<string, string>;
}

/** Thông tin ĐỀ nguồn của lần ghim (tên + version hiện hành ở ngân hàng). */
export interface ExamSourceInfo {
  name: string;
  version: number;
  currentVersionId: string;
  status: string;
}

/** Tải một endpoint độc lập: lỗi thì trả null (giữ nhịp probe thủ công trước đây). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

async function fetchExamPin(pinId: string): Promise<ExamPinPageData> {
  const view = await apiJson<QuizForUser>(`/api/v1/exam-pins/${pinId}`);
  // Tra nhãn cho slot cố định/slot ngẫu nhiên để bảng dựng đề đọc
  // được: nhãn là trích đoạn nội dung thân câu của phiên bản mới nhất.
  const slotNames: Record<string, string> = {};
  await Promise.all(
    view.quiz.slots.map(async (s) => {
      try {
        if (s.questionId) {
          const q = await apiJson<QuestionView>(`/api/v1/questions/${s.questionId}`);
          slotNames[s.id] = extractRichTextPlainText(q.latestVersion.questionText).slice(0, 120);
        }
      } catch { /* nhãn chỉ để hiển thị */ }
    }),
  );
  return { view, slotNames };
}

export function examPinQueryOptions(pinId: string) {
  return queryOptions({
    queryKey: queryKeys.examPin(pinId),
    queryFn: () => fetchExamPin(pinId),
  });
}

/** Đọc lần ghim + nhãn slot; lỗi tải nổi lên query (trang hiện lỗi + nút thử lại như trước). */
export function useExamPin(pinId: string) {
  return useQuery(examPinQueryOptions(pinId));
}

export function examPinOverridesQueryOptions(pinId: string) {
  return queryOptions({
    queryKey: queryKeys.examPinOverrides(pinId),
    queryFn: () => apiJson<QuizOverrideView[]>(`/api/v1/exam-pins/${pinId}/overrides`),
  });
}

/** Danh sách ghi đè của lần ghim; chỉ tải khi người xem có quyền quản ghi đè. */
export function useExamPinOverrides(pinId: string, enabled: boolean) {
  return useQuery({ ...examPinOverridesQueryOptions(pinId), enabled });
}

export function examSourceQueryOptions(examId: string) {
  return queryOptions({
    queryKey: queryKeys.examSource(examId),
    queryFn: async (): Promise<ExamSourceInfo | null> => {
      const view = await probe<{ version: { id: string; version: number; name: string }; paper: { status: string } }>(
        `/api/v1/exams/${examId}`,
      );
      return view
        ? {
            name: view.version.name,
            version: view.version.version,
            currentVersionId: view.version.id,
            status: view.paper.status,
          }
        : null;
    },
  });
}

/** Thông tin đề nguồn; chỉ tải khi có examId và người xem có quyền manage. */
export function useExamSource(examId: string | undefined, enabled: boolean) {
  return useQuery({
    ...examSourceQueryOptions(examId ?? ''),
    enabled: enabled && !!examId,
  });
}

export function courseRosterQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseRosterMembers(courseId),
    queryFn: async () => {
      const res = await probe<{ members: CourseRosterMember[] }>(
        `/api/v1/messages/courses/${courseId}/members?limit=100`,
      );
      return res?.members ?? [];
    },
  });
}

/** Danh sách thành viên khoá cho bộ chọn đích ghi đè; chỉ tải khi có quyền quản ghi đè. */
export function useCourseRoster(courseId: string, enabled: boolean) {
  return useQuery({ ...courseRosterQueryOptions(courseId), enabled });
}
