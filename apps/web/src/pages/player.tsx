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
        resource: { id: string; name: string; kind: string; url: string | null };
        file: { id: string; fileName: string; mimeType: string | null; fileSize: number; signedUrl: string } | null;
        embedUrl: string | null;
      }
    | { type: 'other'; component: string };
  completion: { state: number; viewed: boolean; mode: 'view' | 'manual' | 'none' };
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

/**
 * Trang học (player) của K2: nội dung của một mục khoá học kèm outline
 * kề bên (dấu ✓ theo completion của chính học sinh), nút Trước/Tiếp, tự
 * ghi nhận đã xem qua endpoint /view sẵn có cho mục hoàn thành theo
 * lượt xem, và nút "Đánh dấu đã học" cho mục hoàn thành thủ công (nội
 * dung không tự đo được như liên kết ngoài).
 */
export function PlayerPage() {
  const { t } = useTranslation('app');
  const { id, cmId } = useParams();
  const [data, setData] = useState<PlayerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const viewedPostedFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!id || !cmId) return;
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
      try {
        await apiJson(`/api/v1/courses/${id}/modules/${cmId}/view`, { method: 'POST' });
        const refreshed = await probe<PlayerView>(`/api/v1/courses/${id}/player/${cmId}`);
        if (refreshed) setData(refreshed);
      } catch {
        // Ghi nhận xem thất bại không chặn việc học; tiến độ cập nhật ở lần tải sau.
      }
    }
  }, [id, cmId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Tệp xem trực tuyến: tải nội dung qua endpoint có kiểm quyền rồi phát
  // bằng blob URL (PDF/ảnh/video); dọn URL khi đổi mục.
  const fileId = data?.content.type === 'resource' ? data.content.file?.id : undefined;
  const fileMime = data?.content.type === 'resource' ? data.content.file?.mimeType : undefined;
  useEffect(() => {
    if (!fileId || !isInlineMime(fileMime ?? null)) {
      setFileUrl(null);
      return;
    }
    let alive = true;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const res = await apiFetch(`/api/v1/files/${fileId}/content`);
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
  }, [fileId, fileMime]);

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
                {fileUrl && content.file.mimeType === 'application/pdf' ? (
                  <iframe title={content.file.fileName} src={fileUrl} className="h-[70vh] w-full rounded border" />
                ) : fileUrl && content.file.mimeType?.startsWith('image/') ? (
                  <img src={fileUrl} alt={content.file.fileName} className="max-w-full rounded border" />
                ) : fileUrl && content.file.mimeType?.startsWith('video/') ? (
                  <video src={fileUrl} controls className="w-full rounded border" />
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {content.file.fileName} ({Math.ceil(content.file.fileSize / 1024)} KB)
                </p>
                <a href={content.file.signedUrl} className="underline">
                  {t('playerDownload')}
                </a>
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
