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
import { FrameUnitPicker } from '../components/frame-picker';
import {
  fetchFrameUnitsFor, fetchSubjects, fetchSystemContextId,
  type CurriculumSubject, type FrameUnit,
} from '#lib/curriculum';

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
  // K0a: gắn môn × khối cho khoá mới + nạp khung chương trình ngay lúc tạo.
  const [subjects, setSubjects] = useState<CurriculumSubject[]>([]);
  const [courseSubject, setCourseSubject] = useState('');
  const [courseGrade, setCourseGrade] = useState('');
  const [frameUnits, setFrameUnits] = useState<FrameUnit[]>([]);
  const [frameCurriculumId, setFrameCurriculumId] = useState<string | null>(null);
  const [frameSelected, setFrameSelected] = useState<string[]>([]);

  // Danh sách môn ở context hệ thống: không có quyền đọc thì ẩn nhẹ khu
  // chọn môn/khung (giống khối Chương trình trong editor câu hỏi).
  useEffect(() => {
    void (async () => {
      try {
        const contextId = await fetchSystemContextId();
        if (contextId) setSubjects(await fetchSubjects(contextId));
      } catch {
        setSubjects([]);
      }
    })();
  }, []);

  // Đổi cặp môn × khối thì nạp lại cây khung của khối đó để tích chọn.
  useEffect(() => {
    setFrameSelected([]);
    if (!courseSubject || !courseGrade) {
      setFrameUnits([]);
      setFrameCurriculumId(null);
      return;
    }
    void fetchFrameUnitsFor(courseSubject, Number(courseGrade))
      .then(({ curriculumId, units }) => {
        setFrameCurriculumId(curriculumId);
        setFrameUnits(units);
      })
      .catch(() => {
        setFrameCurriculumId(null);
        setFrameUnits([]);
      });
  }, [courseSubject, courseGrade]);

  const reload = useCallback(async () => {
    const [t, c] = await Promise.all([
      apiJson<CourseCategoryTreeNode[]>('/api/v1/courses/categories/tree'),
      apiJson<Course[]>('/api/v1/courses'),
    ]);
    setTree(t);
    setCourses(c);
    if (c.length === 0 && t.length > 0) setCourseCategory(String(t[0]!.id));
  }, []);

  useEffect(() => {
    void reload().catch(() => setMessage(t('coursesLoadFailed')));
  }, [reload]);

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

  /**
   * Tạo khoá học qua POST /courses (`createCourseSchema`): kèm môn/khối
   * khi đã chọn, và nếu giáo viên tích chọn đơn vị khung thì nạp khung
   * ngay sau khi khoá được tạo (K0a). Nạp khung lỗi sau khi khoá đã tạo
   * thì báo riêng để giáo viên nạp lại từ trang quản trị khoá, không
   * trình bày như thể tạo khoá thất bại.
   */
  async function createCourse(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      const created = await apiJson<Course>('/api/v1/courses', {
        method: 'POST',
        body: JSON.stringify({
          fullName: courseName,
          shortName: courseShort,
          category: courseCategory,
          ...(courseSubject ? { subjectId: courseSubject } : {}),
          ...(courseGrade ? { grade: Number(courseGrade) } : {}),
        }),
      });
      setCourseName('');
      setCourseShort('');
      setFrameSelected([]);
      if (frameCurriculumId && frameSelected.length > 0) {
        try {
          await apiJson(`/api/v1/courses/${created.id}/curriculum-frame`, {
            method: 'POST',
            body: JSON.stringify({ curriculumId: frameCurriculumId, nodeIds: frameSelected }),
          });
          await reload();
          setMessage(t('courseCreated'));
        } catch {
          await reload();
          setMessage(t('courseCreatedFrameFailed'));
        }
        return;
      }
      await reload();
      setMessage(t('courseCreated'));
    } catch {
      setMessage(t('courseCreateFailed'));
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
            </CardHeader>
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
                  <select
                    id="course-category"
                    value={courseCategory}
                    onChange={(e) => setCourseCategory(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  >
                    {flatCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                {subjects.length > 0 ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="course-subject">{t('courseSubject')}</Label>
                      <select
                        id="course-subject"
                        value={courseSubject}
                        onChange={(e) => setCourseSubject(e.target.value)}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      >
                        <option value="">{t('courseSubjectNone')}</option>
                        {subjects.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="course-grade">{t('courseGrade')}</Label>
                      <select
                        id="course-grade"
                        value={courseGrade}
                        onChange={(e) => setCourseGrade(e.target.value)}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      >
                        <option value="">{t('courseGradeNone')}</option>
                        {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                          <option key={g} value={g}>
                            {t('curriculumGradeLabel', { grade: g })}
                          </option>
                        ))}
                      </select>
                    </div>
                    {frameCurriculumId ? (
                      <div className="space-y-2">
                        <Label>{t('courseFrameUnitsTitle')}</Label>
                        <FrameUnitPicker
                          units={frameUnits}
                          selected={frameSelected}
                          idPrefix="create-frame"
                          onToggle={(nodeId, checked) =>
                            setFrameSelected((prev) => (checked ? [...prev, nodeId] : prev.filter((id) => id !== nodeId)))
                          }
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}
                <Button type="submit">{t('createCourse')}</Button>
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default CoursesPage;
