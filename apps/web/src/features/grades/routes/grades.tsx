import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { GradeItem } from '@lms/contracts';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '#components/page-shell';
import '#config/i18n';
import { apiFetch } from '#lib/api';
import { gradeItemHistoryQueryOptions, useCourseGradeData, useCreateGradeItem, useDeleteGradeItem, useSetGradeItemPublished, useSetGradePostingPolicy, useSubmitGrade, useUpdateGradeItem } from '../queries/course-grade';
import type { GradeHistoryView } from '../types/course-grade';
import { usePermissions } from '#lib/permissions';
import { ClassGradesGridCard } from '../components/class-grades-grid-card';
import { EnterGradeCard } from '../components/enter-grade-card';
import { GradeItemsAdminCard, type GradeItemEdit } from '../components/grade-items-admin-card';
import {
  guessVneduColumnKind,
  isVneduExportableItem,
  type VneduColumnKind,
} from '../utils/gradebook-helpers';
import { StudentGradesCard } from '../components/student-grades-card';
import { VneduExportCard } from '../components/vnedu-export-card';

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
 * (PATCH/DELETE /grade-items/:id, POST
 * /grade-items/:itemId/grades) — đúng controller phía API.
 */
export function GradebookPage() {
  const { t, i18n } = useTranslation('app');
  const { id } = useParams();
  const courseId = id ?? '';
  const perms = usePermissions();
  // Điểm theo bài + lưới lớp đọc qua TanStack với ĐÚNG khoá
  // `courseAccess` và fetcher dùng chung ở `src/hooks/use-courses-grade-data.ts`
  // (F-03, rà soát #133): bề mặt nào mở trước thì bề mặt sau đọc cache,
  // không tốn request thêm. Provider KHÔNG tải dữ liệu này khi nạp app
  // (F-02) — trang này là một trong các bề mặt tải lười nó.
  const gradeDataQuery = useCourseGradeData(courseId);
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
  const [itemEdits, setItemEdits] = useState<Record<string, GradeItemEdit>>({});
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [vneduKinds, setVneduKinds] = useState<Record<string, VneduColumnKind>>({});
  /** Mốc tập id bài đã áp gợi ý vnEdu gần nhất — dùng bởi khối điều chỉnh state ngay trong render ở dưới. */
  const [prevItemsIdKey, setPrevItemsIdKey] = useState('');
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
  // Thao tác ghi điểm/mục điểm qua các đột biến của
  // features/grades/queries/course-grade (F-01 của rà soát #133): đột biến tự làm
  // mới đúng khoá dùng chung courseAccess sau khi ghi thành công.
  const submitGradeMutation = useSubmitGrade(courseId);
  const createItemMutation = useCreateGradeItem(courseId);
  const updateItemMutation = useUpdateGradeItem(courseId);
  const deleteItemMutation = useDeleteGradeItem(courseId);
  const postingPolicyMutation = useSetGradePostingPolicy(courseId);
  const publishedMutation = useSetGradeItemPublished(courseId);

  // Lỗi "tải được dữ kiện nhưng không có sổ điểm" suy ngay khi
  // render từ dữ kiện query — không chép qua effect vào state như
  // bản cũ; `error` trong state chỉ còn giữ lỗi của thao tác ghi.
  const gradebookError = gradeDataQuery.data && !gradeDataQuery.data.gradebook ? t('gradebookLoadFailed') : null;

  // Gợi ý ánh xạ vnEdu mặc định theo tên bài mỗi khi TẬP id
  // của danh sách bài đổi: điều chỉnh state ngay trong lúc
  // render (khuôn React khuyến nghị cho state suy từ dữ kiện
  // thay vì dùng effect) — giữ nguyên mốc kích hoạt của effect
  // cũ (chuỗi id nối), giữ loại cột giáo viên đã chọn cho các
  // bài còn hiện diện và chỉ đoán cho bài mới xuất hiện; không
  // còn mảng phụ thuộc dạng biểu thức mà lint không kiểm chứng
  // tĩnh được.
  const itemsIdKey = items.map((i) => i.id).join(',');
  if (itemsIdKey !== prevItemsIdKey) {
    setPrevItemsIdKey(itemsIdKey);
    setVneduKinds((prev) => {
      const next: Record<string, VneduColumnKind> = {};
      for (const item of items) next[item.id] = prev[item.id] ?? guessVneduColumnKind(item);
      return next;
    });
  }

  /** Nhập/sửa điểm một bài cho một học sinh (POST /grade-items/:itemId/grades). */
  async function submitGrade(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    try {
      await submitGradeMutation.mutateAsync({
        gradeItemId,
        userId: gradeUserId,
        rawGrade: gradeValue.trim() === '' ? null : Number(gradeValue),
        ...(gradeFeedback.trim() ? { feedback: gradeFeedback.trim() } : {}),
      });
      setMessage(t('gradeSaved'));
    } catch {
      setError(t('gradeSaveFailed'));
    }
  }

  /** Tạo mục điểm nhập tay mới cho một bài/đợt riêng của khoá. */
  async function createItem(event: FormEvent) {
    event.preventDefault();
    setAdminMessage(null);
    try {
      await createItemMutation.mutateAsync({ itemName: newItemName, gradeMax: Number(newItemMax) });
      setNewItemName('');
      setAdminMessage(t('gradeItemCreated'));
    } catch {
      setAdminMessage(t('gradeItemCreateFailedAdmin'));
    }
  }

  /** Lưu sửa tên/thang điểm của một mục (PATCH /grade-items/:id). */
  async function saveItemEdit(item: GradeItem) {
    const edit = itemEdits[item.id];
    if (!edit) return;
    setAdminMessage(null);
    try {
      await updateItemMutation.mutateAsync({
        itemId: item.id,
        itemName: edit.itemName,
        gradeMax: Number(edit.gradeMax),
      });
      setAdminMessage(t('gradeItemUpdated'));
    } catch {
      setAdminMessage(t('gradeItemUpdateFailed'));
    }
  }

  /** Xoá một mục điểm và mọi điểm của nó (DELETE /grade-items/:id). */
  async function deleteItem(item: GradeItem) {
    if (!window.confirm(t('confirmDeleteGradeItem', { name: item.itemName }))) return;
    setAdminMessage(null);
    try {
      await deleteItemMutation.mutateAsync(item.id);
      setAdminMessage(t('gradeItemDeleted'));
    } catch {
      setAdminMessage(t('gradeItemDeleteFailed'));
    }
  }

  /** Đặt chính sách công bố của một bài (PUT /grade-items/:id/posting-policy). */
  async function setPostingPolicy(item: GradeItem, policy: 'auto' | 'manual') {
    setAdminMessage(null);
    try {
      await postingPolicyMutation.mutateAsync({ itemId: item.id, policy });
      setAdminMessage(t('gradesPublicationUpdated'));
    } catch {
      setAdminMessage(t('gradesPublicationUpdateFailed'));
    }
  }

  /** Công bố / thu hồi công bố điểm của một bài (POST .../publish | .../unpublish). */
  async function setPublished(item: GradeItem, published: boolean) {
    setAdminMessage(null);
    try {
      await publishedMutation.mutateAsync({ itemId: item.id, published });
      setAdminMessage(t('gradesPublicationUpdated'));
    } catch {
      setAdminMessage(t('gradesPublicationUpdateFailed'));
    }
  }

  /**
   * Xuất Excel vnEdu qua POST /courses/:courseId/grade-exports (body
   * mang trường provider: 'vnedu' để chọn nhà cung cấp xuất)
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
      const response = await apiFetch(`/api/v1/courses/${courseId}/grade-exports`, {
        method: 'POST',
        body: JSON.stringify({
          provider: 'vnedu',
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
   * GET /grade-items/:itemId/users/:userId/history. Đọc theo
   * yêu cầu nên đi qua fetchQuery của TanStack (vẫn vào bộ nhớ đệm
   * theo khoá factory) mà giữ nhịp xoá kết quả cũ/hiện lỗi tại chỗ
   * của bản thủ công.
   */
  async function loadHistory(event: FormEvent) {
    event.preventDefault();
    setHistoryError(null);
    setHistoryRows(null);
    try {
      const rows = await queryClient.fetchQuery(gradeItemHistoryQueryOptions(historyItemId, historyUserId));
      setHistoryRows(rows);
    } catch {
      setHistoryError(t('historyLoadFailed'));
    }
  }

  if (gradeDataQuery.isPending)
    return (
      <PageShell width="full">
        <PageHeader title={t('gradebook')} />
        <PageSkeleton label={t('loading')} rows={['h-10 w-full', 'h-10 w-full', 'h-10 w-2/3']} />
      </PageShell>
    );
  if (!book && !report)
    return (
      <PageShell width="full">
        <PageHeader title={t('gradebook')} />
        <ErrorAlert variant="destructive">
          {error ?? t('gradebookLoadFailed')}
        </ErrorAlert>
      </PageShell>
    );

  const myActivities = book?.activities ?? [];

  return (
    <PageShell width="full">
      <PageHeader title={t('gradebook')} />
      {(error ?? gradebookError) ? (
        <ErrorAlert variant="destructive" className="mb-4">
          {error ?? gradebookError}
        </ErrorAlert>
      ) : null}
      {message && (
        <ErrorAlert className="mb-4">
          {message}
        </ErrorAlert>
      )}

      {/* Điểm của chính người dùng: từng bài một, kèm trạng thái công bố. */}
      <StudentGradesCard activities={myActivities} locale={i18n.language} />

      {isStaff && report && (
        <>
          {/* Lưới chỉ-đọc học sinh × các bài cho giáo viên. */}
          <ClassGradesGridCard report={report} locale={i18n.language} />

          {/* Quản trị mục điểm + công bố theo bài. */}
          <GradeItemsAdminCard
            items={items}
            publications={report.publications}
            adminMessage={adminMessage}
            itemEdits={itemEdits}
            onItemEditsChange={setItemEdits}
            newItemName={newItemName}
            onNewItemNameChange={setNewItemName}
            newItemMax={newItemMax}
            onNewItemMaxChange={setNewItemMax}
            onCreateItem={createItem}
            onSaveItemEdit={saveItemEdit}
            onDeleteItem={deleteItem}
            onSetPostingPolicy={setPostingPolicy}
            onSetPublished={setPublished}
          />

          {/* Nhập điểm + lịch sử điểm. */}
          <EnterGradeCard
            items={items}
            rows={report.rows}
            gradeItemId={gradeItemId}
            onGradeItemIdChange={setGradeItemId}
            gradeUserId={gradeUserId}
            onGradeUserIdChange={setGradeUserId}
            gradeValue={gradeValue}
            onGradeValueChange={setGradeValue}
            gradeFeedback={gradeFeedback}
            onGradeFeedbackChange={setGradeFeedback}
            onSubmitGrade={submitGrade}
            historyItemId={historyItemId}
            onHistoryItemIdChange={setHistoryItemId}
            historyUserId={historyUserId}
            onHistoryUserIdChange={setHistoryUserId}
            historyRows={historyRows}
            historyError={historyError}
            onLoadHistory={loadHistory}
          />

          {/* Xuất vnEdu từ các bài đã công bố. */}
          <VneduExportCard
            items={items}
            publications={report.publications}
            vneduKinds={vneduKinds}
            onVneduKindsChange={setVneduKinds}
            vneduSemester={vneduSemester}
            onVneduSemesterChange={setVneduSemester}
            vneduSchoolYear={vneduSchoolYear}
            onVneduSchoolYearChange={setVneduSchoolYear}
            vneduSubject={vneduSubject}
            onVneduSubjectChange={setVneduSubject}
            vneduClass={vneduClass}
            onVneduClassChange={setVneduClass}
            vneduMessage={vneduMessage}
            onDownload={downloadGradesVnedu}
          />
        </>
      )}
    </PageShell>
  );
}

/**
 * Export mặc định cho đích route `courses/:id/grades` trong routes.ts:
 * quy ước framework lấy component của route từ export mặc định (hoặc
 * export tên `Component`) của route module, mà file trang trước đây
 * chỉ export theo tên nên qua router component không được gắn (vùng
 * nội dung trống dù spec gắn trực tiếp vẫn xanh). Export theo tên
 * `GradebookPage` ở trên giữ nguyên cho các nơi tiêu thụ hiện hữu.
 */
export default GradebookPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('gradebook');
}
