import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { Course, CourseCategory, CourseCategoryTreeNode } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lms/ui/components/select';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { usePermissions } from '#lib/permissions';
import {
  categoryTreeQueryOptions,
  courseMyProgressQueryOptions,
  coursesListQueryOptions,
  coursesPageClientLoader,
  useCreateCourseCategory,
  useDeleteCourseCategory,
  useRenameCourseCategory,
} from '#lib/courses-data';
import {
  COURSE_CARD_COLOR_HEX,
  displayCourseName,
  useCourseCardPrefs,
  type CourseCardPrefView,
} from '#lib/course-cards';

/** Map pref rỗng dùng chung khi query pref chưa có dữ liệu (tránh tạo Map mới mỗi lần render). */
const EMPTY_CARD_PREFS = new Map<string, CourseCardPrefView>();
import { CourseCardPrefEditor } from '../components/course-card-pref-editor';

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
  const perms = usePermissions();
  const { canAdminister } = perms;
  // Cây danh mục đọc qua TanStack với ĐÚNG khoá `categoryTree` dùng
  // chung với dashboard (F-03, rà soát #133): trước đây trang tự fetch
  // bằng useEffect + state riêng, trùng dữ liệu dashboard vừa tải.
  // Tuỳ chọn truy vấn nay nằm ở lib/courses-data (F-01).
  const treeQuery = useQuery(categoryTreeQueryOptions());
  const tree = useMemo(() => treeQuery.data ?? [], [treeQuery.data]);
  // Danh sách khoá đọc qua TanStack với ĐÚNG khoá `courses` mà
  // PermissionsProvider dùng (F-03, rà soát #133): trước đây trang tự
  // fetch lại /courses trong khi provider vừa tải cùng dữ liệu — nay
  // cache dùng chung, trang mở sau provider thì không tốn request.
  const coursesQuery = useQuery(coursesListQueryOptions());
  const courses = useMemo(() => coursesQuery.data ?? [], [coursesQuery.data]);
  // Pref thẻ khoá của chính người dùng (DASH1) đọc qua query dùng chung
  // khoá `courseCards` với dashboard (F-03/F-04): mutation lưu pref tự
  // invalidate nên trang này tươi lại sau khi editor lưu — không còn
  // state Map riêng + fetch thủ công khi mở trang. Lỗi tải pref thì
  // lặng lẽ dùng tên gốc (pref là lớp phủ cá nhân, không chặn trang).
  const cardPrefsQuery = useCourseCardPrefs();
  const cardPrefs = cardPrefsQuery.data ?? EMPTY_CARD_PREFS;
  const [editingCardCourseId, setEditingCardCourseId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [catName, setCatName] = useState('');
  const [catParent, setCatParent] = useState('0');
  const [catEdits, setCatEdits] = useState<Record<string, string>>({});
  useEffect(() => {
    if (coursesQuery.isError || treeQuery.isError) setMessage(t('coursesLoadFailed'));
  }, [coursesQuery.isError, treeQuery.isError, t]);

  const loading = treeQuery.isPending || coursesQuery.isPending;

  // % tiến độ học của chính người dùng theo khoá (K2): CHỈ probe các
  // khoá người dùng thuộc về (dạy/học theo ảnh chụp quyền) — khoá ngoài
  // vốn luôn lỗi qua cổng khoá học và không hiện số nào. Mỗi khoá một
  // query qua useQueries với khoá factory `courseMyProgress` (F-03);
  // lỗi từng khoá thì percent = null và không hiện gì, như trước.
  const memberCourseIds = useMemo(
    () => new Set([...perms.teaching, ...perms.learning].map((c) => c.course.id)),
    [perms.teaching, perms.learning],
  );
  const progressTargets = useMemo(
    () => (perms.ready ? courses.filter((c) => memberCourseIds.has(c.id)).map((c) => c.id) : []),
    [courses, memberCourseIds, perms.ready],
  );
  const progressQueries = useQueries({
    queries: progressTargets.map((courseId) => courseMyProgressQueryOptions(courseId)),
  });
  const progressByCourse: Record<string, number | null> = {};
  progressTargets.forEach((courseId, i) => {
    progressByCourse[courseId] = progressQueries[i]?.data?.percent ?? null;
  });

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
                  {nodeCourses.map((c) => {
                    const pref = cardPrefs.get(c.id);
                    return (
                      <li key={c.id}>
                        {pref?.color ? (
                          <span
                            className="mr-1 inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: COURSE_CARD_COLOR_HEX[pref.color] }}
                            data-testid="course-card-color-dot"
                          />
                        ) : null}
                        <Link to={`/courses/${c.id}`} title={c.fullName}>
                          {displayCourseName(pref, c.fullName)} ({c.shortName})
                        </Link>
                        {!c.visible && <span> {t('hiddenSuffix')}</span>}
                        {progressByCourse[c.id] != null ? (
                          <span className="ml-2 text-sm text-muted-foreground">
                            {t('courseProgressLabel', { percent: progressByCourse[c.id]! })}
                          </span>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-1"
                          data-testid="course-card-edit"
                          onClick={() => setEditingCardCourseId(editingCardCourseId === c.id ? null : c.id)}
                        >
                          {t('cardPrefEdit')}
                        </Button>
                        {editingCardCourseId === c.id && (
                          <CourseCardPrefEditor
                            courseId={c.id}
                            initial={pref}
                            onSaved={() => setEditingCardCourseId(null)}
                            onCancel={() => setEditingCardCourseId(null)}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {node.children.length > 0 && renderTree(node.children, true)}
            </li>
          );
        })}
      </ul>
    );
  }

  const createCategoryMutation = useCreateCourseCategory();
  const renameCategoryMutation = useRenameCourseCategory();
  const deleteCategoryMutation = useDeleteCourseCategory();

  /**
   * Tạo danh mục qua đột biến POST /courses/categories với đúng
   * `createCourseCategorySchema`: `parent` chỉ gửi khi chọn một danh mục
   * cha thật (ở cấp cao nhất thì bỏ qua hẳn trường này thay vì gửi giá trị
   * không phải UUID).
   */
  async function createCategory(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await createCategoryMutation.mutateAsync({
        name: catName,
        ...(catParent && catParent !== '0' ? { parent: catParent } : {}),
      });
      setCatName('');
      setMessage(t('categoryCreated'));
    } catch {
      setMessage(t('categoryCreateFailed'));
    }
  }

  /** Đổi tên một danh mục qua đột biến PATCH /courses/categories/:id (`updateCourseCategorySchema`). */
  async function renameCategory(cat: CourseCategory) {
    const name = catEdits[cat.id] ?? cat.name;
    setMessage(null);
    try {
      await renameCategoryMutation.mutateAsync({ categoryId: cat.id, name });
      setMessage(t('categoryUpdated'));
    } catch {
      setMessage(t('categoryUpdateFailed'));
    }
  }

  /**
   * Xoá một danh mục qua đột biến DELETE /courses/categories/:id sau khi xác nhận.
   * Lỗi phía server (danh mục còn khoá học/danh mục con, thiếu quyền…) chỉ
   * hiện thông điệp thân thiện, không sập trang.
   */
  async function deleteCategory(cat: CourseCategory) {
    if (!window.confirm(t('confirmDeleteCategory', { name: cat.name }))) return;
    setMessage(null);
    try {
      await deleteCategoryMutation.mutateAsync(cat.id);
      setMessage(t('categoryDeleted'));
    } catch {
      setMessage(t('categoryDeleteFailed'));
    }
  }

  return (
    <PageShell width="wide">
      <PageHeader title={t('coursesHeading')} />
      <Card>
        <CardHeader>
          <CardTitle>{t('courseCategories')}</CardTitle>
          <CardDescription>{t('courseCategoriesDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-5 w-72" />
              <Skeleton className="h-5 w-48" />
            </div>
          ) : tree.length === 0 ? (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>{t('noCategories')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            renderTree(tree)
          )}
        </CardContent>
      </Card>

      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}

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
                    <Field>
                      <FieldLabel htmlFor={`cat-rename-${cat.id}`}>{t('renameCategory')}</FieldLabel>
                      <Input
                        id={`cat-rename-${cat.id}`}
                        value={catEdits[cat.id] ?? cat.name}
                        onChange={(e) => setCatEdits((prev) => ({ ...prev, [cat.id]: e.target.value }))}
                      />
                    </Field>
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
              <form onSubmit={createCategory}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="cat-name">{t('categoryName')}</FieldLabel>
                    <Input id="cat-name" value={catName} onChange={(e) => setCatName(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel id="cat-parent-label">{t('parentCategory')}</FieldLabel>
                    <Select
                      items={Object.fromEntries([
                        ['0', t('topLevel')],
                        ...flatCategories.map((c) => [c.id, c.name] as [string, string]),
                      ])}
                      value={catParent}
                      onValueChange={(v) => setCatParent(v ?? '0')}
                    >
                      <SelectTrigger aria-labelledby="cat-parent-label" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">{t('topLevel')}</SelectItem>
                        {flatCategories.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="flex justify-end">
                    <Button type="submit">{t('createCategory')}</Button>
                  </div>
                </FieldGroup>
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
    </PageShell>
  );
}

/**
 * clientLoader (F-01, rà soát #133): nạp trước cây danh mục + danh
 * sách khoá vào đúng hai khoá dùng chung trang sẽ đọc.
 */
export async function clientLoader() {
  return coursesPageClientLoader();
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default CoursesPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navCourses');
}
