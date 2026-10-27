import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import '../i18n';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { PageHeader, PageShell } from '../components/page-shell';
import { apiJson } from '#lib/api';
import { systemCapabilities, usePermissions } from '#lib/permissions';
import { globalSearchTarget, type GlobalSearchDoc } from '#lib/search-target';

/** Khoá nhãn loại kết quả theo `area` của API tìm kiếm; area lạ chưa có nhãn thì hiển thị nguyên mã area. */
const AREA_LABEL_KEYS: Record<string, string> = {
  courses: 'searchAreaCourses',
  users: 'searchAreaUsers',
  contentbank: 'searchAreaContentBank',
};

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
 *
 * Mỗi kết quả ĐIỀU HƯỚNG ĐƯỢC vào đúng item (chốt gộp tìm kiếm ngày
 * 27/10/2026 — trước đó danh sách chỉ là chữ tĩnh không bấm được):
 * đích lấy từ ánh xạ dùng chung lib/search-target (khoá học →
 * trang khoá, người dùng → màn quản trị người dùng, học liệu →
 * màn của học liệu đó), cùng ánh xạ với nhóm "Nội dung" của bề mặt
 * Ctrl/Cmd+K. Kết quả thuộc area chưa có route đích thì giữ dạng
 * khối thông tin không liên kết, không bịa đường dẫn. Riêng kết
 * quả người dùng: đích màn quản trị CHỈ gắn khi ảnh chụp quyền của
 * người đang tìm có quyền quản trị người dùng (site admin hoặc
 * `user:update` tại context hệ thống) — mọi vai trò đều nhận kết
 * quả `users` từ API nhưng vai trò không có quyền đó bấm vào màn
 * quản trị chỉ là ngõ cụt, nên giữ dạng khối thông tin như area
 * chưa có đích.
 */
export function SearchPage() {
  const { t: t } = useTranslation();
  const perms = usePermissions();
  // Quyền quản trị người dùng của chính người đang tìm, suy từ ảnh
  // chụp quyền: điều kiện duy nhất để kết quả `users` gắn đích màn
  // quản trị (màn đích tự gác `user:update`). Ảnh chụp chưa tải
  // được thì coi như không có quyền — kết quả giữ dạng thông tin,
  // đúng chiều an toàn của ánh xạ.
  const canManageUsers =
    (perms.access?.isSiteAdmin ?? false) ||
    (perms.access ? systemCapabilities(perms.access).includes('user:update') : false);
  const [searchParams] = useSearchParams();
  const urlQ = searchParams.get('q');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GlobalSearchDoc[]>([]);
  const [searched, setSearched] = useState(false);

  /** Chạy một lượt tìm bằng đúng từ khoá đưa vào và ghi kết quả + cờ đã tìm. */
  const runSearch = useCallback(async (keyword: string) => {
    const docs = await apiJson<GlobalSearchDoc[]>(`/api/v1/search?q=${encodeURIComponent(keyword)}`);
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
            {results.map((d) => {
              const target = globalSearchTarget(d, { canManageUsers });
              const body = (
                <>
                  <p className="font-medium">{d.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {AREA_LABEL_KEYS[d.area] ? t(AREA_LABEL_KEYS[d.area]) : d.area}
                  </p>
                  <p className="text-sm">{d.content}</p>
                </>
              );
              return (
                <li key={d.id}>
                  {target ? (
                    <Link to={target} className="block rounded border p-2 hover:bg-accent" data-testid={`search-result-${d.id}`}>
                      {body}
                    </Link>
                  ) : (
                    <div className="rounded border p-2">{body}</div>
                  )}
                </li>
              );
            })}
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
