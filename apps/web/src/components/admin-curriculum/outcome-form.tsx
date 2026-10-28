import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { ErrorAlert } from '#components/error-alert';
import {
  useCreateCurriculumOutcome, useUpdateCurriculumOutcome,
} from '#lib/curriculum';
import { errorText } from './shared';

export interface OutcomeRow {
  id: string;
  nodeId: string;
  content: string;
  position: number;
  sourceKind: string;
  sourceRef: string | null;
  derivedFromId: string | null;
}

export function OutcomeForm({ nodeId, initial, backTo }: { nodeId: string; initial?: OutcomeRow; backTo: string }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [content, setContent] = useState(initial?.content ?? '');
  const [position, setPosition] = useState(String(initial?.position ?? 1));
  const [sourceKind, setSourceKind] = useState(initial?.sourceKind ?? 'program');
  const [sourceRef, setSourceRef] = useState(initial?.sourceRef ?? '');
  const [derivedFromId, setDerivedFromId] = useState(initial?.derivedFromId ?? '');
  const [error, setError] = useState<string | null>(null);
  // Ghi YCCĐ qua các đột biến của lib/curriculum (F-01 của rà soát
  // #133) — cây chứa YCCĐ được làm mới sau khi ghi thành công.
  const createOutcome = useCreateCurriculumOutcome();
  const updateOutcome = useUpdateCurriculumOutcome();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const payload = {
      content,
      position: Number(position),
      sourceKind,
      sourceRef: sourceRef === '' ? null : sourceRef,
      derivedFromId: derivedFromId === '' ? null : derivedFromId,
    };
    try {
      if (initial) {
        await updateOutcome.mutateAsync({ outcomeId: initial.id, payload });
      } else {
        await createOutcome.mutateAsync({ nodeId, payload });
      }
      navigate(backTo);
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      {error ? (
        <ErrorAlert variant="destructive">
          {error}
        </ErrorAlert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="outcome-content">{t('curriculumOutcomeContent')}</Label>
        <textarea
          id="outcome-content"
          className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="outcome-position">{t('curriculumPosition')}</Label>
        <Input id="outcome-position" type="number" min={1} value={position} onChange={(e) => setPosition(e.target.value)} />
      </div>
      <div className="space-y-2">
        <span id="outcome-source-kind-label" className="text-sm font-medium">
          {t('curriculumOutcomeSourceKind')}
        </span>
        <Select
          items={{ program: t('curriculumSourceKind_program'), derived: t('curriculumSourceKind_derived') }}
          value={sourceKind}
          onValueChange={(v) => v && setSourceKind(v)}
        >
          <SelectTrigger aria-labelledby="outcome-source-kind-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="program">{t('curriculumSourceKind_program')}</SelectItem>
            <SelectItem value="derived">{t('curriculumSourceKind_derived')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="outcome-source-ref">{t('curriculumOutcomeSourceRef')}</Label>
        <Input id="outcome-source-ref" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} />
      </div>
      {sourceKind === 'derived' ? (
        <div className="space-y-2">
          <Label htmlFor="outcome-derived-from">{t('curriculumOutcomeDerivedFrom')}</Label>
          <Input id="outcome-derived-from" value={derivedFromId} onChange={(e) => setDerivedFromId(e.target.value)} />
        </div>
      ) : null}
      <Button type="submit">{t('curriculumSave')}</Button>
    </form>
  );
}
