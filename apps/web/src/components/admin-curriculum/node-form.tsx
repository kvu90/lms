import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { apiJson } from '#lib/api';
import { fetchTree, type CurriculumTreeNode } from '#lib/curriculum';
import { errorText } from './shared';

export interface NodeRow {
  id: string;
  curriculumId: string;
  parentId: string | null;
  title: string;
  kind: string;
  position: number;
  durationPeriods: number | null;
  durationPercent: number | null;
}

function flattenNodes(nodes: CurriculumTreeNode[], depth = 0, out: { id: string; title: string; depth: number }[] = []) {
  for (const node of nodes) {
    out.push({ id: node.id, title: node.title, depth });
    flattenNodes(node.children, depth + 1, out);
  }
  return out;
}

export function NodeForm({ curriculumId, initial, parentId }: { curriculumId: string; initial?: NodeRow; parentId?: string | null }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [kind, setKind] = useState(initial?.kind ?? 'topic');
  const [parent, setParent] = useState<string>(initial ? (initial.parentId ?? '') : (parentId ?? ''));
  const [position, setPosition] = useState(String(initial?.position ?? 1));
  const [durationPeriods, setDurationPeriods] = useState(initial?.durationPeriods != null ? String(initial.durationPeriods) : '');
  const [durationPercent, setDurationPercent] = useState(initial?.durationPercent != null ? String(initial.durationPercent) : '');
  const [parentOptions, setParentOptions] = useState<{ id: string; title: string; depth: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchTree(curriculumId)
      .then((tree) => setParentOptions(flattenNodes(tree.nodes).filter((n) => n.id !== initial?.id)))
      .catch(() => setParentOptions([]));
  }, [curriculumId, initial?.id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const payload = {
      title,
      kind,
      parentId: parent === '' ? null : parent,
      position: Number(position),
      durationPeriods: durationPeriods === '' ? null : Number(durationPeriods),
      durationPercent: durationPercent === '' ? null : Number(durationPercent),
    };
    try {
      if (initial) {
        await apiJson(`/api/v1/curriculum/nodes/${initial.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await apiJson('/api/v1/curriculum/nodes', {
          method: 'POST',
          body: JSON.stringify({ curriculumId, ...payload }),
        });
      }
      navigate(`/admin/curriculum/curricula/${curriculumId}`);
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="node-title">{t('curriculumNodeTitle')}</Label>
        <Input id="node-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="space-y-2">
        <span id="node-kind-label" className="text-sm font-medium">
          {t('curriculumNodeKind')}
        </span>
        <Select
          items={{
            strand: t('curriculumKind_strand'),
            topic: t('curriculumKind_topic'),
            lesson: t('curriculumKind_lesson'),
          }}
          value={kind}
          onValueChange={(v) => v && setKind(v)}
        >
          <SelectTrigger aria-labelledby="node-kind-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="strand">{t('curriculumKind_strand')}</SelectItem>
            <SelectItem value="topic">{t('curriculumKind_topic')}</SelectItem>
            <SelectItem value="lesson">{t('curriculumKind_lesson')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <span id="node-parent-label" className="text-sm font-medium">
          {t('curriculumNodeParent')}
        </span>
        <Select
          items={Object.fromEntries([
            ['root', t('curriculumNodeParentRoot')],
            ...parentOptions.map(
              (option) => [option.id, `${'— '.repeat(option.depth)}${option.title}`] as [string, string],
            ),
          ])}
          value={parent === '' ? 'root' : parent}
          onValueChange={(v) => setParent(!v || v === 'root' ? '' : v)}
        >
          <SelectTrigger aria-labelledby="node-parent-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="root">{t('curriculumNodeParentRoot')}</SelectItem>
            {parentOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {'— '.repeat(option.depth)}
                {option.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="node-position">{t('curriculumPosition')}</Label>
        <Input id="node-position" type="number" min={1} value={position} onChange={(e) => setPosition(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="node-periods">{t('curriculumDurationPeriods')}</Label>
        <Input id="node-periods" type="number" min={0} value={durationPeriods} onChange={(e) => setDurationPeriods(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="node-percent">{t('curriculumDurationPercent')}</Label>
        <Input id="node-percent" type="number" min={0} max={100} value={durationPercent} onChange={(e) => setDurationPercent(e.target.value)} />
      </div>
      <Button type="submit">{t('curriculumSave')}</Button>
    </form>
  );
}
