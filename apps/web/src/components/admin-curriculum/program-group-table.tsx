import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import type { CurriculumTreeNode } from '#lib/curriculum';

/**
 * Trình bày cây chương trình theo MẪU CỦA BỘ (GDPT-SEED, issue #161):
 * mỗi mạch nội dung (node strand ở gốc cây) là một bảng hai cột
 * "Nội dung | Yêu cầu cần đạt". Các bậc ở giữa (section/topic) không
 * thành dòng riêng nếu không mang YCCĐ — tựa của chúng flatten vào
 * đường đi ở cột Nội dung; node mang YCCĐ ở bất kỳ bậc nào cũng thành
 * dòng. Hành vi quản trị giữ nguyên §9: thêm node con / thêm YCCĐ /
 * Sửa mở màn riêng, Xoá tại dòng.
 */
export interface ProgramRow {
  node: CurriculumTreeNode;
  path: string[];
}

/** Flatten một subtree thành các dòng bảng (cha trước con, giữ thứ tự cây). */
export function flattenProgramRows(node: CurriculumTreeNode, path: string[], out: ProgramRow[]): void {
  if (node.kind === 'lesson' || node.outcomes.length > 0) out.push({ node, path });
  for (const child of node.children) flattenProgramRows(child, [...path, node.title], out);
}

/** Các nút thao tác tại dòng của một node (dùng cho cả tiêu đề mạch lẫn dòng nội dung). */
export function NodeRowActions({
  node, curriculumId, onDeleteNode,
}: {
  node: CurriculumTreeNode;
  curriculumId: string;
  onDeleteNode: (node: CurriculumTreeNode) => void;
}) {
  const { t } = useTranslation('app');
  return (
    <span className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/curricula/${curriculumId}/nodes/new?parentId=${node.id}`} />}>
        {t('curriculumAddChildNode')}
      </Button>
      <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/nodes/${node.id}/outcomes/new`} />}>
        {t('curriculumAddOutcome')}
      </Button>
      <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/nodes/${node.id}/edit`} />}>
        {t('curriculumEdit')}
      </Button>
      <Button type="button" variant="destructive" size="sm" onClick={() => onDeleteNode(node)}>
        {t('curriculumDelete')}
      </Button>
    </span>
  );
}

/** Một bảng chương trình: tiêu đề mạch (nếu có) + các dòng Nội dung | Yêu cầu cần đạt. */
export function ProgramGroupTable({
  title, groupNode, rows, curriculumId, onDeleteNode, onDeleteOutcome,
}: {
  title: string | null;
  groupNode: CurriculumTreeNode | null;
  rows: ProgramRow[];
  curriculumId: string;
  onDeleteNode: (node: CurriculumTreeNode) => void;
  onDeleteOutcome: (node: CurriculumTreeNode, outcomeId: string) => void;
}) {
  const { t } = useTranslation('app');
  return (
    <section className="overflow-hidden rounded border">
      {title !== null && groupNode ? (
        <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 p-3">
          <Badge variant="default">{t(`curriculumKind_${groupNode.kind}`)}</Badge>
          <h3 className="font-semibold">{title}</h3>
          <span className="ml-auto">
            <NodeRowActions node={groupNode} curriculumId={curriculumId} onDeleteNode={onDeleteNode} />
          </span>
        </header>
      ) : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="w-1/2 p-2 font-medium">{t('curriculumContentColumn')}</th>
            <th className="p-2 font-medium">{t('curriculumOutcomesLabel')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, path }) => (
            <tr key={node.id} className="border-b align-top last:border-0">
              <td className="p-2">
                {path.length > 0 ? (
                  <span className="block text-xs text-muted-foreground">{path.join(' › ')}</span>
                ) : null}
                <span className="font-medium">{node.title}</span>
                <span className="mt-1 block">
                  <NodeRowActions node={node} curriculumId={curriculumId} onDeleteNode={onDeleteNode} />
                </span>
              </td>
              <td className="p-2">
                {node.outcomes.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {node.outcomes.map((outcome) => (
                      <li key={outcome.id} className="flex flex-wrap items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <span>{outcome.content}</span>
                          {outcome.sourceRef ? (
                            <span className="block text-xs text-muted-foreground">
                              {t('curriculumOutcomeSource', { source: outcome.sourceRef })}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex gap-2">
                          <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/outcomes/${outcome.id}/edit`} />}>
                            {t('curriculumEdit')}
                          </Button>
                          <Button type="button" variant="destructive" size="sm" onClick={() => onDeleteOutcome(node, outcome.id)}>
                            {t('curriculumDelete')}
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
