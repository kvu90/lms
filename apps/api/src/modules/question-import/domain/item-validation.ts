import type { QuestionImportItemPayload } from '@lms/contracts';

/**
 * Một vấn đề của một mục chờ duyệt: `error` CHẶN duyệt (giáo viên phải
 * sửa payload cho hết lỗi), `warning` chỉ để lưu ý khi duyệt. Danh sách
 * này được bộ tách ghi lúc nhập và được tính lại mỗi lần giáo viên sửa
 * payload tại màn hình duyệt — cùng một bộ quy tắc cho cả hai đường.
 */
export interface ImportIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

const FRACTION_SUM_TOLERANCE = 0.000001;

function error(code: string, message: string): ImportIssue {
  return { severity: 'error', code, message };
}
function warning(code: string, message: string): ImportIssue {
  return { severity: 'warning', code, message };
}

/**
 * Kiểm tra cấu trúc một payload chờ duyệt theo đúng ngữ nghĩa mà ngân
 * hàng câu hỏi sẽ áp khi tạo câu (khớp `normaliseContent` của
 * QuestionsService) — nhờ vậy mục đã hết lỗi ở hàng đợi thì duyệt không
 * thể vấp lỗi nội dung ở bước tạo câu.
 */
export function validateImportItem(payload: QuestionImportItemPayload): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (!payload.questionText.trim()) {
    issues.push(error('empty_question_text', 'Nội dung câu hỏi đang trống.'));
  }
  if (payload.qtype === 'multichoice') {
    if (payload.answers.length < 2) {
      issues.push(error('too_few_options', 'Câu trắc nghiệm cần ít nhất 2 lựa chọn.'));
    } else {
      const positive = payload.answers.filter((a) => a.fraction > 0);
      if (positive.length === 0) {
        issues.push(error('no_correct_answer', 'Chưa xác định được đáp án đúng cho câu trắc nghiệm.'));
      } else {
        const sum = positive.reduce((acc, a) => acc + a.fraction, 0);
        if (Math.abs(sum - 1) > FRACTION_SUM_TOLERANCE) {
          issues.push(error('mc_fraction_sum', 'Tổng tỷ trọng của các đáp án đúng phải bằng 1 (100%).'));
        }
      }
    }
  }
  if (payload.qtype === 'truefalse') {
    if (payload.truefalseCorrect === null || payload.truefalseCorrect === undefined) {
      issues.push(error('tf_answer_unknown', 'Chưa xác định được mệnh đề này là Đúng hay Sai.'));
    }
  }
  if (payload.qtype === 'shortanswer') {
    if (!payload.answers.some((a) => a.fraction > 0)) {
      issues.push(error('sa_answer_missing', 'Câu trả lời ngắn cần ít nhất một đáp án mẫu được chấp nhận.'));
    }
  }
  if (payload.qtype === 'essay' && payload.answers.length > 0) {
    issues.push(warning('essay_answers_ignored', 'Câu tự luận không mang đáp án; các đáp án đã nhập sẽ bị bỏ qua khi duyệt.'));
  }
  const seenOutcomes = new Set<string>();
  for (const link of payload.outcomeLinks) {
    if (seenOutcomes.has(link.outcomeId)) {
      issues.push(error('duplicate_outcome_link', 'Một yêu cầu cần đạt đang bị gắn trùng cho câu này.'));
      break;
    }
    seenOutcomes.add(link.outcomeId);
  }
  return issues;
}

/** Mục có bất kỳ issue mức error nào thì bị chặn duyệt. */
export function hasBlockingIssues(issues: ImportIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
