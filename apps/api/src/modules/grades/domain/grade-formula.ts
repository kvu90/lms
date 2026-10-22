/**
 * GradeFormula — bộ đánh giá công thức điểm AN TOÀN (parser đệ quy, KHÔNG dùng eval).
 *
 * Nguồn oracle: MoodleDocs "Grade calculations" (docs.moodle.org/en/Grade_calculations,
 * tra cứu trực tuyến 2026-10-23): công thức bắt đầu bằng dấu `=`, tham chiếu một grade item
 * bằng idnumber của nó đặt trong ngoặc vuông kép — ví dụ `[[Quiz1]]` — các phép toán số học
 * `+ - * /`, dấu ngoặc, và các hàm `sum`, `average`, `min`, `max` với đối số tách bằng dấu phẩy.
 * Ví dụ trong tài liệu: `=average([[item1]], [[item2]])`,
 * `=sum([[item1]]*0.3, [[item2]]*0.6, [[item3]]*0.1)`, `=max([[A]], [[B]], 100)`.
 *
 * Ngữ nghĩa đã chốt cho hệ này (ghi rõ vì Moodle không định nghĩa hết trong một trang):
 *  - Chia cho 0 cho kết quả null (không có điểm) thay vì lỗi/Infinity — khớp yêu cầu nghiệp vụ.
 *  - Điểm trống (null) truyền qua phép toán hai ngôi thành null; riêng các hàm
 *    sum/average/min/max BỎ QUA đối số trống, và chỉ cho null khi mọi đối số đều trống.
 *  - Hàm chưa hỗ trợ (power, round, mod, pi, if… của Moodle) bị từ chối ngay lúc phân tích
 *    cú pháp bằng lỗi rõ ràng — không âm thầm tính sai.
 */

/** Lỗi công thức: `reason` phân biệt cú pháp sai, hàm lạ và tham chiếu vòng để tầng service ánh xạ sang mã lỗi i18n. */
export class GradeFormulaError extends Error {
  constructor(
    public readonly reason: 'syntax' | 'unknown_function' | 'cycle' | 'unknown_reference',
    message: string,
  ) {
    super(message);
    this.name = 'GradeFormulaError';
  }
}

/** Các hàm được hỗ trợ trong công thức tính điểm (đúng tập hàm lõi của tài liệu Moodle được yêu cầu). */
export const FORMULA_FUNCTIONS = ['sum', 'average', 'min', 'max'] as const;
export type FormulaFunction = (typeof FORMULA_FUNCTIONS)[number];

/** Nút cây cú pháp của công thức điểm. */
export type FormulaNode =
  | { kind: 'number'; value: number }
  | { kind: 'reference'; idnumber: string }
  | { kind: 'negate'; operand: FormulaNode }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode }
  | { kind: 'call'; fn: FormulaFunction; args: FormulaNode[] };

type Token =
  | { type: 'number'; value: number }
  | { type: 'reference'; idnumber: string }
  | { type: 'identifier'; name: string }
  | { type: 'op'; value: string };

/**
 * Token hoá công thức: số, tham chiếu `[[idnumber]]`, tên hàm và toán tử/ngoặc/dấu phẩy.
 * Ném GradeFormulaError('syntax') khi gặp ký tự lạ hoặc tham chiếu không đóng ngoặc.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }
    if (ch === '[' && input[i + 1] === '[') {
      const end = input.indexOf(']]', i + 2);
      if (end === -1) throw new GradeFormulaError('syntax', 'Unclosed [[...]] reference in grade calculation');
      const idnumber = input.slice(i + 2, end).trim();
      if (!idnumber) throw new GradeFormulaError('syntax', 'Empty [[...]] reference in grade calculation');
      tokens.push({ type: 'reference', idnumber });
      i = end + 2;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      const match = /^[0-9]*\.?[0-9]+/.exec(input.slice(i))!;
      tokens.push({ type: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i))!;
      tokens.push({ type: 'identifier', name: match[0].toLowerCase() });
      i += match[0].length;
      continue;
    }
    if ('+-*/(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    throw new GradeFormulaError('syntax', `Unexpected character '${ch}' in grade calculation`);
  }
  return tokens;
}

/**
 * Phân tích công thức (có hoặc không có dấu `=` ở đầu) thành cây cú pháp bằng parser đệ quy:
 * expression → term ((+|-) term)* → factor ((*|/) factor)* → unary → primary.
 * Hàm lạ ném GradeFormulaError('unknown_function'); cú pháp sai ném ('syntax').
 */
export function parseGradeFormula(formula: string): FormulaNode {
  const body = formula.trim().startsWith('=') ? formula.trim().slice(1) : formula;
  const tokens = tokenize(body);
  if (!tokens.length) throw new GradeFormulaError('syntax', 'Grade calculation is empty');
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const isOp = (t: Token | undefined, ...values: string[]): boolean => !!t && t.type === 'op' && values.includes(t.value);
  const next = (): Token | undefined => tokens[pos++];
  const expectOp = (value: string): void => {
    const t = next();
    if (!t || t.type !== 'op' || t.value !== value) {
      throw new GradeFormulaError('syntax', `Expected '${value}' in grade calculation`);
    }
  };

  function parseExpression(): FormulaNode {
    let left = parseTerm();
    while (isOp(peek(), '+', '-')) {
      const op = (next() as { type: 'op'; value: '+' | '-' }).value;
      left = { kind: 'binary', op, left, right: parseTerm() };
    }
    return left;
  }
  function parseTerm(): FormulaNode {
    let left = parseFactor();
    while (isOp(peek(), '*', '/')) {
      const op = (next() as { type: 'op'; value: '*' | '/' }).value;
      left = { kind: 'binary', op, left, right: parseFactor() };
    }
    return left;
  }
  function parseFactor(): FormulaNode {
    const t = peek();
    if (t?.type === 'op' && t.value === '-') { next(); return { kind: 'negate', operand: parseFactor() }; }
    if (t?.type === 'op' && t.value === '+') { next(); return parseFactor(); }
    return parsePrimary();
  }
  function parsePrimary(): FormulaNode {
    const t = next();
    if (!t) throw new GradeFormulaError('syntax', 'Unexpected end of grade calculation');
    if (t.type === 'number') return { kind: 'number', value: t.value };
    if (t.type === 'reference') return { kind: 'reference', idnumber: t.idnumber };
    if (t.type === 'op' && t.value === '(') {
      const inner = parseExpression();
      expectOp(')');
      return inner;
    }
    if (t.type === 'identifier') {
      if (!(FORMULA_FUNCTIONS as readonly string[]).includes(t.name)) {
        throw new GradeFormulaError('unknown_function', `Unsupported function '${t.name}' in grade calculation`);
      }
      expectOp('(');
      const args: FormulaNode[] = [];
      const closing = peek();
      if (!(closing?.type === 'op' && closing.value === ')')) {
        args.push(parseExpression());
        while (isOp(peek(), ',')) {
          next();
          args.push(parseExpression());
        }
      }
      expectOp(')');
      if (!args.length) throw new GradeFormulaError('syntax', `Function '${t.name}' needs at least one argument`);
      return { kind: 'call', fn: t.name as FormulaFunction, args };
    }
    throw new GradeFormulaError('syntax', 'Unexpected token in grade calculation');
  }

  const ast = parseExpression();
  if (pos !== tokens.length) throw new GradeFormulaError('syntax', 'Trailing tokens in grade calculation');
  return ast;
}

/**
 * Liệt kê mọi idnumber được tham chiếu trong cây cú pháp (không trùng lặp, giữ thứ tự xuất hiện).
 */
export function formulaReferences(node: FormulaNode): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: FormulaNode): void => {
    if (n.kind === 'reference') {
      if (!seen.has(n.idnumber)) { seen.add(n.idnumber); out.push(n.idnumber); }
    } else if (n.kind === 'negate') walk(n.operand);
    else if (n.kind === 'binary') { walk(n.left); walk(n.right); }
    else if (n.kind === 'call') n.args.forEach(walk);
  };
  walk(node);
  return out;
}

/**
 * Đánh giá cây cú pháp với hàm tra điểm theo idnumber (null = chưa có điểm).
 * Chia cho 0 → null; phép toán hai ngôi có toán hạng null → null; hàm bỏ qua đối số null.
 */
export function evaluateGradeFormula(node: FormulaNode, resolve: (idnumber: string) => number | null): number | null {
  switch (node.kind) {
    case 'number': return node.value;
    case 'reference': return resolve(node.idnumber);
    case 'negate': {
      const v = evaluateGradeFormula(node.operand, resolve);
      return v === null ? null : -v;
    }
    case 'binary': {
      const l = evaluateGradeFormula(node.left, resolve);
      const r = evaluateGradeFormula(node.right, resolve);
      if (l === null || r === null) return null;
      if (node.op === '+') return l + r;
      if (node.op === '-') return l - r;
      if (node.op === '*') return l * r;
      return r === 0 ? null : l / r;
    }
    case 'call': {
      const values = node.args
        .map((a) => evaluateGradeFormula(a, resolve))
        .filter((v): v is number => v !== null);
      if (!values.length) return null;
      if (node.fn === 'sum') return values.reduce((s, v) => s + v, 0);
      if (node.fn === 'average') return values.reduce((s, v) => s + v, 0) / values.length;
      if (node.fn === 'min') return Math.min(...values);
      return Math.max(...values);
    }
  }
}

/**
 * Tiện ích: phân tích rồi đánh giá một công thức dạng chuỗi trong một lần gọi.
 */
export function calculateFromFormula(formula: string, resolve: (idnumber: string) => number | null): number | null {
  return evaluateGradeFormula(parseGradeFormula(formula), resolve);
}

/**
 * Phát hiện vòng tham chiếu trong đồ thị idnumber → các idnumber mà công thức của nó tham chiếu,
 * bắt đầu từ `start`. Trả về đường vòng (gồm nút lặp ở cuối) hoặc null khi không có vòng.
 */
export function findFormulaCycle(graph: Map<string, string[]>, start: string): string[] | null {
  const stack: string[] = [];
  const onStack = new Set<string>();
  const done = new Set<string>();
  const dfs = (node: string): string[] | null => {
    if (onStack.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    if (done.has(node)) return null;
    stack.push(node);
    onStack.add(node);
    for (const ref of graph.get(node) ?? []) {
      const cycle = dfs(ref);
      if (cycle) return cycle;
    }
    stack.pop();
    onStack.delete(node);
    done.add(node);
    return null;
  };
  return dfs(start);
}
