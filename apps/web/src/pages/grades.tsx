import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import type {
  Gradebook,
  GradebookCategoryView,
  GradeCategory,
  GradeItem,
  GradeLetter,
  GradeReport,
} from '@lms/contracts';
import { AGGREGATIONS } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import { DataTable, type DataColumn } from '#components/data-table';
import '../i18n';
import { apiJson } from '#lib/api';
import { usePermissions } from '#lib/permissions';

/**
 * Thang điểm tuỳ biến như API trả về (bảng `scales` phía grades service —
 * contracts chưa có schema response cho scale nên trang khai báo tại chỗ):
 * `scale` là danh sách mức phân tách bằng dấu phẩy, từ thấp đến cao.
 */
interface GradeScaleView {
  id: string;
  courseId: string | null;
  name: string;
  scale: string;
  description: string;
}

/**
 * Một grade outcome như API trả về (bảng `grade_outcomes` phía grades
 * service): `courseId` null nghĩa là outcome mức hệ thống dùng chung;
 * contracts chỉ có schema create/update nên trang khai báo view tại chỗ
 * như GradeScaleView.
 */
interface GradeOutcomeView {
  id: string;
  courseId: string | null;
  scaleId: string;
  name: string;
  description: string;
}

/**
 * Một dòng lịch sử thay đổi điểm như API trả về (bảng
 * `grade_grades_history` phía grades service): `action` 1 = tạo mới,
 * 2 = cập nhật, 3 = xoá theo quy ước của Moodle.
 */
interface GradeHistoryView {
  id: string;
  action: number;
  itemId: string;
  userId: string;
  rawGrade: number | null;
  finalGrade: number | null;
  source: string | null;
  updatedAt: string;
  loggedUser: string | null;
}

/** Một mốc chữ cái đang sửa trong form letters: giữ dạng chuỗi để nhập liệu trung thực, chỉ đổi sang số khi lưu. */
interface LetterDraft {
  letter: string;
  lowerBoundary: string;
}

/**
 * Gradebook: category/item tree with the student's grades, letters at
 * display time, the teacher report (course totals per student) and a grade
 * entry form. All permission/hidden rules are enforced by the API; this page
 * only renders what it is given.
 *
 * Khu quản trị sổ điểm (hạng mục, mục điểm, letters, scales, regrade, lịch
 * sử điểm) chỉ render cho staff của khoá: người dùng thuộc `teaching` của
 * chính khoá này theo `usePermissions()` (có grade:viewall tại context
 * khoá) hoặc có quyền quản trị cấp hệ thống (`canAdminister`). Dữ liệu quản
 * trị chỉ được tải khi đã xác nhận là staff. Lưu ý các endpoint sửa/xoá
 * category và item KHÔNG mang tiền tố courseId (PATCH/DELETE
 * /courses/grades/categories/:id, /courses/grades/items/:id) — đúng
 * controller phía API.
 */
export function GradebookPage() {
  const { t } = useTranslation('app');
  const { id } = useParams();
  const courseId = id ?? '';
  const perms = usePermissions();
  const [book, setBook] = useState<Gradebook | null>(null);
  const [report, setReport] = useState<GradeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [gradeItemId, setGradeItemId] = useState('');
  const [gradeUserId, setGradeUserId] = useState('');
  const [gradeValue, setGradeValue] = useState('');

  /** Staff của khoá này hay không: teaching của khoá hoặc quản trị hệ thống. */
  const courseAccess = perms.courses.find((c) => c.course.id === courseId);
  const isStaff =
    perms.canAdminister ||
    perms.teaching.some((c) => c.course.id === courseId) ||
    (courseAccess?.capabilities.includes('moodle/grade:viewall') ?? false);

  const [adminCategories, setAdminCategories] = useState<GradeCategory[]>([]);
  const [adminItems, setAdminItems] = useState<GradeItem[]>([]);
  const [adminScales, setAdminScales] = useState<GradeScaleView[]>([]);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState('');
  const [newCatAggregation, setNewCatAggregation] = useState<string>('natural');
  const [catEdits, setCatEdits] = useState<Record<string, string>>({});
  const [newItemName, setNewItemName] = useState('');
  const [newItemMax, setNewItemMax] = useState('100');
  const [newItemCategoryId, setNewItemCategoryId] = useState('');
  const [itemEdits, setItemEdits] = useState<Record<string, { itemName: string; gradeMax: string }>>({});
  const [letterDrafts, setLetterDrafts] = useState<LetterDraft[]>([]);
  const [scaleName, setScaleName] = useState('');
  const [scaleValues, setScaleValues] = useState('');
  const [scaleDescription, setScaleDescription] = useState('');
  const [adminOutcomes, setAdminOutcomes] = useState<GradeOutcomeView[]>([]);
  const [outcomeName, setOutcomeName] = useState('');
  const [outcomeScaleId, setOutcomeScaleId] = useState('');
  const [outcomeDescription, setOutcomeDescription] = useState('');
  const [outcomeEdits, setOutcomeEdits] = useState<Record<string, string>>({});
  const [historyItemId, setHistoryItemId] = useState('');
  const [historyUserId, setHistoryUserId] = useState('');
  const [historyRows, setHistoryRows] = useState<GradeHistoryView[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const mine = await apiJson<Gradebook>(`/api/v1/courses/${courseId}/gradebook`);
    setBook(mine);
    const rep = await apiJson<GradeReport>(`/api/v1/courses/${courseId}/grades/report`).catch(() => null);
    setReport(rep);
  }, [courseId]);

  useEffect(() => {
    void reload().catch(() => setError(t('gradebookLoadFailed')));
  }, [reload]);

  /**
   * Nạp dữ liệu quản trị sổ điểm (chỉ gọi khi đã xác nhận staff): category
   * và item của khoá, bộ letters hiện tại (đổ thẳng vào form sửa) và scales.
   * Mỗi endpoint lỗi độc lập thì phần đó để rỗng, không sập cả trang.
   */
  const reloadAdmin = useCallback(async () => {
    const [cats, items, letters, scales, outcomes] = await Promise.all([
      apiJson<GradeCategory[]>(`/api/v1/courses/${courseId}/grades/categories`).catch(() => []),
      apiJson<GradeItem[]>(`/api/v1/courses/${courseId}/grades/items`).catch(() => []),
      apiJson<GradeLetter[]>(`/api/v1/courses/${courseId}/grades/letters`).catch(() => []),
      apiJson<GradeScaleView[]>(`/api/v1/courses/${courseId}/grades/scales`).catch(() => []),
      apiJson<GradeOutcomeView[]>(`/api/v1/courses/${courseId}/grades/outcomes`).catch(() => []),
    ]);
    setAdminOutcomes(outcomes);
    setOutcomeEdits(Object.fromEntries(outcomes.map((o) => [o.id, o.name])));
    setAdminCategories(cats);
    setCatEdits(Object.fromEntries(cats.map((c) => [c.id, c.fullName])));
    setAdminItems(items);
    setItemEdits(Object.fromEntries(items.map((i) => [i.id, { itemName: i.itemName, gradeMax: String(i.gradeMax) }])));
    setLetterDrafts(letters.map((l) => ({ letter: l.letter, lowerBoundary: String(l.lowerBoundary) })));
    setAdminScales(scales);
  }, [courseId]);

  useEffect(() => {
    if (isStaff) void reloadAdmin();
  }, [isStaff, reloadAdmin]);

  async function enterGrade(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/items/${gradeItemId}/grades`, {
        method: 'POST',
        body: JSON.stringify({ userId: gradeUserId, rawGrade: Number(gradeValue) }),
      });
      setMessage(t('gradeSaved'));
      await reload();
    } catch {
      setMessage(t('gradeSaveFailed'));
    }
  }

  /** Tạo hạng mục điểm qua POST /courses/:courseId/grades/categories (`createGradeCategorySchema`). */
  async function createGradeCategory(event: FormEvent) {
    event.preventDefault();
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/grades/categories`, {
        method: 'POST',
        body: JSON.stringify({ fullName: newCatName, aggregation: newCatAggregation }),
      });
      setNewCatName('');
      setAdminMessage(t('gradeCategoryCreated'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('gradeCategoryCreateFailed'));
    }
  }

  /** Đổi tên hạng mục qua PATCH /courses/grades/categories/:categoryId (`updateGradeCategorySchema`). */
  async function saveGradeCategory(cat: GradeCategory) {
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/categories/${cat.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fullName: catEdits[cat.id] ?? cat.fullName }),
      });
      setAdminMessage(t('gradeCategoryUpdated'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('gradeCategoryUpdateFailed'));
    }
  }

  /** Xoá hạng mục qua DELETE /courses/grades/categories/:categoryId sau khi xác nhận. */
  async function deleteGradeCategory(cat: GradeCategory) {
    if (!window.confirm(t('confirmDeleteGradeCategory', { name: cat.fullName }))) return;
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/categories/${cat.id}`, { method: 'DELETE' });
      setAdminMessage(t('gradeCategoryDeleted'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('gradeCategoryDeleteFailed'));
    }
  }

  /**
   * Tạo mục điểm thủ công qua POST /courses/:courseId/grades/items với
   * đúng `createGradeItemSchema`: `itemName`, `gradeMax` dạng số và
   * `categoryId` chỉ khi đã chọn hạng mục (`itemType` bỏ qua — phía server
   * mặc định là manual).
   */
  async function createGradeItem(event: FormEvent) {
    event.preventDefault();
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/grades/items`, {
        method: 'POST',
        body: JSON.stringify({
          itemName: newItemName,
          gradeMax: Number(newItemMax),
          ...(newItemCategoryId ? { categoryId: newItemCategoryId } : {}),
        }),
      });
      setNewItemName('');
      setAdminMessage(t('gradeItemCreated'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('gradeItemCreateFailedAdmin'));
    }
  }

  /** Sửa tên/điểm tối đa của mục điểm qua PATCH /courses/grades/items/:itemId (`updateGradeItemSchema`). */
  async function saveGradeItem(item: GradeItem) {
    const edit = itemEdits[item.id] ?? { itemName: item.itemName, gradeMax: String(item.gradeMax) };
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ itemName: edit.itemName, gradeMax: Number(edit.gradeMax) }),
      });
      setAdminMessage(t('gradeItemUpdated'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('gradeItemUpdateFailed'));
    }
  }

  /** Xoá mục điểm qua DELETE /courses/grades/items/:itemId sau khi xác nhận. */
  async function deleteGradeItem(item: GradeItem) {
    if (!window.confirm(t('confirmDeleteGradeItem', { name: item.itemName }))) return;
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/items/${item.id}`, { method: 'DELETE' });
      setAdminMessage(t('gradeItemDeleted'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('gradeItemDeleteFailed'));
    }
  }

  /**
   * Lưu toàn bộ thang điểm chữ qua PUT /courses/:courseId/grades/letters
   * với đúng `setGradeLettersSchema`: `{ letters: [{ letter, lowerBoundary }] }`
   * — mốc dưới đổi sang số tại lúc gửi.
   */
  async function saveLetters(event: FormEvent) {
    event.preventDefault();
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/grades/letters`, {
        method: 'PUT',
        body: JSON.stringify({
          letters: letterDrafts.map((d) => ({ letter: d.letter, lowerBoundary: Number(d.lowerBoundary) })),
        }),
      });
      setAdminMessage(t('lettersSaved'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('lettersSaveFailed'));
    }
  }

  /** Tạo scale qua POST /courses/:courseId/grades/scales (`createGradeScaleSchema`: name, scale, description tuỳ chọn). */
  async function createScale(event: FormEvent) {
    event.preventDefault();
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/grades/scales`, {
        method: 'POST',
        body: JSON.stringify({
          name: scaleName,
          scale: scaleValues,
          ...(scaleDescription.trim() ? { description: scaleDescription.trim() } : {}),
        }),
      });
      setScaleName('');
      setScaleValues('');
      setScaleDescription('');
      setAdminMessage(t('scaleCreated'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('scaleCreateFailed'));
    }
  }

  /** Tạo outcome của khoá qua POST /courses/:courseId/grades/outcomes (`createGradeOutcomeSchema`: name, scaleId bắt buộc, description tuỳ chọn). */
  async function createOutcome(event: FormEvent) {
    event.preventDefault();
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/grades/outcomes`, {
        method: 'POST',
        body: JSON.stringify({
          name: outcomeName,
          scaleId: outcomeScaleId || adminScales[0]?.id,
          ...(outcomeDescription.trim() ? { description: outcomeDescription.trim() } : {}),
        }),
      });
      setOutcomeName('');
      setOutcomeDescription('');
      setAdminMessage(t('outcomeCreated'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('outcomeCreateFailed'));
    }
  }

  /** Đổi tên outcome qua PATCH /courses/grades/outcomes/:outcomeId (endpoint không mang tiền tố courseId, đúng controller phía API). */
  async function updateOutcome(outcome: GradeOutcomeView) {
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/outcomes/${outcome.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: outcomeEdits[outcome.id] ?? outcome.name }),
      });
      setAdminMessage(t('outcomeUpdated'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('outcomeUpdateFailed'));
    }
  }

  /** Xoá outcome qua DELETE /courses/grades/outcomes/:outcomeId (item đang gắn được gỡ outcomeId phía server). */
  async function deleteOutcome(outcome: GradeOutcomeView) {
    if (!window.confirm(t('confirmDeleteOutcome', { name: outcome.name }))) return;
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/outcomes/${outcome.id}`, { method: 'DELETE' });
      setAdminMessage(t('outcomeDeleted'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('outcomeDeleteFailed'));
    }
  }

  /** Tính lại điểm toàn khoá qua POST /courses/:courseId/grades/regrade (không body). */
  async function regradeCourse() {
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/grades/regrade`, { method: 'POST' });
      setAdminMessage(t('regradeDone'));
      await reload();
    } catch {
      setAdminMessage(t('regradeFailed'));
    }
  }

  /**
   * Xem lịch sử điểm của một học viên trên một mục điểm qua
   * GET /courses/grades/items/:itemId/users/:userId/history (endpoint này
   * cũng không mang tiền tố courseId).
   */
  async function loadHistory(event: FormEvent) {
    event.preventDefault();
    setHistoryError(null);
    setHistoryRows(null);
    try {
      const rows = await apiJson<GradeHistoryView[]>(
        `/api/v1/courses/grades/items/${historyItemId}/users/${historyUserId}/history`,
      );
      setHistoryRows(rows);
    } catch {
      setHistoryError(t('historyLoadFailed'));
    }
  }

  function renderCategory(view: GradebookCategoryView, depth: number) {
    return (
      <div key={view.category.id} className={CATEGORY_INDENT[Math.min(depth, 5)]}>
        <h3 className="font-medium">
          {view.category.fullName || t('gradeCourseFallback')}{' '}
          <span className="text-sm text-muted-foreground">({view.category.aggregation})</span>
          {view.total?.grade?.finalGrade !== null && view.total?.grade ? (
            <span data-testid={`cat-total-${view.category.id}`}>
              {t('categoryTotal', {
                grade: view.total.grade.finalGrade,
                max: view.total.item.gradeMax,
                letterSuffix: view.total.grade.letter ? t('letterSuffix', { letter: view.total.grade.letter }) : '',
              })}
            </span>
          ) : null}
        </h3>
        {/*
          NGOẠI LỆ không dùng DataTable/TanStack Table: bảng điểm của
          học viên render ĐỆ QUY theo cây danh mục điểm, mỗi danh mục
          một bảng con kèm dòng tổng của chính danh mục đó — cấu trúc
          cây lồng nhau có tổng hợp theo tầng, san phẳng thành một mô
          hình hàng duy nhất sẽ phá vỡ ngữ nghĩa hiển thị của sổ điểm.
        */}
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">{t('gradeItem')}</th>
              <th className="text-left">{t('grade')}</th>
              <th className="text-left">{t('letter')}</th>
              <th className="text-left">{t('max')}</th>
            </tr>
          </thead>
          <tbody>
            {view.items.map(({ item, grade }) => (
              <tr key={item.id} data-testid={`grade-item-${item.id}`}>
                <td>
                  {item.itemName}
                  {item.extraCredit ? ` ${t('extraCreditSuffix')}` : ''}
                </td>
                <td>{grade?.finalGrade ?? '—'}</td>
                <td>{grade?.letter ?? ''}</td>
                <td>{item.gradeMax}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {view.children.map((child) => renderCategory(child, depth + 1))}
      </div>
    );
  }

  if (error)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <p role="alert">{error}</p>
      </main>
    );
  if (!book) return <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">{t('loading')}</main>;

  /** Cột của bảng báo cáo điểm toàn lớp trên DataTable dùng chung: sắp xếp theo học viên và điểm tổng, lọc theo mã học viên. */
  const reportColumns: DataColumn<GradeReport['rows'][number]>[] = [
    {
      id: 'student',
      header: t('studentUserId'),
      cell: (row) => row.userId,
      sortValue: (row) => row.userId,
      filterValue: (row) => row.userId,
    },
    {
      id: 'total',
      header: t('courseTotal'),
      cell: (row) => row.finalGrade ?? '—',
      sortValue: (row) => row.finalGrade ?? -1,
    },
    { id: 'letter', header: t('letter'), cell: (row) => row.letter ?? '' },
  ];

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('gradebook')}</CardTitle>
          <CardDescription>
            {t('courseTotalLine', {
              grade: book.courseTotal?.grade?.finalGrade ?? '—',
              letterSuffix: book.courseTotal?.grade?.letter
                ? t('letterSuffix', { letter: book.courseTotal.grade.letter })
                : '',
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">{book.categories.map((c) => renderCategory(c, 0))}</CardContent>
      </Card>

      {report && (
        <Card>
          <CardHeader>
            <CardTitle>{t('classReport')}</CardTitle>
          </CardHeader>
          <DataTable
            data={report.rows}
            columns={reportColumns}
            labels={{
              columns: t('dashboard:tableColumns'),
              previous: t('dashboard:tablePrevious'),
              next: t('dashboard:tableNext'),
              empty: t('dashboard:emptyTable'),
              filterPlaceholder: t('dashboard:tableFilterPlaceholder'),
              pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
            }}
            getRowId={(row) => row.userId}
          />
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('enterGradeTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void enterGrade(e)} className="space-y-3">
            <div>
              <Label htmlFor="grade-item">{t('gradeItemId')}</Label>
              <Input id="grade-item" value={gradeItemId} onChange={(e) => setGradeItemId(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="grade-user">{t('studentUserId')}</Label>
              <Input id="grade-user" value={gradeUserId} onChange={(e) => setGradeUserId(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="grade-value">{t('gradeValue')}</Label>
              <Input id="grade-value" value={gradeValue} onChange={(e) => setGradeValue(e.target.value)} />
            </div>
            <Button type="submit">{t('saveGrade')}</Button>
            {message && <p role="status">{message}</p>}
          </form>
        </CardContent>
      </Card>

      {isStaff && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('gradeAdminTitle')}</CardTitle>
              <CardDescription>{t('gradeAdminDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button type="button" variant="outline" onClick={() => void regradeCourse()}>
                {t('regrade')}
              </Button>
              {adminMessage ? <p role="status">{adminMessage}</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('gradeCategoriesAdminTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-3">
                {adminCategories.map((cat) => (
                  <li
                    key={cat.id}
                    data-testid={`grade-category-admin-${cat.id}`}
                    className="space-y-2 rounded border p-3"
                  >
                    <div className="space-y-2">
                      <Label htmlFor={`grade-cat-edit-${cat.id}`}>{t('gradeCategoryName')}</Label>
                      <Input
                        id={`grade-cat-edit-${cat.id}`}
                        value={catEdits[cat.id] ?? cat.fullName}
                        onChange={(e) => setCatEdits((prev) => ({ ...prev, [cat.id]: e.target.value }))}
                      />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {t('gradeCategoryAggregation')}: {cat.aggregation}
                    </p>
                    <div className="flex gap-2">
                      <Button type="button" variant="outline" onClick={() => void saveGradeCategory(cat)}>
                        {t('saveGradeCategory')}
                      </Button>
                      <Button type="button" variant="destructive" onClick={() => void deleteGradeCategory(cat)}>
                        {t('deleteGradeCategory')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <form onSubmit={(e) => void createGradeCategory(e)} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="grade-cat-name">{t('gradeCategoryName')}</Label>
                  <Input id="grade-cat-name" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="grade-cat-aggregation">{t('gradeCategoryAggregation')}</Label>
                  <select
                    id="grade-cat-aggregation"
                    value={newCatAggregation}
                    onChange={(e) => setNewCatAggregation(e.target.value)}
                    className="border px-2 py-1"
                  >
                    {AGGREGATIONS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="submit">{t('createGradeCategory')}</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('gradeItemsAdminTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-3">
                {adminItems.map((item) => {
                  const edit = itemEdits[item.id] ?? { itemName: item.itemName, gradeMax: String(item.gradeMax) };
                  return (
                    <li
                      key={item.id}
                      data-testid={`grade-item-admin-${item.id}`}
                      className="space-y-2 rounded border p-3"
                    >
                      <div className="space-y-2">
                        <Label htmlFor={`grade-item-edit-name-${item.id}`}>{t('gradeItemName')}</Label>
                        <Input
                          id={`grade-item-edit-name-${item.id}`}
                          value={edit.itemName}
                          onChange={(e) =>
                            setItemEdits((prev) => ({ ...prev, [item.id]: { ...edit, itemName: e.target.value } }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`grade-item-edit-max-${item.id}`}>{t('gradeItemMax')}</Label>
                        <Input
                          id={`grade-item-edit-max-${item.id}`}
                          value={edit.gradeMax}
                          onChange={(e) =>
                            setItemEdits((prev) => ({ ...prev, [item.id]: { ...edit, gradeMax: e.target.value } }))
                          }
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button type="button" variant="outline" onClick={() => void saveGradeItem(item)}>
                          {t('saveGradeItem')}
                        </Button>
                        <Button type="button" variant="destructive" onClick={() => void deleteGradeItem(item)}>
                          {t('deleteGradeItem')}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <form onSubmit={(e) => void createGradeItem(e)} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="grade-item-name">{t('gradeItemName')}</Label>
                  <Input id="grade-item-name" value={newItemName} onChange={(e) => setNewItemName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="grade-item-max">{t('gradeItemMax')}</Label>
                  <Input id="grade-item-max" value={newItemMax} onChange={(e) => setNewItemMax(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="grade-item-category">{t('gradeItemCategory')}</Label>
                  <select
                    id="grade-item-category"
                    value={newItemCategoryId}
                    onChange={(e) => setNewItemCategoryId(e.target.value)}
                    className="border px-2 py-1"
                  >
                    <option value="">{t('gradeItemNoCategory')}</option>
                    {adminCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.fullName || t('gradeCourseFallback')}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="submit">{t('createGradeItem')}</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('gradeLettersTitle')}</CardTitle>
              <CardDescription>{t('gradeLettersDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => void saveLetters(e)} className="space-y-3">
                {letterDrafts.map((draft, index) => (
                  <div key={index} className="flex flex-wrap items-end gap-2">
                    <div className="space-y-2">
                      <Label htmlFor={`letter-symbol-${index}`}>{t('letterSymbol')}</Label>
                      <Input
                        id={`letter-symbol-${index}`}
                        value={draft.letter}
                        onChange={(e) =>
                          setLetterDrafts((prev) =>
                            prev.map((d, i) => (i === index ? { ...d, letter: e.target.value } : d)),
                          )
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`letter-boundary-${index}`}>{t('letterLowerBoundary')}</Label>
                      <Input
                        id={`letter-boundary-${index}`}
                        value={draft.lowerBoundary}
                        onChange={(e) =>
                          setLetterDrafts((prev) =>
                            prev.map((d, i) => (i === index ? { ...d, lowerBoundary: e.target.value } : d)),
                          )
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setLetterDrafts((prev) => prev.filter((_, i) => i !== index))}
                    >
                      {t('removeLetter')}
                    </Button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setLetterDrafts((prev) => [...prev, { letter: '', lowerBoundary: '' }])}
                  >
                    {t('addLetter')}
                  </Button>
                  <Button type="submit">{t('saveLetters')}</Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('gradeScalesTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-1">
                {adminScales.map((s) => (
                  <li key={s.id} className="text-sm">
                    <span className="font-medium">{s.name}</span>: {s.scale}
                  </li>
                ))}
                {adminScales.length === 0 ? <li className="text-sm text-muted-foreground">{t('noScales')}</li> : null}
              </ul>
              <form onSubmit={(e) => void createScale(e)} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="scale-name">{t('scaleName')}</Label>
                  <Input id="scale-name" value={scaleName} onChange={(e) => setScaleName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="scale-values">{t('scaleValues')}</Label>
                  <Input id="scale-values" value={scaleValues} onChange={(e) => setScaleValues(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="scale-description">{t('scaleDescriptionLabel')}</Label>
                  <Input
                    id="scale-description"
                    value={scaleDescription}
                    onChange={(e) => setScaleDescription(e.target.value)}
                  />
                </div>
                <Button type="submit">{t('createScale')}</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('gradeOutcomesTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-2">
                {adminOutcomes.map((outcome) => (
                  <li key={outcome.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <Input
                      aria-label={t('outcomeName')}
                      className="max-w-xs"
                      value={outcomeEdits[outcome.id] ?? outcome.name}
                      onChange={(e) => setOutcomeEdits((prev) => ({ ...prev, [outcome.id]: e.target.value }))}
                    />
                    <span className="text-muted-foreground">
                      {adminScales.find((s) => s.id === outcome.scaleId)?.name ?? outcome.scaleId}
                    </span>
                    {outcome.courseId === null ? (
                      <span className="text-muted-foreground">{t('outcomeSiteBadge')}</span>
                    ) : null}
                    <Button type="button" variant="outline" size="sm" onClick={() => void updateOutcome(outcome)}>
                      {t('saveOutcome')}
                    </Button>
                    <Button type="button" variant="destructive" size="sm" onClick={() => void deleteOutcome(outcome)}>
                      {t('deleteOutcome')}
                    </Button>
                  </li>
                ))}
                {adminOutcomes.length === 0 ? (
                  <li className="text-sm text-muted-foreground">{t('noOutcomes')}</li>
                ) : null}
              </ul>
              <form onSubmit={(e) => void createOutcome(e)} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="outcome-name">{t('outcomeName')}</Label>
                  <Input id="outcome-name" value={outcomeName} onChange={(e) => setOutcomeName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="outcome-scale">{t('outcomeScale')}</Label>
                  <select
                    id="outcome-scale"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                    value={outcomeScaleId}
                    onChange={(e) => setOutcomeScaleId(e.target.value)}
                  >
                    {adminScales.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="outcome-description">{t('outcomeDescriptionLabel')}</Label>
                  <Input
                    id="outcome-description"
                    value={outcomeDescription}
                    onChange={(e) => setOutcomeDescription(e.target.value)}
                  />
                </div>
                <Button type="submit">{t('createOutcome')}</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('gradeHistoryTitle')}</CardTitle>
              <CardDescription>{t('gradeHistoryDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <form onSubmit={(e) => void loadHistory(e)} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="history-item">{t('gradeItem')}</Label>
                  <select
                    id="history-item"
                    value={historyItemId}
                    onChange={(e) => setHistoryItemId(e.target.value)}
                    className="border px-2 py-1"
                  >
                    <option value="">{t('gradeItem')}</option>
                    {adminItems.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.itemName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="history-user">{t('studentUserId')}</Label>
                  <Input id="history-user" value={historyUserId} onChange={(e) => setHistoryUserId(e.target.value)} />
                </div>
                <Button type="submit">{t('viewHistory')}</Button>
              </form>
              {historyError ? <p role="alert">{historyError}</p> : null}
              {historyRows !== null && historyRows.length === 0 ? <p>{t('historyEmpty')}</p> : null}
              {historyRows !== null && historyRows.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {historyRows.map((row) => (
                    <li key={row.id}>
                      {t('historyLine', {
                        time: row.updatedAt,
                        raw: row.rawGrade ?? '—',
                        final: row.finalGrade ?? '—',
                        action:
                          row.action === 1
                            ? t('historyActionInsert')
                            : row.action === 3
                              ? t('historyActionDelete')
                              : t('historyActionUpdate'),
                      })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default GradebookPage; /** Thụt lề theo độ sâu cây hạng mục điểm: bảng class tĩnh theo từng cấp (mỗi cấp 16px), tránh style nội tuyến. */
const CATEGORY_INDENT = ['ml-0', 'ml-4', 'ml-8', 'ml-12', 'ml-16', 'ml-20'];
