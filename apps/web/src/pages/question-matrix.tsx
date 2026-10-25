import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiJson } from '#lib/api';
import { usePermissions } from '#lib/permissions';
import {
  COGNITIVE_LEVELS, LEVEL_LABEL_KEYS, QTYPES, QTYPE_LABEL_KEYS, withApiReason,
  type CurriculumTreeNode,
} from './questions';

/**
 * Màn tạo/sửa MA TRẬN trong ngân hàng ma trận (MB-1, issue #111) —
 * chuẩn §9: tạo mới và sửa là MÀN RIÊNG, danh sách (collapse "Ma trận
 * của tôi" ở trang ngân hàng) chỉ có nút Thêm mới và Sửa/Xoá tại dòng.
 * Ma trận tạo từ đây luôn thuộc bank ma trận CÁ NHÂN của giáo viên
 * (bank_id gửi kèm; API gác quyền phụ trách tại chính bank đó).
 */

interface SubjectLite {
  id: string;
  name: string;
}
interface CurriculumLite {
  id: string;
  subjectId: string;
  grade: number;
}
interface BankLite {
  id: string;
  scope: string;
}
interface CellLite {
  id: string;
  learningOutcomeId: string;
  cognitiveLevel: string;
  qtype: string;
  questionCount: number;
  cellScore: number;
}
interface MatrixLite {
  id: string;
  name: string;
  subjectId: string;
  curriculumId: string;
  bankId: string | null;
  status: string;
  isTemplate: boolean;
  version: number;
  presetKind: string;
  levelSet: string;
  totalScore: number;
  cells: CellLite[];
}
interface AvailabilityLite {
  sufficient: boolean;
  cells: { cellId: string; required: number; available: number; deficit: number }[];
}

const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs';

function flattenOutcomes(nodes: CurriculumTreeNode[]): { id: string; content: string }[] {
  const out: { id: string; content: string }[] = [];
  const walk = (list: CurriculumTreeNode[]) => {
    for (const node of list) {
      for (const o of node.outcomes ?? []) out.push({ id: o.id, content: o.content });
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

/** Màn tạo ma trận mới trong bank ma trận cá nhân (route /matrices/new). */
export function MatrixNewPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const perms = usePermissions();
  const [personalBankId, setPersonalBankId] = useState<string | null>(null);
  const [bankLoaded, setBankLoaded] = useState(false);
  const [subjects, setSubjects] = useState<SubjectLite[]>([]);
  const [curricula, setCurricula] = useState<CurriculumLite[]>([]);
  const [name, setName] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [curriculumId, setCurriculumId] = useState('');
  const [presetKind, setPresetKind] = useState('custom');
  const [levelSet, setLevelSet] = useState('three');
  const [totalScore, setTotalScore] = useState('10');
  const [isTemplate, setIsTemplate] = useState(false);
  const [status, setStatus] = useState('draft');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!perms.ready || !perms.canUseQuestionBank) return;
    void (async () => {
      try {
        const banks = await apiJson<BankLite[]>('/api/v1/question-banks?kind=matrix');
        setPersonalBankId(banks.find((b) => b.scope === 'personal')?.id ?? null);
      } catch {
        setPersonalBankId(null);
      } finally {
        setBankLoaded(true);
      }
      try {
        setSubjects(await apiJson<SubjectLite[]>('/api/v1/curriculum/subjects'));
      } catch {
        setSubjects([]);
      }
    })();
  }, [perms.ready, perms.canUseQuestionBank]);

  useEffect(() => {
    if (!subjectId) {
      setCurricula([]);
      setCurriculumId('');
      return;
    }
    void (async () => {
      try {
        const rows = await apiJson<CurriculumLite[]>(`/api/v1/curriculum/curricula?subjectId=${subjectId}`);
        setCurricula(rows);
        setCurriculumId((prev) => (rows.some((c) => c.id === prev) ? prev : (rows[0]?.id ?? '')));
      } catch {
        setCurricula([]);
      }
    })();
  }, [subjectId]);

  async function createMatrix(event: FormEvent) {
    event.preventDefault();
    if (!personalBankId) return;
    try {
      await apiJson('/api/v1/exam-matrices', {
        method: 'POST',
        body: JSON.stringify({
          name, subjectId, curriculumId, bankId: personalBankId, presetKind, levelSet,
          totalScore: Number(totalScore) || 10, isTemplate, status,
        }),
      });
      navigate('/matrices', { state: { notice: t('matrixCreated') } });
    } catch (err) {
      setMessage(withApiReason(t('matrixCreateFailed'), err));
    }
  }

  if (!perms.ready || !bankLoaded) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('matrixCreate')} />
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </PageShell>
    );
  }
  if (!perms.canUseQuestionBank || !personalBankId) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('matrixCreate')} />
        <Card>
          <CardHeader>
            <CardTitle>{t('myMatrixBank')}</CardTitle>
            <CardDescription>{t('matrixNoPersonalBank')}</CardDescription>
          </CardHeader>
        </Card>
        <p>
          <Link to="/matrices" className="text-sm underline">
            {t('backToQuestionBankList')}
          </Link>
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell width="medium">
      <PageHeader title={t('matrixCreate')} />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={(e) => void createMatrix(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="matrix-name">{t('matrixName')}</FieldLabel>
                <Input id="matrix-name" value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="matrix-subject">{t('matrixSubject')}</FieldLabel>
                <select id="matrix-subject" className={SELECT_CLASS} value={subjectId} onChange={(e) => setSubjectId(e.target.value)} required>
                  <option value="">—</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="matrix-curriculum">{t('matrixCurriculum')}</FieldLabel>
                <select id="matrix-curriculum" className={SELECT_CLASS} value={curriculumId} onChange={(e) => setCurriculumId(e.target.value)} required>
                  <option value="">—</option>
                  {curricula.map((c) => (
                    <option key={c.id} value={c.id}>
                      {t('matrixGradeOption', { grade: c.grade })}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="matrix-preset">{t('matrixFilterPreset')}</FieldLabel>
                <select id="matrix-preset" className={SELECT_CLASS} value={presetKind} onChange={(e) => setPresetKind(e.target.value)}>
                  <option value="cv7991_periodic">{t('matrixPresetPeriodic')}</option>
                  <option value="qd764_graduation">{t('matrixPresetGraduation')}</option>
                  <option value="custom">{t('matrixPresetCustom')}</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="matrix-level-set">{t('matrixLevelSet')}</FieldLabel>
                <select id="matrix-level-set" className={SELECT_CLASS} value={levelSet} onChange={(e) => setLevelSet(e.target.value)}>
                  <option value="three">{t('matrixLevelSetThree')}</option>
                  <option value="four">{t('matrixLevelSetFour')}</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="matrix-total-score">{t('matrixTotalScore')}</FieldLabel>
                <Input
                  id="matrix-total-score"
                  type="number"
                  min="1"
                  step="0.5"
                  value={totalScore}
                  onChange={(e) => setTotalScore(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="matrix-status">{t('matrixStatus')}</FieldLabel>
                <select id="matrix-status" className={SELECT_CLASS} value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="draft">{t('matrixStatusDraft')}</option>
                  <option value="ready">{t('matrixStatusReady')}</option>
                </select>
              </Field>
              <div className="flex items-center gap-2">
                <Checkbox id="matrix-template" checked={isTemplate} onCheckedChange={(v) => setIsTemplate(v === true)} />
                <Label htmlFor="matrix-template">{t('matrixIsTemplate')}</Label>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={!name.trim() || !subjectId || !curriculumId}>
                  {t('matrixCreate')}
                </Button>
                <Button type="button" variant="outline" onClick={() => navigate('/matrices')}>
                  {t('backToQuestionBankList')}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** Màn sửa ma trận (route /matrices/:matrixId/edit): thông tin chung + các ô + khả dụng theo ô. */
export function MatrixEditPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const perms = usePermissions();
  const { matrixId } = useParams<{ matrixId: string }>();
  const [matrix, setMatrix] = useState<MatrixLite | null>(null);
  const [outcomes, setOutcomes] = useState<{ id: string; content: string }[]>([]);
  const [availability, setAvailability] = useState<AvailabilityLite | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [status, setStatus] = useState('draft');
  const [isTemplate, setIsTemplate] = useState(false);
  const [totalScore, setTotalScore] = useState('10');
  const [cellOutcomeId, setCellOutcomeId] = useState('');
  const [cellLevel, setCellLevel] = useState('biet');
  const [cellQtype, setCellQtype] = useState('multichoice');
  const [cellCount, setCellCount] = useState('1');
  const [cellScore, setCellScore] = useState('1');

  const loadMatrix = useCallback(async () => {
    if (!matrixId) return;
    const row = await apiJson<MatrixLite>(`/api/v1/exam-matrices/${matrixId}`);
    setMatrix(row);
    setName(row.name);
    setStatus(row.status);
    setIsTemplate(row.isTemplate);
    setTotalScore(String(row.totalScore));
    try {
      const tree = await apiJson<CurriculumTreeNode[]>(`/api/v1/curriculum/curricula/${row.curriculumId}/tree`);
      setOutcomes(flattenOutcomes(tree));
    } catch {
      setOutcomes([]);
    }
    try {
      setAvailability(await apiJson<AvailabilityLite>(`/api/v1/exam-matrices/${matrixId}/availability`));
    } catch {
      setAvailability(null);
    }
  }, [matrixId]);

  useEffect(() => {
    if (!perms.ready || !perms.canUseQuestionBank) return;
    void loadMatrix().catch(() => setMessage(t('matrixLoadFailed')));
  }, [loadMatrix, perms.ready, perms.canUseQuestionBank, t]);

  async function saveMatrix(event: FormEvent) {
    event.preventDefault();
    if (!matrix) return;
    try {
      await apiJson(`/api/v1/exam-matrices/${matrix.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, status, isTemplate, totalScore: Number(totalScore) || 10 }),
      });
      setMessage(t('matrixSaved'));
      await loadMatrix();
    } catch (err) {
      setMessage(withApiReason(t('matrixSaveFailed'), err));
    }
  }

  async function addCell(event: FormEvent) {
    event.preventDefault();
    if (!matrix || !cellOutcomeId) return;
    try {
      await apiJson(`/api/v1/exam-matrices/${matrix.id}/cells`, {
        method: 'POST',
        body: JSON.stringify({
          learningOutcomeId: cellOutcomeId, cognitiveLevel: cellLevel, qtype: cellQtype,
          questionCount: Number(cellCount) || 1, cellScore: Number(cellScore) || 1,
        }),
      });
      await loadMatrix();
    } catch (err) {
      setMessage(withApiReason(t('matrixCellAddFailed'), err));
    }
  }

  async function deleteCell(cellId: string) {
    if (!matrix) return;
    try {
      await apiJson(`/api/v1/exam-matrices/${matrix.id}/cells/${cellId}`, { method: 'DELETE' });
      await loadMatrix();
    } catch (err) {
      setMessage(withApiReason(t('matrixCellDeleteFailed'), err));
    }
  }

  if (!perms.ready || !matrix) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('matrixEditTitle')} />
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </PageShell>
    );
  }

  const outcomeLabel = (id: string) => outcomes.find((o) => o.id === id)?.content ?? id.slice(0, 8);
  const availabilityOf = (cellId: string) => availability?.cells.find((c) => c.cellId === cellId);

  return (
    <PageShell width="medium">
      <PageHeader title={t('matrixEditTitle')} />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            {matrix.name} <span className="text-sm font-normal text-muted-foreground">v{matrix.version}</span>
          </CardTitle>
          <CardDescription>{t('myMatrixBank')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form onSubmit={(e) => void saveMatrix(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="edit-matrix-name">{t('matrixName')}</FieldLabel>
                <Input id="edit-matrix-name" value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-matrix-status">{t('matrixStatus')}</FieldLabel>
                <select id="edit-matrix-status" className={SELECT_CLASS} value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="draft">{t('matrixStatusDraft')}</option>
                  <option value="ready">{t('matrixStatusReady')}</option>
                  <option value="hidden">{t('matrixStatusHidden')}</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-matrix-score">{t('matrixTotalScore')}</FieldLabel>
                <Input
                  id="edit-matrix-score"
                  type="number"
                  min="1"
                  step="0.5"
                  value={totalScore}
                  onChange={(e) => setTotalScore(e.target.value)}
                />
              </Field>
              <div className="flex items-center gap-2">
                <Checkbox id="edit-matrix-template" checked={isTemplate} onCheckedChange={(v) => setIsTemplate(v === true)} />
                <Label htmlFor="edit-matrix-template">{t('matrixIsTemplate')}</Label>
              </div>
              <div className="flex gap-2">
                <Button type="submit">{t('matrixEditTitle')}</Button>
                <Button type="button" variant="outline" onClick={() => navigate('/matrices')}>
                  {t('backToQuestionBankList')}
                </Button>
              </div>
            </FieldGroup>
          </form>

          <div className="space-y-3">
            <h3 className="font-medium">{t('matrixCells')}</h3>
            {matrix.cells.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dashboard:emptyTable')}</p>
            ) : (
              <ul className="space-y-2">
                {matrix.cells.map((cell) => {
                  const av = availabilityOf(cell.id);
                  return (
                    <li key={cell.id} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-sm">
                        {outcomeLabel(cell.learningOutcomeId)} ·{' '}
                        {t(LEVEL_LABEL_KEYS[cell.cognitiveLevel as (typeof COGNITIVE_LEVELS)[number]] ?? 'levelBiet')} ·{' '}
                        {t(QTYPE_LABEL_KEYS[cell.qtype as (typeof QTYPES)[number]] ?? 'qtypeMultichoice')} ·{' '}
                        {cell.questionCount} × {cell.cellScore}
                        {av ? (
                          <span className="block text-xs text-muted-foreground">
                            {t('matrixAvailabilityRequired')}: {av.required} · {t('matrixAvailabilityAvailable')}: {av.available} ·{' '}
                            {t('matrixAvailabilityDeficit')}: {av.deficit}
                          </span>
                        ) : null}
                      </span>
                      <Button type="button" variant="outline" onClick={() => void deleteCell(cell.id)}>
                        {t('deleteRow')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {availability ? (
              <p className="text-sm">
                {t('matrixAvailability')}:{' '}
                <span className="font-medium">
                  {availability.sufficient ? t('matrixAvailabilitySufficient') : t('matrixAvailabilityInsufficient')}
                </span>
              </p>
            ) : null}
            <form onSubmit={(e) => void addCell(e)} className="flex flex-wrap items-end gap-2">
              <div>
                <Label htmlFor="cell-outcome">{t('matrixCellOutcome')}</Label>
                <select
                  id="cell-outcome"
                  className={SELECT_CLASS}
                  value={cellOutcomeId}
                  onChange={(e) => setCellOutcomeId(e.target.value)}
                  required
                >
                  <option value="">—</option>
                  {outcomes.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.content}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="cell-level">{t('matrixCellLevel')}</Label>
                <select id="cell-level" className={SELECT_CLASS} value={cellLevel} onChange={(e) => setCellLevel(e.target.value)}>
                  {COGNITIVE_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {t(LEVEL_LABEL_KEYS[level])}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="cell-qtype">{t('matrixCellQtype')}</Label>
                <select id="cell-qtype" className={SELECT_CLASS} value={cellQtype} onChange={(e) => setCellQtype(e.target.value)}>
                  {QTYPES.map((qtype) => (
                    <option key={qtype} value={qtype}>
                      {t(QTYPE_LABEL_KEYS[qtype])}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="cell-count">{t('matrixCellCount')}</Label>
                <Input id="cell-count" type="number" min="1" value={cellCount} onChange={(e) => setCellCount(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="cell-score">{t('matrixCellScore')}</Label>
                <Input id="cell-score" type="number" min="0.25" step="0.25" value={cellScore} onChange={(e) => setCellScore(e.target.value)} />
              </div>
              <Button type="submit" disabled={!cellOutcomeId}>
                {t('matrixAddCell')}
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
