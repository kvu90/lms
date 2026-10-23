/**
 * Question engine domain — PURE (no Nest, no DB), report §2#8.
 *
 * Ported from Moodle core_question's engine semantics
 * (question/engine/tests/questionusagebyactivity_test.php: usages group
 * attempts; attempts start in `notstarted`, a deferred-feedback attempt is
 * started → answered → finished/graded, and EVERY transition is a step).
 *
 * States follow Moodle `question_state` names:
 *   notstarted → todo → complete | incomplete → gradedright | gradedpartial
 *   | gradedwrong | needsgrading; finishing an unanswered attempt ⇒ gaveup.
 *   needsgrading is where manually graded qtypes (essay) land at finish.
 *
 * Behaviours are an internal EXTENSION POINT (interface + registry in the
 * service). `deferredfeedback` is the only behaviour shipped in core:
 * responses are stored as steps and graded only when the usage finishes,
 * against the answer/options rows of the PINNED question version.
 *
 * Grading follows each standard qtype's grade_response
 * (question/type/<qtype>/question.php):
 *   - truefalse: fraction 1 when the response matches the correct side.
 *   - shortanswer: the FIRST answer (in stored order) whose pattern matches
 *     via compare_string_with_wildcard (`*` wildcard, `\*` literal) decides
 *     the fraction; case sensitivity follows the useCase option.
 *   - multichoice single: the chosen answer's fraction; multiple: the sum
 *     of the chosen answers' fractions clamped to [0, 1].
 *   - essay: never auto-graded — the attempt goes to needsgrading.
 * The graded state derives from the fraction with Moodle's thresholds
 * (question/engine/states.php graded_state_for_fraction): below 0.000001 is
 * gradedwrong, above 0.999999 is gradedright, in between gradedpartial.
 */

export const QUESTION_STATES = [
  'notstarted', 'todo', 'incomplete', 'complete',
  'gradedright', 'gradedpartial', 'gradedwrong', 'gaveup', 'finished', 'needsgrading',
] as const;
/**
 * Trạng thái của một question attempt theo máy trạng thái của Moodle question engine: todo, complete, needsgrading, finished, gaveup, gradedright/gradedwrong/gradedpartial…
 */
export type QuestionState = (typeof QUESTION_STATES)[number];

export const GRADED_STATES: QuestionState[] = ['gradedright', 'gradedpartial', 'gradedwrong'];

const TRANSITIONS: Record<string, QuestionState[]> = {
  notstarted: ['todo'],
  todo: ['complete', 'incomplete', 'gaveup', 'gradedright', 'gradedpartial', 'gradedwrong', 'needsgrading'],
  incomplete: ['complete', 'incomplete', 'gaveup', 'gradedright', 'gradedpartial', 'gradedwrong', 'needsgrading'],
  complete: ['complete', 'incomplete', 'gradedright', 'gradedpartial', 'gradedwrong', 'needsgrading'],
  gradedright: [], gradedpartial: [], gradedwrong: [], gaveup: [], finished: [],
  // Chấm tay (manual grading của Moodle): người chấm cho điểm một attempt
  // đang chờ ở needsgrading — attempt rời needsgrading sang trạng thái
  // graded* suy từ fraction được cho, kèm một step ghi lại việc chấm.
  needsgrading: ['gradedright', 'gradedpartial', 'gradedwrong'],
};

/**
 * Kiểm tra chuyển trạng thái có hợp lệ trong máy trạng thái question attempt hay không.
 */
export function canTransition(from: string, to: QuestionState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}
/**
 * Trạng thái đã kết thúc (không nhận thêm thao tác) hay chưa. needsgrading
 * được tính là đã kết thúc ở tầng usage như Moodle: lượt làm đã chốt, chỉ
 * còn chờ người chấm cho điểm.
 */
export function isFinishedState(state: string): boolean {
  return GRADED_STATES.includes(state as QuestionState) || state === 'gaveup' || state === 'finished' || state === 'needsgrading';
}

/** Một đáp án đã trích text thuần từ tài liệu Tiptap, kèm tỷ trọng của nó. */
export interface GradableAnswer {
  id: string;
  text: string;
  fraction: number;
}

/**
 * Dữ liệu chấm của một version đã pin, do service dựng từ question_answers +
 * bảng options của qtype tương ứng. fraction của đáp án là tỷ trọng trong
 * nội bộ câu (0..1, có thể âm ở lựa chọn sai của multichoice nhiều đáp án),
 * không phải điểm tuyệt đối.
 */
export interface GradingData {
  answers: GradableAnswer[];
  multichoice?: { single: boolean };
  truefalse?: { trueanswerId: string; falseanswerId: string };
  shortanswer?: { useCase: boolean };
}

export interface GradeOutcome {
  fraction: number | null; // null khi chờ chấm tay (essay)
  state: QuestionState; // gradedright | gradedpartial | gradedwrong | needsgrading
  rightAnswer: string;
}

/**
 * Suy trạng thái graded* từ fraction theo ngưỡng của Moodle
 * (question/engine/states.php::graded_state_for_fraction).
 */
export function gradedStateForFraction(fraction: number): QuestionState {
  if (fraction < 0.000001) return 'gradedwrong';
  if (fraction > 0.999999) return 'gradedright';
  return 'gradedpartial';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * So khớp đáp án học viên với mẫu có ký tự đại diện `*` của shortanswer
 * (qtype_shortanswer_question::compare_string_with_wildcard): `*` khớp mọi
 * dãy ký tự, `\*` là dấu sao thường; hai đầu chuỗi được cắt khoảng trắng;
 * ignorecase tương ứng nghịch đảo của tuỳ chọn useCase.
 */
export function compareStringWithWildcard(value: string, pattern: string, ignoreCase: boolean): boolean {
  const bits = pattern.trim().split(/(?<!\\)\*+/).map((bit) => escapeRegExp(bit.replace(/\\\*/g, '*')));
  const regexp = new RegExp(`^${bits.join('.*')}$`, ignoreCase ? 'iu' : 'u');
  return regexp.test(value.trim());
}

function gradeTruefalse(data: GradingData, response: string | null): GradeOutcome {
  const trueRow = data.answers.find((a) => a.id === data.truefalse?.trueanswerId);
  // Moodle: phía đúng là dòng đáp án mang fraction 1 (question_truefalse trỏ
  // vào hai dòng, đáp án đúng có fraction 1, đáp án sai có fraction 0).
  const correctIsTrue = (trueRow?.fraction ?? 0) >= 1;
  const rightAnswer = correctIsTrue ? 'True' : 'False';
  const given = (response ?? '').trim().toLowerCase();
  const givenBool = given === 'true' || given === '1' ? true : given === 'false' || given === '0' ? false : null;
  const fraction = givenBool !== null && givenBool === correctIsTrue ? 1 : 0;
  return { fraction, state: gradedStateForFraction(fraction), rightAnswer };
}

function gradeShortanswer(data: GradingData, response: string | null): GradeOutcome {
  const ignoreCase = !(data.shortanswer?.useCase ?? false);
  const given = response ?? '';
  let fraction = 0;
  for (const answer of data.answers) {
    if (given.trim() !== '' && compareStringWithWildcard(given, answer.text, ignoreCase)) {
      fraction = answer.fraction;
      break; // Chiến lược khớp đầu tiên: đáp án khớp đầu tiên theo thứ tự lưu quyết định fraction.
    }
  }
  const best = data.answers.reduce<GradableAnswer | undefined>(
    (acc, a) => (acc === undefined || a.fraction > acc.fraction ? a : acc), undefined);
  return { fraction, state: gradedStateForFraction(fraction), rightAnswer: best?.text ?? '' };
}

function gradeMultichoice(data: GradingData, response: string | null): GradeOutcome {
  const single = data.multichoice?.single ?? true;
  const selectedIds = new Set((response ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''));
  const selected = data.answers.filter((a) => selectedIds.has(a.id));
  let fraction: number;
  if (single) {
    fraction = selected[0]?.fraction ?? 0;
  } else {
    fraction = Math.min(Math.max(0, selected.reduce((sum, a) => sum + a.fraction, 0)), 1);
  }
  const rightAnswer = single
    ? (data.answers.reduce<GradableAnswer | undefined>((acc, a) => (acc === undefined || a.fraction > acc.fraction ? a : acc), undefined)?.text ?? '')
    : data.answers.filter((a) => a.fraction > 0).map((a) => a.text).join(', ');
  return { fraction, state: gradedStateForFraction(fraction), rightAnswer };
}

/** Grade one response against a pinned version's answers/options. Pure and total. */
/**
 * Chấm một câu trả lời theo qtype chuẩn Moodle (truefalse, multichoice,
 * shortanswer, essay): trả fraction và trạng thái graded*; essay không tự
 * chấm — trả needsgrading với fraction null chờ người chấm.
 * Đối chiếu Moodle: question/type/<qtype>/question.php (grade_response).
 *
 * Quy ước response dạng chuỗi (lưu trong step data `answer`):
 * truefalse — 'true'/'false'; shortanswer/essay — văn bản trả lời;
 * multichoice — id của đáp án đã chọn, nhiều id ngăn bằng dấu phẩy khi
 * câu cho chọn nhiều đáp án.
 */
export function gradeAnswer(qtype: string, data: GradingData, response: string | null): GradeOutcome {
  switch (qtype) {
    case 'truefalse': return gradeTruefalse(data, response);
    case 'shortanswer': return gradeShortanswer(data, response);
    case 'multichoice': return gradeMultichoice(data, response);
    case 'essay': return { fraction: null, state: 'needsgrading', rightAnswer: '' };
    default:
      // Qtype lạ: engine lõi không tự chấm được.
      return { fraction: 0, state: 'gradedwrong', rightAnswer: '' };
  }
}

/**
 * Behaviour extension point. A behaviour decides how responses move the
 * attempt state and when grading happens. deferredfeedback: submitting only
 * records the response (complete/incomplete); grading happens at finish.
 */
/**
 * Hành vi tương tác của lượt làm (deferred feedback, immediate feedback…): quyết định trạng thái sau khi nộp và thời điểm công bố điểm — xem DeferredFeedbackBehaviour.
 */
export interface QuestionBehaviour {
  readonly name: string;
  stateAfterSubmit(response: string | null): QuestionState;
  gradeAtFinish(qtype: string, data: GradingData, response: string | null): GradeOutcome | null;
}

/**
 * Hành vi phản hồi trì hoãn (deferred feedback): nộp bài chỉ ghi nhận đáp án,
 * điểm và trạng thái graded* chỉ chốt khi kết thúc usage — khớp behaviour mặc định của quiz Moodle.
 */
export class DeferredFeedbackBehaviour implements QuestionBehaviour {
  readonly name = 'deferredfeedback';
  stateAfterSubmit(response: string | null): QuestionState {
    return response !== null && response.trim() !== '' ? 'complete' : 'incomplete';
  }
  gradeAtFinish(qtype: string, data: GradingData, response: string | null): GradeOutcome | null {
    if (response === null || response.trim() === '') return null; // → gaveup
    return gradeAnswer(qtype, data, response);
  }
}

export const BEHAVIOURS: Record<string, QuestionBehaviour> = {
  deferredfeedback: new DeferredFeedbackBehaviour(),
};

/** Usage-level rollup: finished only when every started attempt reached a finished state. */
/**
 * Trạng thái tổng của một question usage suy từ các attempt: notstarted / inprogress / finished.
 */
export function usageState(attemptStates: string[]): 'notstarted' | 'inprogress' | 'finished' {
  if (attemptStates.length === 0 || attemptStates.every((s) => s === 'notstarted')) return 'notstarted';
  if (attemptStates.every((s) => isFinishedState(s))) return 'finished';
  return 'inprogress';
}
