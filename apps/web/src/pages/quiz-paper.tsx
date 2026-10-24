import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { PaperBatch, PaperScan } from '@lms/contracts';
import { Alert, AlertDescription, AlertTitle } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiFetch, apiJson } from '#lib/api';

/**
 * CAM-0 (issue #112) — Chấm bài giấy bằng camera, phía giáo viên:
 * sinh lô phiếu + tải PDF (cá nhân hoá / phiếu trắng), chụp/tải ảnh
 * hàng loạt qua cổng chất lượng, xử lý hai hàng chờ (gán định danh,
 * xác nhận câu mơ hồ trên ảnh đã nắn phẳng) rồi ghi điểm thành attempt
 * thi giấy. Hệ thống không bao giờ chấm đoán: phiếu chưa chắc chắn nằm
 * ở hàng chờ cho tới khi giáo viên quyết.
 */

const TEMPLATE_WIDTH = 1240;
const LETTERS = ['A', 'B', 'C', 'D', 'E'];

interface UploadOutcome {
  fileName: string;
  stored: boolean;
  reasons?: string[];
  scan?: PaperScan;
}

/** Ảnh phiếu đã nắn phẳng (qua endpoint có gác quyền chấm giấy). */
function WarpedImage({ scanId, className }: { scanId: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    void apiFetch(`/api/v1/paper-scans/${scanId}/image/warped`)
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('image failed'))))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (live) setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [scanId]);
  if (!url) return <Skeleton className={className ?? 'h-40 w-full'} />;
  return <img src={url} alt="" className={className ?? 'w-full rounded border'} />;
}

/** Vùng cắt quanh một dòng câu trên ảnh đã nắn (toạ độ template 1240×1754). */
function RowCrop({ scanId, centers }: { scanId: string; centers: { x: number; y: number }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    void apiFetch(`/api/v1/paper-scans/${scanId}/image/warped`)
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('image failed'))))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (live) setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [scanId]);
  const height = 120;
  const cy = centers.reduce((sum, c) => sum + c.y, 0) / Math.max(1, centers.length);
  const scale = width / TEMPLATE_WIDTH;
  return (
    <div ref={ref} className="relative w-full overflow-hidden rounded border bg-white" style={{ height }}>
      {url && width > 0 ? (
        <img src={url} alt="" className="absolute left-0 w-full" style={{ top: -(cy * scale - height / 2) }} />
      ) : (
        <Skeleton className="h-full w-full" />
      )}
    </div>
  );
}

export default function QuizPaperPage() {
  const { id: courseId, quizId } = useParams();
  const { t } = useTranslation();
  const [batches, setBatches] = useState<PaperBatch[] | null>(null);
  const [scans, setScans] = useState<PaperScan[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [variant, setVariant] = useState('');
  const [copies, setCopies] = useState(30);
  const [files, setFiles] = useState<File[]>([]);
  const [outcomes, setOutcomes] = useState<UploadOutcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [identityChoice, setIdentityChoice] = useState<Record<string, string>>({});
  const [resolutions, setResolutions] = useState<Record<string, Record<number, number | null>>>({});
  const [recordedGrades, setRecordedGrades] = useState<Record<string, number>>({});

  const reload = useCallback(async () => {
    const [batchList, scanList] = await Promise.all([
      apiJson<PaperBatch[]>(`/api/v1/quizzes/${quizId}/paper-batches`),
      apiJson<PaperScan[]>(`/api/v1/paper-scans?quizId=${quizId}`),
    ]);
    setBatches(batchList);
    setScans(scanList);
    setSelectedBatchId((prev) => prev ?? batchList[0]?.id ?? null);
  }, [quizId]);

  useEffect(() => {
    reload().catch(() => setFailed(true));
  }, [reload]);

  const batchById = new Map((batches ?? []).map((b) => [b.id, b]));
  const selectedBatch = selectedBatchId ? (batchById.get(selectedBatchId) ?? null) : null;

  async function runAction(fn: () => Promise<void>) {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
    } catch {
      setActionError(t('paperActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function createBatch() {
    await runAction(async () => {
      const created = await apiJson<PaperBatch>(`/api/v1/quizzes/${quizId}/paper-batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(variant.trim() ? { variantCode: variant.trim() } : {}),
      });
      setVariant('');
      await reload();
      setSelectedBatchId(created.id);
    });
  }

  async function downloadPdf(kind: 'personal' | 'blank' | 'one', studentId?: string) {
    await runAction(async () => {
      if (!selectedBatch) return;
      const params = new URLSearchParams();
      if (kind === 'blank') {
        params.set('kind', 'blank');
        params.set('copies', String(Math.max(1, copies || 1)));
      }
      if (kind === 'one' && studentId) params.set('studentId', studentId);
      const query = params.toString();
      const res = await apiFetch(
        `/api/v1/quizzes/${quizId}/paper-batches/${selectedBatch.id}/sheets.pdf${query ? `?${query}` : ''}`,
      );
      if (!res.ok) throw new Error('pdf failed');
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `phieu-${selectedBatch.variantCode}-${kind}.pdf`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    });
  }

  async function uploadPhotos() {
    if (!selectedBatch || files.length === 0) return;
    await runAction(async () => {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      const res = await apiFetch(`/api/v1/quizzes/${quizId}/paper-batches/${selectedBatch.id}/scans`, {
        method: 'POST',
        body: form,
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        // 422 = mọi ảnh đều bị cổng chất lượng từ chối; thân lỗi mang danh sách lý do của ảnh đầu.
        const detail = (body as { detail?: string } | null)?.detail;
        setOutcomes([{ fileName: files.map((f) => f.name).join(', '), stored: false, reasons: detail ? [detail] : ['rejected'] }]);
        return;
      }
      setOutcomes(body as UploadOutcome[]);
      setFiles([]);
      await reload();
    });
  }

  async function assignIdentity(scan: PaperScan) {
    const studentId = identityChoice[scan.id];
    if (!studentId) return;
    await runAction(async () => {
      await apiJson(`/api/v1/paper-scans/${scan.id}/assign-identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId }),
      });
      await reload();
    });
  }

  async function resolveReadings(scan: PaperScan) {
    const picks = resolutions[scan.id] ?? {};
    const ambiguous = scan.readings.filter((r) => r.state === 'ambiguous');
    if (ambiguous.some((r) => !(r.slot in picks))) return;
    await runAction(async () => {
      await apiJson(`/api/v1/paper-scans/${scan.id}/resolve-readings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readings: ambiguous.map((r) => ({ slot: r.slot, chosen: picks[r.slot] ?? null })) }),
      });
      await reload();
    });
  }

  async function record(scan: PaperScan) {
    await runAction(async () => {
      const result = await apiJson<PaperScan & { sumGrades: number }>(`/api/v1/paper-scans/${scan.id}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      setRecordedGrades((prev) => ({ ...prev, [scan.id]: result.sumGrades }));
      await reload();
    });
  }

  async function remove(scan: PaperScan) {
    await runAction(async () => {
      await apiJson(`/api/v1/paper-scans/${scan.id}`, { method: 'DELETE' });
      await reload();
    });
  }

  function choiceLabel(batch: PaperBatch | undefined, slot: number, index: number): string {
    const layout = batch?.layout.find((l) => l.slot === slot);
    if (layout?.qtype === 'truefalse') return index === 0 ? 'Đ' : 'S';
    return LETTERS[index] ?? String(index + 1);
  }

  const queues = {
    needs_identity: (scans ?? []).filter((s) => s.status === 'needs_identity'),
    needs_review: (scans ?? []).filter((s) => s.status === 'needs_review'),
    ready: (scans ?? []).filter((s) => s.status === 'ready'),
    recorded: (scans ?? []).filter((s) => s.status === 'recorded'),
  };

  return (
    <PageShell>
      <PageHeader
        title={t('paperTitle')}
        actions={
          <Button type="button" variant="outline" render={<Link to={`/courses/${courseId}/quizzes/${quizId}`} />}>
            {t('paperBack')}
          </Button>
        }
      />
      {failed ? (
        <Alert variant="destructive">
          <AlertTitle>{t('paperLoadFailed')}</AlertTitle>
        </Alert>
      ) : batches === null || scans === null ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="flex flex-col gap-6">
          {actionError ? (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t('paperBatchesTitle')}</CardTitle>
              <CardDescription>{t('paperBatchesDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {batches.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>{t('paperNoBatches')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ul className="flex flex-col gap-2">
                  {batches.map((batch) => (
                    <li key={batch.id}>
                      <Button
                        type="button"
                        variant={batch.id === selectedBatchId ? 'default' : 'outline'}
                        onClick={() => setSelectedBatchId(batch.id)}
                      >
                        {t('paperBatchLine', { code: batch.variantCode, count: batch.roster.length, slots: batch.layout.length })}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="paper-variant">{t('paperVariantLabel')}</Label>
                  <Input
                    id="paper-variant"
                    value={variant}
                    onChange={(e) => setVariant(e.target.value)}
                    className="w-32"
                    maxLength={8}
                  />
                </div>
                <Button type="button" disabled={busy} onClick={() => void createBatch()}>
                  {t('paperCreateBatch')}
                </Button>
              </div>
              {selectedBatch ? (
                <div className="flex flex-wrap items-end gap-3 border-t pt-4">
                  <Button type="button" variant="outline" disabled={busy} onClick={() => void downloadPdf('personal')}>
                    {t('paperDownloadPersonal')}
                  </Button>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="paper-copies">{t('paperCopiesLabel')}</Label>
                    <Input
                      id="paper-copies"
                      type="number"
                      min={1}
                      max={200}
                      value={copies}
                      onChange={(e) => setCopies(Number(e.target.value))}
                      className="w-24"
                    />
                  </div>
                  <Button type="button" variant="outline" disabled={busy} onClick={() => void downloadPdf('blank')}>
                    {t('paperDownloadBlank')}
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {selectedBatch ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('paperUploadTitle')}</CardTitle>
                <CardDescription>{t('paperUploadHint')}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    type="file"
                    accept="image/*"
                    multiple
                    className="max-w-md"
                    onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                  />
                  <Button type="button" disabled={busy || files.length === 0} onClick={() => void uploadPhotos()}>
                    {t('paperUploadButton')}
                  </Button>
                </div>
                {outcomes ? (
                  <ul className="flex flex-col gap-1 text-sm">
                    {outcomes.map((outcome, i) => (
                      <li key={i}>
                        {outcome.stored
                          ? `${outcome.fileName}: ${t('paperUploadStored')} (${outcome.scan?.status ?? ''})`
                          : `${outcome.fileName}: ${t('paperUploadRejected')} — ${(outcome.reasons ?? []).map((r) => t(`paperReason_${r}`, { defaultValue: r })).join(', ')}`}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t('paperQueueIdentityTitle')} ({queues.needs_identity.length})</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {queues.needs_identity.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('paperQueueEmpty')}</p>
              ) : (
                queues.needs_identity.map((scan) => {
                  const batch = batchById.get(scan.batchId);
                  return (
                    <div key={scan.id} className="flex flex-col gap-3 border-b pb-4">
                      <p className="text-sm font-medium">
                        {t('paperFromBatch', { code: batch?.variantCode ?? '?' })} —{' '}
                        {scan.identityCode ? t('paperIdentityCode', { code: scan.identityCode }) : t('paperIdentityNone')}
                      </p>
                      <div className="max-w-md">
                        <WarpedImage scanId={scan.id} />
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <select
                          className="h-9 rounded-md border bg-background px-2 text-sm"
                          value={identityChoice[scan.id] ?? ''}
                          onChange={(e) => setIdentityChoice((prev) => ({ ...prev, [scan.id]: e.target.value }))}
                        >
                          <option value="">{t('paperSelectStudent')}</option>
                          {(batch?.roster ?? []).map((entry) => (
                            <option key={entry.userId} value={entry.userId}>
                              {entry.displayName} ({entry.code})
                            </option>
                          ))}
                        </select>
                        <Button type="button" disabled={busy || !identityChoice[scan.id]} onClick={() => void assignIdentity(scan)}>
                          {t('paperAssign')}
                        </Button>
                        <Button type="button" variant="outline" disabled={busy} onClick={() => void remove(scan)}>
                          {t('paperDelete')}
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('paperQueueReviewTitle')} ({queues.needs_review.length})</CardTitle>
              <CardDescription>{t('paperQueueReviewDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {queues.needs_review.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('paperQueueEmpty')}</p>
              ) : (
                queues.needs_review.map((scan) => {
                  const batch = batchById.get(scan.batchId);
                  const ambiguous = scan.readings.filter((r) => r.state === 'ambiguous');
                  const picks = resolutions[scan.id] ?? {};
                  const complete = ambiguous.every((r) => r.slot in picks);
                  return (
                    <div key={scan.id} className="flex flex-col gap-4 border-b pb-4">
                      <p className="text-sm font-medium">
                        {scan.studentName ?? t('paperStudentUnknown')} — {t('paperFromBatch', { code: batch?.variantCode ?? '?' })}
                      </p>
                      {ambiguous.map((reading) => {
                        const row = scan.rows.find((r) => r.slot === reading.slot);
                        const optionCount = row?.centers.length ?? reading.densities.length;
                        return (
                          <div key={reading.slot} className="flex flex-col gap-2">
                            <p className="text-sm">{t('paperQuestionLine', { slot: reading.slot })}</p>
                            {row ? <RowCrop scanId={scan.id} centers={row.centers} /> : null}
                            <div className="flex flex-wrap gap-2">
                              {Array.from({ length: optionCount }, (_, index) => (
                                <Button
                                  key={index}
                                  type="button"
                                  size="sm"
                                  variant={picks[reading.slot] === index ? 'default' : 'outline'}
                                  onClick={() =>
                                    setResolutions((prev) => ({
                                      ...prev,
                                      [scan.id]: { ...(prev[scan.id] ?? {}), [reading.slot]: index },
                                    }))
                                  }
                                >
                                  {choiceLabel(batch, reading.slot, index)}
                                </Button>
                              ))}
                              <Button
                                type="button"
                                size="sm"
                                variant={picks[reading.slot] === null ? 'default' : 'outline'}
                                onClick={() =>
                                  setResolutions((prev) => ({
                                    ...prev,
                                    [scan.id]: { ...(prev[scan.id] ?? {}), [reading.slot]: null },
                                  }))
                                }
                              >
                                {t('paperBlankChoice')}
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                      <div className="flex gap-3">
                        <Button type="button" disabled={busy || !complete} onClick={() => void resolveReadings(scan)}>
                          {t('paperResolveSubmit')}
                        </Button>
                        <Button type="button" variant="outline" disabled={busy} onClick={() => void remove(scan)}>
                          {t('paperDelete')}
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('paperQueueReadyTitle')} ({queues.ready.length})</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {queues.ready.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('paperQueueEmpty')}</p>
              ) : (
                queues.ready.map((scan) => (
                  <div key={scan.id} className="flex flex-wrap items-center gap-3 border-b pb-3">
                    <span className="text-sm font-medium">{scan.studentName ?? t('paperStudentUnknown')}</span>
                    <span className="text-sm text-muted-foreground">
                      {t('paperFromBatch', { code: batchById.get(scan.batchId)?.variantCode ?? '?' })}
                    </span>
                    <Button type="button" disabled={busy} onClick={() => void record(scan)}>
                      {t('paperRecord')}
                    </Button>
                    <Button type="button" variant="outline" disabled={busy} onClick={() => void remove(scan)}>
                      {t('paperDelete')}
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('paperQueueRecordedTitle')} ({queues.recorded.length})</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {queues.recorded.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('paperQueueEmpty')}</p>
              ) : (
                queues.recorded.map((scan) => (
                  <p key={scan.id} className="text-sm">
                    {scan.studentName ?? t('paperStudentUnknown')}
                    {recordedGrades[scan.id] !== undefined
                      ? ` — ${t('paperSumGrades', { grade: recordedGrades[scan.id] })}`
                      : ''}
                    {scan.attemptId ? (
                      <>
                        {' — '}
                        <Link className="underline" to={`/quiz-attempts/${scan.attemptId}`}>
                          {t('paperViewAttempt')}
                        </Link>
                      </>
                    ) : null}
                  </p>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </PageShell>
  );
}
