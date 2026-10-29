import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { ErrorAlert } from '#components/error-alert';
import { PageHeader, PageShell } from '#components/page-shell';
import { errorText } from '../utils/shared';
import { ApiError } from '#lib/api';
import { accessContextsQueryOptions, useAccessContexts, type ContextRow } from '#lib/access';
import { queryClient } from '#lib/query-client';
import { queryKeys } from '#lib/query-keys';
import { curriculaBySubjectQueryOptions } from '#features/matrices/queries/matrix';
import {
  bookDatasetStatusQueryOptions, booksQueryOptions, curriculumSubjectsScopedQueryOptions,
  programDatasetStatusQueryOptions,
  useBookDatasetStatus, useBooks, useBookTree, useCurriculumSubjectsScoped,
  useDeleteCurriculumRow, useDeleteCurriculumSubject, useImportBookDataset,
  useImportProgramDataset, useProgramDatasetStatus,
  type Book, type BookDatasetStatus, type BookImportResult, type Curriculum,
  type CurriculumSubject, type ProgramDatasetStatus, type ProgramImportResult,
} from '#lib/curriculum';
import '#config/i18n';

/**
 * Quản trị chương trình GDPT 2018 (K0a + GDPT-SEED): bề mặt chính là
 * danh sách môn học — thu/mở ra chương trình theo khối, cây của một
 * khối trình bày theo mẫu Bộ (bảng Nội dung | Yêu cầu cần đạt nhóm
 * theo mạch). Tạo/sửa môn, chương trình, node và YCCĐ đều là MÀN
 * RIÊNG; Sửa/Xoá nằm ngay tại dòng (§9). Panel đồng bộ dữ liệu chuẩn
 * nằm cuối trang như tiện ích phụ: chương trình đã được seed tự động
 * khi dựng DB (restore từ dump đông cứng, định danh cố định theo dump), panel chỉ để đồng bộ lại
 * khi dataset được đính chính — nạp lại không nhân đôi và không xoá
 * (sổ đăng ký + luật không-xoá phía API quyết định). Mọi lời gọi bị
 * API gác bằng curriculum:manage tại context hệ thống: 403 thì trang
 * hiện thông báo không có quyền thay vì sập (học sinh không vào được
 * trang này).
 *
 * Luồng dữ liệu (F-01 của rà soát #133): bốn nguồn nền — trạng thái
 * dataset chương trình, contexts (để neo danh sách môn ở context hệ
 * thống), trạng thái dataset SGK và danh sách sách — đọc qua
 * TanStack Query từ lib/curriculum; lỗi 403 ở bất kỳ nguồn nào thì
 * trang coi là không có quyền, lỗi khác hiện thông báo tải thất bại.
 * Chương trình của một môn và cây của một cuốn sách chỉ tải khi mở
 * lần đầu (truy vấn con theo từng dòng, bật theo trạng thái mở) rồi
 * giữ trong bộ nhớ đệm; đồng bộ dataset và xoá đi qua các đột biến
 * của lib/curriculum, làm mới đúng cụm khoá bị ảnh hưởng.
 */

// --- Các dòng con lười tải ----------------------------------------------------

/** Danh sách chương trình theo khối của một môn đang mở — chỉ tải khi môn được mở lần đầu. */
function SubjectCurricula({
  subject,
  onLoadError,
  onMessage,
}: {
  subject: CurriculumSubject;
  onLoadError: () => void;
  onMessage: (text: string) => void;
}) {
  const { t } = useTranslation('app');
  const query = useQuery(curriculaBySubjectQueryOptions(subject.id));
  const deleteRow = useDeleteCurriculumRow();

  useEffect(() => {
    if (query.isError) onLoadError();
  }, [query.isError, onLoadError]);

  /** Xoá một chương trình (cascade cây node + YCCĐ của khối đó) sau xác nhận. */
  async function deleteCurriculum(curriculum: Curriculum) {
    if (!window.confirm(t('curriculumConfirmDeleteCurriculum', { name: subject.name, grade: curriculum.grade }))) return;
    try {
      await deleteRow.mutateAsync(curriculum.id);
      onMessage(t('curriculumCurriculumDeleted'));
    } catch (err) {
      onMessage(errorText(err, t('curriculumDeleteFailed')));
    }
  }

  const curricula = query.data ?? [];
  return (
    <div className="mt-3 flex flex-col gap-2">
      <ul className="flex flex-col gap-1" aria-label={t('curriculumCurriculaLabel', { name: subject.name })}>
        {curricula.map((curriculum) => (
          <li key={curriculum.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t('curriculumGradeLabel', { grade: curriculum.grade })}</span>
            <Link className="underline" to={`/admin/curriculum/curricula/${curriculum.id}`}>
              {t('curriculumViewTree')}
            </Link>
            <span className="ml-auto flex gap-2">
              <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/curricula/${curriculum.id}/edit`} />}>
                {t('curriculumEdit')}
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={() => void deleteCurriculum(curriculum)}>
                {t('curriculumDelete')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <div>
        <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/subjects/${subject.id}/curricula/new`} />}>
          {t('curriculumCreateCurriculum')}
        </Button>
      </div>
    </div>
  );
}

/** Một dòng môn: nút thu/mở, sửa/xoá môn và (khi mở) danh sách chương trình của môn. */
function SubjectRow({
  subject,
  open,
  onToggle,
  onLoadError,
  onMessage,
}: {
  subject: CurriculumSubject;
  open: boolean;
  onToggle: () => void;
  onLoadError: () => void;
  onMessage: (text: string) => void;
}) {
  const { t } = useTranslation('app');
  const deleteSubjectMutation = useDeleteCurriculumSubject();

  /** Xoá một môn (cascade toàn bộ chương trình của môn) sau xác nhận. */
  async function deleteSubject() {
    if (!window.confirm(t('curriculumConfirmDeleteSubject', { name: subject.name }))) return;
    try {
      await deleteSubjectMutation.mutateAsync(subject.id);
      onMessage(t('curriculumSubjectDeleted'));
    } catch (err) {
      onMessage(errorText(err, t('curriculumDeleteFailed')));
    }
  }

  return (
    <li className="rounded border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onToggle}>
          {open ? '▾' : '▸'} {subject.name}
        </Button>
        <Badge variant="secondary">{subject.slug}</Badge>
        <span className="ml-auto flex gap-2">
          <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/subjects/${subject.id}/edit`} />}>
            {t('curriculumEdit')}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={() => void deleteSubject()}>
            {t('curriculumDelete')}
          </Button>
        </span>
      </div>
      {open ? <SubjectCurricula subject={subject} onLoadError={onLoadError} onMessage={onMessage} /> : null}
    </li>
  );
}

/** Một dòng SGK: cây sách chỉ tải khi mở lần đầu rồi giữ lại (huy hiệu số bài vẫn hiện khi đã đóng). */
function BookRow({
  book,
  subjectName,
  open,
  onToggle,
  onLoadError,
}: {
  book: Book;
  subjectName: string;
  open: boolean;
  onToggle: () => void;
  onLoadError: () => void;
}) {
  const { t } = useTranslation('app');
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open ]);
  const treeQuery = useBookTree(book.id, everOpened);

  useEffect(() => {
    if (treeQuery.isError) onLoadError();
  }, [treeQuery.isError, onLoadError]);

  const tree = treeQuery.data;
  return (
    <li className="rounded border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={onToggle}>
          {open ? '▾' : '▸'}
        </Button>
        <span className="font-medium">{book.title}</span>
        <span className="text-sm text-muted-foreground">
          {subjectName} · {t('curriculumGradeLabel', { grade: book.grade })}
        </span>
        {tree ? (
          <Badge variant="secondary">
            {t('bookLessonsCount', {
              count: tree.chapters.reduce((n, c) => n + c.lessons.length, 0),
            })}
          </Badge>
        ) : null}
      </div>
      {open && tree ? (
        <div className="mt-3 flex flex-col gap-3">
          {tree.chapters.map((chapter) => (
            <div key={chapter.id}>
              <p className="text-sm font-medium">{chapter.title}</p>
              <ul className="mt-1 flex flex-col gap-1 pl-4">
                {chapter.lessons.map((lesson) => {
                  const codes = lesson.mappings
                    .map((m) => m.programRecordId)
                    .filter((x): x is string => x !== null);
                  return (
                    <li key={lesson.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span>{lesson.title}</span>
                      {codes.length > 0 ? (
                        <Badge variant="outline">{t('bookMappedTo', { codes: codes.join(', ') })}</Badge>
                      ) : (
                        <Badge variant="secondary">{t('bookUnmapped')}</Badge>
                      )}
                      {lesson.outcomes.length > 0 ? (
                        <span className="text-muted-foreground">
                          {t('bookOutcomesCount', { count: lesson.outcomes.length })}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
}

// --- Màn danh sách + nạp dữ liệu chuẩn ---------------------------------------

export function AdminCurriculumPage() {
  const { t } = useTranslation('app');
  const [openSubjects, setOpenSubjects] = useState<string[]>([]);
  const [importResults, setImportResults] = useState<Record<string, ProgramImportResult>>({});
  const [bookImportResults, setBookImportResults] = useState<Record<string, BookImportResult>>({});
  const [openBooks, setOpenBooks] = useState<string[]>([]);
  const [extraError, setExtraError] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const programStatusQuery = useProgramDatasetStatus();
  const contextsQuery = useAccessContexts();
  const systemContextId = contextsQuery.data?.find((c) => c.contextLevel === 10)?.id;
  const subjectsQuery = useCurriculumSubjectsScoped(systemContextId ?? null);
  const bookStatusQuery = useBookDatasetStatus();
  const booksQuery = useBooks();
  const importProgram = useImportProgramDataset();
  const importBook = useImportBookDataset();

  const datasets: ProgramDatasetStatus[] = programStatusQuery.data ?? [];
  const subjects: CurriculumSubject[] = subjectsQuery.data ?? [];
  const bookDatasets: BookDatasetStatus[] = bookStatusQuery.data ?? [];
  const books: Book[] = booksQuery.data ?? [];

  const backgroundQueries = [programStatusQuery, contextsQuery, subjectsQuery, bookStatusQuery, booksQuery];
  const isForbiddenError = (err: unknown) => err instanceof ApiError && err.problem.status === 403;
  const forbidden = backgroundQueries.some((q) => isForbiddenError(q.error));
  const loadFailed = backgroundQueries.some((q) => q.isError && !isForbiddenError(q.error));
  const error = loadFailed || extraError ? t('curriculumLoadFailed') : null;

  const importing = importProgram.isPending ? (importProgram.variables ?? null) : null;
  const bookImporting = importBook.isPending ? (importBook.variables ?? null) : null;

  const handleLoadError = useCallback(() => setExtraError(true), []);
  const handleMessage = useCallback((text: string) => setMessage(text), []);

  /** Thu/mở một môn: việc tải chương trình của môn do truy vấn con đảm nhiệm. */
  function toggleSubject(subject: CurriculumSubject) {
    setExtraError(false);
    setOpenSubjects((prev) =>
      prev.includes(subject.id) ? prev.filter((id) => id !== subject.id) : [...prev, subject.id],
    );
  }

  /** Nạp một dataset đã kiểm chứng vào cây chương trình (idempotent phía API). */
  async function importDataset(dataset: ProgramDatasetStatus) {
    setMessage(null);
    try {
      const result = await importProgram.mutateAsync(dataset.datasetKey);
      setImportResults((prev) => ({ ...prev, [dataset.datasetKey]: result }));
      setMessage(t('curriculumImportDone', { subject: dataset.subjectName }));
    } catch (err) {
      setMessage(errorText(err, t('curriculumImportFailed')));
    }
  }

  /** Nạp một dataset SGK đã kiểm chứng vào cây sách + ánh xạ (idempotent phía API). */
  async function importBookDataset(dataset: BookDatasetStatus) {
    setMessage(null);
    try {
      const result = await importBook.mutateAsync(dataset.datasetKey);
      setBookImportResults((prev) => ({ ...prev, [dataset.datasetKey]: result }));
      setMessage(t('bookImportDone', { book: dataset.bookTitle }));
    } catch (err) {
      setMessage(errorText(err, t('bookImportFailed')));
    }
  }

  /** Thu/mở một cuốn SGK: việc tải cây sách do truy vấn ở dòng sách đảm nhiệm. */
  function toggleBook(book: Book) {
    setExtraError(false);
    setOpenBooks((prev) =>
      prev.includes(book.id) ? prev.filter((id) => id !== book.id) : [...prev, book.id],
    );
  }

  return (
    <PageShell>
      <PageHeader title={t('curriculumAdminTitle')} description={t('curriculumAdminDescription')} />
      {forbidden ? (
        <ErrorAlert variant="destructive">
          {t('curriculumForbidden')}
        </ErrorAlert>
      ) : null}
      {error ? (
        <ErrorAlert variant="destructive">
          {error}
        </ErrorAlert>
      ) : null}
      {message ? (
        <ErrorAlert>
          {message}
        </ErrorAlert>
      ) : null}

      {!forbidden ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('curriculumSubjectsTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <Button type="button" render={<Link to="/admin/curriculum/subjects/new" />}>
                {t('curriculumCreateSubject')}
              </Button>
            </div>
            {subjects.length === 0 ? (
              <Empty className="p-6">
                <EmptyHeader>
                  <EmptyTitle>{t('curriculumNoSubjects')}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="flex flex-col gap-2" aria-label={t('curriculumSubjectsTitle')}>
                {subjects.map((subject) => (
                  <SubjectRow
                    key={subject.id}
                    subject={subject}
                    open={openSubjects.includes(subject.id)}
                    onToggle={() => toggleSubject(subject)}
                    onLoadError={handleLoadError}
                    onMessage={handleMessage}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      {!forbidden ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('bookListTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {books.length === 0 ? (
              <Empty className="p-6">
                <EmptyHeader>
                  <EmptyTitle>{t('bookNoBooks')}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="flex flex-col gap-2" aria-label={t('bookListTitle')}>
                {books.map((book) => (
                  <BookRow
                    key={book.id}
                    book={book}
                    subjectName={subjects.find((s) => s.id === book.subjectId)?.name ?? ''}
                    open={openBooks.includes(book.id)}
                    onToggle={() => toggleBook(book)}
                    onLoadError={handleLoadError}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      {!forbidden ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('bookImportTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{t('bookImportDescription')}</p>
            {bookDatasets.map((dataset) => {
              const result = bookImportResults[dataset.datasetKey];
              return (
                <div key={dataset.datasetKey} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">
                    {t('bookImportBook', { book: dataset.bookTitle, grade: dataset.grade })}
                  </span>
                  <Badge variant={dataset.importedRecords >= dataset.totalRecords ? 'default' : 'secondary'}>
                    {t('bookImportState', { imported: dataset.importedRecords, total: dataset.totalRecords })}
                  </Badge>
                  <span className="text-muted-foreground">
                    {t('bookImportMapped', { mapped: dataset.mappedRecords })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={bookImporting === dataset.datasetKey}
                    onClick={() => void importBookDataset(dataset)}
                  >
                    {t('bookImportRun')}
                  </Button>
                  {result ? (
                    <span className="text-muted-foreground">
                      {t('bookImportResult', {
                        created: result.created, updated: result.updated, skipped: result.skipped,
                        mappings: result.mappingsWritten,
                      })}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {!forbidden ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('curriculumImportTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{t('curriculumImportDescription')}</p>
            {datasets.map((dataset) => {
              const result = importResults[dataset.datasetKey];
              return (
                <div key={dataset.datasetKey} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{dataset.subjectName}</span>
                  <Badge variant={dataset.importedRecords >= dataset.totalRecords ? 'default' : 'secondary'}>
                    {t('curriculumImportState', { imported: dataset.importedRecords, total: dataset.totalRecords })}
                  </Badge>
                  <span className="text-muted-foreground">
                    {t('curriculumImportGrades', { grades: dataset.grades.join(', ') })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={importing === dataset.datasetKey}
                    onClick={() => void importDataset(dataset)}
                  >
                    {t('curriculumImportRun')}
                  </Button>
                  {result ? (
                    <span className="text-muted-foreground">
                      {t('curriculumImportResult', {
                        created: result.created, updated: result.updated, skipped: result.skipped,
                      })}
                      {(result.orphanedNodes ?? 0) + (result.retiredOutcomes ?? 0) > 0
                        ? ` · ${t('curriculumImportRetired', {
                            nodes: result.orphanedNodes ?? 0, outcomes: result.retiredOutcomes ?? 0,
                          })}`
                        : ''}
                      {result.changeCounts
                        ? ` · ${t('curriculumImportChanges', { ...result.changeCounts })}`
                        : ''}
                    </span>
                  ) : null}
                  {result && result.changes && result.changes.length > 0 ? (
                    <details className="w-full text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        {t('curriculumImportChanges', { ...result.changeCounts })}
                      </summary>
                      <ul className="mt-1 flex flex-col gap-1">
                        {result.changes.map((change, i) => {
                          // Mục cần mắt người: nghi ghép nhầm khi vừa
                          // sửa chữ vừa xô lệch, ca mơ hồ trong nhóm
                          // trùng hệt, hoặc dòng còn liên kết trỏ vào.
                          const needsReview = change.shiftSuspected || change.identicalTextAmbiguous
                            || (change.linkedQuestions ?? 0) > 0 || (change.linkedBookMappings ?? 0) > 0;
                          const kindText = change.kind === 'text-changed'
                            ? t('curriculumChangeTextChanged')
                            : change.kind === 'added'
                              ? t('curriculumChangeAdded')
                              : change.kind === 'removed'
                                ? t('curriculumChangeRemoved')
                                : change.kind === 'moved'
                                  ? t('curriculumChangeMoved')
                                  : t('curriculumChangeRevived');
                          return (
                            <li key={`${change.recordId}-${change.position}-${change.kind}-${i}`}>
                              <span className="font-medium">{change.recordId}.{String(change.position).padStart(2, '0')}</span>
                              {` · ${kindText}`}
                              {change.oldText ? ` · ${change.oldText.slice(0, 80)}` : ''}
                              {change.newText && change.kind === 'text-changed' ? ` → ${change.newText.slice(0, 80)}` : ''}
                              {change.newText && change.kind !== 'text-changed' ? ` · ${change.newText.slice(0, 80)}` : ''}
                              {needsReview ? (
                                <span className="ml-1 font-medium text-amber-600">{t('curriculumImportChangeFlag')}</span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                      {result.changesOmitted > 0 ? (
                        <p className="text-muted-foreground">{t('curriculumImportChangesOmitted', { count: result.changesOmitted })}</p>
                      ) : null}
                    </details>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

    </PageShell>
  );
}

/**
 * Nạp trước cho route danh sách quản trị chương trình: bốn nguồn nền
 * của trang; danh sách môn cần id context hệ thống nên nạp sau khi
 * contexts về (đúng thứ tự phụ thuộc của trang). Lỗi nạp bỏ qua —
 * trang tự hiện trạng thái lỗi/cấm như khi không có loader.
 */
export async function adminCurriculumPageClientLoader() {
  await Promise.allSettled([
    queryClient.ensureQueryData(programDatasetStatusQueryOptions()),
    queryClient.ensureQueryData(accessContextsQueryOptions()),
    queryClient.ensureQueryData(bookDatasetStatusQueryOptions()),
    queryClient.ensureQueryData(booksQueryOptions()),
  ]);
  const contexts = queryClient.getQueryData<ContextRow[]>(queryKeys.accessContexts);
  const systemContextId = contexts?.find((c) => c.contextLevel === 10)?.id;
  if (systemContextId) {
    await queryClient.ensureQueryData(curriculumSubjectsScopedQueryOptions(systemContextId)).catch(() => undefined);
  }
  return null;
}

// --- Màn cây chương trình ------------------------------------------------------

/** Export mặc định cho route danh sách (xem src/routes.ts). */
export default AdminCurriculumPage;

// Tái xuất cho spec trang (màn cây đã tách sang components/tree-page của feature).
export { AdminCurriculumTreePage } from '../components/tree-page';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133) —
// trước đây nằm ở wrapper mỏng của route, gộp vào route module này khi
// tổ chức lại theo mô hình features/ (issue #500).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('navCurriculum');
}

/** clientLoader của route danh sách: nạp trước các nguồn nền của trang. */
export const clientLoader = adminCurriculumPageClientLoader;
