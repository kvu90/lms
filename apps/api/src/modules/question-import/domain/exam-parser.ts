import type { QuestionImportItemPayload, QuestionImportQtype } from '@lms/contracts';
import type { SourceLine, SourceRun } from './document-text';
import { validateImportItem, type ImportIssue } from './item-validation';

/**
 * Bộ tách đề thuần QUY TẮC (issue #52 — chưa dùng AI). Đầu vào là các
 * dòng nguồn đã trích từ docx/pdf; đầu ra là danh sách mục chờ duyệt.
 *
 * CÁC QUY ƯỚC ĐÁNH DẤU ĐƯỢC HỖ TRỢ (ghi trong bàn giao của issue):
 *  1. Câu bắt đầu bằng "Câu N" (dự phòng: "N." ở đầu dòng khi cả file
 *     không có một "Câu N" nào). Lựa chọn bắt đầu bằng "A." / "A)" /
 *     "A:" ở đầu dòng, hoặc nhiều lựa chọn trên cùng một dòng.
 *  2. Đáp án đúng của trắc nghiệm: (a) lựa chọn được BÔI ĐẬM hoặc GẠCH
 *     CHÂN (chỉ docx), (b) dấu * ngay trước chữ cái lựa chọn hoặc cuối
 *     nội dung lựa chọn, (c) dòng "Đáp án: X" ngay trong khối câu,
 *     (d) mục tương ứng ở BẢNG ĐÁP ÁN cuối file. Thứ tự ưu tiên khi các
 *     nguồn mâu thuẫn: bảng đáp án > dòng "Đáp án:" > định dạng/dấu * —
 *     mâu thuẫn được ghi warning `answer_source_conflict`.
 *  3. Bảng đáp án cuối file bắt đầu bằng tiêu đề "ĐÁP ÁN" / "Bảng đáp
 *     án" / "Hướng dẫn chấm" / "Answer key"; các mục dạng "1. A",
 *     "1A", "Câu 1: A", dãy "1A 2B 3C", ô bảng (số, chữ) nối tiếp,
 *     "1. Đúng/Sai" cho câu đúng–sai, "1a. Đ" cho ý của câu đúng–sai
 *     chùm, và "1. <văn bản>" là đáp án mẫu của câu trả lời ngắn.
 *  4. Đúng–sai đơn: hai lựa chọn đúng nghĩa "Đúng"/"Sai". Đúng–sai
 *     CHÙM: một đề dẫn rồi các ý "a) b) c) d)", đáp án từng ý ghi bằng
 *     hậu tố "(Đ)"/"(S)"/"(Đúng)"/"(Sai)" cuối ý hoặc ở bảng đáp án
 *     dạng "1a. Đ" — mỗi ý thành một câu truefalse riêng mang theo đề
 *     dẫn (khớp mô hình ngân hàng: truefalse là câu một mệnh đề).
 *  5. Trả lời ngắn: câu có chỗ trống (____, …, ...) và đáp án mẫu ở
 *     dòng "Đáp án: <văn bản>" hoặc bảng đáp án (nhiều đáp án mẫu chấp
 *     nhận được ngăn bằng dấu ";"). Không lựa chọn + không đáp án mẫu
 *     → tự luận. Điểm từng câu đọc từ "(N điểm)"/"[N điểm]" nếu có.
 */

export interface ParsedImportItem {
  ordinal: number;
  sourceNumber: number | null;
  qtype: QuestionImportQtype;
  payload: QuestionImportItemPayload;
  rawText: string;
  issues: ImportIssue[];
}

export interface ExamParseResult {
  items: ParsedImportItem[];
  warnings: ImportIssue[];
}

// --- biểu thức chính quy của các quy ước -------------------------------------

const QUESTION_PRIMARY_RE = /^câu\s*(\d{1,3})\b\s*[:\.)\-–]?\s*(.*)$/iu;
const QUESTION_FALLBACK_RE = /^(\d{1,3})\s*[.\)]\s+(.*)$/u;
const OPTION_START_RE = /^\(?([A-E])\s*[.):]\s*/u;
const STATEMENT_START_RE = /^\(?([a-e])\s*[.\)]\s*/u;
const HINT_RE = /^đáp án\s*[:\-–]\s*(.+)$/iu;
const KEY_HEADING_RE = /^(đáp án|bảng đáp án|hướng dẫn chấm|answer key)\b/iu;
const MARK_RE = /[\(\[]\s*(\d+(?:[.,]\d+)?)\s*điểm\s*[\)\]]/iu;
const BLANK_RE = /_{2,}|…|\.\.\.|\(\s*\.{2,}\s*\)/u;
const TRAILING_TRUTH_RE = /[\(\[]\s*(đúng|sai|đ|s)\s*[\)\]]\s*\.?\s*$/iu;
const TRAILING_TRUTH_DASH_RE = /\s[-–:]\s*(đúng|sai)\s*\.?\s*$/iu;

const KEY_SUB_RE = /(\d{1,3})\s*[.\-]?\s*\(?([a-e])\)?\s*[.:\-–]?\s*(đúng|sai|đ|s)(?![\p{L}\p{N}])/giu;
const KEY_TRUTH_RE = /(\d{1,3})\s*[:\.)\-–]\s*(đúng|sai)(?![\p{L}])/giu;
const KEY_LETTER_RE = /(\d{1,3})\s*[:\.)\-–]?\s*\(?([A-E])\)?(?![\p{L}\p{N}])/gu;
const KEY_TEXT_RE = /^\s*(?:câu\s*)?(\d{1,3})\s*[:\.)]\s*(.+)$/iu;

// --- tiện ích trên runs --------------------------------------------------------

/** Cắt runs theo khoảng ký tự [start, end) của văn bản nối. */
function sliceRuns(runs: SourceRun[], start: number, end: number): SourceRun[] {
  const out: SourceRun[] = [];
  let pos = 0;
  for (const run of runs) {
    const runStart = pos;
    const runEnd = pos + run.text.length;
    pos = runEnd;
    const s = Math.max(start, runStart);
    const e = Math.min(end, runEnd);
    if (s < e) out.push({ text: run.text.slice(s - runStart, e - runStart), bold: run.bold, underline: run.underline });
  }
  return out;
}

/** Tỷ lệ ký tự (không tính khoảng trắng) của một đoạn được bôi đậm hoặc gạch chân. */
function markedRatio(runs: SourceRun[]): number {
  let total = 0;
  let marked = 0;
  for (const run of runs) {
    const len = run.text.replace(/\s/g, '').length;
    total += len;
    if (run.bold || run.underline) marked += len;
  }
  return total === 0 ? 0 : marked / total;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truthWord(word: string): boolean {
  const w = word.toLowerCase();
  return w === 'đúng' || w === 'đ' || w === 'true';
}

// --- bảng đáp án ---------------------------------------------------------------

interface KeyEntry {
  letter?: string;
  truth?: boolean;
  text?: string;
  subs: Map<string, boolean>;
}

function scanKeyEntriesInText(text: string, into: Map<number, KeyEntry>): number {
  let count = 0;
  const get = (n: number): KeyEntry => {
    let e = into.get(n);
    if (!e) { e = { subs: new Map() }; into.set(n, e); }
    return e;
  };
  let work = text.replace(KEY_SUB_RE, (m, n: string, letter: string, word: string) => {
    get(Number(n)).subs.set(letter.toLowerCase(), truthWord(word));
    count += 1;
    return ' '.repeat(m.length);
  });
  work = work.replace(KEY_TRUTH_RE, (m, n: string, word: string) => {
    const e = get(Number(n));
    if (e.truth === undefined) { e.truth = truthWord(word); count += 1; }
    return ' '.repeat(m.length);
  });
  work.replace(KEY_LETTER_RE, (m, n: string, letter: string) => {
    const e = get(Number(n));
    if (e.letter === undefined) { e.letter = letter.toUpperCase(); count += 1; }
    return ' '.repeat(m.length);
  });
  return count;
}

/** Phân tích vùng bảng đáp án thành bản đồ số câu → đáp án. */
function parseAnswerKey(lines: SourceLine[]): Map<number, KeyEntry> {
  const map = new Map<number, KeyEntry>();
  let pendingNumber: number | null = null;
  for (const line of lines) {
    const text = line.text.trim();
    if (/^\d{1,3}$/.test(text)) { pendingNumber = Number(text); continue; }
    if (/^[A-E]$/i.test(text) && pendingNumber !== null && !/^[a-e]$/.test(text)) {
      const e = map.get(pendingNumber) ?? { subs: new Map<string, boolean>() };
      if (e.letter === undefined) e.letter = text.toUpperCase();
      map.set(pendingNumber, e);
      pendingNumber = null;
      continue;
    }
    if (/^(đúng|sai)$/iu.test(text) && pendingNumber !== null) {
      const e = map.get(pendingNumber) ?? { subs: new Map<string, boolean>() };
      if (e.truth === undefined) e.truth = truthWord(text);
      map.set(pendingNumber, e);
      pendingNumber = null;
      continue;
    }
    pendingNumber = null;
    const found = scanKeyEntriesInText(text, map);
    if (found === 0) {
      const tm = KEY_TEXT_RE.exec(text);
      if (tm) {
        const n = Number(tm[1]);
        const e = map.get(n) ?? { subs: new Map<string, boolean>() };
        if (e.letter === undefined && e.truth === undefined && e.text === undefined) {
          e.text = tm[2]!.trim().replace(/\.$/, '');
          map.set(n, e);
        }
      }
    }
  }
  return map;
}

/**
 * Tìm vị trí bắt đầu vùng bảng đáp án: dòng tiêu đề đầu tiên sau câu hỏi
 * đầu tiên mà chính nó + 3 dòng kế tiếp chứa ít nhất 2 mục đáp án — nhờ
 * vậy dòng "Đáp án: B" đơn lẻ trong thân đề không bị nhầm thành tiêu đề.
 */
const KEY_HEADING_ALONE_RE = /^(đáp án|bảng đáp án|hướng dẫn chấm|answer key|đáp án và hướng dẫn chấm)\s*[:.]?\s*$/iu;

function findKeyZoneStart(lines: SourceLine[], firstQuestionIdx: number): number {
  // Lượt 1: tiêu đề đứng một mình ("ĐÁP ÁN") — mốc chắc chắn nhất, và
  // phải thắng các dòng "Đáp án: X" inline nằm trong thân đề trước nó.
  for (let i = firstQuestionIdx + 1; i < lines.length; i += 1) {
    if (KEY_HEADING_ALONE_RE.test(lines[i]!.text.trim())) return i;
  }
  // Lượt 2: tiêu đề kèm nội dung trên cùng dòng ("Đáp án: 1A 2B 3C") —
  // chỉ nhận khi chính dòng đó chứa ít nhất 2 mục đáp án, để một dòng
  // gợi ý inline đơn lẻ không bị nuốt thành vùng đáp án.
  for (let i = firstQuestionIdx + 1; i < lines.length; i += 1) {
    const text = lines[i]!.text.trim();
    if (!KEY_HEADING_RE.test(text)) continue;
    const probe = new Map<number, KeyEntry>();
    if (scanKeyEntriesInText(text, probe) >= 2) return i;
  }
  return -1;
}

// --- khối câu ------------------------------------------------------------------

interface Segment {
  kind: 'stem' | 'option' | 'statement';
  letter: string | null;
  text: string;
  runs: SourceRun[];
  forceMarked: boolean;
}

interface WorkBlock {
  number: number | null;
  segments: Segment[];
  hint: string | null;
  rawLines: string[];
}

function splitInlineOptions(text: string, runs: SourceRun[], expectedFirst: string): { head: Segment; options: Segment[] } {
  const markerRe = /(?:^|\s)\(?([A-E])\s*[.\)]\s+/g;
  const marks: { letter: string; segStart: number; contentStart: number }[] = [];
  let expected = expectedFirst;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(text)) !== null) {
    const letter = m[1]!;
    if (letter !== expected) continue;
    const boundary = m[0].startsWith(' ') || m[0].startsWith('\t') || m[0].startsWith('(') ? 1 : 0;
    marks.push({ letter, segStart: m.index + (m.index === 0 ? 0 : boundary), contentStart: m.index + m[0].length });
    expected = String.fromCharCode(letter.charCodeAt(0) + 1);
  }
  const headEnd = marks.length > 0 ? marks[0]!.segStart : text.length;
  const head: Segment = {
    kind: 'stem', letter: null,
    text: text.slice(0, headEnd).trim(),
    runs: sliceRuns(runs, 0, headEnd),
    forceMarked: false,
  };
  const options: Segment[] = marks.map((mark, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1]!.segStart : text.length;
    return {
      kind: 'option' as const, letter: mark.letter,
      text: text.slice(mark.contentStart, end).trim(),
      runs: sliceRuns(runs, mark.contentStart, end),
      forceMarked: false,
    };
  });
  return { head, options };
}

function nextOptionLetter(block: WorkBlock): string {
  const opts = block.segments.filter((s) => s.kind === 'option');
  if (opts.length === 0) return 'A';
  const last = opts[opts.length - 1]!.letter ?? 'A';
  return String.fromCharCode(last.charCodeAt(0) + 1);
}

function appendToSegment(seg: Segment, text: string, runs: SourceRun[]): void {
  const glue = seg.kind === 'stem' ? '\n' : ' ';
  if (seg.text !== '') {
    seg.text += glue;
    seg.runs.push({ text: glue, bold: false, underline: false });
  }
  seg.text += text;
  seg.runs.push(...runs);
}

/** Xử lý hậu tố dấu * của một đoạn lựa chọn: trả về cờ đánh dấu và làm sạch văn bản. */
function stripAsterisk(seg: Segment): boolean {
  let marked = seg.forceMarked;
  let text = seg.text;
  if (text.startsWith('*')) { marked = true; text = text.slice(1).trimStart(); }
  if (text.endsWith('*')) { marked = true; text = text.slice(0, -1).trimEnd(); }
  if (marked && text !== seg.text) {
    seg.text = text;
    seg.runs = sliceRuns(seg.runs, 0, seg.runs.reduce((a, r) => a + r.text.length, 0));
    // runs không còn khớp tuyệt đối sau khi cắt ký tự — tính lại tỷ lệ từ text đã sạch là đủ cho ngưỡng.
    seg.runs = [{ text, bold: false, underline: false }];
  }
  return marked || markedRatio(seg.runs) >= 0.8;
}

function splitBlocks(lines: SourceLine[], questionRe: RegExp): WorkBlock[] {
  const blocks: WorkBlock[] = [];
  let current: WorkBlock | null = null;

  const pushLineAsContent = (block: WorkBlock, text: string, runs: SourceRun[], forceMarked: boolean) => {
    const last = block.segments[block.segments.length - 1];
    // Lựa chọn ở đầu dòng.
    const optMatch = OPTION_START_RE.exec(text);
    if (optMatch) {
      const restStart = optMatch[0].length;
      const seg: Segment = {
        kind: 'option', letter: optMatch[1]!,
        text: text.slice(restStart).trim(),
        runs: sliceRuns(runs, restStart, text.length),
        forceMarked,
      };
      block.segments.push(seg);
      return;
    }
    // Ý con của câu đúng–sai chùm.
    const stMatch = STATEMENT_START_RE.exec(text);
    if (stMatch && !block.segments.some((s) => s.kind === 'option')) {
      const restStart = stMatch[0].length;
      block.segments.push({
        kind: 'statement', letter: stMatch[1]!.toLowerCase(),
        text: text.slice(restStart).trim(),
        runs: sliceRuns(runs, restStart, text.length),
        forceMarked,
      });
      return;
    }
    // Dòng gợi ý đáp án ngay trong khối.
    const hintMatch = HINT_RE.exec(text);
    if (hintMatch && block.segments.length > 0) {
      block.hint = hintMatch[1]!.trim();
      return;
    }
    // Lựa chọn nằm giữa dòng (nhiều lựa chọn trên một dòng).
    const { head, options } = splitInlineOptions(text, runs, nextOptionLetter(block));
    if (options.length > 0) {
      if (head.text !== '') {
        if (last) appendToSegment(last, head.text, head.runs);
        else block.segments.push({ ...head, forceMarked });
      }
      for (const opt of options) { opt.forceMarked = forceMarked; block.segments.push(opt); }
      return;
    }
    // Dòng tiếp nối thường.
    if (last) appendToSegment(last, text, runs);
    else block.segments.push({ kind: 'stem', letter: null, text, runs, forceMarked });
  };

  for (const line of lines) {
    const rawTrimmed = line.text.trim();
    if (rawTrimmed === '') continue;
    const lead = line.text.length - line.text.trimStart().length;
    const runs = sliceRuns(line.runs, lead, lead + rawTrimmed.length);
    let text = rawTrimmed;
    let forceMarked = false;
    if (text.startsWith('*') && (OPTION_START_RE.test(text.slice(1)) || questionRe.test(text.slice(1)))) {
      forceMarked = true;
      text = text.slice(1);
    }

    const qm = questionRe.exec(text);
    if (qm) {
      current = { number: Number(qm[1]), segments: [], hint: null, rawLines: [line.text] };
      blocks.push(current);
      const rest = qm[2] ?? '';
      if (rest !== '') {
        const restRuns = sliceRuns(runs, text.length - rest.length, text.length);
        const { head, options } = splitInlineOptions(rest, restRuns, 'A');
        if (head.text !== '' || options.length === 0) current.segments.push({ ...head, forceMarked });
        for (const opt of options) { opt.forceMarked = forceMarked; current.segments.push(opt); }
      }
      continue;
    }
    if (!current) continue; // phần đầu file (tiêu đề đề, hướng dẫn chung) — bỏ qua.
    current.rawLines.push(line.text);
    pushLineAsContent(current, text, runs, forceMarked);
  }
  return blocks;
}

// --- khối → mục chờ duyệt -------------------------------------------------------

function extractMark(stem: string): { stem: string; mark: number } {
  const m = MARK_RE.exec(stem);
  if (!m) return { stem, mark: 1 };
  const value = Number(m[1]!.replace(',', '.'));
  const cleaned = collapse(stem.replace(m[0], ' ')).replace(/^:\s*/, '');
  return { stem: cleaned, mark: Number.isFinite(value) && value > 0 ? value : 1 };
}

function makeName(text: string, fallbackNumber: number | null): string {
  const flat = collapse(text);
  if (flat !== '') return flat.slice(0, 90);
  return fallbackNumber !== null ? `Câu ${fallbackNumber}` : 'Câu hỏi nhập từ file';
}

function conflictWarning(): ImportIssue {
  return { severity: 'warning', code: 'answer_source_conflict', message: 'Các nguồn đánh dấu đáp án trong file không khớp nhau; đã ưu tiên bảng đáp án cuối file, rồi tới dòng "Đáp án:", cuối cùng là định dạng/dấu *.' };
}

function blockToItems(block: WorkBlock, key: Map<number, KeyEntry>): { payload: QuestionImportItemPayload; qtype: QuestionImportQtype; rawText: string; issues: ImportIssue[] }[] {
  const issues: ImportIssue[] = [];
  const stemSegs = block.segments.filter((s) => s.kind === 'stem');
  const options = block.segments.filter((s) => s.kind === 'option');
  const statements = block.segments.filter((s) => s.kind === 'statement');
  let stem = stemSegs.map((s) => s.text.trim()).filter((t) => t !== '').join('\n');
  const extracted = extractMark(stem);
  stem = extracted.stem;
  const defaultMark = extracted.mark;
  const entry = block.number !== null ? key.get(block.number) : undefined;
  const hint = block.hint;
  const rawText = block.rawLines.join('\n');

  const hintLetter = hint && /^[A-E]$/i.test(hint.trim()) ? hint.trim().toUpperCase() : null;
  const hintTruth = hint && /^(đúng|sai)$/iu.test(hint.trim()) ? truthWord(hint.trim()) : null;

  const basePayload = (partial: Partial<QuestionImportItemPayload>): QuestionImportItemPayload => ({
    name: makeName(String(partial.questionText ?? stem), block.number),
    qtype: partial.qtype ?? 'essay',
    questionText: String(partial.questionText ?? stem),
    generalFeedback: null,
    defaultMark,
    answers: partial.answers ?? [],
    options: partial.options ?? {},
    truefalseCorrect: partial.truefalseCorrect ?? null,
    outcomeLinks: [],
  });

  // --- đúng–sai chùm: mỗi ý là một câu truefalse mang theo đề dẫn --------------
  if (statements.length >= 2 && options.length === 0) {
    return statements.map((st) => {
      const stIssues = [...issues];
      let text = st.text.trim();
      let inlineTruth: boolean | null = null;
      const suffix = TRAILING_TRUTH_RE.exec(text) ?? TRAILING_TRUTH_DASH_RE.exec(text);
      if (suffix) {
        inlineTruth = truthWord(suffix[1]!);
        text = text.slice(0, suffix.index).trim();
      }
      const keyTruth = st.letter ? entry?.subs.get(st.letter) : undefined;
      let truth: boolean | null = null;
      if (inlineTruth !== null && keyTruth !== undefined && inlineTruth !== keyTruth) {
        stIssues.push(conflictWarning());
        truth = inlineTruth;
      } else if (inlineTruth !== null) truth = inlineTruth;
      else if (keyTruth !== undefined) truth = keyTruth;
      const questionText = stem !== '' ? `${stem}\n${text}` : text;
      const payload = basePayload({ qtype: 'truefalse', questionText, truefalseCorrect: truth });
      payload.name = makeName(text, block.number);
      return {
        payload,
        qtype: 'truefalse' as const,
        rawText,
        issues: stIssues,
      };
    });
  }

  // Ý đơn lẻ không thành chùm: gộp vào đề dẫn như văn bản thường.
  if (statements.length === 1 && options.length === 0) {
    stem = stem !== '' ? `${stem}\n${statements[0]!.text.trim()}` : statements[0]!.text.trim();
  }

  // --- có lựa chọn --------------------------------------------------------------
  if (options.length >= 1) {
    const marked = new Set<string>();
    const optionData = options.map((opt) => {
      const isMarked = stripAsterisk(opt);
      if (isMarked && opt.letter) marked.add(opt.letter);
      return { letter: opt.letter ?? '', text: collapse(opt.text) };
    });
    const normalized = optionData.map((o) => o.text.toLowerCase());
    const isTruthPair = optionData.length === 2
      && normalized.every((t) => t === 'đúng' || t === 'sai' || t === 'true' || t === 'false')
      && normalized[0] !== normalized[1];

    // Chọn nguồn đáp án theo thứ tự ưu tiên: bảng đáp án > gợi ý inline > đánh dấu.
    const keyLetter = entry?.letter ?? null;
    const sources: { name: string; letters: Set<string> }[] = [
      { name: 'key', letters: new Set(keyLetter ? [keyLetter] : []) },
      { name: 'hint', letters: new Set(hintLetter ? [hintLetter] : []) },
      { name: 'marks', letters: marked },
    ];
    const chosen = sources.find((s) => s.letters.size > 0);
    if (chosen) {
      for (const other of sources) {
        if (other !== chosen && other.letters.size > 0
          && [...other.letters].some((l) => !chosen.letters.has(l))) {
          issues.push(conflictWarning());
          break;
        }
      }
    }
    const correctLetters = chosen?.letters ?? new Set<string>();

    if (isTruthPair) {
      let truth: boolean | null = null;
      const correctOpt = optionData.find((o) => correctLetters.has(o.letter));
      if (correctOpt) truth = correctOpt.text.toLowerCase() === 'đúng' || correctOpt.text.toLowerCase() === 'true';
      else if (entry?.truth !== undefined) truth = entry.truth;
      else if (hintTruth !== null) truth = hintTruth;
      return [{
        payload: basePayload({ qtype: 'truefalse', truefalseCorrect: truth }),
        qtype: 'truefalse', rawText, issues,
      }];
    }

    const correctCount = optionData.filter((o) => correctLetters.has(o.letter)).length;
    const answers = optionData.map((o) => ({
      text: o.text,
      fraction: correctLetters.has(o.letter) && correctCount > 0 ? 1 / correctCount : 0,
    }));
    return [{
      payload: basePayload({
        qtype: 'multichoice',
        answers,
        options: { single: correctCount <= 1, shuffleAnswers: false },
      }),
      qtype: 'multichoice', rawText, issues,
    }];
  }

  // --- không lựa chọn -------------------------------------------------------------
  let truth: boolean | null = null;
  const suffix = TRAILING_TRUTH_RE.exec(stem) ?? TRAILING_TRUTH_DASH_RE.exec(stem);
  if (suffix) {
    truth = truthWord(suffix[1]!);
    stem = stem.slice(0, suffix.index).trim();
  } else if (entry?.truth !== undefined) truth = entry.truth;
  else if (hintTruth !== null) truth = hintTruth;
  if (truth !== null) {
    return [{ payload: basePayload({ qtype: 'truefalse', questionText: stem, truefalseCorrect: truth }), qtype: 'truefalse', rawText, issues }];
  }

  const hintText = hint && !hintLetter && hintTruth === null ? hint : null;
  const answerText = hintText ?? entry?.text ?? null;
  if (answerText !== null || BLANK_RE.test(stem)) {
    const answers = answerText !== null
      ? answerText.split(';').map((t) => collapse(t)).filter((t) => t !== '').map((text) => ({ text, fraction: 1 }))
      : [];
    return [{
      payload: basePayload({ qtype: 'shortanswer', answers, options: { useCase: false } }),
      qtype: 'shortanswer', rawText, issues,
    }];
  }

  return [{ payload: basePayload({ qtype: 'essay' }), qtype: 'essay', rawText, issues }];
}

/** Điểm vào: tách toàn bộ tài liệu thành các mục chờ duyệt. */
export function parseExamDocument(lines: SourceLine[]): ExamParseResult {
  const warnings: ImportIssue[] = [];
  const firstQuestionIdx = lines.findIndex((l) => QUESTION_PRIMARY_RE.test(l.text.trim()));
  const usePrimary = firstQuestionIdx >= 0;
  const questionRe = usePrimary ? QUESTION_PRIMARY_RE : QUESTION_FALLBACK_RE;

  let bodyLines = lines;
  let key = new Map<number, KeyEntry>();
  if (usePrimary) {
    const keyStart = findKeyZoneStart(lines, firstQuestionIdx);
    if (keyStart >= 0) {
      key = parseAnswerKey(lines.slice(keyStart));
      bodyLines = lines.slice(0, keyStart);
    }
  }

  const blocks = splitBlocks(bodyLines, questionRe);
  const items: ParsedImportItem[] = [];
  const seenTexts = new Map<string, number>();
  for (const block of blocks) {
    for (const produced of blockToItems(block, key)) {
      const merged = [...produced.issues];
      for (const vi of validateImportItem(produced.payload)) {
        if (!merged.some((i) => i.code === vi.code)) merged.push(vi);
      }
      const normText = collapse(produced.payload.questionText).toLowerCase();
      if (normText !== '' && seenTexts.has(normText)) {
        merged.push({ severity: 'warning', code: 'duplicate_question_text', message: 'Câu này trùng nội dung với một câu khác trong cùng file.' });
      } else if (normText !== '') {
        seenTexts.set(normText, items.length);
      }
      items.push({
        ordinal: items.length + 1,
        sourceNumber: block.number,
        qtype: produced.qtype,
        payload: produced.payload,
        rawText: produced.rawText,
        issues: merged,
      });
    }
  }
  if (items.length === 0) {
    warnings.push({ severity: 'error', code: 'no_questions_found', message: 'Không tìm thấy câu hỏi nào theo các quy ước đánh dấu đã hỗ trợ.' });
  }
  return { items, warnings };
}
