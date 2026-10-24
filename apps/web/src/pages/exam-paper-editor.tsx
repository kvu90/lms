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
import { apiJson } from '#lib/api';
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
}

/** Chi tiết một đề (GET /exam-papers/:id). */
interface PaperView {
  paper: { id: string; bankId: string; status: string; latestVersion: number };
  version: {
    id: string; version: number; name: string;
    subjectId: string | null; grade: number | null; examKind: string | null;
    totalScore: number; durationMinutes: number | null;
  };
  slots: PaperSlotView[];
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
 * /exam-papers/new?bank=<bankId>, sửa /exam-papers/:paperId/edit.
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
      })));
    } catch (err) {
      setMessage(withApiReason(t('examPaperSaveFailed'), err));
    }
  }, [mode, paperId, t]);

  useEffect(() => { void loadPaper(); }, [loadPaper]);

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
        await navigate('/questions');
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
      await navigate('/questions');
    } catch (err) {
      setMessage(withApiReason(t('examPaperSaveFailed'), err));
    }
  }

  return (
    <PageShell width="full">
      <PageHeader
        title={mode === 'new' ? t('examPaperNew') : t('examPaperEdit')}
        actions={
          <Button type="button" variant="outline" render={<Link to="/questions" />}>
            {t('backToBanks')}
          </Button>
        }
      />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
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
                        onClick={() => addQuestion(item)}
                      >
                        {t('examAddQuestion')}
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
