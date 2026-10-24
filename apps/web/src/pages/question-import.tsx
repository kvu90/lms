import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';

/**
 * Trang nhập đề từ file (issue #52): tải docx/pdf → hàng đợi duyệt →
 * sửa + gắn YCCĐ/mức tại bước duyệt → duyệt vào ngân hàng câu hỏi.
 * Trang này chỉ làm việc với các đợt nhập của module question-import;
 * câu chưa duyệt không xuất hiện ở trang ngân hàng — đúng bất biến của
 * lát: hàng đợi là vùng đệm tách hẳn khỏi ngân hàng chính thức.
 */

const QTYPES = ['multichoice', 'truefalse', 'shortanswer', 'essay'] as const;
type Qtype = (typeof QTYPES)[number];
const QTYPE_LABEL_KEYS: Record<Qtype, string> = {
  multichoice: 'qtypeMultichoice',
  truefalse: 'qtypeTruefalse',
  shortanswer: 'qtypeShortanswer',
  essay: 'qtypeEssay',
};
const COGNITIVE_LEVELS = ['biet', 'hieu', 'van_dung', 'van_dung_cao'] as const;
const LEVEL_LABEL_KEYS: Record<string, string> = {
  biet: 'levelBiet', hieu: 'levelHieu', van_dung: 'levelVanDung', van_dung_cao: 'levelVanDungCao',
};
const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs';
const TEXTAREA_CLASS = 'w-full rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs';

interface ImportIssue { severity: 'error' | 'warning'; code: string; message: string }
interface OutcomeLink { outcomeId: string; cognitiveLevel: string }
interface ImportPayload {
  name: string;
  qtype: Qtype;
  questionText: string;
  generalFeedback?: string | null;
  defaultMark: number;
  answers: { text: string; fraction: number; feedback?: string | null }[];
  options: { single?: boolean; shuffleAnswers?: boolean; useCase?: boolean };
  truefalseCorrect?: boolean | null;
  outcomeLinks: OutcomeLink[];
}
interface ImportItem {
  id: string;
  ordinal: number;
  sourceNumber: number | null;
  qtype: string;
  status: 'pending' | 'approved' | 'rejected';
  payload: ImportPayload;
  issues: ImportIssue[];
  questionId: string | null;
  rawText: string;
}
interface ImportBatch {
  id: string; categoryId: string; fileName: string; fileKind: string;
  status: string; totalItems: number; createdAt: string;
}
interface BatchCounts { total: number; pending: number; approved: number; rejected: number }
interface BatchView { batch: ImportBatch; counts: BatchCounts; items: ImportItem[] }
interface BatchSummary { batch: ImportBatch; counts: BatchCounts }
interface CategoryRow { id: string; name: string }
interface CurriculumTreeNode {
  id: string; title: string;
  outcomes: { id: string; content: string }[];
  children: CurriculumTreeNode[];
}

/** Bản nháp sửa của một mục: fraction/điểm giữ dạng chuỗi cho nhập liệu tự do như editor câu hỏi. */
interface ItemDraft {
  name: string;
  qtype: Qtype;
  questionText: string;
  defaultMark: string;
  answers: { text: string; fraction: string }[];
  single: boolean;
  useCase: boolean;
  truefalseCorrect: boolean | null;
  outcomeLinks: OutcomeLink[];
}

function draftFromItem(item: ImportItem): ItemDraft {
  const p = item.payload;
  return {
    name: p.name,
    qtype: (QTYPES as readonly string[]).includes(p.qtype) ? p.qtype : 'essay',
    questionText: p.questionText,
    defaultMark: String(p.defaultMark ?? 1),
    answers: (p.answers ?? []).map((a) => ({ text: a.text, fraction: String(a.fraction) })),
    single: p.options?.single ?? true,
    useCase: p.options?.useCase ?? false,
    truefalseCorrect: p.truefalseCorrect ?? null,
    outcomeLinks: (p.outcomeLinks ?? []).map((l) => ({ ...l })),
  };
}

function payloadFromDraft(draft: ItemDraft): ImportPayload {
  const num = (v: string, fallback: number) => {
    const n = Number.parseFloat(v.replace(',', '.'));
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    name: draft.name.trim() === '' ? draft.questionText.slice(0, 90) : draft.name,
    qtype: draft.qtype,
    questionText: draft.questionText,
    generalFeedback: null,
    defaultMark: num(draft.defaultMark, 1),
    answers: draft.qtype === 'multichoice' || draft.qtype === 'shortanswer'
      ? draft.answers.map((a) => ({ text: a.text, fraction: num(a.fraction, 0) }))
      : [],
    options: draft.qtype === 'multichoice'
      ? { single: draft.single, shuffleAnswers: false }
      : draft.qtype === 'shortanswer' ? { useCase: draft.useCase } : {},
    truefalseCorrect: draft.qtype === 'truefalse' ? draft.truefalseCorrect : null,
    outcomeLinks: draft.outcomeLinks,
  };
}

/**
 * Bộ chọn YCCĐ cho một mục: chọn môn → nạp cây mọi khối của môn → chọn
 * YCCĐ + mức (cùng luồng dữ liệu với khối Chương trình của editor câu
 * hỏi). Danh sách YCCĐ theo môn được cache ở cấp trang để nhiều mục
 * không nạp lặp.
 */
function OutcomeLinkEditor(props: {
  links: OutcomeLink[];
  onChange: (links: OutcomeLink[]) => void;
  subjects: { id: string; name: string }[];
  outcomeOptionsCache: React.MutableRefObject<Map<string, { id: string; label: string }[]>>;
  labels: Record<string, string>;
  onLabels: (labels: Record<string, string>) => void;
}) {
  const { t } = useTranslation('app');
  const [subjectPick, setSubjectPick] = useState('');
  const [outcomeOptions, setOutcomeOptions] = useState<{ id: string; label: string }[]>([]);
  const [outcomePick, setOutcomePick] = useState('');
  const [levelPick, setLevelPick] = useState<string>('biet');

  async function pickSubject(subjectId: string) {
    setSubjectPick(subjectId);
    setOutcomePick('');
    if (!subjectId) { setOutcomeOptions([]); return; }
    const cached = props.outcomeOptionsCache.current.get(subjectId);
    if (cached) { setOutcomeOptions(cached); return; }
    try {
      const curricula = await apiJson<{ id: string; grade: number }[]>(`/api/v1/curriculum/curricula?subjectId=${subjectId}`);
      const options: { id: string; label: string }[] = [];
      const labels: Record<string, string> = {};
      for (const curr of curricula) {
        const tree = await apiJson<{ nodes: CurriculumTreeNode[] }>(`/api/v1/curriculum/curricula/${curr.id}/tree`);
        const walk = (nodes: CurriculumTreeNode[]): void => {
          for (const node of nodes) {
            for (const outcome of node.outcomes) {
              options.push({ id: outcome.id, label: `${curr.grade} · ${node.title} · ${outcome.content}` });
              labels[outcome.id] = outcome.content;
            }
            walk(node.children);
          }
        };
        walk(tree.nodes);
      }
      props.outcomeOptionsCache.current.set(subjectId, options);
      props.onLabels(labels);
      setOutcomeOptions(options);
    } catch {
      setOutcomeOptions([]);
    }
  }

  return (
    <div className="space-y-2">
      <Label>{t('importOutcomeLinksHeading')}</Label>
      <ul className="space-y-1">
        {props.links.map((link) => (
          <li key={link.outcomeId} className="flex items-center gap-2 text-sm">
            <span className="flex-1">{props.labels[link.outcomeId] ?? link.outcomeId}</span>
            <select
              aria-label={t('programmeLevel')}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs"
              value={link.cognitiveLevel}
              onChange={(e) => props.onChange(props.links.map((l) => (l.outcomeId === link.outcomeId ? { ...l, cognitiveLevel: e.target.value } : l)))}
            >
              {COGNITIVE_LEVELS.map((level) => (
                <option key={level} value={level}>{t(LEVEL_LABEL_KEYS[level]!)}</option>
              ))}
            </select>
            <Button
              type="button" variant="outline"
              onClick={() => props.onChange(props.links.filter((l) => l.outcomeId !== link.outcomeId))}
            >
              {t('programmeDetach')}
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <select aria-label={t('programmePickSubject')} className={SELECT_CLASS + ' w-auto'} value={subjectPick} onChange={(e) => void pickSubject(e.target.value)}>
          <option value="">{t('programmePickSubject')}</option>
          {props.subjects.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
        </select>
        <select aria-label={t('programmePickOutcome')} className={SELECT_CLASS + ' w-auto'} value={outcomePick} onChange={(e) => setOutcomePick(e.target.value)}>
          <option value="">{t('programmePickOutcome')}</option>
          {outcomeOptions.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
        </select>
        <select aria-label={t('programmeLevel')} className={SELECT_CLASS + ' w-auto'} value={levelPick} onChange={(e) => setLevelPick(e.target.value)}>
          {COGNITIVE_LEVELS.map((level) => (
            <option key={level} value={level}>{t(LEVEL_LABEL_KEYS[level]!)}</option>
          ))}
        </select>
        <Button
          type="button"
          disabled={!outcomePick || props.links.some((l) => l.outcomeId === outcomePick)}
          onClick={() => {
            props.onChange([...props.links, { outcomeId: outcomePick, cognitiveLevel: levelPick }]);
            setOutcomePick('');
          }}
        >
          {t('importAddOutcome')}
        </Button>
      </div>
    </div>
  );
}

/** Thẻ một mục trong hàng đợi: xem vấn đề, sửa nội dung/đáp án, gắn YCCĐ, duyệt/từ chối. */
function ImportItemCard(props: {
  item: ImportItem;
  draft: ItemDraft;
  onDraft: (draft: ItemDraft) => void;
  onSave: () => void;
  onApprove: () => void;
  onReject: () => void;
  subjects: { id: string; name: string }[];
  outcomeOptionsCache: React.MutableRefObject<Map<string, { id: string; label: string }[]>>;
  labels: Record<string, string>;
  onLabels: (labels: Record<string, string>) => void;
}) {
  const { t } = useTranslation('app');
  const { item, draft } = props;
  const pending = item.status === 'pending';
  const set = (patch: Partial<ItemDraft>) => props.onDraft({ ...draft, ...patch });
  const statusLabel = item.status === 'approved'
    ? t('importItemStatusApproved')
    : item.status === 'rejected' ? t('importItemStatusRejected') : t('importItemStatusPending');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span>{item.ordinal}. {draft.name}</span>
          <span className="rounded bg-secondary px-2 py-0.5 text-xs">{t(QTYPE_LABEL_KEYS[draft.qtype])}</span>
          <span className="rounded bg-secondary px-2 py-0.5 text-xs">{statusLabel}</span>
          {item.sourceNumber !== null && (
            <span className="text-xs text-muted-foreground">{t('importSourceQuestion', { number: item.sourceNumber })}</span>
          )}
        </CardTitle>
        {item.status === 'approved' && item.questionId && (
          <CardDescription>{t('importApprovedNote', { id: item.questionId })}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {item.issues.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('importIssuesHeading')}</p>
            <ul className="space-y-1">
              {item.issues.map((issue, idx) => (
                <li key={idx} className={issue.severity === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
                  {t(`importIssue_${issue.code}`, { defaultValue: issue.message })}
                </li>
              ))}
            </ul>
          </div>
        )}
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">{t('importRawText')}</summary>
          <pre className="mt-1 whitespace-pre-wrap text-xs">{item.rawText}</pre>
        </details>
        {pending && (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`name-${item.id}`}>{t('name')}</Label>
                <Input id={`name-${item.id}`} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`qtype-${item.id}`}>{t('questionType')}</Label>
                <select id={`qtype-${item.id}`} className={SELECT_CLASS} value={draft.qtype} onChange={(e) => set({ qtype: e.target.value as Qtype })}>
                  {QTYPES.map((q) => (<option key={q} value={q}>{t(QTYPE_LABEL_KEYS[q])}</option>))}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`text-${item.id}`}>{t('questionText')}</Label>
              <textarea id={`text-${item.id}`} className={TEXTAREA_CLASS} rows={3} value={draft.questionText} onChange={(e) => set({ questionText: e.target.value })} />
            </div>
            <div className="w-40 space-y-1">
              <Label htmlFor={`mark-${item.id}`}>{t('importMarkLabel')}</Label>
              <Input id={`mark-${item.id}`} inputMode="decimal" value={draft.defaultMark} onChange={(e) => set({ defaultMark: e.target.value })} />
            </div>

            {(draft.qtype === 'multichoice' || draft.qtype === 'shortanswer') && (
              <div className="space-y-2">
                <Label>{draft.qtype === 'multichoice' ? t('choices') : t('acceptedAnswers')}</Label>
                {draft.answers.map((answer, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      aria-label={t('choiceText', { index: idx + 1 })}
                      value={answer.text}
                      onChange={(e) => set({ answers: draft.answers.map((a, i) => (i === idx ? { ...a, text: e.target.value } : a)) })}
                    />
                    <Input
                      aria-label={t('answerFraction', { index: idx + 1 })}
                      className="w-24"
                      inputMode="decimal"
                      value={answer.fraction}
                      onChange={(e) => set({ answers: draft.answers.map((a, i) => (i === idx ? { ...a, fraction: e.target.value } : a)) })}
                    />
                    <Button type="button" variant="outline" onClick={() => set({ answers: draft.answers.filter((_, i) => i !== idx) })}>
                      {t('removeChoice', { index: idx + 1 })}
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" onClick={() => set({ answers: [...draft.answers, { text: '', fraction: '0' }] })}>
                  {t('addChoice')}
                </Button>
                {draft.qtype === 'multichoice' && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={draft.single} onChange={(e) => set({ single: e.target.checked })} />
                    {t('singleAnswerOnly')}
                  </label>
                )}
                {draft.qtype === 'shortanswer' && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={draft.useCase} onChange={(e) => set({ useCase: e.target.checked })} />
                    {t('caseSensitive')}
                  </label>
                )}
              </div>
            )}

            {draft.qtype === 'truefalse' && (
              <div className="space-y-1">
                <Label>{t('questionType')}</Label>
                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio" name={`tf-${item.id}`} checked={draft.truefalseCorrect === true}
                      onChange={() => set({ truefalseCorrect: true })}
                    />
                    {t('correctAnswerIsTrue')}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio" name={`tf-${item.id}`} checked={draft.truefalseCorrect === false}
                      onChange={() => set({ truefalseCorrect: false })}
                    />
                    {t('correctAnswerIsFalse')}
                  </label>
                  {draft.truefalseCorrect === null && <span className="text-destructive">{t('importTfUndecided')}</span>}
                </div>
              </div>
            )}

            <OutcomeLinkEditor
              links={draft.outcomeLinks}
              onChange={(outcomeLinks) => set({ outcomeLinks })}
              subjects={props.subjects}
              outcomeOptionsCache={props.outcomeOptionsCache}
              labels={props.labels}
              onLabels={props.onLabels}
            />

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={props.onSave}>{t('importSaveItem')}</Button>
              <Button type="button" onClick={props.onApprove}>{t('importApproveItem')}</Button>
              <Button type="button" variant="destructive" onClick={props.onReject}>{t('importRejectItem')}</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function QuestionImportPage() {
  const { t } = useTranslation('app');
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [current, setCurrent] = useState<BatchView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});
  const [uploadCategory, setUploadCategory] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const [subjects, setSubjects] = useState<{ id: string; name: string }[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const outcomeOptionsCache = useRef(new Map<string, { id: string; label: string }[]>());

  const applyBatch = (view: BatchView) => {
    setCurrent(view);
    setDrafts(Object.fromEntries(view.items.map((item) => [item.id, draftFromItem(item)])));
  };

  const loadBatches = async () => {
    const rows = await apiJson<BatchSummary[]>('/api/v1/question-imports');
    setBatches(rows);
  };

  const openBatch = async (batchId: string) => {
    try {
      applyBatch(await apiJson<BatchView>(`/api/v1/question-imports/${batchId}`));
    } catch {
      setMessage(t('importLoadFailed'));
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        setCategories(await apiJson<CategoryRow[]>('/api/v1/questions/categories'));
      } catch { /* danh mục trống thì form tải lên không dùng được, trang vẫn hiện */ }
      try {
        await loadBatches();
      } catch {
        setMessage(t('importLoadFailed'));
      }
      try {
        const contexts = await apiJson<{ id: string; contextLevel: number }[]>('/api/v1/access/contexts');
        const system = contexts.find((c) => c.contextLevel === 10);
        if (system) {
          setSubjects(await apiJson<{ id: string; name: string }[]>(`/api/v1/curriculum/subjects?contextId=${system.id}`));
        }
      } catch { /* khối YCCĐ là phụ trợ của bước duyệt */ }
    })();
  }, []);

  async function submitUpload(event: FormEvent) {
    event.preventDefault();
    if (!file || !uploadCategory) return;
    const form = new FormData();
    form.set('file', file);
    form.set('categoryId', uploadCategory);
    try {
      const view = await apiJson<BatchView>('/api/v1/question-imports', { method: 'POST', body: form });
      applyBatch(view);
      await loadBatches();
      setMessage('');
    } catch {
      setMessage(t('importUploadFailed'));
    }
  }

  async function saveItem(item: ImportItem): Promise<boolean> {
    if (!current) return false;
    try {
      const updated = await apiJson<ImportItem>(`/api/v1/question-imports/${current.batch.id}/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ payload: payloadFromDraft(drafts[item.id] ?? draftFromItem(item)) }),
      });
      setCurrent({ ...current, items: current.items.map((i) => (i.id === item.id ? updated : i)) });
      setMessage(t('importSaved'));
      return true;
    } catch {
      setMessage(t('importSaveFailed'));
      return false;
    }
  }

  async function approveItem(item: ImportItem) {
    if (!current) return;
    if (!(await saveItem(item))) return;
    try {
      await apiJson(`/api/v1/question-imports/${current.batch.id}/items/${item.id}/approve`, { method: 'POST' });
      await openBatch(current.batch.id);
      await loadBatches();
    } catch {
      setMessage(t('importApproveFailed'));
    }
  }

  async function rejectItem(item: ImportItem) {
    if (!current) return;
    try {
      await apiJson(`/api/v1/question-imports/${current.batch.id}/items/${item.id}/reject`, { method: 'POST' });
      await openBatch(current.batch.id);
      await loadBatches();
    } catch {
      setMessage(t('importApproveFailed'));
    }
  }

  async function approveAll() {
    if (!current) return;
    try {
      const result = await apiJson<{ approved: unknown[]; skipped: unknown[] }>(
        `/api/v1/question-imports/${current.batch.id}/approve-all`, { method: 'POST' },
      );
      setMessage(t('importApproveAllResult', { approved: result.approved.length, skipped: result.skipped.length }));
      await openBatch(current.batch.id);
      await loadBatches();
    } catch {
      setMessage(t('importApproveFailed'));
    }
  }

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('importTitle')}</CardTitle>
          <CardDescription>{t('importDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm">
            <Link to="/questions" className="underline">{t('questionBank')}</Link>
          </p>
          {message && <p role="status" className="mb-3 text-sm">{message}</p>}
          <form onSubmit={(e) => void submitUpload(e)} className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="import-category">{t('importTargetCategory')}</Label>
              <select id="import-category" className={SELECT_CLASS} value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value)}>
                <option value="">{t('importSelectCategory')}</option>
                {categories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="import-file">{t('importFileLabel')}</Label>
              <Input id="import-file" type="file" accept=".docx,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <Button type="submit" disabled={!file || !uploadCategory}>{t('importUploadButton')}</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('importMyBatches')}</CardTitle>
        </CardHeader>
        <CardContent>
          {batches.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('importNoBatches')}</p>
          ) : (
            <ul className="space-y-2">
              {batches.map(({ batch, counts }) => (
                <li key={batch.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <button type="button" className="underline" onClick={() => void openBatch(batch.id)}>
                    {batch.fileName}
                  </button>
                  <span>{t('importBatchSummary', { ...counts })}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {current && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">{current.batch.fileName}</h2>
            <span className="text-sm">{t('importBatchSummary', { ...current.counts })}</span>
            <Button type="button" onClick={() => void approveAll()}>{t('importApproveAll')}</Button>
          </div>
          <div className="space-y-4">
            {current.items.map((item) => (
              <ImportItemCard
                key={item.id}
                item={item}
                draft={drafts[item.id] ?? draftFromItem(item)}
                onDraft={(draft) => setDrafts((prev) => ({ ...prev, [item.id]: draft }))}
                onSave={() => void saveItem(item)}
                onApprove={() => void approveItem(item)}
                onReject={() => void rejectItem(item)}
                subjects={subjects}
                outcomeOptionsCache={outcomeOptionsCache}
                labels={labels}
                onLabels={(newLabels) => setLabels((prev) => ({ ...prev, ...newLabels }))}
              />
            ))}
          </div>
        </>
      )}
    </main>
  );
}
