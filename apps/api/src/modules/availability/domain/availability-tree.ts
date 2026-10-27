/**
 * AvailabilityTree — miền thuần (không Nest, không DB), report §2#10.
 *
 * Hình dạng JSON của Moodle: một nút cây là `{ op, c: [...] }` với
 * op ∈ '&' (AND), '|' (OR), '!&' (NOT-AND), '!|' (NOT-OR); nút ROOT còn có thể
 * mang `show` (boolean) và các nút không phải root/root mang `showc`
 * (boolean theo từng con). Lá là các đối tượng điều kiện `{ type: string, ... }`.
 *
 * Ngữ nghĩa (dịch từ availability/tests/tree_test.php
 * ::test_check_available):
 *  - Cây AND/OR rỗng thì khả dụng; cây NOT rỗng thì KHÔNG khả dụng
 *    (NOT của phần tử trung hoà sẽ đảo nó — Moodle xử lý `!&`/`!|` không có
 *    con bằng cùng quy tắc gộp-rồi-phủ-định dùng ở đây).
 *  - `!&` = NOT(AND(children)) và `!|` = NOT(OR(children)) — De Morgan vì vậy
 *    là cấu trúc, không phải phép viết lại: ta gộp rồi phủ định.
 *  - `showc[i] === false` cho một con không đạt sẽ ẩn MỌI thông tin
 *    hạn chế của toàn cây ("nếu bạn không có điều kiện đó thì
 *    bạn không được thấy gì cả") — mô hình hoá ở đây thành
 *    `informationHidden = true`, và chính item bị ẩn.
 *  - Root `show === false` cũng ẩn thông tin tương tự khi không khả dụng.
 *  - Tính hiển thị của một item không khả dụng: hiện (làm mờ, kèm thông tin)
 *    chỉ khi thông tin không bị ẩn; ngược lại ẩn hẳn.
 *    Dù trường hợp nào item cũng KHÔNG truy cập được — show/showc không bao giờ cấp quyền truy cập.
 */

/**
 * Toán tử của một nút cây availability: & (AND), | (OR), !& (NAND — phủ định toàn nút), !| (NOR).
 * Khớp định dạng JSON cây điều kiện của Moodle (availability/classes).
 */
export type AvailabilityOp = '&' | '|' | '!&' | '!|';

/**
 * Điều kiện lá của cây availability: type là loại điều kiện (date, grade, profile, completion, group, grouping…), phần còn lại là tham số của điều kiện.
 */
export interface AvailabilityLeaf {
  type: string;
  [key: string]: unknown;
}

/**
 * Nút cây availability: toán tử op, cờ show (hiển thị mục dù chưa khả dụng hay ẩn hẳn) và danh sách điều kiện con.
 */
export interface AvailabilityNode {
  op: AvailabilityOp;
  c: AvailabilityChild[];
  show?: boolean;
  showc?: boolean[];
}
export type AvailabilityChild = AvailabilityNode | AvailabilityLeaf;

/**
 * Phân biệt nút cây (có op/c) với điều kiện lá.
 */
export function isTreeNode(child: AvailabilityChild): child is AvailabilityNode {
  return typeof (child as AvailabilityNode).op === 'string' && Array.isArray((child as AvailabilityNode).c);
}

/**
 * Kết quả đánh giá một điều kiện lá: available và description hiển thị cho người học khi chưa đạt.
 */
export interface LeafResult {
  available: boolean;
  /** Mô tả ngắn dễ đọc cho người dùng về điều kiện (chưa đạt), vd để hiển thị trên UI. */
  description?: string;
}

/**
 * Kết quả đánh giá toàn cây: available tổng thể, và failedDescriptions — danh sách mô tả các điều kiện lá chưa đạt ở các nút AND có show=true (để giao diện giải thích vì sao bị khoá).
 */
export interface TreeEvaluation {
  available: boolean;
  /** Đúng khi thông tin hạn chế phải bị ẩn hẳn (một con showc=false không đạt, hoặc root show=false). */
  informationHidden: boolean;
  /** Mô tả các điều kiện chưa đạt được phép hiển thị. Rỗng khi informationHidden. */
  failedDescriptions: string[];
  /** Hiển thị ở cấp item: item khả dụng thì hiển thị; item không khả dụng chỉ hiển thị khi thông tin được hiển thị. */
  visible: boolean;
  children: (TreeEvaluation | LeafResult & { leaf: true })[];
}

const OPS: AvailabilityOp[] = ['&', '|', '!&', '!|'];

/**
 * Phân tích JSON cây availability từ chuỗi/object thô; trả null khi rỗng hoặc không hợp lệ để tầng trên coi như không có điều kiện.
 * Đối chiếu Moodle: availability/classes/tree.php và condition classes tương ứng.
 */
export function parseAvailabilityTree(raw: unknown): AvailabilityNode | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('Availability tree must be an object');
  const node = raw as Record<string, unknown>;
  if (!OPS.includes(node.op as AvailabilityOp)) throw new Error(`Invalid availability op ${String(node.op)}`);
  if (!Array.isArray(node.c)) throw new Error('Availability tree node must have a c array');
  for (const child of node.c as AvailabilityChild[]) {
    if (isTreeNode(child)) parseAvailabilityTree(child);
    else if (typeof (child as AvailabilityLeaf).type !== 'string') throw new Error('Availability leaf must have a type');
  }
  return raw as AvailabilityNode;
}

function aggregate(op: AvailabilityOp, values: boolean[]): boolean {
  switch (op) {
    case '&': return values.every(Boolean);
    case '|': return values.some(Boolean);
    case '!&': return !values.every(Boolean);
    case '!|': return !values.some(Boolean);
  }
}

/**
 * Đánh giá một cây. `evaluateLeaf` do AvailabilityService cung cấp (registry
 * của các evaluator lá); hàm này chỉ sở hữu ngữ nghĩa cây.
 */
export async function evaluateTree(
  node: AvailabilityNode,
  evaluateLeaf: (leaf: AvailabilityLeaf) => Promise<LeafResult>,
  isRoot = true,
): Promise<TreeEvaluation> {
  const childResults: TreeEvaluation['children'] = [];
  const values: boolean[] = [];
  for (const child of node.c) {
    if (isTreeNode(child)) {
      const r = await evaluateTree(child, evaluateLeaf, false);
      childResults.push(r);
      values.push(r.available);
    } else {
      const r = await evaluateLeaf(child);
      childResults.push({ ...r, leaf: true });
      values.push(r.available);
    }
  }
  const available = node.c.length === 0 ? (node.op === '&' || node.op === '|') : aggregate(node.op, values);

  // Ẩn thông tin: một con không đạt mà showc của nó là false sẽ ẩn mọi thứ.
  // Với các op phủ định, một con "góp phần gây không đạt" khi nó khả dụng
  // (chính thành công của con làm NOT-AND/NOT-OR không đạt).
  let informationHidden = false;
  if (!available) {
    if (isRoot && node.show === false) informationHidden = true;
    node.c.forEach((child, i) => {
      const showc = node.showc?.[i];
      if (showc === false) {
        const childAvailable = values[i]!;
        const negated = node.op === '!&' || node.op === '!|';
        const causesFailure = negated ? childAvailable : !childAvailable;
        if (causesFailure) informationHidden = true;
        // Con là cây lồng nhau: cờ ẩn của chính nó cũng lan lên.
        const cr = childResults[i] as TreeEvaluation;
        if (!isTreeNode(child) === false && cr && 'informationHidden' in cr && cr.informationHidden && causesFailure) {
          informationHidden = true;
        }
      }
    });
    // Một cây con lồng nhau tự nó bị ẩn thông tin và gây không đạt cũng ẩn thông tin của cha.
    node.c.forEach((child, i) => {
      if (isTreeNode(child)) {
        const cr = childResults[i] as TreeEvaluation;
        const negated = node.op === '!&' || node.op === '!|';
        const causesFailure = negated ? values[i]! : !values[i]!;
        if (cr.informationHidden && causesFailure && node.showc?.[i] !== true) {
          // Chỉ khi cha không hiển thị tường minh con này.
          if (node.showc !== undefined && node.showc[i] === false) informationHidden = true;
        }
      }
    });
  }

  const failedDescriptions: string[] = [];
  if (!available && !informationHidden) {
    node.c.forEach((child, i) => {
      const negated = node.op === '!&' || node.op === '!|';
      const causesFailure = negated ? values[i]! : !values[i]!;
      if (!causesFailure) return;
      if (node.showc !== undefined && node.showc[i] === false) return;
      const cr = childResults[i]!;
      if ('failedDescriptions' in cr) failedDescriptions.push(...(cr as TreeEvaluation).failedDescriptions);
      else if ((cr as LeafResult).description) {
        const desc = (cr as LeafResult).description!;
        failedDescriptions.push(negated && isRoot ? `!${desc}` : desc);
      }
    });
  }

  return {
    available,
    informationHidden,
    failedDescriptions,
    visible: available || !informationHidden,
    children: childResults,
  };
}

/** Đường tắt đồng bộ dùng bởi các golden test với giá trị lá trong bộ nhớ. */
/**
 * Dựng map đánh giá lá từ kết quả từng điều kiện (đủ/không đủ) và mô tả hiển thị tương ứng — đầu vào cho bước gộp cây.
 */
export function leafFromMap(values: Record<string, boolean>, descriptions: Record<string, string> = {}) {
  return async (leaf: AvailabilityLeaf): Promise<LeafResult> => {
    const key = String(leaf.id ?? leaf.type);
    return { available: values[key] ?? false, description: descriptions[key] ?? key };
  };
}
