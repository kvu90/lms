import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { Course, CourseCategory, CourseCategoryTreeNode } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';
import { usePermissions } from '#lib/permissions';

/**
 * Cây danh mục + danh sách khoá học cho mọi người dùng. Khu quản trị danh
 * mục (tạo/đổi tên/xoá danh mục) và form tạo khoá học chỉ render khi
 * `usePermissions().canAdminister` — quyền quản trị cấp hệ thống; API vẫn
 * thực thi capability thật phía server cho từng thao tác ghi. Xoá danh mục
 * luôn hỏi xác nhận, và lỗi phía server (ví dụ danh mục còn khoá học hoặc
 * danh mục con) được hiển thị bằng thông điệp thân thiện.
 */
export function CoursesPage() {
  const { t } = useTranslation('app');
  const { canAdminister } = usePermissions();
  const [tree, setTree] = useState<CourseCategoryTreeNode[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  // Tiến độ học của chính người dùng theo khoá (K2): chỉ khoá truy cập
  // được mới có số (endpoint progress/me qua cổng khoá học); khoá không
  // vào được thì probe lỗi và không hiện gì.
  const [progressByCourse, setProgressByCourse] = useState<Record<string, number | null>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [catName, setCatName] = useState('');
  const [catParent, setCatParent] = useState('0');
  const [catEdits, setCatEdits] = useState<Record<string, string>>({});
  const reload = useCallback(async () => {
    const [t, c] = await Promise.all([
      apiJson<CourseCategoryTreeNode[]>('/api/v1/courses/categories/tree'),
      apiJson<Course[]>('/api/v1/courses'),
    ]);
    setTree(t);
    setCourses(c);
  }, []);

  useEffect(() => {
    void reload().catch(() => setMessage(t('coursesLoadFailed')));
  }, [reload]);

  // Nạp % tiến độ của từng khoá sau khi có danh sách: probe độc lập
  // từng khoá, lỗi (chưa ghi danh/không quyền) thì bỏ qua lặng lẽ.
  useEffect(() => {
    if (courses.length === 0) return;
    let alive = true;
    void (async () => {
      const entries = await Promise.all(
        courses.map(async (c) => {
          try {
            const p = await apiJson<{ percent: number | null }>(`/api/v1/courses/${c.id}/progress/me`);
            return [c.id, p.percent] as const;
          } catch {
            return [c.id, null] as const;
          }
        }),
      );
      if (alive) setProgressByCourse(Object.fromEntries(entries));
    })();
    return () => {
      alive = false;
    };
  }, [courses]);

  const flatCategories: CourseCategory[] = [];
  const walk = (nodes: CourseCategoryTreeNode[]) => {
    for (const n of nodes) {
      flatCategories.push(n);
      walk(n.children);
    }
  };
  walk(tree);

  /**
   * Vẽ cây danh mục: mọi cấp con — cả danh mục con lẫn khoá học trong
   * danh mục — thụt vào cùng một mức `ml-4` để các mục con thẳng hàng
   * theo cấp, thay vì mỗi loại danh sách một mức thụt khác nhau.
   */
  function renderTree(nodes: CourseCategoryTreeNode[], nested = false) {
    return (
      <ul className={nested ? 'ml-4 list-disc' : 'list-disc'}>
        {nodes.map((node) => {
          const nodeCourses = courses.filter((c) => c.category === node.id);
          return (
            <li key={node.id}>
              <span>{node.name}</span>
              {nodeCourses.length > 0 ? (
                <ul className="ml-4 list-disc">
                  {nodeCourses.map((c) => (
                    <li key={c.id}>
                      <Link to={`/courses/${c.id}`}>
                        {c.fullName} ({c.shortName})
                      </Link>
                      {!c.visible && <span> {t('hiddenSuffix')}</span>}
                      {progressByCourse[c.id] != null ? (
                        <span className="ml-2 text-sm text-muted-foreground">
                          {t('courseProgressLabel', { percent: progressByCourse[c.id]! })}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {node.children.length > 0 && renderTree(node.children, true)}
            </li>
          );
        })}
      </ul>
    );
  }

  /**
   * Tạo danh mục qua POST /courses/categories với đúng
   * `createCourseCategorySchema`: `parent` chỉ gửi khi chọn một danh mục
   * cha thật (ở cấp cao nhất thì bỏ qua hẳn trường này thay vì gửi giá trị
   * không phải UUID).
   */
  async function createCategory(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await apiJson('/api/v1/courses/categories', {
        method: 'POST',
        body: JSON.stringify({
          name: catName,
          ...(catParent && catParent !== '0' ? { parent: catParent } : {}),
        }),
      });
      setCatName('');
      await reload();
      setMessage(t('categoryCreated'));
    } catch {
      setMessage(t('categoryCreateFailed'));
    }
  }

  /** Đổi tên một danh mục qua PATCH /courses/categories/:id (`updateCourseCategorySchema`). */
  async function renameCategory(cat: CourseCategory) {
    const name = catEdits[cat.id] ?? cat.name;
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/categories/${cat.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      await reload();
      setMessage(t('categoryUpdated'));
    } catch {
      setMessage(t('categoryUpdateFailed'));
    }
  }

  /**
   * Xoá một danh mục qua DELETE /courses/categories/:id sau khi xác nhận.
   * Lỗi phía server (danh mục còn khoá học/danh mục con, thiếu quyền…) chỉ
   * hiện thông điệp thân thiện, không sập trang.
   */
  async function deleteCategory(cat: CourseCategory) {
    if (!window.confirm(t('confirmDeleteCategory', { name: cat.name }))) return;
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/categories/${cat.id}`, { method: 'DELETE' });
      await reload();
      setMessage(t('categoryDeleted'));
    } catch {
      setMessage(t('categoryDeleteFailed'));
    }
  }

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('courseCategories')}</CardTitle>
          <CardDescription>{t('courseCategoriesDescription')}</CardDescription>
        </CardHeader>
        <CardContent>{tree.length === 0 ? <p>{t('noCategories')}</p> : renderTree(tree)}</CardContent>
      </Card>

      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}

      {canAdminister && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('categoryAdminTitle')}</CardTitle>
              <CardDescription>{t('categoryAdminDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-4">
                {flatCategories.map((cat) => (
                  <li key={cat.id} data-testid={`category-admin-${cat.id}`} className="space-y-2 rounded border p-3">
                    <p className="font-medium">{cat.name}</p>
                    <div className="space-y-2">
                      <Label htmlFor={`cat-rename-${cat.id}`}>{t('renameCategory')}</Label>
                      <Input
                        id={`cat-rename-${cat.id}`}
                        value={catEdits[cat.id] ?? cat.name}
                        onChange={(e) => setCatEdits((prev) => ({ ...prev, [cat.id]: e.target.value }))}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button type="button" variant="outline" onClick={() => void renameCategory(cat)}>
                        {t('saveCategory')}
                      </Button>
                      <Button type="button" variant="destructive" onClick={() => void deleteCategory(cat)}>
                        {t('deleteCategory')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('createCategory')}</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={createCategory} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="cat-name">{t('categoryName')}</Label>
                  <Input id="cat-name" value={catName} onChange={(e) => setCatName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cat-parent">{t('parentCategory')}</Label>
                  <select
                    id="cat-parent"
                    value={catParent}
                    onChange={(e) => setCatParent(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  >
                    <option value="0">{t('topLevel')}</option>
                    {flatCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="submit">{t('createCategory')}</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('createCourse')}</CardTitle>
              <CardDescription>{t('wizardListHint')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground" to="/courses/new">{t('wizardOpen')}</Link>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default CoursesPage;
