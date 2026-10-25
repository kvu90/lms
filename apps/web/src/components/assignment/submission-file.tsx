import { useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import type { AssignAnnotationView, AssignSubmissionFileView } from '@lms/contracts';
import { useTranslation } from 'react-i18next';

export const ANNOTATION_KINDS = ['correct', 'incorrect', 'note', 'highlight', 'frame', 'draw'] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(file: AssignSubmissionFileView): boolean {
  return (file.mimeType ?? '').startsWith('image/');
}

const KIND_MARK: Record<string, { symbol: string; className: string }> = {
  correct: { symbol: '✓', className: 'bg-green-600 text-white' },
  incorrect: { symbol: '✗', className: 'bg-red-600 text-white' },
  note: { symbol: '✎', className: 'bg-amber-500 text-white' },
  highlight: { symbol: '', className: 'bg-yellow-300/50 border border-yellow-500' },
  frame: { symbol: '', className: 'border-2 border-sky-600 bg-sky-400/10' },
  draw: { symbol: '', className: '' },
};

/**
 * Một tệp của bài nộp: ảnh hiển thị trực tiếp kèm lớp dấu chấm vector
 * đè lên (toạ độ % neo theo khổ ảnh — ảnh gốc không bị đốt dấu); tệp
 * khác hiện dạng liên kết mở URL đã ký. Ở bề mặt chấm, bấm vào ảnh để
 * thả dấu (hoặc kéo để vẽ khi đang chọn nét vẽ).
 */
export function SubmissionFileView({
  file,
  annotations,
  onPlace,
}: {
  file: AssignSubmissionFileView;
  annotations: AssignAnnotationView[];
  onPlace?: (fileId: string, point: { x: number; y: number }, points?: { x: number; y: number }[]) => void;
}) {
  const { t } = useTranslation('app');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef<{ x: number; y: number }[] | null>(null);
  const [preview, setPreview] = useState<{ x: number; y: number }[]>([]);
  const own = annotations.filter((a) => a.fileId === file.fileId);

  function pointOf(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100)),
    };
  }

  function handleClick(event: MouseEvent) {
    if (!onPlace || drawingRef.current) return;
    const p = pointOf(event);
    if (p) onPlace(file.fileId, p);
  }
  function handlePointerDown(event: PointerEvent) {
    if (!onPlace) return;
    const p = pointOf(event);
    if (p) {
      drawingRef.current = [p];
      setPreview([p]);
    }
  }
  function handlePointerMove(event: PointerEvent) {
    if (!drawingRef.current) return;
    const p = pointOf(event);
    if (!p) return;
    const last = drawingRef.current[drawingRef.current.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
    drawingRef.current = [...drawingRef.current, p];
    setPreview(drawingRef.current);
  }
  function handlePointerUp() {
    const pts = drawingRef.current;
    drawingRef.current = null;
    setPreview([]);
    if (!onPlace || !pts || pts.length === 0) return;
    // Kéo thật sự (≥2 điểm cách nhau) = nét vẽ; còn lại là một cú bấm thả dấu.
    if (pts.length >= 2) onPlace(file.fileId, pts[0]!, pts);
  }

  if (!isImage(file)) {
    return (
      <li className="rounded border p-3" data-testid={`assign-file-${file.fileId}`}>
        <a href={file.signedUrl} target="_blank" rel="noreferrer" className="font-medium underline">
          {file.fileName}
        </a>{' '}
        <span className="text-sm text-muted-foreground">({fileSizeLabel(file.fileSize)})</span>
        {own.length > 0 ? (
          <ul className="mt-1 list-disc pl-5 text-sm">
            {own.map((a) => (
              <li key={a.id}>
                {t(`assignKind_${a.kind}`)}
                {a.text ? `: ${a.text}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </li>
    );
  }
  return (
    <li className="space-y-1" data-testid={`assign-file-${file.fileId}`}>
      <div
        ref={wrapRef}
        className="relative inline-block max-w-full"
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <img src={file.signedUrl} alt={file.fileName} className="max-h-[70vh] w-auto max-w-full rounded border" draggable={false} />
        {own.map((a) => {
          if (a.kind === 'draw' && a.points && a.points.length > 1) {
            return (
              <svg
                key={a.id}
                className="pointer-events-none absolute inset-0 h-full w-full"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-label={t('assignKind_draw')}
              >
                <polyline
                  points={a.points.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke={a.color ?? '#dc2626'}
                  strokeWidth={0.8}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            );
          }
          const mark = KIND_MARK[a.kind] ?? KIND_MARK.note!;
          const sized = a.kind === 'highlight' || a.kind === 'frame';
          return (
            <span
              key={a.id}
              title={a.text ?? t(`assignKind_${a.kind}`)}
              className={`absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-xs font-bold ${mark.className} ${sized ? 'h-[10%] w-[16%] rounded-sm' : 'h-6 w-6'}`}
              style={{ left: `${a.x}%`, top: `${a.y}%` }}
            >
              {mark.symbol}
            </span>
          );
        })}
        {preview.length > 1 ? (
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polyline points={preview.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#dc2626" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
          </svg>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {file.fileName} ({fileSizeLabel(file.fileSize)})
      </p>
    </li>
  );
}
