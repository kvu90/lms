import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiJson } from '@/lib/api';

interface PostView { id: number; userid: number; subject: string; content: string; publishstate: string; contextid: number }
interface CommentView { id: number; userid: number; content: string }
interface TagView { id: number; name: string; ordering: number }
interface AggregateView { count: number; average: number }

/**
 * Blog (P4) with the polymorphic social layer integrated: every post can
 * be tagged, commented on and rated through the SAME tag/comment/rating
 * APIs used for courses — the item is addressed by
 * (component, itemtype, itemid, contextid), never by a blog-specific API.
 */
export function BlogPage() {
  const [posts, setPosts] = useState<PostView[]>([]);
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [comments, setComments] = useState<Record<number, CommentView[]>>({});
  const [tags, setTags] = useState<Record<number, TagView[]>>({});
  const [aggregates, setAggregates] = useState<Record<number, AggregateView>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<number, string>>({});
  const [tagDrafts, setTagDrafts] = useState<Record<number, string>>({});
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

  useEffect(() => { void reload().catch(() => setError('Could not load the blog')); }, [reload]);

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
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      {error ? <p role="alert">{error}</p> : null}
      <Card>
        <CardHeader><CardTitle>Write a post</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={(e) => void createPost(e)} className="space-y-2">
            <Label htmlFor="post-subject">Subject</Label>
            <Input id="post-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <Label htmlFor="post-content">Content</Label>
            <Input id="post-content" value={content} onChange={(e) => setContent(e.target.value)} />
            <Button type="submit">Publish</Button>
          </form>
        </CardContent>
      </Card>
      {posts.map((post) => (
        <Card key={post.id}>
          <CardHeader><CardTitle>{post.subject}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p>{post.content}</p>
            <p className="text-sm text-muted-foreground">
              Rating: {aggregates[post.id]?.count ? `${aggregates[post.id]!.average} average from ${aggregates[post.id]!.count} rating(s)` : 'not rated yet'}
              {[1, 2, 3, 4, 5].map((v) => (
                <Button key={v} type="button" variant="outline" aria-label={`Rate ${post.subject} ${v}`} onClick={() => void rate(post, v)}>{v}</Button>
              ))}
            </p>
            <p className="text-sm">
              Tags: {(tags[post.id] ?? []).map((t) => t.name).join(', ') || 'none'}
            </p>
            <div className="flex gap-2">
              <Input aria-label={`Tags for ${post.subject}`} value={tagDrafts[post.id] ?? ''} onChange={(e) => setTagDrafts((prev) => ({ ...prev, [post.id]: e.target.value }))} />
              <Button type="button" variant="outline" onClick={() => void setPostTags(post)}>Set tags</Button>
            </div>
            <ul className="space-y-1" aria-label={`Comments on ${post.subject}`}>
              {(comments[post.id] ?? []).map((c) => <li key={c.id} className="text-sm">{c.content} <span className="text-muted-foreground">(user {c.userid})</span></li>)}
            </ul>
            <div className="flex gap-2">
              <Input aria-label={`Comment on ${post.subject}`} value={commentDrafts[post.id] ?? ''} onChange={(e) => setCommentDrafts((prev) => ({ ...prev, [post.id]: e.target.value }))} />
              <Button type="button" variant="outline" onClick={() => void addComment(post)}>Comment</Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </main>
  );
}
