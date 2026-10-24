import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiFetch, apiJson } from '#lib/api';

/** Một mục trong outline của player (từ progress/me). */
interface PlayerOutlineItem {
  cmId: string;
  name: string;
  component: string;
  completion: number;
  state: number;
  viewed: boolean;
  done: boolean;
}

/** Dữ liệu player từ GET /courses/:id/player/:cmId. */
interface PlayerView {
  course: { id: string; fullName: string; shortName: string };
  cm: { id: string; name: string; component: string; instanceId: string | null };
  content:
    | { type: 'page'; page: { id: string; name: string; content: string } }
    | {
        type: 'resource';
        resource: { id: string; name: string; kind: string; url: string | null; transcript: string | null };
        file: { id: string; fileName: string; mimeType: string | null; fileSize: number; signedUrl: string } | null;
        embedUrl: string | null;
      }
    | { type: 'other'; component: string };
  completion: { state: number; viewed: boolean; mode: 'view' | 'manual' | 'progress' | 'none' };
  itemProgress: { percent: number; positionSeconds: number | null; page: number | null } | null;
  progress: {
    percent: number | null;
    completed: number;
    total: number;
    sections: { sectionId: string; name: string | null; section: number; percent: number | null; items: PlayerOutlineItem[] }[];
  };
  prevCmId: string | null;
  nextCmId: string | null;
}

/** Tải một endpoint phụ độc lập: lỗi thì trả null. */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

function isInlineMime(mime: string | null): boolean {
  return mime === 'application/pdf' || (mime?.startsWith('image/') ?? false) || (mime?.startsWith('video/') ?? false);
}

function isHls(fileName: string, mime: string | null): boolean {
  return fileName.toLowerCase().endsWith('.m3u8') || mime === 'application/vnd.apple.mpegurl' || mime === 'application/x-mpegurl';
}

/**
 * Hàng đợi gửi bù sự kiện học (K2-B2): view/progress là hồ sơ quá
 * trình học — khi mạng rớt, sự kiện được giữ trong localStorage và
 * gửi lại khi có mạng hoặc lần mở player sau, học sinh mạng yếu
 * không bị mất tiến độ đã học thật.
 */
const QUEUE_KEY = 'lms-learn-event-queue';
interface QueuedEvent { path: string; body: string }

function enqueueEvent(event: QueuedEvent): void {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const queue: QueuedEvent[] = raw ? (JSON.parse(raw) as QueuedEvent[]) : [];
    queue.push(event);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-100)));
  } catch {
    // localStorage không dùng được (chế độ riêng tư…) — bỏ qua lặng lẽ.
  }
}

async function flushEventQueue(): Promise<void> {
  let queue: QueuedEvent[] = [];
  try {
    queue = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as QueuedEvent[];
  } catch {
    return;
  }
  if (!queue.length) return;
  const remaining: QueuedEvent[] = [];
  for (const event of queue) {
    try {
      await apiJson(event.path, { method: 'POST', body: event.body });
    } catch {
      remaining.push(event);
    }
  }
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  } catch {
    // Bỏ qua như trên.
  }
}

/** Gửi một sự kiện học; thất bại (rớt mạng) thì vào hàng đợi gửi bù. */
async function postLearningEvent(path: string, body: unknown): Promise<boolean> {
  try {
    await apiJson(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
    return true;
  } catch {
    enqueueEvent({ path, body: JSON.stringify(body ?? {}) });
    return false;
  }
}

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

/**
 * Trang học (player) của K2: nội dung của một mục khoá học kèm outline
 * kề bên (dấu ✓ theo completion của chính học sinh), nút Trước/Tiếp, tự
 * ghi nhận đã xem qua endpoint /view sẵn có, báo tiến độ xem cho video
 * (lưu bền + gửi bù khi rớt mạng, phát tiếp đúng vị trí dở, đổi tốc độ
 * phát), và nút "Đánh dấu đã học" cho mục hoàn thành thủ công.
 */
export function PlayerPage() {
  const { t } = useTranslation('app');
  const { id, cmId } = useParams();
  const [data, setData] = useState<PlayerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const viewedPostedFor = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastProgressSentAt = useRef(0);

  const load = useCallback(async () => {
    if (!id || !cmId) return;
    await flushEventQueue();
    const view = await probe<PlayerView>(`/api/v1/courses/${id}/player/${cmId}`);
    if (!view) {
      setError(t('playerLoadFailed'));
      return;
    }
    setError(null);
    setData(view);
    // Tự ghi nhận đã xem qua endpoint /view sẵn có — một lần cho mỗi mục.
    if (view.completion.mode === 'view' && !view.completion.viewed && viewedPostedFor.current !== cmId) {
      viewedPostedFor.current = cmId;
      const sent = await postLearningEvent(`/api/v1/courses/${id}/modules/${cmId}/view`, {});
      if (sent) {
        const refreshed = await probe<PlayerView>(`/api/v1/courses/${id}/player/${cmId}`);
        if (refreshed) setData(refreshed);
      }
    }
  }, [id, cmId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Có mạng trở lại thì gửi bù hàng đợi sự kiện học.
  useEffect(() => {
    const onOnline = () => void flushEventQueue();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // Tệp xem trực tuyến: tải nội dung qua endpoint có kiểm quyền rồi phát
  // bằng blob URL (PDF/ảnh/video thường); HLS (.m3u8) phát thẳng bằng
  // URL đã ký để trình duyệt tự chọn mốc bitrate theo mạng. Dọn URL khi
  // đổi mục.
  const file = data?.content.type === 'resource' ? data.content.file : undefined;
  const hls = file ? isHls(file.fileName, file.mimeType) : false;
  useEffect(() => {
    if (!file || hls || !isInlineMime(file.mimeType)) {
      setFileUrl(null);
      return;
    }
    let alive = true;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const res = await apiFetch(`/api/v1/files/${file.id}/content`);
        if (!res.ok) return;
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (alive) setFileUrl(objectUrl);
      } catch {
        if (alive) setFileUrl(null);
      }
    })();
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, hls]);

  /** Báo tiến độ xem video: % đã xem + vị trí hiện tại (gửi bù khi rớt mạng). */
  const reportVideoProgress = useCallback(
    (force = false) => {
      const video = videoRef.current;
      if (!video || !id || !cmId || !video.duration) return;
      const now = Date.now();
      if (!force && now - lastProgressSentAt.current < 5000) return;
      lastProgressSentAt.current = now;
      void postLearningEvent(`/api/v1/courses/${id}/modules/${cmId}/progress`, {
        percent: Math.min(100, Math.round((video.currentTime / video.duration) * 100)),
        positionSeconds: Math.floor(video.currentTime),
      });
    },
    [id, cmId],
  );

  // Phát tiếp đúng vị trí dở + áp tốc độ phát đã chọn khi video sẵn sàng.
  const resumeAt = data?.itemProgress?.positionSeconds ?? null;
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    if (resumeAt && video.currentTime < 1 && Math.abs(video.currentTime - resumeAt) > 2) {
      video.currentTime = resumeAt;
    }
  }, [data, rate, resumeAt]);

  /** "Đánh dấu đã học" cho mục hoàn thành thủ công: gọi endpoint manual sẵn có với chính mình. */
  async function markLearned() {
    if (!id || !cmId) return;
    setBusy(true);
    try {
      const mine = await probe<{ course: { userId: string } }>(`/api/v1/courses/${id}/completion/me`);
      const userId = mine?.course.userId;
      if (!userId) throw new Error('no user');
      await apiJson(`/api/v1/courses/${id}/modules/${cmId}/completion/manual`, {
        method: 'POST',
        body: JSON.stringify({ userId, complete: true }),
      });
      viewedPostedFor.current = null;
      await load();
    } catch {
      setError(t('completionMarkFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 lg:px-6">
        <p role="alert">{error}</p>
        <Link to={`/courses/${id}`}>{t('playerBackToCourse')}</Link>
      </main>
    );
  }
  if (!data) {
    return <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 lg:px-6">{t('courseLoading')}</main>;
  }

  const { content } = data;
  const videoSrc = content.type === 'resource' && content.file
    ? (hls ? content.file.signedUrl : fileUrl)
    : null;
  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to={`/courses/${id}`} className="text-sm underline">
          {t('playerBackToCourse')}: {data.course.fullName}
        </Link>
        {data.progress.percent !== null ? (
          <span className="text-sm font-medium">{t('courseProgressLabel', { percent: data.progress.percent })}</span>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <CardTitle>
              {data.completion.state !== 0 ? '✓ ' : ''}
              {data.cm.name}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {content.type === 'page' ? (
              <div dangerouslySetInnerHTML={{ __html: content.page.content }} />
            ) : null}
            {content.type === 'resource' && content.file ? (
              <div className="space-y-3">
                {content.file.mimeType === 'application/pdf' && fileUrl ? (
                  <iframe title={content.file.fileName} src={fileUrl} className="h-[70vh] w-full rounded border" />
                ) : content.file.mimeType?.startsWith('image/') && fileUrl ? (
                  <img src={fileUrl} alt={content.file.fileName} className="max-w-full rounded border" />
                ) : content.file.mimeType?.startsWith('video/') || hls ? (
                  <div className="space-y-2">
                    {videoSrc ? (
                      <video
                        ref={videoRef}
                        src={videoSrc}
                        controls
                        className="w-full rounded border"
                        onTimeUpdate={() => reportVideoProgress()}
                        onPause={() => reportVideoProgress(true)}
                        onEnded={() => reportVideoProgress(true)}
                      />
                    ) : null}
                    <label className="flex items-center gap-2 text-sm">
                      {t('playerSpeed')}
                      <select
                        className="rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                        value={rate}
                        onChange={(e) => setRate(Number(e.target.value))}
                      >
                        {PLAYBACK_RATES.map((r) => (
                          <option key={r} value={r}>{r}x</option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {content.file.fileName} ({Math.ceil(content.file.fileSize / 1024)} KB)
                </p>
                <a href={content.file.signedUrl} className="underline">
                  {t('playerDownload')}
                </a>
                {content.resource.transcript ? (
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">{t('playerTranscript')}</summary>
                    <div className="mt-2 whitespace-pre-wrap text-sm">{content.resource.transcript}</div>
                  </details>
                ) : null}
              </div>
            ) : null}
            {content.type === 'resource' && !content.file ? (
              <div className="space-y-3">
                {content.embedUrl ? (
                  <iframe
                    title={content.resource.name}
                    src={content.embedUrl}
                    className="aspect-video w-full rounded border"
                    allow="accelerometer; encrypted-media; picture-in-picture"
                    allowFullScreen
                  />
                ) : null}
                {content.resource.url ? (
                  <a href={content.resource.url} target="_blank" rel="noreferrer" className="underline">
                    {t('playerOpenLink')}
                  </a>
                ) : null}
                {content.resource.transcript ? (
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">{t('playerTranscript')}</summary>
                    <div className="mt-2 whitespace-pre-wrap text-sm">{content.resource.transcript}</div>
                  </details>
                ) : null}
              </div>
            ) : null}
            {content.type === 'other' ? <p>{t('playerUnsupported')}</p> : null}
            {data.completion.mode === 'manual' && data.completion.state === 0 ? (
              <Button type="button" disabled={busy} onClick={() => void markLearned()}>
                {t('playerMarkLearned')}
              </Button>
            ) : null}
            {data.completion.mode === 'manual' && data.completion.state !== 0 ? <p>{t('completionCompleted')}</p> : null}
            <div className="flex items-center justify-between border-t pt-3">
              {data.prevCmId ? (
                <Link to={`/courses/${id}/learn/${data.prevCmId}`}>
                  <Button type="button" variant="outline">{t('playerPrev')}</Button>
                </Link>
              ) : (
                <span />
              )}
              {data.nextCmId ? (
                <Link to={`/courses/${id}/learn/${data.nextCmId}`}>
                  <Button type="button">{t('playerNext')}</Button>
                </Link>
              ) : null}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('playerOutline')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.progress.sections.map((section) => (
              <div key={section.sectionId}>
                <p className="text-sm font-medium">
                  {section.name ?? t('sectionDefaultName', { number: section.section })}
                  {section.percent !== null ? (
                    <span className="ml-2 font-normal text-muted-foreground">
                      {t('courseProgressLabel', { percent: section.percent })}
                    </span>
                  ) : null}
                </p>
                <ul className="mt-1 space-y-1">
                  {section.items.map((item) => (
                    <li key={item.cmId} className={item.cmId === cmId ? 'font-semibold' : undefined}>
                      {item.done ? '✓ ' : ''}
                      <Link to={`/courses/${id}/learn/${item.cmId}`}>{item.name}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

/** Route module là chính trang này (src/routes.ts trỏ thẳng vào file): cần default export để framework mode coi đây là route có component — thiếu nó, request tài liệu phía server bị xếp vào resource route và trả 400 (GĐ4 của issue #7 phát hiện khi rà SSR toàn bộ route). */
export default PlayerPage;
