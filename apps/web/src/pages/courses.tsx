import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { Course, CourseCategory, CourseCategoryTreeNode } from '@lms/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

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
  const [message, setMessage] = useState<string | null>(null);
  const [catName, setCatName] = useState('');
  const [catParent, setCatParent] = useState('0');
  const [courseName, setCourseName] = useState('');
  const [courseShort, setCourseShort] = useState('');
  const [courseCategory, setCourseCategory] = useState('');
  const [catEdits, setCatEdits] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    const [t, c] = await Promise.all([
      apiJson<CourseCategoryTreeNode[]>('/api/v1/courses/categories/tree'),
      apiJson<Course[]>('/api/v1/courses'),
    ]);
    setTree(t);
    setCourses(c);
    if (c.length === 0 && t.length > 0) setCourseCategory(String(t[0]!.id));
  }, []);

  useEffect(() => { void reload().catch(() => setMessage(t('coursesLoadFailed'))); }, [reload]);

  const flatCategories: CourseCategory[] = [];
  const walk = (nodes: CourseCategoryTreeNode[]) => { for (const n of nodes) { flatCategories.push(n); walk(n.children); } };
  walk(tree);

  function renderTree(nodes: CourseCategoryTreeNode[]) {
    return (
      <ul className="ml-4 list-disc">
        {nodes.map((node) => (
          <li key={node.id}>
            <span>{node.name}</span>
            <ul className="ml-3">
              {courses.filter((c) => c.category === node.id).map((c) => (
                <li key={c.id}>
                  <Link to={`/courses/${c.id}`}>{c.fullname} ({c.shortname})</Link>
                  {!c.visible && <span> {t('hiddenSuffix')}</span>}
                </li>
              ))}
            </ul>
            {node.children.length > 0 && renderTree(node.children)}
          </li>
        ))}
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
    } catch { setMessage(t('categoryCreateFailed')); }
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
    } catch { setMessage(t('categoryUpdateFailed')); }
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
    } catch { setMessage(t('categoryDeleteFailed')); }
  }

  /** Tạo khoá học qua POST /courses với tối thiểu của `createCourseSchema` (fullname, shortname, category). */
  async function createCourse(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await apiJson('/api/v1/courses', {
        method: 'POST',
        body: JSON.stringify({ fullname: courseName, shortname: courseShort, category: courseCategory }),
      });
      setCourseName(''); setCourseShort('');
      await reload();
      setMessage(t('courseCreated'));
    } catch { setMessage(t('courseCreateFailed')); }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>{t('courseCategories')}</CardTitle>
          <CardDescription>{t('courseCategoriesDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {tree.length === 0 ? <p>{t('noCategories')}</p> : renderTree(tree)}
        </CardContent>
      </Card>

      {message && <p role="status" className="text-sm">{message}</p>}

      {canAdminister && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('categoryAdminTitle')}</CardTitle>
              <CardDescription>{t('categoryAdminDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
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
                      <Button type="button" variant="outline" onClick={() => void renameCategory(cat)}>{t('saveCategory')}</Button>
                      <Button type="button" variant="destructive" onClick={() => void deleteCategory(cat)}>{t('deleteCategory')}</Button>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('createCategory')}</CardTitle></CardHeader>
            <CardContent>
              <form onSubmit={createCategory} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="cat-name">{t('categoryName')}</Label>
                  <Input id="cat-name" value={catName} onChange={(e) => setCatName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cat-parent">{t('parentCategory')}</Label>
                  <select id="cat-parent" value={catParent} onChange={(e) => setCatParent(e.target.value)} className="border px-2 py-1">
                    <option value="0">{t('topLevel')}</option>
                    {flatCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <Button type="submit">{t('createCategory')}</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('createCourse')}</CardTitle></CardHeader>
            <CardContent>
              <form onSubmit={createCourse} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="course-fullname">{t('courseFullName')}</Label>
                  <Input id="course-fullname" value={courseName} onChange={(e) => setCourseName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="course-shortname">{t('courseShortName')}</Label>
                  <Input id="course-shortname" value={courseShort} onChange={(e) => setCourseShort(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="course-category">{t('courseCategory')}</Label>
                  <select id="course-category" value={courseCategory} onChange={(e) => setCourseCategory(e.target.value)} className="border px-2 py-1">
                    {flatCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <Button type="submit">{t('createCourse')}</Button>
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
