import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { AssignmentForUserView } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Textarea } from '@lms/ui/components/textarea';
import { useTranslation } from 'react-i18next';
import { apiJson } from '#lib/api';
import { selectClass } from './shared';

/** Chuyển ISO sang giá trị của input datetime-local. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface CriterionDraft {
  name: string;
  descriptionForStudent: string;
  descriptionForGrader: string;
  mode: 'levels' | 'score';
  maxScore: string;
  outcomeText: string;
  levels: { label: string; score: string }[];
}

/** Phía quản lý bài: sửa cài đặt (PATCH), dựng/cập nhật bảng tiêu chí (PUT rubric), xoá bài. */
export function ManagePanel({ data, courseId, reload }: { data: AssignmentForUserView; courseId: string; reload: () => Promise<void> }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const { assignment, rubric } = data;
  const [name, setName] = useState(assignment.name);
  const [intro, setIntro] = useState(assignment.intro);
  const [due, setDue] = useState(toLocalInput(assignment.dueDate));
  const [maxFiles, setMaxFiles] = useState(String(assignment.maxFiles));
  const [acceptedTypes, setAcceptedTypes] = useState(assignment.acceptedFileTypes ?? '');
  const [gradeMax, setGradeMax] = useState(String(assignment.grade));
  const [resultMode, setResultMode] = useState(assignment.resultMode);
  const [rubricTitle, setRubricTitle] = useState(rubric?.title ?? '');
  const [criteria, setCriteria] = useState<CriterionDraft[]>(
    (rubric?.criteria ?? []).map((c) => ({
      name: c.name,
      descriptionForStudent: c.descriptionForStudent ?? '',
      descriptionForGrader: c.descriptionForGrader ?? '',
      mode: c.mode,
      maxScore: c.maxScore !== null ? String(c.maxScore) : '',
      outcomeText: c.outcomeText ?? '',
      levels: c.levels.map((lv) => ({ label: lv.label, score: String(lv.score) })),
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      await reload();
      setNotice(t('assignSavedNotice'));
    } catch {
      setError(t('assignActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    await act(() =>
      apiJson(`/api/v1/assignments/${assignment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          intro,
          dueDate: due ? new Date(due).toISOString() : null,
          maxFiles: Math.max(1, Math.trunc(Number(maxFiles) || 1)),
          acceptedFileTypes: acceptedTypes.trim() ? acceptedTypes.trim() : null,
          grade: Number(gradeMax) || assignment.grade,
          resultMode,
        }),
      }),
    );
  }

  async function saveRubric(event: FormEvent) {
    event.preventDefault();
    await act(() =>
      apiJson(`/api/v1/assignments/${assignment.id}/rubric`, {
        method: 'PUT',
        body: JSON.stringify({
          title: rubricTitle.trim() ? rubricTitle.trim() : null,
          criteria: criteria.map((c) => ({
            name: c.name.trim(),
            descriptionForStudent: c.descriptionForStudent || null,
            descriptionForGrader: c.descriptionForGrader || null,
            mode: c.mode,
            maxScore: c.mode === 'score' ? Number(c.maxScore) || null : null,
            outcomeText: c.outcomeText || null,
            ...(c.mode === 'levels'
              ? { levels: c.levels.map((lv) => ({ label: lv.label, score: Number(lv.score) || 0 })) }
              : {}),
          })),
        }),
      }),
    );
  }

  async function deleteAssignment() {
    if (!window.confirm(t('assignConfirmDelete', { name: assignment.name }))) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/v1/assignments/${assignment.id}`, { method: 'DELETE' });
      await navigate(`/courses/${courseId}`);
    } catch {
      setError(t('assignActionFailed'));
      setBusy(false);
    }
  }

  const setCriterion = (index: number, patch: Partial<CriterionDraft>) =>
    setCriteria((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  return (
    <Card data-testid="assign-manage-panel">
      <CardHeader>
        <CardTitle>{t('assignSettingsTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        <form onSubmit={(e) => void saveSettings(e)} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="assign-name">{t('assignNameLabel')}</Label>
            <Input id="assign-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="assign-intro">{t('assignIntroLabel')}</Label>
            <Textarea id="assign-intro" value={intro} onChange={(e) => setIntro(e.target.value)} />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="assign-due">{t('assignDueLabel')}</Label>
              <Input id="assign-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="assign-mode">{t('assignResultModeLabel')}</Label>
              <select id="assign-mode" className={selectClass} value={resultMode} onChange={(e) => setResultMode(e.target.value as typeof resultMode)}>
                <option value="score">{t('assignResultMode_score')}</option>
                <option value="level">{t('assignResultMode_level')}</option>
                <option value="score_feedback">{t('assignResultMode_score_feedback')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="assign-maxfiles">{t('assignMaxFilesLabel')}</Label>
              <Input id="assign-maxfiles" type="number" min={1} max={50} value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="assign-grademax">{t('assignGradeLabel')}</Label>
              <Input id="assign-grademax" type="number" min={1} step="0.5" value={gradeMax} onChange={(e) => setGradeMax(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="assign-types">{t('assignAcceptedTypesLabel')}</Label>
            <Input id="assign-types" value={acceptedTypes} onChange={(e) => setAcceptedTypes(e.target.value)} placeholder="jpg,png,pdf" />
          </div>
          <Button type="submit" disabled={busy}>
            {t('assignSaveSettings')}
          </Button>
        </form>

        <form onSubmit={(e) => void saveRubric(e)} className="space-y-3">
          <h3 className="font-medium">{t('assignRubricEditTitle')}</h3>
          <div className="space-y-1">
            <Label htmlFor="rubric-title">{t('assignRubricTitleLabel')}</Label>
            <Input id="rubric-title" value={rubricTitle} onChange={(e) => setRubricTitle(e.target.value)} />
          </div>
          {criteria.map((c, ci) => (
            <div key={ci} className="space-y-2 rounded border p-3" data-testid={`rubric-criterion-${ci}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label={t('assignRubricCriterionName')}
                  value={c.name}
                  onChange={(e) => setCriterion(ci, { name: e.target.value })}
                  placeholder={t('assignRubricCriterionName')}
                  className="max-w-sm"
                />
                <select
                  aria-label={t('assignRubricModeLabel')}
                  className={selectClass}
                  value={c.mode}
                  onChange={(e) => setCriterion(ci, { mode: e.target.value as CriterionDraft['mode'] })}
                >
                  <option value="levels">{t('assignRubricMode_levels')}</option>
                  <option value="score">{t('assignRubricMode_score')}</option>
                </select>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => setCriteria((prev) => prev.filter((_, i) => i !== ci))}
                >
                  {t('assignRubricRemoveCriterion')}
                </Button>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <Textarea
                  aria-label={t('assignRubricDescStudent')}
                  value={c.descriptionForStudent}
                  onChange={(e) => setCriterion(ci, { descriptionForStudent: e.target.value })}
                  placeholder={t('assignRubricDescStudent')}
                />
                <Textarea
                  aria-label={t('assignRubricDescGrader')}
                  value={c.descriptionForGrader}
                  onChange={(e) => setCriterion(ci, { descriptionForGrader: e.target.value })}
                  placeholder={t('assignRubricDescGrader')}
                />
              </div>
              <Input
                aria-label={t('assignRubricOutcomeLabel')}
                value={c.outcomeText}
                onChange={(e) => setCriterion(ci, { outcomeText: e.target.value })}
                placeholder={t('assignRubricOutcomeLabel')}
              />
              {c.mode === 'score' ? (
                <Input
                  aria-label={t('assignRubricMaxScoreLabel')}
                  type="number"
                  min={0}
                  step="0.25"
                  value={c.maxScore}
                  onChange={(e) => setCriterion(ci, { maxScore: e.target.value })}
                  placeholder={t('assignRubricMaxScoreLabel')}
                  className="max-w-40"
                />
              ) : (
                <div className="space-y-2">
                  {c.levels.map((lv, li) => (
                    <div key={li} className="flex items-center gap-2">
                      <Input
                        aria-label={t('assignRubricLevelLabel')}
                        value={lv.label}
                        onChange={(e) =>
                          setCriterion(ci, { levels: c.levels.map((x, xi) => (xi === li ? { ...x, label: e.target.value } : x)) })
                        }
                        placeholder={t('assignRubricLevelLabel')}
                        className="max-w-52"
                      />
                      <Input
                        aria-label={t('assignRubricLevelScore')}
                        type="number"
                        min={0}
                        step="0.25"
                        value={lv.score}
                        onChange={(e) =>
                          setCriterion(ci, { levels: c.levels.map((x, xi) => (xi === li ? { ...x, score: e.target.value } : x)) })
                        }
                        className="max-w-28"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setCriterion(ci, { levels: c.levels.filter((_, xi) => xi !== li) })}
                      >
                        {t('assignRemoveFile')}
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCriterion(ci, { levels: [...c.levels, { label: '', score: '0' }] })}
                  >
                    {t('assignRubricAddLevel')}
                  </Button>
                </div>
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setCriteria((prev) => [
                  ...prev,
                  { name: '', descriptionForStudent: '', descriptionForGrader: '', mode: 'levels', maxScore: '', outcomeText: '', levels: [{ label: '', score: '0' }] },
                ])
              }
            >
              {t('assignRubricAddCriterion')}
            </Button>
            <Button type="submit" disabled={busy || criteria.length === 0}>
              {t('assignRubricSave')}
            </Button>
          </div>
        </form>

        <div>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void deleteAssignment()}>
            {t('assignDeleteButton')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
