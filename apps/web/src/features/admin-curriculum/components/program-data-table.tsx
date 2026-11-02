import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { DataTable, type DataColumn } from '#components/data-table';
import type {
  CurriculumOutcome, CurriculumTree, CurriculumTreeNode,
} from '#lib/curriculum';
import { flattenProgramRows, NodeRowActions, OutcomeContent, type ProgramRow } from './program-group-table';

/**
 * Bảng chương trình GDPT của trang cây quản trị, dựng trên Data Table
 * dùng chung của app (`#components/data-table`, TanStack Table +
 * shadcn Table) thay cho bảng `<table>` tự chế trước đây.
 *
 * Hình dạng dòng: cây được làm phẳng thành các DÒNG YCCĐ — mỗi YCCĐ
 * của cây là đúng một dòng bảng, theo cấu trúc bảng chương trình
 * chính thức: cột "Mạch / chủ đề" (mạch gốc chứa node), cột "Nội
 * dung" (đường đi tổ tiên + tên node) và cột "Yêu cầu cần đạt" (một
 * YCCĐ). Node không có YCCĐ vẫn có một dòng với ô YCCĐ trống để nút
 * thao tác của node còn chỗ đứng. Quy tắc nhóm theo mạch giữ đúng
 * `buildProgramGroups` của bề mặt giáo viên (mạch gốc là một nhóm
 * mang tên mạch; gốc không phải mạch thì nhóm không tên) — hai bề
 * mặt trình bày cùng một cây theo cùng thứ tự, chỉ khác cơ chế bảng.
 *
 * Thao tác tại dòng giữ nguyên hành vi quản trị: nút của một node
 * (thêm node con, thêm YCCĐ, sửa, xoá) nằm ở dòng đầu của node đó
 * trong cột Nội dung; nút của mạch nằm ở dòng đầu của nhóm trong cột
 * Mạch / chủ đề (đúng vị trí tiêu đề nhóm của cách trình bày cũ);
 * nút sửa/xoá của một YCCĐ nằm ngay tại dòng của YCCĐ đó. Riêng mạch
 * chưa có dòng nội dung nào vẫn được một dòng giữ chỗ để nút thao
 * tác của mạch không biến mất khỏi trang.
 *
 * Sắp xếp, lọc toàn cục (ô tìm kiếm quét qua mạch, Nội dung và văn
 * bản YCCĐ qua `filterValue` của từng cột) và phân trang đều do Data
 * Table đảm nhiệm phía client trên cây đã tải một lần — trang gọi
 * không tự chế lại cơ chế nào trong số này.
 */

/** Một dòng của bảng chương trình: một YCCĐ (hoặc dòng giữ chỗ của node chưa có YCCĐ). */
export type ProgramOutcomeRow = {
  id: string;
  /** Tên mạch gốc chứa node; null khi gốc cây không phải mạch nội dung. */
  strandTitle: string | null;
  /** Node mạch gốc của nhóm (để bày nút thao tác của mạch); null khi nhóm không có mạch. */
  strandNode: CurriculumTreeNode | null;
  /** Dòng đầu tiên của nhóm mạch — điểm neo nút thao tác của mạch. */
  isGroupStart: boolean;
  node: CurriculumTreeNode;
  /** Đường đi tổ tiên của node bên dưới mạch (rỗng khi node nằm ngay dưới mạch). */
  path: string[];
  /** YCCĐ của dòng; null ở dòng giữ chỗ của node chưa có YCCĐ. */
  outcome: CurriculumOutcome | null;
  /** Dòng đầu tiên của node — điểm neo nút thao tác của node. */
  isNodeStart: boolean;
};

/**
 * Làm phẳng cây chương trình thành các dòng YCCĐ theo thứ tự cây:
 * nhóm theo mạch gốc như `buildProgramGroups`, trong mỗi nhóm các
 * dòng nội dung theo `flattenProgramRows`, mỗi dòng nội dung nở
 * thành một dòng cho từng YCCĐ của node đó.
 */
export function buildProgramOutcomeRows(tree: CurriculumTree): ProgramOutcomeRow[] {
  const rows: ProgramOutcomeRow[] = [];
  for (const root of tree.nodes) {
    const strandTitle = root.kind === 'strand' ? root.title : null;
    const strandNode = root.kind === 'strand' ? root : null;
    const programRows: ProgramRow[] = [];
    if (root.kind === 'strand') {
      if (root.outcomes.length > 0) programRows.push({ node: root, path: [] });
      for (const child of root.children) flattenProgramRows(child, [], programRows);
    } else {
      flattenProgramRows(root, [], programRows);
    }
    let groupStartPending = true;
    const pushRow = (programRow: ProgramRow, outcome: CurriculumOutcome | null, isNodeStart: boolean) => {
      rows.push({
        id: `${programRow.node.id}::${outcome?.id ?? 'none'}`,
        strandTitle,
        strandNode,
        isGroupStart: groupStartPending,
        node: programRow.node,
        path: programRow.path,
        outcome,
        isNodeStart,
      });
      groupStartPending = false;
    };
    if (programRows.length === 0 && strandNode) {
      // Mạch chưa có dòng nội dung nào: một dòng giữ chỗ cho chính
      // node mạch để nút thao tác của mạch còn hiện trên trang.
      pushRow({ node: strandNode, path: [] }, null, true);
    }
    for (const programRow of programRows) {
      if (programRow.node.outcomes.length === 0) {
        pushRow(programRow, null, true);
      } else {
        programRow.node.outcomes.forEach((outcome, index) => {
          pushRow(programRow, outcome, index === 0);
        });
      }
    }
  }
  return rows;
}

/**
 * Bảng chương trình của một cây (một môn, một khối): ba cột theo cấu
 * trúc bảng chính thức, cơ chế bảng của Data Table dùng chung.
 *
 * @param props.rows - Các dòng YCCĐ đã làm phẳng từ cây (xem `buildProgramOutcomeRows`).
 * @param props.curriculumId - Id chương trình chứa cây, để dựng liên kết thao tác tại dòng.
 * @param props.onDeleteNode - Xoá một node (trang gọi lo xác nhận + đột biến).
 * @param props.onDeleteOutcome - Xoá một YCCĐ của một node (trang gọi lo xác nhận + đột biến).
 */
export function ProgramDataTable({
  rows,
  curriculumId,
  onDeleteNode,
  onDeleteOutcome,
}: {
  rows: ProgramOutcomeRow[];
  curriculumId: string;
  onDeleteNode: (node: CurriculumTreeNode) => void;
  onDeleteOutcome: (node: CurriculumTreeNode, outcomeId: string) => void;
}) {
  const { t } = useTranslation('app');

  const columns: DataColumn<ProgramOutcomeRow>[] = [
    {
      id: 'strand',
      header: t('curriculumStrandTopicColumn'),
      sortValue: (row) => row.strandTitle ?? '',
      filterValue: (row) => row.strandTitle ?? '',
      cell: (row) => (
        <span className="block">
          {row.strandTitle ? (
            <span className="flex flex-wrap items-center gap-2">
              {row.strandNode ? (
                <Badge variant="default">{t(`curriculumKind_${row.strandNode.kind}`)}</Badge>
              ) : null}
              <span className="font-medium">{row.strandTitle}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          {row.isGroupStart && row.strandNode ? (
            <span className="mt-1 block">
              <NodeRowActions node={row.strandNode} curriculumId={curriculumId} onDeleteNode={onDeleteNode} />
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'content',
      header: t('curriculumContentColumn'),
      sortValue: (row) => row.node.title,
      filterValue: (row) => [...row.path, row.node.title].join(' '),
      cell: (row) => (
        <span className="block">
          {row.path.length > 0 ? (
            <span className="block text-xs text-muted-foreground">{row.path.join(' › ')}</span>
          ) : null}
          <span className="font-medium">{row.node.title}</span>
          {row.isNodeStart && row.node.id !== row.strandNode?.id ? (
            <span className="mt-1 block">
              <NodeRowActions node={row.node} curriculumId={curriculumId} onDeleteNode={onDeleteNode} />
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'outcome',
      header: t('curriculumOutcomesLabel'),
      sortValue: (row) => row.outcome?.content ?? '',
      filterValue: (row) => row.outcome?.content ?? '',
      cell: (row) =>
        row.outcome ? (
          <span className="flex flex-wrap items-start gap-2">
            <span aria-hidden="true" className="text-muted-foreground">–</span>
            <span className="min-w-0 flex-1">
              <OutcomeContent content={row.outcome.content} contentDoc={row.outcome.contentDoc} />
              {row.outcome.sourceRef ? (
                <span className="block text-xs text-muted-foreground">
                  {t('curriculumOutcomeSource', { source: row.outcome.sourceRef })}
                </span>
              ) : null}
            </span>
            <span className="flex gap-2">
              <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/outcomes/${row.outcome.id}/edit`} />}>
                {t('curriculumEdit')}
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={() => onDeleteOutcome(row.node, row.outcome!.id)}>
                {t('curriculumDelete')}
              </Button>
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      labels={{
        columns: t('dashboard:tableColumns'),
        previous: t('dashboard:tablePrevious'),
        next: t('dashboard:tableNext'),
        empty: t('curriculumTableEmpty'),
        pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
        filterPlaceholder: t('curriculumSearchPlaceholder'),
      }}
      getRowId={(row) => row.id}
    />
  );
}
