import type { CurriculumTreeNode } from '#lib/curriculum';
import type { FlatNode } from '../types/content-bank';

/**
 * Hàm thuần của Kho học liệu thuộc feature content-bank. Tách
 * từ các module phẳng `src/lib/content-bank.ts` và
 * `src/lib/content-bank-data.ts` khi tổ chức lại apps/web theo
 * mô hình features/ (issue #500).
 */

/** Phẳng hoá cây chương trình theo chiều sâu, gom YCCĐ của từng cây con vào chính node tổ tiên của nó. */
export function flattenNodes(nodes: CurriculumTreeNode[], depth = 0, out: FlatNode[] = []): FlatNode[] {
  for (const node of nodes) {
    const subtreeOutcomes: { id: string; content: string }[] = [];
    const collect = (n: CurriculumTreeNode) => {
      for (const o of n.outcomes) subtreeOutcomes.push({ id: o.id, content: o.content });
      n.children.forEach(collect);
    };
    collect(node);
    out.push({ id: node.id, title: node.title, kind: node.kind, depth, outcomeIds: subtreeOutcomes.map((o) => o.id), outcomes: subtreeOutcomes });
    flattenNodes(node.children, depth + 1, out);
  }
  return out;
}

/** Đọc File của input[type=file] thành base64 thuần (bỏ tiền tố data:...;base64,). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
