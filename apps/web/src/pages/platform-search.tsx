import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import '../i18n';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { PageHeader, PageShell } from '../components/page-shell';
import { apiJson } from '#lib/api';

interface SearchDoc {
  id: string;
  area: string;
  itemId: string;
  title: string;
  content: string;
}

/**
 * Tìm kiếm toàn cục (platform services): kết quả đã được server lọc theo quyền của người
 * tìm tại thời điểm truy vấn — client không tự lọc thêm.
 *
 * Nguồn từ khoá có hai đường, hợp nhất ở `runSearch`:
 * 1. Tham số `q` trên URL — đường chính từ ô tìm kiếm giữa header
 *    (chốt 23:52 ngày 26/10/2026, issue #303): vào trang có `q` (kể
 *    cả khi `q` đổi trong lúc đang ở trang) thì ô của trang điền
 *    đúng `q` đó và chạy tìm NGAY, không chờ người dùng bấm nút.
 *    `q` rỗng/trắng thì dọn về trạng thái chưa tìm thay vì gọi API
 *    bằng từ khoá trống.
 * 2. Form ngay trong trang — giữ nguyên hành vi cũ: gõ tiếp rồi bấm
 *    "Tìm kiếm" là chạy lại bằng chữ đang có trong ô, không đổi URL.
 */
export function SearchPage() {
  const { t: t } = useTranslation();
  const [searchParams] = useSearchParams();
  const urlQ = searchParams.get('q');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchDoc[]>([]);
  const [searched, setSearched] = useState(false);

  /** Chạy một lượt tìm bằng đúng từ khoá đưa vào và ghi kết quả + cờ đã tìm. */
  const runSearch = useCallback(async (keyword: string) => {
    const docs = await apiJson<SearchDoc[]>(`/api/v1/search?q=${encodeURIComponent(keyword)}`);
    setResults(docs);
    setSearched(true);
  }, []);

  // Đồng bộ theo q trên URL: chạy mỗi lần q xuất hiện/đổi (lần vào
  // trang đầu tiên cũng là một lần q "xuất hiện"). Không có tham số
  // q (vào /search trần) thì giữ nguyên trạng thái khởi tạo.
  useEffect(() => {
    if (urlQ === null) return;
    setQ(urlQ);
    if (urlQ.trim()) {
      void runSearch(urlQ);
    } else {
      setResults([]);
      setSearched(false);
    }
  }, [urlQ, runSearch]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await runSearch(q);
  }
  return (
    <PageShell width="narrow">
      <PageHeader title={t('searchTitle')} />
      <Card>
        <CardContent className="space-y-3">
          <form onSubmit={(e) => void submit(e)} className="flex gap-2">
            <Label htmlFor="search-q" className="sr-only">
              {t('searchQuery')}
            </Label>
            <Input
              id="search-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('searchPlaceholder')}
            />
            <Button type="submit">{t('searchButton')}</Button>
          </form>
          <ul aria-label={t('searchResults')} className="space-y-2">
            {results.map((d) => (
              <li key={d.id} className="rounded border p-2">
                <p className="font-medium">{d.title}</p>
                <p className="text-xs text-muted-foreground">
                  {d.area} · item {d.itemId}
                </p>
                <p className="text-sm">{d.content}</p>
              </li>
            ))}
          </ul>
          {searched && results.length === 0 ? (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>{t('noResults')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null}
        </CardContent>
      </Card>
    </PageShell>
  );
}
