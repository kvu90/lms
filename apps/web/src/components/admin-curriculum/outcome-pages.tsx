import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageShell } from '../page-shell';
import { useCurriculumNode, useCurriculumOutcome } from '#lib/curriculum';
import { FormScreen } from './form-screen';
import { OutcomeForm } from './outcome-form';

export function AdminOutcomeNewPage() {
  const { t } = useTranslation('app');
  const { nodeId } = useParams();
  // Node cha chỉ để suy đường quay lại cây của đúng chương trình
  // chứa node — đọc qua TanStack Query (F-01 của rà soát #133).
  const nodeQuery = useCurriculumNode(nodeId);
  const node = nodeQuery.data;
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
  // Đọc YCCĐ rồi mới đọc node chứa nó (để suy đường quay lại) — hai
  // truy vấn TanStack Query, truy vấn node bật khi đã có YCCĐ.
  const outcomeQuery = useCurriculumOutcome(outcomeId);
  const outcome = outcomeQuery.data;
  const nodeQuery = useCurriculumNode(outcome?.nodeId);
  const node = nodeQuery.data;
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
