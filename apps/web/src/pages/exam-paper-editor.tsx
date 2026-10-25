import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiFetch, apiJson } from '#lib/api';
import { withApiReason } from './questions';

/** Một slot của đề như API exam-papers trả về (đã ghim version câu). */
interface PaperSlotView {
  position: number;
  section: string;
  questionId: string;
  questionName: string | null;
  qtype: string | null;
  pinnedVersionNumber: number | null;
  maxMark: number;
  clusterId: string | null;
  /** Ô ma trận nguồn (EB-2) — có ở snapshot chụp từ recipe; neo swap-cùng-ô. */
  matrixCellId: string | null;
}

/** Công thức rút câu đã ghim của đề recipe (EB-2). */
interface RecipeSpecView {
  drawMode: string;
  sourceBankScope: string | null;
  cells: { qtype: string; questionCount: number; cellScore: number }[];
}

/** Một dòng báo cáo tỉ lệ theo ô (snapshot chụp từ recipe). */
interface CellReportView {
  sourceCellId: string;
  expectedUnits: number;
  actualUnits: number;
  expectedScore: number;
  actualScore: number;
  deviated: boolean;
}

/** Một lần triển khai đề + các mã đề của lần đó (EB-2). */
interface DeploymentView {
  id: string;
  quizId: string;
  variantCount: number;
  variants: { code: string; seed: number }[];
  createdAt: string;
}

/** Chi tiết một đề (GET /exam-papers/:id). */
interface PaperView {
  paper: { id: string; bankId: string; kind: string; status: string; latestVersion: number; derivedFromPaperId: string | null };
  version: {
    id: string; version: number; name: string;
    subjectId: string | null; grade: number | null; examKind: string | null;
    totalScore: number; durationMinutes: number | null;
    matrixId: string | null; matrixVersion: number | null;
    recipeSpec: RecipeSpecView | null;
  };
  slots: PaperSlotView[];
  cellReport: CellReportView[] | null;
  capabilities: { edit: boolean };
}

/** Một dòng kết quả khám phá ngân hàng câu hỏi (GET /questions/discovery). */
interface DiscoveryItemLite {
  questionId: string;
  name: string;
  qtype: string;
  bankName: string;
}

/** Slot đang soạn trong form (chưa ghim — server ghim bản ready mới nhất khi lưu). */
interface SlotDraft {
  questionId: string;
  questionName: string;
  maxMark: string;
  section: string;
  pinnedVersionNumber: number | null;
  /** Ô ma trận nguồn (EB-2): slot có trường này thì đổi câu bằng swap-cùng-ô. */
  matrixCellId?: string | null;
}

const EXAM_KINDS = ['regular', 'midterm', 'final', 'mock', 'practice'] as const;
const EXAM_KIND_LABEL_KEYS: Record<(typeof EXAM_KINDS)[number], string> = {
  regular: 'examKindRegular',
  midterm: 'examKindMidterm',
  final: 'examKindFinal',
  mock: 'examKindMock',
  practice: 'examKindPractice',
};

const selectClass = 'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs';

/**
 * Màn soạn đề RIÊNG theo chuẩn §9 (EB-1, issue #113): tạo mới
 * /exams/new?bank=<bankId>, sửa /exams/:paperId/edit.
 * Soạn tự do: metadata + chọn câu từ ngân hàng câu hỏi (khám phá theo
 * từ khoá) → thứ tự/phần/điểm từng câu → lưu. Lưu sửa tạo paper
 * version mới phía server (metadata qua PATCH, slots qua PUT — chỉ
 * gọi phần thật sự đổi); server ghim bản ready mới nhất của mỗi câu.
 */
export function ExamPaperEditorPage({ mode }: { mode: 'new' | 'edit' }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const { paperId } = useParams();
  const [searchParams] = useSearchParams();
  const bankId = searchParams.get('bank') ?? '';

  const [name, setName] = useState('');
  const [examKind, setExamKind] = useState('');
  const [grade, setGrade] = useState('');
  const [duration, setDuration] = useState('');
  const [totalScore, setTotalScore] = useState('10');
  const [slots, setSlots] = useState<SlotDraft[]>([]);
  const [original, setOriginal] = useState<PaperView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<DiscoveryItemLite[]>([]);
  const [searched, setSearched] = useState(false);
  const [deployments, setDeployments] = useState<DeploymentView[]>([]);
  /** Vị trí slot đang ở chế độ đổi câu cùng ô (EB-2); null = chế độ thêm câu thường. */
  const [swapPosition, setSwapPosition] = useState<number | null>(null);

  const loadPaper = useCallback(async () => {
    if (mode !== 'edit' || !paperId) return;
    try {
      const view = await apiJson<PaperView>(`/api/v1/exam-papers/${paperId}`);
      setOriginal(view);
      setName(view.version.name);
      setExamKind(view.version.examKind ?? '');
      setGrade(view.version.grade != null ? String(view.version.grade) : '');
      setDuration(view.version.durationMinutes != null ? String(view.version.durationMinutes) : '');
      setTotalScore(String(view.version.totalScore));
      setSlots(view.slots.map((s) => ({
        questionId: s.questionId,
        questionName: s.questionName ?? s.questionId,
        maxMark: String(s.maxMark),
        section: s.section,
        pinnedVersionNumber: s.pinnedVersionNumber,
        matrixCellId: s.matrixCellId,
      })));
    } catch (err) {
      setMessage(withApiReason(t('examPaperSaveFailed'), err));
    }
  }, [mode, paperId, t]);

  useEffect(() => { void loadPaper(); }, [loadPaper]);

  const loadDeployments = useCallback(async () => {
    if (mode !== 'edit' || !paperId) return;
    try {
      setDeployments(await apiJson<DeploymentView[]>(`/api/v1/exam-papers/${paperId}/deployments`));
    } catch {
      setDeployments([]);
    }
  }, [mode, paperId]);

  useEffect(() => { void loadDeployments(); }, [loadDeployments]);

  /** Chụp recipe xuống snapshot rồi mở bản chụp để sửa (EB-2). */
  async function doMaterialize() {
    if (!paperId) return;
    setMessage(null);
    try {
      const snapshot = await apiJson<PaperView>(`/api/v1/exam-papers/${paperId}/materialize`, { method: 'POST', body: '{}' });
      setMessage(t('materializeOk'));
      await navigate(`/exams/${snapshot.paper.id}/edit`);
    } catch (err) {
      setMessage(withApiReason(t('materializeFailed'), err));
    }
  }

  /** Đổi câu của slot đang chọn sang câu khác CÙNG Ô (server gác pool của ô nguồn). */
  async function doSwap(questionId: string) {
    if (!paperId || swapPosition == null) return;
    setMessage(null);
    try {
      const view = await apiJson<PaperView>(`/api/v1/exam-papers/${paperId}/swap`, {
        method: 'POST',
        body: JSON.stringify({ position: swapPosition, questionId }),
      });
      setOriginal(view);
      setSlots(view.slots.map((s) => ({
        questionId: s.questionId,
        questionName: s.questionName ?? s.questionId,
        maxMark: String(s.maxMark),
        section: s.section,
        pinnedVersionNumber: s.pinnedVersionNumber,
        matrixCellId: s.matrixCellId,
      })));
      setSwapPosition(null);
      setMessage(t('swapOk', { version: view.version.version }));
    } catch (err) {
      setMessage(withApiReason(t('swapFailed'), err));
    }
  }

  /** In đề snapshot theo một mã đề: tải HTML kèm token rồi mở tab in. */
  async function printVariant(deploymentId: string, code: string) {
    if (!paperId) return;
    setMessage(null);
    try {
      const response = await apiFetch(`/api/v1/exam-papers/${paperId}/print?deploymentId=${deploymentId}&variantCode=${code}`);
      if (!response.ok) throw new Error('print failed');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, '_blank');
    } catch (err) {
      setMessage(withApiReason(t('printFailed'), err));
    }
  }

  async function searchQuestions() {
    try {
      const params = new URLSearchParams();
      if (keyword.trim()) params.set('keyword', keyword.trim());
      const rows = await apiJson<DiscoveryItemLite[]>(`/api/v1/questions/discovery?${params.toString()}`);
      setResults(rows);
    } catch {
      setResults([]);
    }
    setSearched(true);
  }

  function addQuestion(item: DiscoveryItemLite) {
    setSlots((prev) => (prev.some((s) => s.questionId === item.questionId)
      ? prev
      : [...prev, { questionId: item.questionId, questionName: item.name, maxMark: '1', section: '', pinnedVersionNumber: null }]));
  }

  function moveSlot(index: number, delta: number) {
    setSlots((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      const [row] = next.splice(index, 1);
      next.splice(target, 0, row!);
      return next;
    });
  }

  function slotPayload() {
    return slots.map((s) => ({
      questionId: s.questionId,
      maxMark: Number(s.maxMark) > 0 ? Number(s.maxMark) : 1,
      ...(s.section.trim() ? { section: s.section.trim() } : {}),
    }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      if (mode === 'new') {
        const created = await apiJson<PaperView>(`/api/v1/exam-papers/banks/${bankId}/papers`, {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            examKind: examKind || null,
            grade: grade ? Number(grade) : null,
            durationMinutes: duration ? Number(duration) : null,
            totalScore: Number(totalScore) > 0 ? Number(totalScore) : 10,
            slots: slotPayload(),
          }),
        });
        setMessage(t('examPaperSaved', { version: created.version.version }));
        await navigate('/exams');
        return;
      }
      if (!original || !paperId) return;
      const metaChanged =
        name.trim() !== original.version.name ||
        (examKind || null) !== original.version.examKind ||
        (grade ? Number(grade) : null) !== original.version.grade ||
        (duration ? Number(duration) : null) !== original.version.durationMinutes ||
        Number(totalScore) !== original.version.totalScore;
      const slotsChanged = JSON.stringify(slotPayload()) !== JSON.stringify(
        original.slots.map((s) => ({
          questionId: s.questionId, maxMark: s.maxMark, ...(s.section ? { section: s.section } : {}),
        })),
      );
      let view: PaperView = original;
      if (metaChanged) {
        view = await apiJson<PaperView>(`/api/v1/exam-papers/${paperId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: name.trim(),
            examKind: examKind || null,
            grade: grade ? Number(grade) : null,
            durationMinutes: duration ? Number(duration) : null,
            totalScore: Number(totalScore) > 0 ? Number(totalScore) : 10,
          }),
        });
      }
      if (slotsChanged) {
        view = await apiJson<PaperView>(`/api/v1/exam-papers/${paperId}/slots`, {
          method: 'PUT',
          body: JSON.stringify({ slots: slotPayload() }),
        });
      }
      setMessage(t('examPaperSaved', { version: view.version.version }));
      await navigate('/exams');
    } catch (err) {
      setMessage(withApiReason(t('examPaperSaveFailed'), err));
    }
  }

  const isRecipe = mode === 'edit' && original?.paper.kind === 'recipe';
  const recipeSpec = original?.version.recipeSpec ?? null;
  /** Thứ tự slot nháp còn khớp bản đã lưu thì mới ánh xạ được vị trí cho swap-cùng-ô. */
  const orderIntact = !!original && slots.length === original.slots.length
    && slots.every((s, i) => s.questionId === original.slots[i]!.questionId);

  return (
    <PageShell width="full">
      <PageHeader
        title={mode === 'new' ? t('examPaperNew') : t('examPaperEdit')}
        actions={
          <Button type="button" variant="outline" render={<Link to="/exams" />}>
            {t('backToBanks')}
          </Button>
        }
      />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      {isRecipe ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('recipeInfoTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm">{original?.version.name}</p>
              <p className="text-sm text-muted-foreground">
                {t('recipePinnedMatrix', { version: original?.version.matrixVersion ?? '—' })}
                {' · '}
                {recipeSpec?.drawMode === 'per_student' ? t('recipeDrawPerStudent') : t('recipeDrawFixed')}
                {recipeSpec?.sourceBankScope ? ` · ${t('recipeSourceScope', { scope: recipeSpec.sourceBankScope })}` : ''}
              </p>
              {recipeSpec ? (
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {recipeSpec.cells.map((cell, i) => (
                    <li key={i}>{t('recipeCellLine', { index: i + 1, qtype: cell.qtype, count: cell.questionCount, score: cell.cellScore })}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-sm text-muted-foreground">{t('recipeNotEditable')}</p>
              {original?.capabilities.edit ? (
                <Button type="button" onClick={() => void doMaterialize()}>{t('materializeAction')}</Button>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : (
      <form onSubmit={(e) => void submit(e)} className="space-y-6">
        <Card>
          <CardContent className="pt-6">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="paper-name">{t('examPaperName')}</FieldLabel>
                <Input id="paper-name" value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <div className="grid gap-4 sm:grid-cols-4">
                <Field>
                  <FieldLabel htmlFor="paper-kind">{t('examKindLabel')}</FieldLabel>
                  <select id="paper-kind" className={selectClass} value={examKind} onChange={(e) => setExamKind(e.target.value)}>
                    <option value="">—</option>
                    {EXAM_KINDS.map((kind) => (
                      <option key={kind} value={kind}>{t(EXAM_KIND_LABEL_KEYS[kind])}</option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="paper-grade">{t('examGradeLabel')}</FieldLabel>
                  <Input id="paper-grade" type="number" min={1} max={12} value={grade} onChange={(e) => setGrade(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="paper-duration">{t('examDurationLabel')}</FieldLabel>
                  <Input id="paper-duration" type="number" min={1} value={duration} onChange={(e) => setDuration(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="paper-score">{t('examTotalScoreLabel')}</FieldLabel>
                  <Input id="paper-score" type="number" min={0} step="0.5" value={totalScore} onChange={(e) => setTotalScore(e.target.value)} />
                </Field>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('examPaperQuestions')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {slots.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('examPaperNoSlots')}</p>
            ) : (
              <ul className="space-y-2">
                {slots.map((slot, index) => (
                  <li key={slot.questionId} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1">
                      {index + 1}. {slot.questionName}
                      {slot.pinnedVersionNumber != null ? (
                        <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">
                          {t('examSlotPinned', { version: slot.pinnedVersionNumber })}
                        </span>
                      ) : null}
                    </span>
                    <Label className="sr-only" htmlFor={`slot-section-${slot.questionId}`}>{t('examSectionLabel')}</Label>
                    <Input
                      id={`slot-section-${slot.questionId}`}
                      className="w-32"
                      placeholder={t('examSectionLabel')}
                      value={slot.section}
                      onChange={(e) => setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, section: e.target.value } : s)))}
                    />
                    <Label className="sr-only" htmlFor={`slot-mark-${slot.questionId}`}>{t('examSlotMarkLabel')}</Label>
                    <Input
                      id={`slot-mark-${slot.questionId}`}
                      className="w-20"
                      type="number"
                      min={0}
                      step="0.25"
                      value={slot.maxMark}
                      onChange={(e) => setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, maxMark: e.target.value } : s)))}
                    />
                    <Button type="button" variant="outline" onClick={() => moveSlot(index, -1)}>↑</Button>
                    <Button type="button" variant="outline" onClick={() => moveSlot(index, 1)}>↓</Button>
                    {mode === 'edit' && slot.matrixCellId && orderIntact ? (
                      <Button
                        type="button"
                        variant={swapPosition === index + 1 ? 'default' : 'outline'}
                        onClick={() => setSwapPosition(swapPosition === index + 1 ? null : index + 1)}
                      >
                        {t('swapAction')}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setSlots((prev) => prev.filter((_, i) => i !== index))}
                    >
                      {t('deleteRow')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-3 border-t pt-4">
              <Label htmlFor="paper-pick">{t('examPickQuestions')}</Label>
              {swapPosition != null ? (
                <p className="text-sm text-muted-foreground">{t('swapPickHint', { position: swapPosition })}</p>
              ) : null}
              <div className="flex flex-wrap items-end gap-2">
                <Input
                  id="paper-pick"
                  className="max-w-sm"
                  placeholder={t('examSearchQuestions')}
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
                <Button type="button" onClick={() => void searchQuestions()}>{t('discoverySearch')}</Button>
              </div>
              {searched && results.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('examNoQuestionsFound')}</p>
              ) : (
                <ul className="space-y-2">
                  {results.map((item) => (
                    <li key={item.questionId} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        {item.name}
                        <span className="block text-xs text-muted-foreground">{item.bankName}</span>
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={slots.some((s) => s.questionId === item.questionId)}
                        onClick={() => (swapPosition != null ? void doSwap(item.questionId) : addQuestion(item))}
                      >
                        {swapPosition != null ? t('swapApply') : t('examAddQuestion')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        <Button type="submit" disabled={!name.trim()}>{t('saveAction')}</Button>
      </form>
      )}
      {mode === 'edit' && original && !isRecipe && original.cellReport && original.cellReport.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('cellReportTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {original.cellReport.map((cell, i) => (
                <li key={cell.sourceCellId} className={cell.deviated ? 'text-destructive' : 'text-muted-foreground'}>
                  {t('cellReportLine', {
                    index: i + 1,
                    expectedUnits: cell.expectedUnits, expectedScore: cell.expectedScore,
                    actualUnits: cell.actualUnits, actualScore: cell.actualScore,
                  })}
                  {' — '}
                  {cell.deviated ? t('cellDeviated') : t('cellAligned')}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {mode === 'edit' && deployments.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('deploymentsTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {deployments.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">
                    {new Date(d.createdAt).toLocaleString()} · {t('deploymentVariants', { count: d.variantCount, codes: d.variants.map((v) => v.code).join(', ') })}
                  </span>
                  {!isRecipe ? d.variants.map((v) => (
                    <Button key={v.code} type="button" variant="outline" onClick={() => void printVariant(d.id, v.code)}>
                      {t('printVariant', { code: v.code })}
                    </Button>
                  )) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </PageShell>
  );
}

export function ExamPaperNewPage() {
  return <ExamPaperEditorPage mode="new" />;
}

export function ExamPaperEditPage() {
  return <ExamPaperEditorPage mode="edit" />;
}

export default ExamPaperNewPage;
