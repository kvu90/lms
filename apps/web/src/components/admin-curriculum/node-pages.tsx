import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageShell } from '../page-shell';
import { apiJson } from '#lib/api';
import { FormScreen } from './form-screen';
import { NodeForm, type NodeRow } from './node-form';

export function AdminNodeNewPage() {
  const { t } = useTranslation('app');
  const { curriculumId } = useParams();
  const [searchParams] = useSearchParams();
  if (!curriculumId) return null;
  return (
    <FormScreen title={t('curriculumCreateNode')} backTo={`/admin/curriculum/curricula/${curriculumId}`}>
      <NodeForm curriculumId={curriculumId} parentId={searchParams.get('parentId')} />
    </FormScreen>
  );
}

export function AdminNodeEditPage() {
  const { t } = useTranslation('app');
  const { nodeId } = useParams();
  const [node, setNode] = useState<NodeRow | null>(null);
  useEffect(() => {
    if (!nodeId) return;
    void apiJson<NodeRow>(`/api/v1/curriculum/nodes/${nodeId}`).then(setNode).catch(() => setNode(null));
  }, [nodeId]);
  if (!node) {
    return (
      <PageShell width="narrow">
        <p className="text-sm text-muted-foreground">{t('curriculumLoading')}</p>
      </PageShell>
    );
  }
  return (
    <FormScreen title={t('curriculumEditNode', { title: node.title })} backTo={`/admin/curriculum/curricula/${node.curriculumId}`}>
      <NodeForm curriculumId={node.curriculumId} initial={node} />
    </FormScreen>
  );
}
