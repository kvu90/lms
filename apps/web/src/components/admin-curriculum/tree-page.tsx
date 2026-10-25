import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { PageHeader, PageShell } from '../page-shell';
import { apiJson, ApiError } from '#lib/api';
import { fetchTree, type CurriculumTree, type CurriculumTreeNode } from '#lib/curriculum';
import { flattenProgramRows, ProgramGroupTable, type ProgramRow } from './program-group-table';
import { errorText } from './shared';

export function AdminCurriculumTreePage() {
  const { t } = useTranslation('app');
  const { curriculumId } = useParams();
  const [tree, setTree] = useState<CurriculumTree | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!curriculumId) return;
    try {
      const data = await fetchTree(curriculumId);
      setTree(data);
      setForbidden(false);
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 403) setForbidden(true);
    }
  }, [curriculumId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function deleteNode(node: CurriculumTreeNode) {
    if (!window.confirm(t('curriculumConfirmDeleteNode', { title: node.title }))) return;
    try {
      await apiJson(`/api/v1/curriculum/nodes/${node.id}`, { method: 'DELETE' });
      setMessage(t('curriculumNodeDeleted'));
      await reload();
    } catch (err) {
      setMessage(errorText(err, t('curriculumDeleteFailed')));
    }
  }

  async function deleteOutcome(_node: CurriculumTreeNode, outcomeId: string) {
    if (!window.confirm(t('curriculumConfirmDeleteOutcome'))) return;
    try {
      await apiJson(`/api/v1/curriculum/outcomes/${outcomeId}`, { method: 'DELETE' });
      setMessage(t('curriculumOutcomeDeleted'));
      await reload();
    } catch (err) {
      setMessage(errorText(err, t('curriculumDeleteFailed')));
    }
  }

  if (forbidden) {
    return (
      <PageShell>
        <Alert variant="destructive">
          <AlertDescription>{t('curriculumForbidden')}</AlertDescription>
        </Alert>
      </PageShell>
    );
  }
  if (!tree) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">{t('curriculumLoading')}</p>
      </PageShell>
    );
  }
  return (
    <PageShell>
      <PageHeader
        title={t('curriculumTreeTitle', { subject: tree.subject.name, grade: tree.curriculum.grade })}
        description={t('curriculumTreeDescription')}
      />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="button" render={<Link to={`/admin/curriculum/curricula/${tree.curriculum.id}/nodes/new`} />}>
          {t('curriculumAddRootNode')}
        </Button>{' '}
        <Link to="/admin/curriculum" className="text-sm underline">
          {t('curriculumBackToList')}
        </Link>
      </div>
      <div className="flex flex-col gap-4">
        {tree.nodes.map((root) => {
          // Node gốc là mạch nội dung → một bảng mang tên mạch; node gốc
          // khác (dataset không mang mạch) → bảng không tiêu đề nhóm.
          const rows: ProgramRow[] = [];
          if (root.kind === 'strand') {
            if (root.outcomes.length > 0) rows.push({ node: root, path: [] });
            for (const child of root.children) flattenProgramRows(child, [], rows);
            return (
              <ProgramGroupTable
                key={root.id}
                title={root.title}
                groupNode={root}
                rows={rows}
                curriculumId={tree.curriculum.id}
                onDeleteNode={(n) => void deleteNode(n)}
                onDeleteOutcome={(n, id) => void deleteOutcome(n, id)}
              />
            );
          }
          flattenProgramRows(root, [], rows);
          return (
            <ProgramGroupTable
              key={root.id}
              title={null}
              groupNode={null}
              rows={rows}
              curriculumId={tree.curriculum.id}
              onDeleteNode={(n) => void deleteNode(n)}
              onDeleteOutcome={(n, id) => void deleteOutcome(n, id)}
            />
          );
        })}
      </div>
    </PageShell>
  );
}
