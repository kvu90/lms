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
 * PHÂN 1/0 cho multichoice và shortanswer:
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
 * (question/engine/states.php graded_state_for_fraction).
 *
 * Câu truefalse là trường hợp riêng (TF-A nguyên bản giaokhoa, điểm
 * quyết D-1, lát P5): MỘT câu gồm thân chung + 4 mệnh đề, mỗi mệnh đề
 * chấm 0/1 và fraction của CÂU tra thang Đ–S theo SỐ Ý ĐÚNG
 * (`thang[số ý đúng] / 100`). Thang là CẤU HÌNH của lần ghim, đi vào
 * qua `GradingData.tfScale`; không có thang thì mặc định QĐ 764
 * [0, 10, 25, 50, 100] — thang KHÔNG nằm trong câu hỏi. Đây là nguồn
 * gradedpartial duy nhất còn lại của chấm tự động (đúng một phần số ý
 * của câu Đ–S), bên cạnh chấm tay essay.
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
  /**
   * Các mệnh đề của câu truefalse TF-A kèm đáp án đúng của từng mệnh
   * đề — dựng từ `question_answer_keys.solution` của version đã pin
   * (mệnh đề và đáp án bám theo `statementId`, không theo vị trí).
   */
  truefalseStatements?: { statementId: string; value: boolean }[];
  /**
   * Thang Đ–S của lần ghim: tỉ lệ % cho 0..4 ý đúng của câu truefalse.
   * Vắng mặt hoặc sai hình dạng → {@link DEFAULT_TF_SCALE} (QĐ 764).
   * Thang là cấu hình của lần ghim — KHÔNG nằm trong câu hỏi.
   */
  tfScale?: readonly number[];
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
 * Thang Đ–S mặc định theo QĐ 764 (tỉ lệ % cho 0..4 ý đúng của một câu
 * truefalse chùm). Dùng khi lần ghim không cấu hình thang riêng —
 * thang là cấu hình của lần ghim, engine chỉ giữ bản mặc định này làm
 * giá trị rơi về, KHÔNG đọc từ câu hỏi.
 */
export const DEFAULT_TF_SCALE: readonly number[] = [0, 10, 25, 50, 100];

/**
 * Mã hoá đáp án của học sinh cho một câu truefalse chùm thành chuỗi
 * response lưu trong step data: JSON của bản đồ `statementId →
 * boolean` (true = học sinh chọn "Đúng" cho mệnh đề đó). Mệnh đề học
 * sinh không trả lời thì VẮNG MẶT trong bản đồ (phân biệt được với
 * chọn "Sai"). Lượt online (web) và lượt giấy (CAM recordScan quy các
 * cặp ô Đ/S về cùng bản đồ này) đều dùng đúng quy ước này.
 *
 * @param answers - Bản đồ đáp án theo id mệnh đề.
 * @returns Chuỗi JSON để lưu làm response của attempt.
 */
export function encodeTrueFalseResponse(answers: Readonly<Record<string, boolean>>): string {
  return JSON.stringify(answers);
}

/**
 * Đọc chuỗi response của câu truefalse chùm về bản đồ đáp án. Response
 * rỗng/hỏng/không phải JSON object → bản đồ rỗng (mọi mệnh đề tính là
 * chưa trả lời); các giá trị không phải boolean bị bỏ qua. Hàm thuần
 * và toàn phần: không bao giờ ném lỗi.
 *
 * @param response - Chuỗi response đã lưu trong step data.
 * @returns Bản đồ `statementId → boolean` của các mệnh đề đã trả lời.
 */
export function decodeTrueFalseResponse(response: string | null): Record<string, boolean> {
  if (!response) return {};
  try {
    const parsed: unknown = JSON.parse(response);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Dữ kiện băm chống trùng của một câu truefalse TF-A (issue #316): đáp
 * án của TF-A không nằm ở các dòng đáp án thông thường mà là giá trị
 * Đúng/Sai của TỪNG mệnh đề, lưu ở bản ghi phía đáp án (solution dạng
 * `{ answers: [{ statementId, value }] }`). Hàm này ghép nội dung text
 * của từng mệnh đề trong tài liệu thân câu (nút statementList chốt
 * đuôi tài liệu) với giá trị Đ/S của đúng mệnh đề đó theo statementId,
 * cho ra danh sách (text, isCorrect) cùng hình với dữ kiện băm của các
 * loại câu có dòng đáp án — để công thức hash chống trùng duy nhất
 * phủ được giá trị Đ/S: hai câu TF-A cùng chữ nhưng khác Đ/S ở một
 * mệnh đề cho hash khác nhau, không còn bị kết luận trùng hoàn toàn.
 *
 * Đây là điểm ghép DUY NHẤT dùng chung cho cả hai đường băm (version
 * đã lưu trong ngân hàng và payload chưa lưu qua MCP) để hai đường
 * không bao giờ lệch nhau. Tài liệu không đúng hình TF-A hoặc solution
 * thiếu/không đúng hình thì trả danh sách rỗng — khi đó hash rơi về
 * chỉ gồm thân câu như trước (dữ kiện lỗi hình vốn đã bị chặn ở cổng
 * tạo câu, nhánh này chỉ là phòng thủ cho dữ liệu cũ).
 */
export function truefalseHashAnswers(
  questionText: unknown,
  solution: unknown,
): { textPlain: string; isCorrect: boolean }[] {
  const doc = questionText as { content?: { type?: string; content?: unknown[] }[] } | null;
  const list = doc?.content?.[doc.content.length - 1];
  if (!list || list.type !== 'statementList' || !Array.isArray(list.content)) return [];
  const sol = solution as { answers?: { statementId?: unknown; value?: unknown }[] } | null;
  if (!sol || !Array.isArray(sol.answers)) return [];
  const valueById = new Map<string, boolean>();
  for (const a of sol.answers) {
    if (typeof a?.statementId === 'string' && typeof a?.value === 'boolean') {
      valueById.set(a.statementId, a.value);
    }
  }
  const collectText = (node: unknown): string => {
    if (!node || typeof node !== 'object') return '';
    const n = node as { text?: unknown; content?: unknown[] };
    if (typeof n.text === 'string') return n.text;
    return (n.content ?? []).map((child) => collectText(child)).join('');
  };
  const out: { textPlain: string; isCorrect: boolean }[] = [];
  for (const statement of list.content) {
    const s = statement as { attrs?: { id?: unknown }; content?: unknown[] };
    if (typeof s?.attrs?.id !== 'string') return [];
    out.push({ textPlain: (s.content ?? []).map((child) => collectText(child)).join(''), isCorrect: valueById.get(s.attrs.id) === true });
  }
  return out;
}

/**
 * Chấm truefalse TF-A (một câu chùm 4 mệnh đề): từng mệnh đề chấm 0/1
 * bằng cách so đáp án học sinh chọn (theo `statementId`) với đáp án
 * đúng của mệnh đề đó; fraction của câu = `thang[số ý đúng] / 100` với
 * thang lấy từ `data.tfScale` của lần ghim (sai hình dạng → mặc định
 * QĐ 764). Mệnh đề học sinh không trả lời tính là ý sai. `rightAnswer`
 * hiển thị là dãy Đúng/Sai của các mệnh đề theo đúng thứ tự của câu
 * (vd "Đúng, Sai, Đúng, Đúng").
 */
function gradeTruefalse(data: GradingData, response: string | null): GradeOutcome {
  const statements = data.truefalseStatements ?? [];
  const rightAnswer = statements.map((s) => (s.value ? 'Đúng' : 'Sai')).join(', ');
  if (statements.length === 0) {
    return { fraction: 0, state: gradedStateForFraction(0), rightAnswer };
  }
  const given = decodeTrueFalseResponse(response);
  const correctCount = statements.filter((s) => given[s.statementId] === s.value).length;
  const scale = data.tfScale && data.tfScale.length === statements.length + 1
    ? data.tfScale
    : DEFAULT_TF_SCALE;
  const percent = scale[Math.min(correctCount, scale.length - 1)] ?? 0;
  const fraction = percent / 100;
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
 * essay) theo mô hình giaokhoa: multichoice/shortanswer cho fraction
 * NHỊ PHÂN 1/0; truefalse chấm từng mệnh đề rồi tra thang Đ–S của lần
 * ghim (có thể ra gradedpartial); essay không tự chấm — trả
 * needsgrading với fraction null chờ người chấm.
 *
 * Quy ước response dạng chuỗi (lưu trong step data `answer`):
 * truefalse — JSON của bản đồ `statementId → boolean` (xem
 * {@link encodeTrueFalseResponse}); shortanswer/essay — văn bản trả
 * lời; multichoice — id của đáp án đã chọn (đúng một id; nhiều id ngăn
 * bằng dấu phẩy bị chấm 0 theo luật chọn-một của mô hình mới).
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
