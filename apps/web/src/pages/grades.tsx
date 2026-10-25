import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GradeItem } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
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
import { apiFetch, apiJson } from '#lib/api';
import { fetchCourseGradeData, usePermissions } from '#lib/permissions';
import { queryKeys } from '#lib/query-keys';

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

/** Loại cột vnEdu (TT 22/2021) mà giáo viên gán cho một mục điểm khi xuất Excel — issue #53. */
type VneduColumnKind = 'none' | 'regular' | 'midterm' | 'final';

/**
 * Mục điểm đủ điều kiện làm cột thành phần vnEdu: mục của một bài
 * (nhập tay hoặc hoạt động), điểm số dạng value — khớp đúng điều kiện
 * phía API kiểm khi xuất. Từ issue #224, bài còn phải ĐÃ CÔNG BỐ.
 */
function isVneduExportableItem(item: GradeItem): boolean {
  return (item.itemType === 'manual' || item.itemType === 'mod') && (item.gradeType ?? 'value') === 'value';
}

/**
 * Gợi ý loại cột vnEdu từ tên mục điểm. Đây CHỈ là mặc định trên giao diện
 * để giáo viên đỡ phải chọn lại từ đầu — giáo viên xác nhận trước khi xuất
 * và phía API không hề đoán theo tên.
 */
function guessVneduColumnKind(item: GradeItem): VneduColumnKind {
  const name = item.itemName.toLowerCase();
  if (/giữa\s*k[ỳì]|giua\s*ky|midterm|\bgk\b/.test(name)) return 'midterm';
  if (/cuối\s*k[ỳì]|cuoi\s*ky|học\s*k[ỳì]|hoc\s*ky|\bck\b|final/.test(name)) return 'final';
  return 'regular';
}

/** Số điểm hiển thị theo ngôn ngữ (tối đa 2 chữ số thập phân, không ép 0) — cùng quy ước trang phụ huynh. */
function scoreLabel(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/**
 * Trang Điểm theo bài của một khoá (issue #224 — thay trang Sổ điểm
 * tổng hợp): học sinh xem điểm của TỪNG BÀI của mình (chỉ bài đã công
 * bố mới hiện điểm); giáo viên xem lưới CHỈ-ĐỌC học sinh × các bài,
 * quản trị mục điểm + công bố theo bài, nhập điểm và xuất vnEdu từ các
 * bài đã công bố. Không còn điểm tổng khoá, hạng mục, thang chữ,
 * scales/outcomes hay sổ VN ở bất kỳ bề mặt nào.
 *
 * Khu quản trị chỉ render cho staff của khoá (grade:viewall tại
 * context khoá hoặc quản trị hệ thống) qua `usePermissions()`. Lưu ý
 * các endpoint sửa/xoá item và nhập điểm KHÔNG mang tiền tố courseId
 * (PATCH/DELETE /courses/grades/items/:id, POST
 * /courses/grades/items/:itemId/grades) — đúng controller phía API.
 */
export function GradebookPage() {
  const { t, i18n } = useTranslation('app');
  const { id } = useParams();
  const courseId = id ?? '';
  const perms = usePermissions();
  // Điểm theo bài + lưới lớp đọc qua TanStack với ĐÚNG khoá
  // `courseAccess` và fetcher mà PermissionsProvider dùng (F-03, rà
  // soát #133): cache dùng chung, trang mở sau provider thì không tốn
  // request thêm.
  const gradeDataQuery = useQuery({
    queryKey: queryKeys.courseAccess(courseId),
    queryFn: () => fetchCourseGradeData(courseId),
  });
  const book = gradeDataQuery.data?.gradebook ?? null;
  const report = gradeDataQuery.data?.report ?? null;
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [gradeItemId, setGradeItemId] = useState('');
  const [gradeUserId, setGradeUserId] = useState('');
  const [gradeValue, setGradeValue] = useState('');
  const [gradeFeedback, setGradeFeedback] = useState('');

  /** Staff của khoá này hay không: teaching của khoá hoặc quản trị hệ thống. */
  const courseAccess = perms.courses.find((c) => c.course.id === courseId);
  const isStaff =
    perms.canAdminister ||
    perms.teaching.some((c) => c.course.id === courseId) ||
    (courseAccess?.capabilities.includes('grade:viewall') ?? false);

  const items: GradeItem[] = report?.items ?? book?.activities.map((a) => a.item) ?? [];
  const [newItemName, setNewItemName] = useState('');
  const [newItemMax, setNewItemMax] = useState('10');
  const [itemEdits, setItemEdits] = useState<Record<string, { itemName: string; gradeMax: string }>>({});
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [vneduKinds, setVneduKinds] = useState<Record<string, VneduColumnKind>>({});
  const [vneduSemester, setVneduSemester] = useState('1');
  const [vneduSchoolYear, setVneduSchoolYear] = useState('');
  const [vneduSubject, setVneduSubject] = useState('');
  const [vneduClass, setVneduClass] = useState('');
  const [vneduMessage, setVneduMessage] = useState<string | null>(null);
  const [historyItemId, setHistoryItemId] = useState('');
  const [historyUserId, setHistoryUserId] = useState('');
  const [historyRows, setHistoryRows] = useState<GradeHistoryView[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  /** Nạp lại dữ liệu điểm sau đột biến: invalidate đúng khoá dùng chung với provider. */
  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.courseAccess(courseId) });
  }, [queryClient, courseId]);

  useEffect(() => {
    if (gradeDataQuery.data) {
      setError(gradeDataQuery.data.gradebook ? null : t('gradebookLoadFailed'));
    }
  }, [gradeDataQuery.data, t]);

  // Gợi ý ánh xạ vnEdu mặc định theo tên bài khi danh sách bài đổi.
  useEffect(() => {
    setVneduKinds((prev) => {
      const next: Record<string, VneduColumnKind> = {};
      for (const item of items) next[item.id] = prev[item.id] ?? guessVneduColumnKind(item);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.id).join(',')]);

  /** Nhập/sửa điểm một bài cho một học sinh (POST /courses/grades/items/:itemId/grades). */
  async function submitGrade(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    try {
      await apiJson(`/api/v1/courses/grades/items/${gradeItemId}/grades`, {
        method: 'POST',
        body: JSON.stringify({
          userId: gradeUserId,
          rawGrade: gradeValue.trim() === '' ? null : Number(gradeValue),
          ...(gradeFeedback.trim() ? { feedback: gradeFeedback.trim() } : {}),
        }),
      });
      setMessage(t('gradeSaved'));
      await reload();
    } catch {
      setError(t('gradeSaveFailed'));
    }
  }

  /** Tạo mục điểm nhập tay mới cho một bài/đợt riêng của khoá. */
  async function createItem(event: FormEvent) {
    event.preventDefault();
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/grades/items`, {
        method: 'POST',
        body: JSON.stringify({ itemName: newItemName, gradeMax: Number(newItemMax) }),
      });
      setNewItemName('');
      setAdminMessage(t('gradeItemCreated'));
      await reload();
    } catch {
      setAdminMessage(t('gradeItemCreateFailedAdmin'));
    }
  }

  /** Lưu sửa tên/thang điểm của một mục (PATCH /courses/grades/items/:id). */
  async function saveItemEdit(item: GradeItem) {
    const edit = itemEdits[item.id];
    if (!edit) return;
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ itemName: edit.itemName, gradeMax: Number(edit.gradeMax) }),
      });
      setAdminMessage(t('gradeItemUpdated'));
      await reload();
    } catch {
      setAdminMessage(t('gradeItemUpdateFailed'));
    }
  }

  /** Xoá một mục điểm và mọi điểm của nó (DELETE /courses/grades/items/:id). */
  async function deleteItem(item: GradeItem) {
    if (!window.confirm(t('confirmDeleteGradeItem', { name: item.itemName }))) return;
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/items/${item.id}`, { method: 'DELETE' });
      setAdminMessage(t('gradeItemDeleted'));
      await reload();
    } catch {
      setAdminMessage(t('gradeItemDeleteFailed'));
    }
  }

  /** Đặt chính sách công bố của một bài (PUT /courses/grades/items/:id/posting-policy). */
  async function setPostingPolicy(item: GradeItem, policy: 'auto' | 'manual') {
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/items/${item.id}/posting-policy`, {
        method: 'PUT',
        body: JSON.stringify({ policy }),
      });
      setAdminMessage(t('gradesPublicationUpdated'));
      await reload();
    } catch {
      setAdminMessage(t('gradesPublicationUpdateFailed'));
    }
  }

  /** Công bố / thu hồi công bố điểm của một bài (POST .../publish | .../unpublish). */
  async function setPublished(item: GradeItem, published: boolean) {
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/items/${item.id}/${published ? 'publish' : 'unpublish'}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setAdminMessage(t('gradesPublicationUpdated'));
      await reload();
    } catch {
      setAdminMessage(t('gradesPublicationUpdateFailed'));
    }
  }

  /**
   * Xuất Excel vnEdu qua POST /courses/:courseId/grades/export/vnedu
   * (issue #53; nguồn đổi ở #224): chỉ các bài ĐÃ CÔNG BỐ mới được
   * chọn; giáo viên xác nhận ánh xạ bài → loại cột kèm học kỳ, năm
   * học, môn và lớp (để trống thì server lấy mặc định từ khoá học).
   * Ánh xạ chưa hợp lệ thì chặn ngay tại giao diện.
   */
  async function downloadGradesVnedu(event: FormEvent) {
    event.preventDefault();
    setVneduMessage(null);
    const exportable = items.filter(
      (i) => isVneduExportableItem(i) && (report?.publications[i.id]?.published ?? false),
    );
    const regularItemIds = exportable.filter((i) => (vneduKinds[i.id] ?? 'none') === 'regular').map((i) => i.id);
    const midterms = exportable.filter((i) => vneduKinds[i.id] === 'midterm');
    const finals = exportable.filter((i) => vneduKinds[i.id] === 'final');
    if (!regularItemIds.length || midterms.length !== 1 || finals.length !== 1) {
      setVneduMessage(t('vneduMappingInvalid'));
      return;
    }
    try {
      const response = await apiFetch(`/api/v1/courses/${courseId}/grades/export/vnedu`, {
        method: 'POST',
        body: JSON.stringify({
          regularItemIds,
          midtermItemId: midterms[0]!.id,
          finalItemId: finals[0]!.id,
          semester: Number(vneduSemester),
          ...(vneduSchoolYear.trim() ? { schoolYear: vneduSchoolYear.trim() } : {}),
          ...(vneduSubject.trim() ? { subjectName: vneduSubject.trim() } : {}),
          ...(vneduClass.trim() ? { className: vneduClass.trim() } : {}),
        }),
      });
      if (!response.ok) throw new Error('vnedu export failed');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `vnedu-${courseId}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setVneduMessage(t('vneduExported'));
    } catch {
      setVneduMessage(t('vneduExportFailed'));
    }
  }

  /**
   * Xem lịch sử điểm của một học viên trên một mục điểm qua
   * GET /courses/grades/items/:itemId/users/:userId/history.
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

  if (gradeDataQuery.isPending)
    return (
      <PageShell width="full">
        <PageHeader title={t('gradebook')} />
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      </PageShell>
    );
  if (!book && !report)
    return (
      <PageShell width="full">
        <PageHeader title={t('gradebook')} />
        <Alert variant="destructive">
          <AlertDescription>{error ?? t('gradebookLoadFailed')}</AlertDescription>
        </Alert>
      </PageShell>
    );

  const myActivities = book?.activities ?? [];

  return (
    <PageShell width="full">
      <PageHeader title={t('gradebook')} />
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="mb-4">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      {/* Điểm của chính người dùng: từng bài một, kèm trạng thái công bố. */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t('myGradesTitle')}</CardTitle>
          <CardDescription>{t('myGradesDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {myActivities.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t('gradesNoActivities')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">{t('gradeItem')}</th>
                  <th className="py-2 pr-4 font-medium">{t('grade')}</th>
                  <th className="py-2 pr-4 font-medium">{t('gradesFeedback')}</th>
                  <th className="py-2 font-medium">{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {myActivities.map(({ item, grade, publication }) => (
                  <tr key={item.id} className="border-t">
                    <td className="py-2 pr-4">{item.itemName}</td>
                    <td className="py-2 pr-4">
                      {grade?.finalGrade !== null && grade?.finalGrade !== undefined
                        ? `${scoreLabel(grade.finalGrade, i18n.language)} / ${scoreLabel(item.gradeMax, i18n.language)}`
                        : '—'}
                    </td>
                    <td className="py-2 pr-4">{grade?.feedback ?? ''}</td>
                    <td className="py-2">{publication.published ? t('gradesPublished') : t('gradesUnpublished')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {isStaff && report && (
        <>
          {/* Lưới chỉ-đọc học sinh × các bài cho giáo viên. */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>{t('gradesGridTitle')}</CardTitle>
              <CardDescription>{t('gradesGridDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">{t('gradesStudentColumn')}</th>
                      {report.items.map((item) => (
                        <th key={item.id} className="py-2 pr-4 font-medium">
                          {item.itemName}
                          <span className="block text-xs font-normal">
                            {report.publications[item.id]?.published ? t('gradesPublished') : t('gradesUnpublished')}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr key={row.userId} className="border-t">
                        <td className="py-2 pr-4">{row.displayName}</td>
                        {report.items.map((item) => (
                          <td key={item.id} className="py-2 pr-4">
                            {row.grades[item.id] !== null && row.grades[item.id] !== undefined
                              ? scoreLabel(row.grades[item.id]!, i18n.language)
                              : '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Quản trị mục điểm + công bố theo bài. */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>{t('gradeItemsAdminTitle')}</CardTitle>
              <CardDescription>{t('gradeAdminDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              {adminMessage && (
                <Alert className="mb-4">
                  <AlertDescription>{adminMessage}</AlertDescription>
                </Alert>
              )}
              <ul className="divide-y">
                {items.map((item) => {
                  const publication = report.publications[item.id] ?? { policy: 'auto' as const, published: true };
                  const edit = itemEdits[item.id] ?? { itemName: item.itemName, gradeMax: String(item.gradeMax) };
                  return (
                    <li key={item.id} className="flex flex-wrap items-center gap-2 py-3">
                      <Input
                        aria-label={t('gradeItemName')}
                        className="w-56"
                        value={edit.itemName}
                        onChange={(e) =>
                          setItemEdits((prev) => ({ ...prev, [item.id]: { ...edit, itemName: e.target.value } }))
                        }
                      />
                      <Input
                        aria-label={t('gradeItemMax')}
                        className="w-24"
                        type="number"
                        value={edit.gradeMax}
                        onChange={(e) =>
                          setItemEdits((prev) => ({ ...prev, [item.id]: { ...edit, gradeMax: e.target.value } }))
                        }
                      />
                      <span className="text-sm text-muted-foreground">{item.itemType}</span>
                      <Select
                        value={publication.policy}
                        onValueChange={(value) => void setPostingPolicy(item, value as 'auto' | 'manual')}
                      >
                        <SelectTrigger className="w-64" aria-label={t('gradesPostingPolicy')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">{t('gradesPostingAuto')}</SelectItem>
                          <SelectItem value="manual">{t('gradesPostingManual')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button size="sm" variant="outline" onClick={() => void saveItemEdit(item)}>
                        {t('saveGradeItem')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void setPublished(item, !publication.published)}
                      >
                        {publication.published ? t('gradesUnpublish') : t('gradesPublish')}
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => void deleteItem(item)}>
                        {t('deleteGradeItem')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
              <form onSubmit={createItem} className="mt-4 flex flex-wrap items-end gap-2">
                <Field>
                  <FieldLabel>{t('gradeItemName')}</FieldLabel>
                  <Input id="grade-item-name" value={newItemName} onChange={(e) => setNewItemName(e.target.value)} required />
                </Field>
                <Field>
                  <FieldLabel>{t('gradeItemMax')}</FieldLabel>
                  <Input
                    id="grade-item-max"
                    type="number"
                    className="w-24"
                    value={newItemMax}
                    onChange={(e) => setNewItemMax(e.target.value)}
                    required
                  />
                </Field>
                <Button type="submit">{t('createGradeItem')}</Button>
              </form>
            </CardContent>
          </Card>

          {/* Nhập điểm + lịch sử điểm. */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>{t('enterGradeTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={submitGrade}>
                <FieldGroup>
                  <Field>
                    <FieldLabel>{t('gradeItem')}</FieldLabel>
                    <Select value={gradeItemId} onValueChange={(value) => setGradeItemId(value ?? '')}>
                      <SelectTrigger aria-label={t('gradeItem')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {items.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.itemName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>{t('gradesStudentColumn')}</FieldLabel>
                    <Select value={gradeUserId} onValueChange={(value) => setGradeUserId(value ?? '')}>
                      <SelectTrigger aria-label={t('gradesStudentColumn')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {report.rows.map((row) => (
                          <SelectItem key={row.userId} value={row.userId}>
                            {row.displayName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>{t('gradeValue')}</FieldLabel>
                    <Input value={gradeValue} onChange={(e) => setGradeValue(e.target.value)} inputMode="decimal" />
                  </Field>
                  <Field>
                    <FieldLabel>{t('gradesFeedback')}</FieldLabel>
                    <Input value={gradeFeedback} onChange={(e) => setGradeFeedback(e.target.value)} />
                  </Field>
                </FieldGroup>
                <Button type="submit" className="mt-3" disabled={!gradeItemId || !gradeUserId}>
                  {t('saveGrade')}
                </Button>
              </form>

              <h3 className="mt-8 font-medium">{t('gradeHistoryTitle')}</h3>
              <p className="text-sm text-muted-foreground">{t('gradeHistoryDescription')}</p>
              <form onSubmit={loadHistory} className="mt-3 flex flex-wrap items-end gap-2">
                <Field>
                  <FieldLabel>{t('gradeItem')}</FieldLabel>
                  <Select value={historyItemId} onValueChange={(value) => setHistoryItemId(value ?? '')}>
                    <SelectTrigger aria-label={t('gradeItem')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {items.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.itemName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>{t('gradesStudentColumn')}</FieldLabel>
                  <Select value={historyUserId} onValueChange={(value) => setHistoryUserId(value ?? '')}>
                    <SelectTrigger aria-label={t('gradesStudentColumn')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {report.rows.map((row) => (
                        <SelectItem key={row.userId} value={row.userId}>
                          {row.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Button type="submit" variant="outline" disabled={!historyItemId || !historyUserId}>
                  {t('viewHistory')}
                </Button>
              </form>
              {historyError && (
                <Alert variant="destructive" className="mt-3">
                  <AlertDescription>{historyError}</AlertDescription>
                </Alert>
              )}
              {historyRows && (
                <ul className="mt-3 space-y-1 text-sm">
                  {historyRows.map((row) => (
                    <li key={row.id}>
                      {row.updatedAt} · {row.finalGrade ?? '—'} · {row.source ?? ''}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Xuất vnEdu từ các bài đã công bố. */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>{t('exportGradesVnedu')}</CardTitle>
              <CardDescription>{t('gradesVneduOnlyPublished')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={downloadGradesVnedu}>
                <ul className="divide-y">
                  {items.filter(isVneduExportableItem).map((item) => {
                    const published = report.publications[item.id]?.published ?? false;
                    return (
                      <li key={item.id} className="flex flex-wrap items-center gap-2 py-2">
                        <span className="w-56">{item.itemName}</span>
                        <Select
                          value={vneduKinds[item.id] ?? 'none'}
                          onValueChange={(value) =>
                            setVneduKinds((prev) => ({ ...prev, [item.id]: value as VneduColumnKind }))
                          }
                          disabled={!published}
                        >
                          <SelectTrigger className="w-48" aria-label={item.itemName}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">{t('vneduKindNone')}</SelectItem>
                            <SelectItem value="regular">{t('vneduKindRegular')}</SelectItem>
                            <SelectItem value="midterm">{t('vneduKindMidterm')}</SelectItem>
                            <SelectItem value="final">{t('vneduKindFinal')}</SelectItem>
                          </SelectContent>
                        </Select>
                        {!published && <span className="text-sm text-muted-foreground">{t('gradesUnpublished')}</span>}
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-4 flex flex-wrap items-end gap-2">
                  <Field>
                    <FieldLabel>{t('vneduSemester')}</FieldLabel>
                    <Select value={vneduSemester} onValueChange={(value) => setVneduSemester(value ?? '1')}>
                      <SelectTrigger className="w-32" aria-label={t('vneduSemester')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1</SelectItem>
                        <SelectItem value="2">2</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>{t('vneduSchoolYear')}</FieldLabel>
                    <Input value={vneduSchoolYear} onChange={(e) => setVneduSchoolYear(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel>{t('vneduSubjectName')}</FieldLabel>
                    <Input value={vneduSubject} onChange={(e) => setVneduSubject(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel>{t('vneduClassName')}</FieldLabel>
                    <Input value={vneduClass} onChange={(e) => setVneduClass(e.target.value)} />
                  </Field>
                  <Button type="submit">{t('exportGradesVnedu')}</Button>
                </div>
                {vneduMessage && (
                  <Alert className="mt-3">
                    <AlertDescription>{vneduMessage}</AlertDescription>
                  </Alert>
                )}
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </PageShell>
  );
}
