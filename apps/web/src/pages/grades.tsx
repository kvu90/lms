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
import { DataTable, type DataColumn } from '#components/data-table';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiFetch, apiJson } from '#lib/api';
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
 * Một lỗi import CSV như API trả về (báo cáo của POST grades/import):
 * dòng trên bảng tính (tiêu đề là dòng 1), cột gây lỗi và mã lỗi nghiệp vụ.
 */
interface GradeImportErrorView {
  row: number;
  column: string | null;
  code: string;
  message: string;
}

/** Báo cáo import CSV như API trả về: số ô đã nhập/bỏ qua, lỗi theo ô và các cột bị bỏ qua. */
interface GradeImportResultView {
  imported: number;
  skipped: number;
  errors: GradeImportErrorView[];
  ignoredColumns: string[];
}

/** Loại cột vnEdu (TT 22/2021) mà giáo viên gán cho một mục điểm khi xuất Excel — issue #53. */
type VneduColumnKind = 'none' | 'regular' | 'midterm' | 'final';

/**
 * Mục điểm đủ điều kiện làm cột thành phần vnEdu: mục lá (nhập tay hoặc
 * hoạt động), điểm số dạng value, không phải mục tính bằng công thức —
 * khớp đúng điều kiện phía API kiểm khi xuất.
 */
function isVneduExportableItem(item: GradeItem): boolean {
  return (item.itemType === 'manual' || item.itemType === 'mod') && (item.gradeType ?? 'value') === 'value' && !item.calculation;
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

/** Năm học hiện tại dạng "2026-2027": năm học Việt Nam bắt đầu từ tháng 8. */
function currentSchoolYear(now = new Date()): string {
  const start = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}-${start + 1}`;
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
    (courseAccess?.capabilities.includes('grade:viewall') ?? false);

  const [adminCategories, setAdminCategories] = useState<GradeCategory[]>([]);
  const [adminItems, setAdminItems] = useState<GradeItem[]>([]);
  const [adminScales, setAdminScales] = useState<GradeScaleView[]>([]);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<GradeImportErrorView[]>([]);
  const [vneduKinds, setVneduKinds] = useState<Record<string, VneduColumnKind>>({});
  const [vneduSemester, setVneduSemester] = useState('1');
  const [vneduSchoolYear, setVneduSchoolYear] = useState('');
  const [vneduSubject, setVneduSubject] = useState('');
  const [vneduClass, setVneduClass] = useState('');
  const [vneduMessage, setVneduMessage] = useState<string | null>(null);
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
    // Mặc định ánh xạ vnEdu theo tên mục (giáo viên sửa được từng mục);
    // mục đã có lựa chọn của giáo viên thì giữ nguyên qua các lần nạp lại.
    setVneduKinds((prev) => {
      const next = { ...prev };
      for (const item of items) {
        if (!(item.id in next)) next[item.id] = isVneduExportableItem(item) ? guessVneduColumnKind(item) : 'none';
      }
      return next;
    });
    setVneduSchoolYear((prev) => prev || currentSchoolYear());
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

  /**
   * Tải bảng điểm CSV của khoá qua GET /courses/:courseId/grades/export
   * (endpoint đòi đăng nhập nên fetch kèm token rồi tải blob như xuất lịch).
   */
  async function downloadGradesCsv() {
    setAdminMessage(null);
    try {
      const response = await apiFetch(`/api/v1/courses/${courseId}/grades/export`);
      if (!response.ok) throw new Error('export failed');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `grades-${courseId}.csv`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setAdminMessage(t('gradesExported'));
    } catch {
      setAdminMessage(t('gradesExportFailed'));
    }
  }

  /**
   * Nhập điểm từ tệp CSV đã chọn qua POST /courses/:courseId/grades/import
   * (multipart, trường `file`); hiển thị bản tóm tắt của báo cáo import và
   * từng lỗi theo dòng/cột, rồi tải lại sổ điểm và báo cáo lớp.
   */
  async function importGradesCsv(event: FormEvent) {
    event.preventDefault();
    if (!importFile) return;
    setImportSummary(null);
    setImportErrors([]);
    try {
      const form = new FormData();
      form.append('file', importFile);
      const response = await apiFetch(`/api/v1/courses/${courseId}/grades/import`, { method: 'POST', body: form });
      if (!response.ok) throw new Error('import failed');
      const result = (await response.json()) as GradeImportResultView;
      setImportSummary(
        t('gradesImportSummary', {
          imported: result.imported,
          skipped: result.skipped,
          errors: result.errors.length,
          ignored: result.ignoredColumns.length,
        }),
      );
      setImportErrors(result.errors);
      await reload().catch(() => undefined);
    } catch {
      setImportSummary(t('gradesImportFailed'));
    }
  }

  /**
   * Xuất Excel vnEdu qua POST /courses/:courseId/grades/export/vnedu
   * (issue #53): gửi ánh xạ mục điểm → loại cột đang chọn kèm học kỳ, năm
   * học, môn và lớp (để trống thì server lấy mặc định từ khoá học), nhận
   * blob .xlsx và tải xuống như đường xuất CSV. Ánh xạ chưa hợp lệ (thiếu
   * thường xuyên, không đúng một giữa kỳ/một cuối kỳ) thì chặn ngay tại
   * giao diện, không gọi API.
   */
  async function downloadGradesVnedu(event: FormEvent) {
    event.preventDefault();
    setVneduMessage(null);
    const exportable = adminItems.filter(isVneduExportableItem);
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
        {/* §5.4: bảng cuộn ngang trong khung; cột đầu (tên mục điểm)
            dính trái với nền đặc để không bị nội dung cuộn đè lên. */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 bg-background text-left">{t('gradeItem')}</th>
                <th className="text-left">{t('grade')}</th>
                <th className="text-left">{t('letter')}</th>
                <th className="text-left">{t('max')}</th>
              </tr>
            </thead>
            <tbody>
              {view.items.map(({ item, grade }) => (
                <tr key={item.id} data-testid={`grade-item-${item.id}`}>
                  <td className="sticky left-0 bg-background">
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
        </div>
        {view.children.map((child) => renderCategory(child, depth + 1))}
      </div>
    );
  }

  if (error)
    return (
      <PageShell width="full">
        <PageHeader title={t('gradebook')} />
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setError(null);
              void reload().catch(() => setError(t('gradebookLoadFailed')));
            }}
          >
            {t('retry')}
          </Button>
        </div>
      </PageShell>
    );
  if (!book)
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
    <PageShell width="full">
      <PageHeader
        title={t('gradebook')}
        description={t('courseTotalLine', {
          grade: book.courseTotal?.grade?.finalGrade ?? '—',
          letterSuffix: book.courseTotal?.grade?.letter
            ? t('letterSuffix', { letter: book.courseTotal.grade.letter })
            : '',
        })}
      />
      <Card>
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
          <form onSubmit={(e) => void enterGrade(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="grade-item">{t('gradeItemId')}</FieldLabel>
                <Input id="grade-item" value={gradeItemId} onChange={(e) => setGradeItemId(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="grade-user">{t('studentUserId')}</FieldLabel>
                <Input id="grade-user" value={gradeUserId} onChange={(e) => setGradeUserId(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="grade-value">{t('gradeValue')}</FieldLabel>
                <Input id="grade-value" value={gradeValue} onChange={(e) => setGradeValue(e.target.value)} />
              </Field>
              <div className="flex justify-end">
                <Button type="submit">{t('saveGrade')}</Button>
              </div>
              {message ? (
                <Alert>
                  <AlertDescription>{message}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
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
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" onClick={() => void downloadGradesCsv()}>
                  {t('exportGradesCsv')}
                </Button>
              </div>
              <form onSubmit={(e) => void importGradesCsv(e)} className="space-y-2">
                <Field>
                  <FieldLabel htmlFor="grades-import-file">{t('importGradesCsvFile')}</FieldLabel>
                  <Input
                    id="grades-import-file"
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                  />
                </Field>
                <Button type="submit" variant="outline" disabled={!importFile}>
                  {t('importGradesCsv')}
                </Button>
                {importSummary ? (
                  <Alert>
                    <AlertDescription>{importSummary}</AlertDescription>
                  </Alert>
                ) : null}
                {importErrors.length ? (
                  <ul className="space-y-1 text-sm">
                    {importErrors.map((err) => (
                      <li key={`${err.row}-${err.column ?? ''}-${err.code}`}>
                        {t('gradesImportErrorLine', {
                          row: err.row,
                          column: err.column ?? '—',
                          message: err.message,
                        })}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </form>
              <form onSubmit={(e) => void downloadGradesVnedu(e)} className="space-y-3 border-t pt-3">
                <div>
                  <p className="font-medium">{t('vneduExportTitle')}</p>
                  <p className="text-sm">{t('vneduExportDescription')}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel id="vnedu-semester-label">{t('vneduSemester')}</FieldLabel>
                    <Select
                      items={{ '1': t('vneduSemester1'), '2': t('vneduSemester2') }}
                      value={vneduSemester}
                      onValueChange={(v) => setVneduSemester(v ?? '1')}
                    >
                      <SelectTrigger aria-labelledby="vnedu-semester-label" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">{t('vneduSemester1')}</SelectItem>
                        <SelectItem value="2">{t('vneduSemester2')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="vnedu-school-year">{t('vneduSchoolYear')}</FieldLabel>
                    <Input
                      id="vnedu-school-year"
                      value={vneduSchoolYear}
                      onChange={(e) => setVneduSchoolYear(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="vnedu-subject">{t('vneduSubjectName')}</FieldLabel>
                    <Input
                      id="vnedu-subject"
                      value={vneduSubject}
                      onChange={(e) => setVneduSubject(e.target.value)}
                      placeholder={t('vneduSubjectPlaceholder')}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="vnedu-class">{t('vneduClassName')}</FieldLabel>
                    <Input
                      id="vnedu-class"
                      value={vneduClass}
                      onChange={(e) => setVneduClass(e.target.value)}
                      placeholder={t('vneduClassPlaceholder')}
                    />
                  </Field>
                </div>
                <ul className="space-y-2">
                  {adminItems.filter(isVneduExportableItem).map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-2">
                      <FieldLabel id={`vnedu-kind-label-${item.id}`} className="min-w-40">
                        {item.itemName}
                      </FieldLabel>
                      <Select
                        items={{
                          none: t('vneduKindNone'),
                          regular: t('vneduKindRegular'),
                          midterm: t('vneduKindMidterm'),
                          final: t('vneduKindFinal'),
                        }}
                        value={vneduKinds[item.id] ?? 'none'}
                        onValueChange={(v) =>
                          setVneduKinds((prev) => ({ ...prev, [item.id]: (v ?? 'none') as VneduColumnKind }))
                        }
                      >
                        <SelectTrigger aria-labelledby={`vnedu-kind-label-${item.id}`} className="w-48">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{t('vneduKindNone')}</SelectItem>
                          <SelectItem value="regular">{t('vneduKindRegular')}</SelectItem>
                          <SelectItem value="midterm">{t('vneduKindMidterm')}</SelectItem>
                          <SelectItem value="final">{t('vneduKindFinal')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </li>
                  ))}
                </ul>
                <Button type="submit" variant="outline">
                  {t('exportGradesVnedu')}
                </Button>
                {vneduMessage ? (
                  <Alert>
                    <AlertDescription>{vneduMessage}</AlertDescription>
                  </Alert>
                ) : null}
              </form>
              {adminMessage ? (
                <Alert>
                  <AlertDescription>{adminMessage}</AlertDescription>
                </Alert>
              ) : null}
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
                    <Field>
                      <FieldLabel htmlFor={`grade-cat-edit-${cat.id}`}>{t('gradeCategoryName')}</FieldLabel>
                      <Input
                        id={`grade-cat-edit-${cat.id}`}
                        value={catEdits[cat.id] ?? cat.fullName}
                        onChange={(e) => setCatEdits((prev) => ({ ...prev, [cat.id]: e.target.value }))}
                      />
                    </Field>
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
              <form onSubmit={(e) => void createGradeCategory(e)}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="grade-cat-name">{t('gradeCategoryName')}</FieldLabel>
                    <Input id="grade-cat-name" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel id="grade-cat-aggregation-label">{t('gradeCategoryAggregation')}</FieldLabel>
                    <Select
                      items={Object.fromEntries(AGGREGATIONS.map((a) => [a, t(`gradeAggregation_${a}`)]))}
                      value={newCatAggregation}
                      onValueChange={(v) => setNewCatAggregation(v ?? 'natural')}
                    >
                      <SelectTrigger aria-labelledby="grade-cat-aggregation-label" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AGGREGATIONS.map((a) => (
                          <SelectItem key={a} value={a}>
                            {a}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="flex justify-end">
                    <Button type="submit">{t('createGradeCategory')}</Button>
                  </div>
                </FieldGroup>
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
                      <Field>
                        <FieldLabel htmlFor={`grade-item-edit-name-${item.id}`}>{t('gradeItemName')}</FieldLabel>
                        <Input
                          id={`grade-item-edit-name-${item.id}`}
                          value={edit.itemName}
                          onChange={(e) =>
                            setItemEdits((prev) => ({ ...prev, [item.id]: { ...edit, itemName: e.target.value } }))
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`grade-item-edit-max-${item.id}`}>{t('gradeItemMax')}</FieldLabel>
                        <Input
                          id={`grade-item-edit-max-${item.id}`}
                          value={edit.gradeMax}
                          onChange={(e) =>
                            setItemEdits((prev) => ({ ...prev, [item.id]: { ...edit, gradeMax: e.target.value } }))
                          }
                        />
                      </Field>
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
              <form onSubmit={(e) => void createGradeItem(e)}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="grade-item-name">{t('gradeItemName')}</FieldLabel>
                    <Input id="grade-item-name" value={newItemName} onChange={(e) => setNewItemName(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="grade-item-max">{t('gradeItemMax')}</FieldLabel>
                    <Input id="grade-item-max" value={newItemMax} onChange={(e) => setNewItemMax(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel id="grade-item-category-label">{t('gradeItemCategory')}</FieldLabel>
                    <Select
                      items={Object.fromEntries([
                        ['none', t('gradeItemNoCategory')],
                        ...adminCategories.map((c) => [c.id, c.fullName || t('gradeCourseFallback')] as [string, string]),
                      ])}
                      value={newItemCategoryId === '' ? 'none' : newItemCategoryId}
                      onValueChange={(v) => setNewItemCategoryId(v === 'none' || v === null ? '' : v)}
                    >
                      <SelectTrigger aria-labelledby="grade-item-category-label" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t('gradeItemNoCategory')}</SelectItem>
                        {adminCategories.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.fullName || t('gradeCourseFallback')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="flex justify-end">
                    <Button type="submit">{t('createGradeItem')}</Button>
                  </div>
                </FieldGroup>
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
                    <Field>
                      <FieldLabel htmlFor={`letter-symbol-${index}`}>{t('letterSymbol')}</FieldLabel>
                      <Input
                        id={`letter-symbol-${index}`}
                        value={draft.letter}
                        onChange={(e) =>
                          setLetterDrafts((prev) =>
                            prev.map((d, i) => (i === index ? { ...d, letter: e.target.value } : d)),
                          )
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`letter-boundary-${index}`}>{t('letterLowerBoundary')}</FieldLabel>
                      <Input
                        id={`letter-boundary-${index}`}
                        value={draft.lowerBoundary}
                        onChange={(e) =>
                          setLetterDrafts((prev) =>
                            prev.map((d, i) => (i === index ? { ...d, lowerBoundary: e.target.value } : d)),
                          )
                        }
                      />
                    </Field>
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
              <form onSubmit={(e) => void createScale(e)}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="scale-name">{t('scaleName')}</FieldLabel>
                    <Input id="scale-name" value={scaleName} onChange={(e) => setScaleName(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="scale-values">{t('scaleValues')}</FieldLabel>
                    <Input id="scale-values" value={scaleValues} onChange={(e) => setScaleValues(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="scale-description">{t('scaleDescriptionLabel')}</FieldLabel>
                    <Input
                      id="scale-description"
                      value={scaleDescription}
                      onChange={(e) => setScaleDescription(e.target.value)}
                    />
                  </Field>
                  <div className="flex justify-end">
                    <Button type="submit">{t('createScale')}</Button>
                  </div>
                </FieldGroup>
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
              <form onSubmit={(e) => void createOutcome(e)}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="outcome-name">{t('outcomeName')}</FieldLabel>
                    <Input id="outcome-name" value={outcomeName} onChange={(e) => setOutcomeName(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel id="outcome-scale-label">{t('outcomeScale')}</FieldLabel>
                    <Select
                      items={Object.fromEntries(adminScales.map((s) => [s.id, s.name]))}
                      value={outcomeScaleId === '' ? null : outcomeScaleId}
                      onValueChange={(v) => setOutcomeScaleId(v ?? '')}
                    >
                      <SelectTrigger aria-labelledby="outcome-scale-label" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {adminScales.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="outcome-description">{t('outcomeDescriptionLabel')}</FieldLabel>
                    <Input
                      id="outcome-description"
                      value={outcomeDescription}
                      onChange={(e) => setOutcomeDescription(e.target.value)}
                    />
                  </Field>
                  <div className="flex justify-end">
                    <Button type="submit">{t('createOutcome')}</Button>
                  </div>
                </FieldGroup>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('gradeHistoryTitle')}</CardTitle>
              <CardDescription>{t('gradeHistoryDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <form onSubmit={(e) => void loadHistory(e)}>
                <FieldGroup>
                  <Field>
                    <FieldLabel id="history-item-label">{t('gradeItem')}</FieldLabel>
                    <Select
                      items={Object.fromEntries(adminItems.map((i) => [i.id, i.itemName]))}
                      value={historyItemId === '' ? null : historyItemId}
                      onValueChange={(v) => setHistoryItemId(v ?? '')}
                    >
                      <SelectTrigger aria-labelledby="history-item-label" className="w-full">
                        <SelectValue placeholder={t('gradeItem')} />
                      </SelectTrigger>
                      <SelectContent>
                        {adminItems.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.itemName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="history-user">{t('studentUserId')}</FieldLabel>
                    <Input id="history-user" value={historyUserId} onChange={(e) => setHistoryUserId(e.target.value)} />
                  </Field>
                  <div className="flex justify-end">
                    <Button type="submit">{t('viewHistory')}</Button>
                  </div>
                </FieldGroup>
              </form>
              {historyError ? (
                <Alert variant="destructive">
                  <AlertDescription>{historyError}</AlertDescription>
                </Alert>
              ) : null}
              {historyRows !== null && historyRows.length === 0 ? (
                <Empty className="p-4">
                  <EmptyHeader>
                    <EmptyTitle>{t('historyEmpty')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
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
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default GradebookPage; /** Thụt lề theo độ sâu cây hạng mục điểm: bảng class tĩnh theo từng cấp (mỗi cấp 16px), tránh style nội tuyến. */
const CATEGORY_INDENT = ['ml-0', 'ml-4', 'ml-8', 'ml-12', 'ml-16', 'ml-20'];

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Điểm số');
}
