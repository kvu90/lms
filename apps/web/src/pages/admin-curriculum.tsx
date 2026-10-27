import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Label } from '@lms/ui/components/label';
import { PageHeader, PageShell } from '../components/page-shell';
import { errorText } from '../components/admin-curriculum/shared';
import { apiJson, ApiError } from '#lib/api';
import {
  fetchCurricula, fetchSubjects, fetchSystemContextId, fetchBookDatasetStatus, fetchBooks, fetchBookTree,
  type Curriculum, type CurriculumSubject, type Book, type BookDatasetStatus, type BookTree,
} from '#lib/curriculum';
import '../i18n';

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
 */
interface DatasetStatus {
  datasetKey: string;
  subjectName: string;
  slug: string;
  grades: number[];
  totalRecords: number;
  importedRecords: number;
  subjectId: string | null;
  lastImportedAt: string | null;
}

/** Một mục thay đổi theo từng dòng YCCĐ trong báo cáo của một lượt đồng bộ (issue #161). */
interface ImportChange {
  recordId: string;
  position: number;
  kind: 'text-changed' | 'added' | 'removed' | 'moved' | 'revived';
  oldText?: string;
  newText?: string;
  shiftSuspected?: boolean;
  identicalTextAmbiguous?: boolean;
  linkedQuestions?: number;
  linkedBookMappings?: number;
}

interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  outcomesWritten: number;
  totalRecords: number;
  orphanedNodes: number;
  retiredOutcomes: number;
  changeCounts: { textChanged: number; added: number; removed: number; moved: number; revived: number; shiftSuspected: number };
  changes: ImportChange[];
  changesOmitted: number;
}

interface BookImportResult {
  created: number;
  updated: number;
  skipped: number;
  mappingsWritten: number;
  totalRecords: number;
}
// --- Màn danh sách + nạp dữ liệu chuẩn ---------------------------------------

export function AdminCurriculumPage() {
  const { t } = useTranslation('app');
  const [datasets, setDatasets] = useState<DatasetStatus[]>([]);
  const [subjects, setSubjects] = useState<CurriculumSubject[]>([]);
  const [curriculaBySubject, setCurriculaBySubject] = useState<Record<string, Curriculum[]>>({});
  const [openSubjects, setOpenSubjects] = useState<string[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [importResults, setImportResults] = useState<Record<string, ImportResult>>({});
  const [bookDatasets, setBookDatasets] = useState<BookDatasetStatus[]>([]);
  const [bookImporting, setBookImporting] = useState<string | null>(null);
  const [bookImportResults, setBookImportResults] = useState<Record<string, BookImportResult>>({});
  const [books, setBooks] = useState<Book[]>([]);
  const [openBooks, setOpenBooks] = useState<string[]>([]);
  const [bookTrees, setBookTrees] = useState<Record<string, BookTree>>({});
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [status, contextId] = await Promise.all([
        apiJson<DatasetStatus[]>('/api/v1/curriculum/program-import'),
        fetchSystemContextId(),
      ]);
      setDatasets(status);
      if (contextId) setSubjects(await fetchSubjects(contextId));
      // Tầng SGK (K0b): trạng thái dataset sách + danh sách sách đã nạp.
      setBookDatasets(await fetchBookDatasetStatus());
      setBooks(await fetchBooks());
      setForbidden(false);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 403) {
        setForbidden(true);
        return;
      }
      setError(t('curriculumLoadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Thu/mở một môn: mở lần đầu thì tải danh sách chương trình theo khối của môn đó. */
  async function toggleSubject(subject: CurriculumSubject) {
    if (openSubjects.includes(subject.id)) {
      setOpenSubjects(openSubjects.filter((id) => id !== subject.id));
      return;
    }
    setOpenSubjects([...openSubjects, subject.id]);
    if (!curriculaBySubject[subject.id]) {
      try {
        const rows = await fetchCurricula(subject.id);
        setCurriculaBySubject((prev) => ({ ...prev, [subject.id]: rows }));
      } catch {
        setError(t('curriculumLoadFailed'));
      }
    }
  }

  /** Nạp một dataset đã kiểm chứng vào cây chương trình (idempotent phía API). */
  async function importDataset(dataset: DatasetStatus) {
    setImporting(dataset.datasetKey);
    setMessage(null);
    try {
      const result = await apiJson<ImportResult>('/api/v1/curriculum/program-import', {
        method: 'POST',
        body: JSON.stringify({ datasetKey: dataset.datasetKey }),
      });
      setImportResults((prev) => ({ ...prev, [dataset.datasetKey]: result }));
      setMessage(t('curriculumImportDone', { subject: dataset.subjectName }));
      await reload();
    } catch (err) {
      setMessage(errorText(err, t('curriculumImportFailed')));
    } finally {
      setImporting(null);
    }
  }

  /** Nạp một dataset SGK đã kiểm chứng vào cây sách + ánh xạ (idempotent phía API). */
  async function importBookDataset(dataset: BookDatasetStatus) {
    setBookImporting(dataset.datasetKey);
    setMessage(null);
    try {
      const result = await apiJson<BookImportResult>('/api/v1/books/dataset-import', {
        method: 'POST',
        body: JSON.stringify({ datasetKey: dataset.datasetKey }),
      });
      setBookImportResults((prev) => ({ ...prev, [dataset.datasetKey]: result }));
      setMessage(t('bookImportDone', { book: dataset.bookTitle }));
      await reload();
    } catch (err) {
      setMessage(errorText(err, t('bookImportFailed')));
    } finally {
      setBookImporting(null);
    }
  }

  /** Thu/mở một cuốn SGK: mở lần đầu thì tải cây sách (chủ đề → bài → ánh xạ). */
  async function toggleBook(book: Book) {
    if (openBooks.includes(book.id)) {
      setOpenBooks(openBooks.filter((id) => id !== book.id));
      return;
    }
    setOpenBooks([...openBooks, book.id]);
    if (!bookTrees[book.id]) {
      try {
        const tree = await fetchBookTree(book.id);
        setBookTrees((prev) => ({ ...prev, [book.id]: tree }));
      } catch {
        setError(t('curriculumLoadFailed'));
      }
    }
  }

  /** Xoá một môn (cascade toàn bộ chương trình của môn) sau xác nhận. */
  async function deleteSubject(subject: CurriculumSubject) {
    if (!window.confirm(t('curriculumConfirmDeleteSubject', { name: subject.name }))) return;
    try {
      await apiJson(`/api/v1/curriculum/subjects/${subject.id}`, { method: 'DELETE' });
      setMessage(t('curriculumSubjectDeleted'));
      await reload();
    } catch (err) {
      setMessage(errorText(err, t('curriculumDeleteFailed')));
    }
  }

  /** Xoá một chương trình (cascade cây node + YCCĐ của khối đó) sau xác nhận. */
  async function deleteCurriculum(subject: CurriculumSubject, curriculum: Curriculum) {
    if (!window.confirm(t('curriculumConfirmDeleteCurriculum', { name: subject.name, grade: curriculum.grade }))) return;
    try {
      await apiJson(`/api/v1/curriculum/curricula/${curriculum.id}`, { method: 'DELETE' });
      const rows = await fetchCurricula(subject.id);
      setCurriculaBySubject((prev) => ({ ...prev, [subject.id]: rows }));
      setMessage(t('curriculumCurriculumDeleted'));
    } catch (err) {
      setMessage(errorText(err, t('curriculumDeleteFailed')));
    }
  }

  return (
    <PageShell>
      <PageHeader title={t('curriculumAdminTitle')} description={t('curriculumAdminDescription')} />
      {forbidden ? (
        <Alert variant="destructive">
          <AlertDescription>{t('curriculumForbidden')}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
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
                {subjects.map((subject) => {
                  const open = openSubjects.includes(subject.id);
                  const curricula = curriculaBySubject[subject.id] ?? [];
                  return (
                    <li key={subject.id} className="rounded border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button type="button" variant="ghost" size="sm" onClick={() => void toggleSubject(subject)}>
                          {open ? '▾' : '▸'} {subject.name}
                        </Button>
                        <Badge variant="secondary">{subject.slug}</Badge>
                        <span className="ml-auto flex gap-2">
                          <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/subjects/${subject.id}/edit`} />}>
                            {t('curriculumEdit')}
                          </Button>
                          <Button type="button" variant="destructive" size="sm" onClick={() => void deleteSubject(subject)}>
                            {t('curriculumDelete')}
                          </Button>
                        </span>
                      </div>
                      {open ? (
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
                                  <Button type="button" variant="destructive" size="sm" onClick={() => void deleteCurriculum(subject, curriculum)}>
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
                      ) : null}
                    </li>
                  );
                })}
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
                {books.map((book) => {
                  const open = openBooks.includes(book.id);
                  const tree = bookTrees[book.id];
                  const subjectName = subjects.find((s) => s.id === book.subjectId)?.name ?? '';
                  return (
                    <li key={book.id} className="rounded border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-expanded={open}
                          onClick={() => void toggleBook(book)}
                        >
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
                })}
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

// --- Màn cây chương trình ------------------------------------------------------

/** Export mặc định cho route danh sách (xem src/routes.ts). */
export default AdminCurriculumPage;

// Tái xuất cho spec trang (màn cây đã tách sang components/admin-curriculum/tree-page).
export { AdminCurriculumTreePage } from '../components/admin-curriculum/tree-page';
