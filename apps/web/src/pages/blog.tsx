import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/ui/card';
import { Input } from '@lms/ui/components/ui/input';
import { Label } from '@lms/ui/components/ui/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';

interface PostView { id: string; userid: string; subject: string; content: string; publishstate: string; contextid: string }
interface CommentView { id: string; userid: string; content: string }
interface TagView { id: string; name: string; ordering: number }
interface AggregateView { count: number; average: number }

/**
 * Blog with the polymorphic social layer integrated: every post can
 * be tagged, commented on and rated through the SAME tag/comment/rating
 * APIs used for courses — the item is addressed by
 * (component, itemtype, itemid, contextid), never by a blog-specific API.
 */
export function BlogPage() {
  const { t } = useTranslation('app');
  const [posts, setPosts] = useState<PostView[]>([]);
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [comments, setComments] = useState<Record<string, CommentView[]>>({});
  const [tags, setTags] = useState<Record<string, TagView[]>>({});
  const [aggregates, setAggregates] = useState<Record<string, AggregateView>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const loadExtras = useCallback(async (post: PostView) => {
    const [cs, ts, agg] = await Promise.all([
      apiJson<{ comments: CommentView[] }>(`/api/v1/comments?contextid=${post.contextid}&component=core_blog&commentarea=post&itemid=${post.id}`).catch(() => ({ comments: [] })),
      apiJson<TagView[]>(`/api/v1/tags/items?component=core_blog&itemtype=post&itemid=${post.id}`).catch(() => []),
      apiJson<AggregateView>(`/api/v1/ratings/aggregate?contextid=${post.contextid}&component=core_blog&ratingarea=post&itemid=${post.id}&scaleid=-5`).catch(() => ({ count: 0, average: 0 })),
    ]);
    setComments((prev) => ({ ...prev, [post.id]: cs.comments }));
    setTags((prev) => ({ ...prev, [post.id]: ts }));
    setAggregates((prev) => ({ ...prev, [post.id]: agg }));
  }, []);

  const reload = useCallback(async () => {
    const list = await apiJson<PostView[]>('/api/v1/blog/posts');
    setPosts(list);
    for (const post of list) await loadExtras(post);
  }, [loadExtras]);

  useEffect(() => { void reload().catch(() => setError(t('blogLoadFailed'))); }, [reload]);

  async function createPost(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/blog/posts', {
      method: 'POST', body: JSON.stringify({ subject, content, publishstate: 'site' }),
    });
    setSubject(''); setContent('');
    await reload();
  }

  async function addComment(post: PostView) {
    const text = commentDrafts[post.id];
    if (!text) return;
    await apiJson('/api/v1/comments', {
      method: 'POST',
      body: JSON.stringify({ contextid: post.contextid, component: 'core_blog', commentarea: 'post', itemid: post.id, content: text }),
    });
    setCommentDrafts((prev) => ({ ...prev, [post.id]: '' }));
    await loadExtras(post);
  }

  async function setPostTags(post: PostView) {
    const names = (tagDrafts[post.id] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    await apiJson('/api/v1/tags/items', {
      method: 'POST',
      body: JSON.stringify({ component: 'core_blog', itemtype: 'post', itemid: post.id, contextid: post.contextid, tags: names }),
    });
    await loadExtras(post);
  }

  async function rate(post: PostView, value: number) {
    await apiJson('/api/v1/ratings', {
      method: 'POST',
      body: JSON.stringify({ contextid: post.contextid, component: 'core_blog', ratingarea: 'post', itemid: post.id, scaleid: -5, rating: value }),
    });
    await loadExtras(post);
  }

  return (
    <main className="@container/main flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      {error ? <p role="alert">{error}</p> : null}
      <Card>
        <CardHeader><CardTitle>{t('writePost')}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={(e) => void createPost(e)} className="space-y-2">
            <Label htmlFor="post-subject">{t('subject')}</Label>
            <Input id="post-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <Label htmlFor="post-content">{t('content')}</Label>
            <Input id="post-content" value={content} onChange={(e) => setContent(e.target.value)} />
            <Button type="submit">{t('publish')}</Button>
          </form>
        </CardContent>
      </Card>
      {posts.map((post) => (
        <Card key={post.id}>
          <CardHeader><CardTitle>{post.subject}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p>{post.content}</p>
            <p className="text-sm text-muted-foreground">
              {t('ratingPrefix')} {aggregates[post.id]?.count ? t('ratingLine', { average: aggregates[post.id]!.average, count: aggregates[post.id]!.count }) : t('notRatedYet')}
              {[1, 2, 3, 4, 5].map((v) => (
                <Button key={v} type="button" variant="outline" aria-label={t('rateAria', { subject: post.subject, value: v })} onClick={() => void rate(post, v)}>{v}</Button>
              ))}
            </p>
            <p className="text-sm">
              {t('tagsPrefix')} {(tags[post.id] ?? []).map((tag) => tag.name).join(', ') || t('tagsNone')}
            </p>
            <div className="flex gap-2">
              <Input aria-label={t('tagsForAria', { subject: post.subject })} value={tagDrafts[post.id] ?? ''} onChange={(e) => setTagDrafts((prev) => ({ ...prev, [post.id]: e.target.value }))} />
              <Button type="button" variant="outline" onClick={() => void setPostTags(post)}>{t('setTags')}</Button>
            </div>
            <ul className="space-y-1" aria-label={t('commentsOnAria', { subject: post.subject })}>
              {(comments[post.id] ?? []).map((c) => <li key={c.id} className="text-sm">{c.content} <span className="text-muted-foreground">{t('commentByUser', { userId: c.userid })}</span></li>)}
            </ul>
            <div className="flex gap-2">
              <Input aria-label={t('commentOnAria', { subject: post.subject })} value={commentDrafts[post.id] ?? ''} onChange={(e) => setCommentDrafts((prev) => ({ ...prev, [post.id]: e.target.value }))} />
              <Button type="button" variant="outline" onClick={() => void addComment(post)}>{t('comment')}</Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default BlogPage;
