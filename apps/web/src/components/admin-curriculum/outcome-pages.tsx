import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageShell } from '../page-shell';
import { apiJson } from '#lib/api';
import { FormScreen } from './form-screen';
import { type NodeRow } from './node-form';
import { OutcomeForm, type OutcomeRow } from './outcome-form';

export function AdminOutcomeNewPage() {
  const { t } = useTranslation('app');
  const { nodeId } = useParams();
  const [node, setNode] = useState<NodeRow | null>(null);
  useEffect(() => {
    if (!nodeId) return;
    void apiJson<NodeRow>(`/api/v1/curriculum/nodes/${nodeId}`).then(setNode).catch(() => setNode(null));
  }, [nodeId]);
  if (!nodeId) return null;
  const backTo = node ? `/admin/curriculum/curricula/${node.curriculumId}` : '/admin/curriculum';
  return (
    <FormScreen title={t('curriculumCreateOutcome')} backTo={backTo}>
      <OutcomeForm nodeId={nodeId} backTo={backTo} />
    </FormScreen>
  );
}

export function AdminOutcomeEditPage() {
  const { t } = useTranslation('app');
  const { outcomeId } = useParams();
  const [outcome, setOutcome] = useState<OutcomeRow | null>(null);
  const [node, setNode] = useState<NodeRow | null>(null);
  useEffect(() => {
    if (!outcomeId) return;
    void (async () => {
      try {
        const row = await apiJson<OutcomeRow>(`/api/v1/curriculum/outcomes/${outcomeId}`);
        setOutcome(row);
        setNode(await apiJson<NodeRow>(`/api/v1/curriculum/nodes/${row.nodeId}`));
      } catch {
        setOutcome(null);
      }
    })();
  }, [outcomeId]);
  if (!outcome) {
    return (
      <PageShell width="narrow">
        <p className="text-sm text-muted-foreground">{t('curriculumLoading')}</p>
      </PageShell>
    );
  }
  const backTo = node ? `/admin/curriculum/curricula/${node.curriculumId}` : '/admin/curriculum';
  return (
    <FormScreen title={t('curriculumEditOutcome')} backTo={backTo}>
      <OutcomeForm nodeId={outcome.nodeId} initial={outcome} backTo={backTo} />
    </FormScreen>
  );
}
