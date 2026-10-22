/**
 * AvailabilityTree — pure domain (no Nest, no DB), report §2#10.
 *
 * Moodle JSON shape: a tree node is `{ op, c: [...] }` with
 * op ∈ '&' (AND), '|' (OR), '!&' (NOT-AND), '!|' (NOT-OR); the ROOT node may
 * also carry `show` (boolean) and non-root/root nodes carry `showc`
 * (boolean per child). Leaves are condition objects `{ type: string, ... }`.
 *
 * Semantics (translated from availability/tests/tree_test.php
 * ::test_check_available):
 *  - Empty AND/OR tree is available; empty NOT tree is NOT available
 *    (NOT of the identity would invert it — Moodle treats `!&`/`!|` of no
 *    children via the same aggregate-then-negate rule used here).
 *  - `!&` = NOT(AND(children)) and `!|` = NOT(OR(children)) — De Morgan is
 *    therefore structural, not a rewrite: we aggregate then negate.
 *  - `showc[i] === false` for a failing child hides ALL restriction
 *    information for the whole tree ("if you don't have that condition you
 *    don't get to see anything at all") — modelled here as
 *    `informationHidden = true`, and the item itself is hidden.
 *  - Root `show === false` similarly hides information when unavailable.
 *  - Visibility of an unavailable item: shown (greyed, with information)
 *    only when information is not hidden; otherwise hidden entirely.
 *    Either way the item is NOT accessible — show/showc never grant access.
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
  /** Short human description of the (failed) condition, e.g. for UI display. */
  description?: string;
}

/**
 * Kết quả đánh giá toàn cây: available tổng thể, và failedDescriptions — danh sách mô tả các điều kiện lá chưa đạt ở các nút AND có show=true (để giao diện giải thích vì sao bị khoá).
 */
export interface TreeEvaluation {
  available: boolean;
  /** True when restriction information must be hidden entirely (a showc=false child failed, or root show=false). */
  informationHidden: boolean;
  /** Descriptions of failed conditions that are allowed to be shown. Empty when informationHidden. */
  failedDescriptions: string[];
  /** Item-level visibility: available items are visible; unavailable items are visible only when info is shown. */
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
 * Evaluate a tree. `evaluateLeaf` is supplied by AvailabilityService (the
 * registry of leaf evaluators); this function owns only the tree semantics.
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

  // Information hiding: a failing child whose showc is false hides everything.
  // For negated ops a child "contributes to failure" when it is available
  // (it is the child's success that makes NOT-AND/NOT-OR fail).
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
        // Nested tree child: its own hidden flag also propagates.
        const cr = childResults[i] as TreeEvaluation;
        if (!isTreeNode(child) === false && cr && 'informationHidden' in cr && cr.informationHidden && causesFailure) {
          informationHidden = true;
        }
      }
    });
    // A nested child tree that is itself information-hidden and causes failure hides the parent info too.
    node.c.forEach((child, i) => {
      if (isTreeNode(child)) {
        const cr = childResults[i] as TreeEvaluation;
        const negated = node.op === '!&' || node.op === '!|';
        const causesFailure = negated ? values[i]! : !values[i]!;
        if (cr.informationHidden && causesFailure && node.showc?.[i] !== true) {
          // Only when the parent does not explicitly show this child.
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

/** Synchronous convenience used by golden tests with in-memory leaf values. */
/**
 * Dựng map đánh giá lá từ kết quả từng điều kiện (đủ/không đủ) và mô tả hiển thị tương ứng — đầu vào cho bước gộp cây.
 */
export function leafFromMap(values: Record<string, boolean>, descriptions: Record<string, string> = {}) {
  return async (leaf: AvailabilityLeaf): Promise<LeafResult> => {
    const key = String(leaf.id ?? leaf.type);
    return { available: values[key] ?? false, description: descriptions[key] ?? key };
  };
}
