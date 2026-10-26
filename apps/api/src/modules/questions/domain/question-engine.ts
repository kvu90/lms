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
 * Chấm điểm theo MÔ HÌNH GIAOKHOA (quyết 12:04 ngày 26/10/2026, đợt
 * port #248): đáp án KHÔNG còn tỉ trọng (fraction) — mỗi dòng đáp án chỉ
 * mang cờ đúng/sai nhị phân `isCorrect`, và việc chấm tự động là NHỊ
 * PHÂN 1/0 cho multichoice, truefalse và shortanswer:
 *   - truefalse: 1 khi phía học sinh chọn trùng phía đúng (phía đúng =
 *     dòng đáp án phía Đúng mang `isCorrect`, tra qua options
 *     truefalse trueAnswer/falseAnswer).
 *   - multichoice: 1 khi học sinh chọn ĐÚNG MỘT đáp án và đó là đáp án
 *     đúng duy nhất của câu (mô hình giaokhoa khoá một đáp án đúng);
 *     chọn khác, chọn nhiều hoặc không chọn đều 0.
 *   - shortanswer: 1 khi đáp án khớp CHÍNH XÁC một đáp án được chấp
 *     nhận sau chuẩn hoá (cắt khoảng trắng hai đầu; hoa/thường theo
 *     tuỳ chọn useCase) — ký tự đại diện `*` đã BỎ HẲN (điểm quyết
 *     D-2). Chế độ đáp án số (điểm 6.3.3 issue #30) giữ nguyên: đáp án
 *     vi phạm ràng buộc số bị 0 điểm ngay, không rơi xuống so khớp.
 *   - essay: never auto-graded — the attempt goes to needsgrading.
 * `rightAnswer` (đáp án đúng để hiển thị xem lại) luôn suy từ dòng đáp
 * án `isCorrect` của version đã pin, không còn suy từ fraction cao nhất.
 * Trạng thái graded* vẫn suy từ fraction bằng ngưỡng của Moodle
 * (question/engine/states.php graded_state_for_fraction) — với chấm tự
 * động nhị phân chỉ còn gradedright/gradedwrong; gradedpartial từ nay
 * CHỈ còn xuất hiện qua chấm tay essay (manualGradeAttempt) khi giáo
 * viên cho điểm lẻ.
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

/** Một đáp án đã trích text thuần từ tài liệu Tiptap, kèm cờ đúng/sai nhị phân của nó. */
export interface GradableAnswer {
  id: string;
  text: string;
  /** Cờ đúng/sai của dòng đáp án (`question_answers.is_correct`) — thay hẳn tỉ trọng fraction theo quyết 12:04 ngày 26/10/2026. */
  isCorrect: boolean;
}

/**
 * Dữ liệu chấm của một version đã pin, do service dựng từ question_answers +
 * bảng options của qtype tương ứng. Đáp án đúng của multichoice/truefalse/
 * shortanswer nằm ở cờ `isCorrect` của chính các dòng đáp án; lời giải
 * (solution) KHÔNG tham gia chấm — nó chỉ là nội dung hiển thị xem lại.
 */
export interface GradingData {
  answers: GradableAnswer[];
  truefalse?: { trueanswerId: string; falseanswerId: string };
  shortanswer?: {
    useCase: boolean;
    /** Chế độ đáp án số kiểu thi tốt nghiệp (điểm 6.3.3 đã chốt trên issue #30): cờ CẤU HÌNH, mặc định TẮT = ngữ nghĩa Moodle nguyên vẹn. */
    numericAnswer?: boolean;
    /** Độ dài tối đa của đáp án số (ký tự); null = mặc định 4 như phiếu thi tốt nghiệp. */
    numericMaxLength?: number | null;
    /** Cho phép dấu +/− ở đầu đáp án số. */
    numericAllowSign?: boolean;
    /** Cho phép một dấu thập phân (`.` hoặc `,`) trong đáp án số. */
    numericAllowDecimal?: boolean;
  };
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

/**
 * Chấm truefalse (một mệnh đề, hai phía Đúng/Sai): phía đúng là phía mà
 * dòng đáp án của nó mang `isCorrect` — phía Đúng tra qua
 * `truefalse.trueanswerId` của options. Response theo quy ước engine là
 * chuỗi 'true'/'false' (lượt giấy OMR và lượt online đều quy về dạng
 * này trước khi vào engine). Đúng phía → 1, sai phía hoặc response
 * không đọc được → 0. `rightAnswer` hiển thị là TEXT của dòng đáp án
 * đúng (vd "Đúng"), không còn là chữ 'True'/'False' cứng.
 */
function gradeTruefalse(data: GradingData, response: string | null): GradeOutcome {
  const trueRow = data.answers.find((a) => a.id === data.truefalse?.trueanswerId);
  const correctIsTrue = trueRow?.isCorrect ?? false;
  const correctRow = data.answers.find((a) => a.isCorrect);
  const rightAnswer = correctRow?.text ?? (correctIsTrue ? 'True' : 'False');
  const given = (response ?? '').trim().toLowerCase();
  const givenBool = given === 'true' || given === '1' ? true : given === 'false' || given === '0' ? false : null;
  const fraction = givenBool !== null && givenBool === correctIsTrue ? 1 : 0;
  return { fraction, state: gradedStateForFraction(fraction), rightAnswer };
}

/** Độ dài tối đa mặc định của đáp án số khi chế độ bật mà không đặt riêng (theo phiếu thi tốt nghiệp: tối đa 4 ký tự). */
export const NUMERIC_ANSWER_DEFAULT_MAX_LENGTH = 4;

/**
 * Kiểm tra một đáp án theo chế độ đáp án số: sau khi cắt khoảng trắng
 * hai đầu, đáp án phải là MỘT số — dấu (nếu cho phép) + phần nguyên +
 * phần thập phân tuỳ chọn (nếu cho phép) — và tổng số ký tự không vượt
 * độ dài tối đa. Vi phạm bất kỳ ràng buộc nào → đáp án không hợp lệ.
 */
export function isValidNumericAnswer(response: string, opts: { maxLength?: number | null; allowSign?: boolean; allowDecimal?: boolean }): boolean {
  const value = response.trim();
  if (value === '') return false;
  const maxLength = opts.maxLength ?? NUMERIC_ANSWER_DEFAULT_MAX_LENGTH;
  if ([...value].length > maxLength) return false;
  const sign = opts.allowSign === false ? '' : '[+-]?';
  const decimal = opts.allowDecimal === false ? '' : '(?:[.,][0-9]+)?';
  return new RegExp(`^${sign}[0-9]+${decimal}$`).test(value);
}

/**
 * Chuẩn hoá một đáp án shortanswer trước khi so khớp CHÍNH XÁC: cắt
 * khoảng trắng hai đầu; khi câu KHÔNG phân biệt hoa/thường (useCase
 * tắt) thì gấp chữ thường cả hai phía. KHÔNG còn ký tự đại diện `*`
 * (điểm quyết D-2): đáp án của học sinh phải bằng đúng một đáp án được
 * chấp nhận, lệch một ký tự là không ăn điểm.
 */
function normaliseShortanswerText(value: string, ignoreCase: boolean): string {
  const trimmed = value.trim();
  return ignoreCase ? trimmed.toLowerCase() : trimmed;
}

/**
 * Chấm shortanswer nhị phân: khớp chính xác (sau chuẩn hoá) với BẤT KỲ
 * đáp án được chấp nhận nào (`isCorrect`) → 1; ngoài ra 0. Chế độ đáp
 * án số bật thì cổng hợp lệ số chạy TRƯỚC: vi phạm ràng buộc độ dài/bộ
 * ký tự → 0 điểm ngay, không rơi xuống so khớp (điểm 6.3.3, issue
 * #30). `rightAnswer` hiển thị là đáp án được chấp nhận đầu tiên theo
 * thứ tự lưu.
 */
function gradeShortanswer(data: GradingData, response: string | null): GradeOutcome {
  const ignoreCase = !(data.shortanswer?.useCase ?? false);
  const given = response ?? '';
  const accepted = data.answers.filter((a) => a.isCorrect);
  const rightAnswer = accepted[0]?.text ?? '';
  // Chế độ đáp án số bật: đáp án vi phạm ràng buộc độ dài/bộ ký tự bị 0
  // điểm NGAY, không rơi xuống so khớp mẫu (điểm 6.3.3, issue #30).
  if (data.shortanswer?.numericAnswer) {
    const valid = isValidNumericAnswer(given, {
      maxLength: data.shortanswer.numericMaxLength,
      allowSign: data.shortanswer.numericAllowSign,
      allowDecimal: data.shortanswer.numericAllowDecimal,
    });
    if (!valid) {
      return { fraction: 0, state: gradedStateForFraction(0), rightAnswer };
    }
  }
  const givenNormalised = normaliseShortanswerText(given, ignoreCase);
  const matched = givenNormalised !== ''
    && accepted.some((a) => normaliseShortanswerText(a.text, ignoreCase) === givenNormalised);
  const fraction = matched ? 1 : 0;
  return { fraction, state: gradedStateForFraction(fraction), rightAnswer };
}

/**
 * Chấm multichoice nhị phân theo mô hình giaokhoa: câu có đúng MỘT đáp
 * án đúng và học sinh chọn một đáp án — chọn trúng đáp án đúng (và chỉ
 * một đáp án đó) → 1; chọn đáp án sai, chọn nhiều đáp án hoặc không
 * chọn → 0. Không còn cộng tỉ trọng từng phần: trạng thái
 * gradedpartial không xuất phát từ multichoice nữa.
 */
function gradeMultichoice(data: GradingData, response: string | null): GradeOutcome {
  const selectedIds = new Set((response ?? '').split(',').map((x) => x.trim()).filter((x) => x !== ''));
  const selected = data.answers.filter((a) => selectedIds.has(a.id));
  const correctRow = data.answers.find((a) => a.isCorrect);
  const fraction = selected.length === 1 && selected[0]!.isCorrect ? 1 : 0;
  return { fraction, state: gradedStateForFraction(fraction), rightAnswer: correctRow?.text ?? '' };
}

/** Grade one response against a pinned version's answers/options. Pure and total. */
/**
 * Chấm một câu trả lời theo qtype (truefalse, multichoice, shortanswer,
 * essay) theo mô hình giaokhoa: ba qtype tự chấm cho fraction NHỊ PHÂN
 * 1/0 và trạng thái gradedright/gradedwrong tương ứng; essay không tự
 * chấm — trả needsgrading với fraction null chờ người chấm.
 *
 * Quy ước response dạng chuỗi (lưu trong step data `answer`):
 * truefalse — 'true'/'false'; shortanswer/essay — văn bản trả lời;
 * multichoice — id của đáp án đã chọn (đúng một id; nhiều id ngăn bằng
 * dấu phẩy bị chấm 0 theo luật chọn-một của mô hình mới).
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
