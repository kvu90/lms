import { describe, expect, it } from 'vitest';
import { buildProgramOutcomeRows } from './program-data-table';
import type { CurriculumTree, CurriculumTreeNode } from '#lib/curriculum';

/**
 * Spec hàm làm phẳng cây chương trình thành các dòng YCCĐ cho bảng
 * Data Table của trang cây quản trị: mỗi YCCĐ là đúng một dòng, thứ
 * tự cây được giữ nguyên, dòng biết mạch chứa nó và đường đi tổ
 * tiên, node chưa có YCCĐ vẫn có một dòng giữ chỗ, và mạch rỗng vẫn
 * có dòng giữ chỗ cho node mạch để thao tác quản trị không mất.
 */

function node(partial: Partial<CurriculumTreeNode> & { id: string; title: string }): CurriculumTreeNode {
  return {
    curriculumId: 'curr-1',
    parentId: null,
    kind: 'lesson',
    position: 1,
    durationPeriods: null,
    durationPercent: null,
    outcomes: [],
    children: [],
    ...partial,
  };
}

function outcome(id: string, content: string, position: number) {
  return { id, content, position, sourceKind: 'program', sourceRef: null, derivedFromId: null };
}

const TREE: CurriculumTree = {
  curriculum: { id: 'curr-1', subjectId: 'subj-1', grade: 5 },
  subject: { id: 'subj-1', contextId: 'ctx-sys', name: 'Toán', slug: 'toan', position: 1 },
  nodes: [
    node({
      id: 'strand-1',
      title: 'Số và phép tính',
      kind: 'strand',
      children: [
        node({
          id: 'section-1',
          title: 'Số tự nhiên',
          kind: 'section',
          parentId: 'strand-1',
          children: [
            node({
              id: 'lesson-1',
              title: 'Đọc số',
              parentId: 'section-1',
              outcomes: [outcome('o-1', 'Đọc được số.', 1), outcome('o-2', 'Viết được số.', 2)],
            }),
            node({ id: 'lesson-2', title: 'So sánh số', parentId: 'section-1' }),
          ],
        }),
      ],
    }),
    node({ id: 'strand-2', title: 'Hình học', kind: 'strand', position: 2 }),
    node({
      id: 'loose-1',
      title: 'Nội dung ngoài mạch',
      kind: 'lesson',
      position: 3,
      outcomes: [outcome('o-3', 'Yêu cầu ngoài mạch.', 1)],
    }),
  ],
};

describe('buildProgramOutcomeRows — làm phẳng cây thành dòng YCCĐ', () => {
  it('mỗi YCCĐ thành một dòng riêng theo đúng thứ tự cây, node có 2 YCCĐ tạo đúng 2 dòng liên tiếp', () => {
    const rows = buildProgramOutcomeRows(TREE);
    const lessonRows = rows.filter((r) => r.node.id === 'lesson-1');
    expect(lessonRows.map((r) => r.outcome?.id)).toEqual(['o-1', 'o-2']);
    // Chỉ dòng đầu của node mang cờ mở đầu node (điểm neo nút thao tác).
    expect(lessonRows.map((r) => r.isNodeStart)).toEqual([true, false]);
    // Thứ tự toàn cục: hai dòng của lesson-1 đứng trước dòng của lesson-2.
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf('lesson-1::o-2')).toBeLessThan(ids.indexOf('lesson-2::none'));
  });

  it('node chưa có YCCĐ vẫn có một dòng giữ chỗ với YCCĐ rỗng', () => {
    const rows = buildProgramOutcomeRows(TREE);
    const placeholder = rows.filter((r) => r.node.id === 'lesson-2');
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0]!.outcome).toBeNull();
    expect(placeholder[0]!.isNodeStart).toBe(true);
  });

  it('dòng mang tên mạch chứa nó và đường đi tổ tiên bên dưới mạch', () => {
    const rows = buildProgramOutcomeRows(TREE);
    const lessonRow = rows.find((r) => r.node.id === 'lesson-1');
    expect(lessonRow!.strandTitle).toBe('Số và phép tính');
    expect(lessonRow!.strandNode?.id).toBe('strand-1');
    expect(lessonRow!.path).toEqual(['Số tự nhiên']);
    // Dòng đầu tiên của nhóm mạch mang cờ mở đầu nhóm; các dòng sau không.
    expect(rows[0]!.isGroupStart).toBe(true);
    expect(rows[1]!.isGroupStart).toBe(false);
  });

  it('mạch chưa có dòng nội dung nào vẫn có một dòng giữ chỗ cho chính node mạch', () => {
    const rows = buildProgramOutcomeRows(TREE);
    const strandRows = rows.filter((r) => r.node.id === 'strand-2');
    expect(strandRows).toHaveLength(1);
    expect(strandRows[0]!.outcome).toBeNull();
    expect(strandRows[0]!.isGroupStart).toBe(true);
    expect(strandRows[0]!.strandNode?.id).toBe('strand-2');
  });

  it('node gốc không thuộc mạch nào thì dòng của nó không có mạch chứa', () => {
    const rows = buildProgramOutcomeRows(TREE);
    const loose = rows.filter((r) => r.node.id === 'loose-1');
    expect(loose).toHaveLength(1);
    expect(loose[0]!.strandTitle).toBeNull();
    expect(loose[0]!.strandNode).toBeNull();
    expect(loose[0]!.outcome?.id).toBe('o-3');
  });
});
