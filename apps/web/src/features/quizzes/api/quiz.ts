import type {
  CourseRosterMember,
  PinRegradeLogEntry,
  PinRegradeResult,
  PinVersionUpdatePreview,
  QuestionView,
  ExamPinOverrideView as QuizOverrideView,
} from '@lms/contracts';
import { extractRichTextPlainText } from '@lms/contracts';
import { apiJson } from '#lib/api';
import type {
  AttemptView,
  ExamPinOverrideFields,
  ExamPinPageData,
  ExamPinSettingsPayload,
  ExamSourceInfo,
  QuizForUser,
  RegradeQuestionVersion,
} from '../types/quiz';

/**
 * Tầng gọi API thuần của trang lần ghim đề và trang làm bài thuộc
 * feature quizzes: chỉ chứa các hàm gọi HTTP, không phụ thuộc
 * React hay React Query. Tầng `queries/` của feature bọc các hàm
 * này thành queryOptions, hook và đột biến. Tách từ module dữ
 * liệu phẳng `src/lib/quiz-data.ts` khi tổ chức lại apps/web theo
 * mô hình features/ (issue #500).
 */

/** Tải một endpoint độc lập: lỗi thì trả null (giữ nhịp probe thủ công trước đây). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Đọc lần ghim + nhãn câu của các slot (GET /exam-pins/:id rồi tra
 * nhãn từng câu cố định): nhãn là trích đoạn nội dung thân câu của
 * phiên bản mới nhất; slot không tra được thì nhãn vắng mặt.
 *
 * @param pinId - Định danh lần ghim.
 * @returns Gói trang lần ghim.
 */
export async function fetchExamPin(pinId: string): Promise<ExamPinPageData> {
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

/**
 * Đọc danh sách ghi đè của lần ghim (GET /exam-pins/:id/overrides).
 *
 * @param pinId - Định danh lần ghim.
 * @returns Danh sách ghi đè.
 */
export function fetchExamPinOverrides(pinId: string) {
  return apiJson<QuizOverrideView[]>(`/api/v1/exam-pins/${pinId}/overrides`);
}

/**
 * Đọc thông tin đề nguồn của lần ghim (GET /exams/:id, probe):
 * lỗi tải → null.
 *
 * @param examId - Định danh đề nguồn.
 * @returns Thông tin đề nguồn hoặc null.
 */
export async function fetchExamSource(examId: string): Promise<ExamSourceInfo | null> {
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
}

/**
 * Đọc danh sách thành viên khoá cho bộ chọn đích ghi đè
 * (GET /messages/courses/:id/members, probe): lỗi tải → null,
 * tầng queries hạ cấp thành danh sách rỗng.
 *
 * @param courseId - Định danh khoá.
 * @returns Gói thành viên hoặc null khi lỗi tải.
 */
export function fetchCourseRoster(courseId: string) {
  return probe<{ members: CourseRosterMember[] }>(
    `/api/v1/messages/courses/${courseId}/members?limit=100`,
  );
}

/**
 * Đọc view lượt làm (GET /quiz-attempts/:id).
 *
 * @param attemptId - Định danh lượt làm.
 * @returns View lượt làm.
 */
export function fetchQuizAttempt(attemptId: string) {
  return apiJson<AttemptView>(`/api/v1/quiz-attempts/${attemptId}`);
}

/**
 * Lưu đáp án một câu qua question engine (POST /quiz-attempts/:id/responses).
 *
 * @param vars - Lượt làm, câu và đáp án.
 * @returns Đáp ứng của API.
 */
export function saveQuizResponse(vars: {
  attemptId: string;
  questionAttemptId: string;
  response: string | null;
}) {
  return apiJson(`/api/v1/quiz-attempts/${vars.attemptId}/responses`, {
    method: 'POST',
    body: JSON.stringify({ questionAttemptId: vars.questionAttemptId, response: vars.response }),
  });
}

/**
 * Nộp bài để chốt điểm (POST /quiz-attempts/:id/submit).
 *
 * @param attemptId - Định danh lượt làm.
 * @returns Đáp ứng của API.
 */
export function submitQuizAttempt(attemptId: string) {
  return apiJson(`/api/v1/quiz-attempts/${attemptId}/submit`, { method: 'POST', body: '{}' });
}

/**
 * Đọc nhật ký chấm lại của lần ghim (GET /exam-pins/:id/regrades).
 *
 * @param pinId - Định danh lần ghim.
 * @returns Nhật ký chấm lại.
 */
export function fetchExamPinRegrades(pinId: string) {
  return apiJson<PinRegradeLogEntry[]>(`/api/v1/exam-pins/${pinId}/regrades`);
}

/**
 * Đọc lịch sử chấm lại của chính người xem (GET /exam-pins/:id/my-regrades).
 *
 * @param pinId - Định danh lần ghim.
 * @returns Lịch sử chấm lại của người xem.
 */
export function fetchExamPinMyRegrades(pinId: string) {
  return apiJson<PinRegradeLogEntry[]>(`/api/v1/exam-pins/${pinId}/my-regrades`);
}

/**
 * Đọc xem trước cập nhật version (GET /exam-pins/:id/version-update).
 *
 * @param pinId - Định danh lần ghim.
 * @returns Bản xem trước cập nhật version.
 */
export function fetchExamPinVersionUpdate(pinId: string) {
  return apiJson<PinVersionUpdatePreview>(`/api/v1/exam-pins/${pinId}/version-update`);
}

/**
 * Đọc các version của một câu cho panel chấm lại (GET /questions/:id/versions).
 *
 * @param questionId - Định danh câu hỏi.
 * @returns Danh sách version rút gọn.
 */
export function fetchRegradeQuestionVersions(questionId: string) {
  return apiJson<RegradeQuestionVersion[]>(`/api/v1/questions/${questionId}/versions`);
}

/**
 * Lưu cài đặt tổ chức của lần ghim (PATCH /exam-pins/:id).
 *
 * @param pinId - Định danh lần ghim.
 * @param payload - Thân cài đặt.
 * @returns Đáp ứng của API.
 */
export function updateExamPinSettings(pinId: string, payload: ExamPinSettingsPayload) {
  return apiJson(`/api/v1/exam-pins/${pinId}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

/**
 * Áp cập nhật version lên đúng exam version đã xem trước (POST /exam-pins/:id/version-update).
 *
 * @param pinId - Định danh lần ghim.
 * @param toExamVersionId - Định danh version đích.
 * @returns Đáp ứng của API.
 */
export function applyExamPinVersionUpdate(pinId: string, toExamVersionId: string) {
  return apiJson(`/api/v1/exam-pins/${pinId}/version-update`, {
    method: 'POST',
    body: JSON.stringify({ toExamVersionId }),
  });
}

/**
 * Tạo ghi đè cho một đích (POST /exam-pins/:id/overrides).
 *
 * @param pinId - Định danh lần ghim.
 * @param body - Các trường ghi đè kèm đích.
 * @returns Đáp ứng của API.
 */
export function createExamPinOverride(
  pinId: string,
  body: ExamPinOverrideFields & { userId?: string; groupId?: string },
) {
  return apiJson(`/api/v1/exam-pins/${pinId}/overrides`, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Sửa một ghi đè (PATCH /exam-pin-overrides/:id).
 *
 * @param overrideId - Định danh ghi đè.
 * @param fields - Các trường ghi đè mới.
 * @returns Đáp ứng của API.
 */
export function updateExamPinOverride(overrideId: string, fields: ExamPinOverrideFields) {
  return apiJson(`/api/v1/exam-pin-overrides/${overrideId}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

/**
 * Xoá một ghi đè (DELETE /exam-pin-overrides/:id).
 *
 * @param overrideId - Định danh ghi đè.
 * @returns Đáp ứng của API.
 */
export function deleteExamPinOverride(overrideId: string) {
  return apiJson(`/api/v1/exam-pin-overrides/${overrideId}`, { method: 'DELETE' });
}

/**
 * Chạy chấm lại theo đáp án (POST /exam-pins/:id/regrades):
 * dryRun=true chỉ xem trước điểm đổi.
 *
 * @param pinId - Định danh lần ghim.
 * @param vars - Câu, version đích và cờ xem trước.
 * @returns Kết quả chấm lại.
 */
export function runExamPinRegrade(
  pinId: string,
  vars: { questionId: string; toVersionId: string; dryRun: boolean },
) {
  return apiJson<PinRegradeResult>(`/api/v1/exam-pins/${pinId}/regrades`, {
    method: 'POST',
    body: JSON.stringify(vars),
  });
}

/**
 * Bắt đầu một lượt làm (POST /exam-pins/:id/attempts).
 *
 * @param pinId - Định danh lần ghim.
 * @param preview - Cờ lượt xem trước.
 * @returns Id của lượt làm vừa tạo.
 */
export function startExamPinAttempt(pinId: string, preview: boolean) {
  return apiJson<{ attempt: { id: string } }>(`/api/v1/exam-pins/${pinId}/attempts`, {
    method: 'POST',
    body: JSON.stringify({ preview }),
  });
}
