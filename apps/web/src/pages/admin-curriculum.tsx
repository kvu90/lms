import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { PageHeader, PageShell } from '../components/page-shell';
import { apiJson, ApiError } from '#lib/api';
import {
  fetchCurricula, fetchSubjects, fetchSystemContextId, fetchBookDatasetStatus, fetchBooks, fetchBookTree, fetchTree,
  type Curriculum, type CurriculumSubject, type CurriculumTree, type CurriculumTreeNode,
  type Book, type BookDatasetStatus, type BookTree,
} from '#lib/curriculum';
import '../i18n';

/**
 * Quản trị chương trình GDPT 2018 (K0a + GDPT-SEED): bề mặt chính là
 * danh sách môn học — thu/mở ra chương trình theo khối, cây của một
 * khối trình bày theo mẫu Bộ (bảng Nội dung | Yêu cầu cần đạt nhóm
 * theo mạch). Tạo/sửa môn, chương trình, node và YCCĐ đều là MÀN
 * RIÊNG; Sửa/Xoá nằm ngay tại dòng (§9). Panel đồng bộ dữ liệu chuẩn
 * nằm cuối trang như tiện ích phụ: chương trình đã được seed tự động
 * khi dựng DB (định danh xác định UUIDv5), panel chỉ để đồng bộ lại
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

interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  outcomesWritten: number;
  totalRecords: number;
  orphanedNodes: number;
  orphanedOutcomes: number;
}

interface BookImportResult {
  created: number;
  updated: number;
  skipped: number;
  mappingsWritten: number;
  totalRecords: number;
}

/** Thông điệp lỗi từ API (problem detail) hoặc thông điệp dự phòng theo i18n. */
function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (err.problem.detail ?? err.problem.title ?? fallback) : fallback;
}

/** Khung một màn form riêng (tạo/sửa) theo chuẩn §9: tiêu đề + quay lại danh sách. */
function FormScreen({
  title, backTo, children,
}: {
  title: string;
  backTo: string;
  children: ReactNode;
}) {
  const { t } = useTranslation('app');
  return (
    <PageShell width="narrow">
      <PageHeader title={title} />
      <Card>
        <CardContent>{children}</CardContent>
      </Card>
      <p>
        <Link to={backTo} className="text-sm underline">
          {t('curriculumBackToList')}
        </Link>
      </p>
    </PageShell>
  );
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
                      {(result.orphanedNodes ?? 0) + (result.orphanedOutcomes ?? 0) > 0
                        ? ` · ${t('curriculumImportOrphaned', {
                            nodes: result.orphanedNodes ?? 0, outcomes: result.orphanedOutcomes ?? 0,
                          })}`
                        : ''}
                    </span>
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

/**
 * Trình bày cây chương trình theo MẪU CỦA BỘ (GDPT-SEED, issue #161):
 * mỗi mạch nội dung (node strand ở gốc cây) là một bảng hai cột
 * "Nội dung | Yêu cầu cần đạt". Các bậc ở giữa (section/topic) không
 * thành dòng riêng nếu không mang YCCĐ — tựa của chúng flatten vào
 * đường đi ở cột Nội dung; node mang YCCĐ ở bất kỳ bậc nào cũng thành
 * dòng. Hành vi quản trị giữ nguyên §9: thêm node con / thêm YCCĐ /
 * Sửa mở màn riêng, Xoá tại dòng.
 */
interface ProgramRow {
  node: CurriculumTreeNode;
  path: string[];
}

/** Flatten một subtree thành các dòng bảng (cha trước con, giữ thứ tự cây). */
function flattenProgramRows(node: CurriculumTreeNode, path: string[], out: ProgramRow[]): void {
  if (node.kind === 'lesson' || node.outcomes.length > 0) out.push({ node, path });
  for (const child of node.children) flattenProgramRows(child, [...path, node.title], out);
}

/** Các nút thao tác tại dòng của một node (dùng cho cả tiêu đề mạch lẫn dòng nội dung). */
function NodeRowActions({
  node, curriculumId, onDeleteNode,
}: {
  node: CurriculumTreeNode;
  curriculumId: string;
  onDeleteNode: (node: CurriculumTreeNode) => void;
}) {
  const { t } = useTranslation('app');
  return (
    <span className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/curricula/${curriculumId}/nodes/new?parentId=${node.id}`} />}>
        {t('curriculumAddChildNode')}
      </Button>
      <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/nodes/${node.id}/outcomes/new`} />}>
        {t('curriculumAddOutcome')}
      </Button>
      <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/nodes/${node.id}/edit`} />}>
        {t('curriculumEdit')}
      </Button>
      <Button type="button" variant="destructive" size="sm" onClick={() => onDeleteNode(node)}>
        {t('curriculumDelete')}
      </Button>
    </span>
  );
}

/** Một bảng chương trình: tiêu đề mạch (nếu có) + các dòng Nội dung | Yêu cầu cần đạt. */
function ProgramGroupTable({
  title, groupNode, rows, curriculumId, onDeleteNode, onDeleteOutcome,
}: {
  title: string | null;
  groupNode: CurriculumTreeNode | null;
  rows: ProgramRow[];
  curriculumId: string;
  onDeleteNode: (node: CurriculumTreeNode) => void;
  onDeleteOutcome: (node: CurriculumTreeNode, outcomeId: string) => void;
}) {
  const { t } = useTranslation('app');
  return (
    <section className="overflow-hidden rounded border">
      {title !== null && groupNode ? (
        <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 p-3">
          <Badge variant="default">{t(`curriculumKind_${groupNode.kind}`)}</Badge>
          <h3 className="font-semibold">{title}</h3>
          <span className="ml-auto">
            <NodeRowActions node={groupNode} curriculumId={curriculumId} onDeleteNode={onDeleteNode} />
          </span>
        </header>
      ) : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="w-1/2 p-2 font-medium">{t('curriculumContentColumn')}</th>
            <th className="p-2 font-medium">{t('curriculumOutcomesLabel')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, path }) => (
            <tr key={node.id} className="border-b align-top last:border-0">
              <td className="p-2">
                {path.length > 0 ? (
                  <span className="block text-xs text-muted-foreground">{path.join(' › ')}</span>
                ) : null}
                <span className="font-medium">{node.title}</span>
                <span className="mt-1 block">
                  <NodeRowActions node={node} curriculumId={curriculumId} onDeleteNode={onDeleteNode} />
                </span>
              </td>
              <td className="p-2">
                {node.outcomes.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {node.outcomes.map((outcome) => (
                      <li key={outcome.id} className="flex flex-wrap items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <span>{outcome.content}</span>
                          {outcome.sourceRef ? (
                            <span className="block text-xs text-muted-foreground">
                              {t('curriculumOutcomeSource', { source: outcome.sourceRef })}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex gap-2">
                          <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/outcomes/${outcome.id}/edit`} />}>
                            {t('curriculumEdit')}
                          </Button>
                          <Button type="button" variant="destructive" size="sm" onClick={() => onDeleteOutcome(node, outcome.id)}>
                            {t('curriculumDelete')}
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function AdminCurriculumTreePage() {
  const { t } = useTranslation('app');
  const { curriculumId } = useParams();
  const [tree, setTree] = useState<CurriculumTree | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!curriculumId) return;
    try {
      const data = await fetchTree(curriculumId);
      setTree(data);
      setForbidden(false);
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 403) setForbidden(true);
    }
  }, [curriculumId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function deleteNode(node: CurriculumTreeNode) {
    if (!window.confirm(t('curriculumConfirmDeleteNode', { title: node.title }))) return;
    try {
      await apiJson(`/api/v1/curriculum/nodes/${node.id}`, { method: 'DELETE' });
      setMessage(t('curriculumNodeDeleted'));
      await reload();
    } catch (err) {
      setMessage(errorText(err, t('curriculumDeleteFailed')));
    }
  }

  async function deleteOutcome(_node: CurriculumTreeNode, outcomeId: string) {
    if (!window.confirm(t('curriculumConfirmDeleteOutcome'))) return;
    try {
      await apiJson(`/api/v1/curriculum/outcomes/${outcomeId}`, { method: 'DELETE' });
      setMessage(t('curriculumOutcomeDeleted'));
      await reload();
    } catch (err) {
      setMessage(errorText(err, t('curriculumDeleteFailed')));
    }
  }

  if (forbidden) {
    return (
      <PageShell>
        <Alert variant="destructive">
          <AlertDescription>{t('curriculumForbidden')}</AlertDescription>
        </Alert>
      </PageShell>
    );
  }
  if (!tree) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">{t('curriculumLoading')}</p>
      </PageShell>
    );
  }
  return (
    <PageShell>
      <PageHeader
        title={t('curriculumTreeTitle', { subject: tree.subject.name, grade: tree.curriculum.grade })}
        description={t('curriculumTreeDescription')}
      />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="button" render={<Link to={`/admin/curriculum/curricula/${tree.curriculum.id}/nodes/new`} />}>
          {t('curriculumAddRootNode')}
        </Button>{' '}
        <Link to="/admin/curriculum" className="text-sm underline">
          {t('curriculumBackToList')}
        </Link>
      </div>
      <div className="flex flex-col gap-4">
        {tree.nodes.map((root) => {
          // Node gốc là mạch nội dung → một bảng mang tên mạch; node gốc
          // khác (dataset không mang mạch) → bảng không tiêu đề nhóm.
          const rows: ProgramRow[] = [];
          if (root.kind === 'strand') {
            if (root.outcomes.length > 0) rows.push({ node: root, path: [] });
            for (const child of root.children) flattenProgramRows(child, [], rows);
            return (
              <ProgramGroupTable
                key={root.id}
                title={root.title}
                groupNode={root}
                rows={rows}
                curriculumId={tree.curriculum.id}
                onDeleteNode={(n) => void deleteNode(n)}
                onDeleteOutcome={(n, id) => void deleteOutcome(n, id)}
              />
            );
          }
          flattenProgramRows(root, [], rows);
          return (
            <ProgramGroupTable
              key={root.id}
              title={null}
              groupNode={null}
              rows={rows}
              curriculumId={tree.curriculum.id}
              onDeleteNode={(n) => void deleteNode(n)}
              onDeleteOutcome={(n, id) => void deleteOutcome(n, id)}
            />
          );
        })}
      </div>
    </PageShell>
  );
}

// --- Màn form môn học ----------------------------------------------------------

function SubjectForm({ initial, subjectId }: { initial?: CurriculumSubject; subjectId?: string }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [position, setPosition] = useState(String(initial?.position ?? 1));
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (subjectId) {
        await apiJson(`/api/v1/curriculum/subjects/${subjectId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, slug, position: Number(position) }),
        });
      } else {
        const contextId = await fetchSystemContextId();
        if (!contextId) throw new Error('no system context');
        await apiJson('/api/v1/curriculum/subjects', {
          method: 'POST',
          body: JSON.stringify({ contextId, name, slug, position: Number(position) }),
        });
      }
      navigate('/admin/curriculum');
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="subject-name">{t('curriculumSubjectName')}</Label>
        <Input id="subject-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="subject-slug">{t('curriculumSubjectSlug')}</Label>
        <Input id="subject-slug" value={slug} onChange={(e) => setSlug(e.target.value)} required />
        <p className="text-xs text-muted-foreground">{t('curriculumSubjectSlugHelp')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="subject-position">{t('curriculumPosition')}</Label>
        <Input id="subject-position" type="number" min={1} value={position} onChange={(e) => setPosition(e.target.value)} />
      </div>
      <Button type="submit">{t('curriculumSave')}</Button>
    </form>
  );
}

export function AdminSubjectNewPage() {
  const { t } = useTranslation('app');
  return (
    <FormScreen title={t('curriculumCreateSubject')} backTo="/admin/curriculum">
      <SubjectForm />
    </FormScreen>
  );
}

export function AdminSubjectEditPage() {
  const { t } = useTranslation('app');
  const { subjectId } = useParams();
  const [subject, setSubject] = useState<CurriculumSubject | null>(null);
  useEffect(() => {
    if (!subjectId) return;
    void apiJson<CurriculumSubject>(`/api/v1/curriculum/subjects/${subjectId}`).then(setSubject).catch(() => setSubject(null));
  }, [subjectId]);
  if (!subject) {
    return (
      <PageShell width="narrow">
        <p className="text-sm text-muted-foreground">{t('curriculumLoading')}</p>
      </PageShell>
    );
  }
  return (
    <FormScreen title={t('curriculumEditSubject', { name: subject.name })} backTo="/admin/curriculum">
      <SubjectForm initial={subject} subjectId={subject.id} />
    </FormScreen>
  );
}

// --- Màn form chương trình (khối) ----------------------------------------------

export function AdminCurriculumNewPage() {
  const { t } = useTranslation('app');
  const { subjectId } = useParams();
  const navigate = useNavigate();
  const [grade, setGrade] = useState('1');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await apiJson('/api/v1/curriculum/curricula', {
        method: 'POST',
        body: JSON.stringify({ subjectId, grade: Number(grade) }),
      });
      navigate('/admin/curriculum');
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <FormScreen title={t('curriculumCreateCurriculum')} backTo="/admin/curriculum">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-2">
          <span id="curriculum-grade-label" className="text-sm font-medium">
            {t('curriculumGrade')}
          </span>
          <Select items={Object.fromEntries(
              Array.from({ length: 12 }, (_, i) => i + 1).map((g) => [String(g), t('curriculumGradeLabel', { grade: g })]),
            )} value={grade} onValueChange={(v) => v && setGrade(v)}>
            <SelectTrigger aria-labelledby="curriculum-grade-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                <SelectItem key={g} value={String(g)}>
                  {t('curriculumGradeLabel', { grade: g })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit">{t('curriculumSave')}</Button>
      </form>
    </FormScreen>
  );
}

export function AdminCurriculumEditPage() {
  const { t } = useTranslation('app');
  const { curriculumId } = useParams();
  const navigate = useNavigate();
  const [grade, setGrade] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!curriculumId) return;
    void apiJson<Curriculum>(`/api/v1/curriculum/curricula/${curriculumId}`)
      .then((row) => setGrade(String(row.grade)))
      .catch(() => setGrade(''));
  }, [curriculumId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await apiJson(`/api/v1/curriculum/curricula/${curriculumId}`, {
        method: 'PATCH',
        body: JSON.stringify({ grade: Number(grade) }),
      });
      navigate('/admin/curriculum');
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <FormScreen title={t('curriculumEditCurriculum')} backTo="/admin/curriculum">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-2">
          <span id="curriculum-grade-edit-label" className="text-sm font-medium">
            {t('curriculumGrade')}
          </span>
          <Select items={Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => i + 1).map((g) => [String(g), t('curriculumGradeLabel', { grade: g })]),
          )} value={grade} onValueChange={(v) => v && setGrade(v)}>
            <SelectTrigger aria-labelledby="curriculum-grade-edit-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                <SelectItem key={g} value={String(g)}>
                  {t('curriculumGradeLabel', { grade: g })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit">{t('curriculumSave')}</Button>
      </form>
    </FormScreen>
  );
}

// --- Màn form node ----------------------------------------------------------------

interface NodeRow {
  id: string;
  curriculumId: string;
  parentId: string | null;
  title: string;
  kind: string;
  position: number;
  durationPeriods: number | null;
  durationPercent: number | null;
}

function flattenNodes(nodes: CurriculumTreeNode[], depth = 0, out: { id: string; title: string; depth: number }[] = []) {
  for (const node of nodes) {
    out.push({ id: node.id, title: node.title, depth });
    flattenNodes(node.children, depth + 1, out);
  }
  return out;
}

function NodeForm({ curriculumId, initial, parentId }: { curriculumId: string; initial?: NodeRow; parentId?: string | null }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [kind, setKind] = useState(initial?.kind ?? 'topic');
  const [parent, setParent] = useState<string>(initial ? (initial.parentId ?? '') : (parentId ?? ''));
  const [position, setPosition] = useState(String(initial?.position ?? 1));
  const [durationPeriods, setDurationPeriods] = useState(initial?.durationPeriods != null ? String(initial.durationPeriods) : '');
  const [durationPercent, setDurationPercent] = useState(initial?.durationPercent != null ? String(initial.durationPercent) : '');
  const [parentOptions, setParentOptions] = useState<{ id: string; title: string; depth: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchTree(curriculumId)
      .then((tree) => setParentOptions(flattenNodes(tree.nodes).filter((n) => n.id !== initial?.id)))
      .catch(() => setParentOptions([]));
  }, [curriculumId, initial?.id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const payload = {
      title,
      kind,
      parentId: parent === '' ? null : parent,
      position: Number(position),
      durationPeriods: durationPeriods === '' ? null : Number(durationPeriods),
      durationPercent: durationPercent === '' ? null : Number(durationPercent),
    };
    try {
      if (initial) {
        await apiJson(`/api/v1/curriculum/nodes/${initial.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await apiJson('/api/v1/curriculum/nodes', {
          method: 'POST',
          body: JSON.stringify({ curriculumId, ...payload }),
        });
      }
      navigate(`/admin/curriculum/curricula/${curriculumId}`);
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="node-title">{t('curriculumNodeTitle')}</Label>
        <Input id="node-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="space-y-2">
        <span id="node-kind-label" className="text-sm font-medium">
          {t('curriculumNodeKind')}
        </span>
        <Select
          items={{
            strand: t('curriculumKind_strand'),
            topic: t('curriculumKind_topic'),
            lesson: t('curriculumKind_lesson'),
          }}
          value={kind}
          onValueChange={(v) => v && setKind(v)}
        >
          <SelectTrigger aria-labelledby="node-kind-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="strand">{t('curriculumKind_strand')}</SelectItem>
            <SelectItem value="topic">{t('curriculumKind_topic')}</SelectItem>
            <SelectItem value="lesson">{t('curriculumKind_lesson')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <span id="node-parent-label" className="text-sm font-medium">
          {t('curriculumNodeParent')}
        </span>
        <Select
          items={Object.fromEntries([
            ['root', t('curriculumNodeParentRoot')],
            ...parentOptions.map(
              (option) => [option.id, `${'— '.repeat(option.depth)}${option.title}`] as [string, string],
            ),
          ])}
          value={parent === '' ? 'root' : parent}
          onValueChange={(v) => setParent(!v || v === 'root' ? '' : v)}
        >
          <SelectTrigger aria-labelledby="node-parent-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="root">{t('curriculumNodeParentRoot')}</SelectItem>
            {parentOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {'— '.repeat(option.depth)}
                {option.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="node-position">{t('curriculumPosition')}</Label>
        <Input id="node-position" type="number" min={1} value={position} onChange={(e) => setPosition(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="node-periods">{t('curriculumDurationPeriods')}</Label>
        <Input id="node-periods" type="number" min={0} value={durationPeriods} onChange={(e) => setDurationPeriods(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="node-percent">{t('curriculumDurationPercent')}</Label>
        <Input id="node-percent" type="number" min={0} max={100} value={durationPercent} onChange={(e) => setDurationPercent(e.target.value)} />
      </div>
      <Button type="submit">{t('curriculumSave')}</Button>
    </form>
  );
}

export function AdminNodeNewPage() {
  const { t } = useTranslation('app');
  const { curriculumId } = useParams();
  const [searchParams] = useSearchParams();
  if (!curriculumId) return null;
  return (
    <FormScreen title={t('curriculumCreateNode')} backTo={`/admin/curriculum/curricula/${curriculumId}`}>
      <NodeForm curriculumId={curriculumId} parentId={searchParams.get('parentId')} />
    </FormScreen>
  );
}

export function AdminNodeEditPage() {
  const { t } = useTranslation('app');
  const { nodeId } = useParams();
  const [node, setNode] = useState<NodeRow | null>(null);
  useEffect(() => {
    if (!nodeId) return;
    void apiJson<NodeRow>(`/api/v1/curriculum/nodes/${nodeId}`).then(setNode).catch(() => setNode(null));
  }, [nodeId]);
  if (!node) {
    return (
      <PageShell width="narrow">
        <p className="text-sm text-muted-foreground">{t('curriculumLoading')}</p>
      </PageShell>
    );
  }
  return (
    <FormScreen title={t('curriculumEditNode', { title: node.title })} backTo={`/admin/curriculum/curricula/${node.curriculumId}`}>
      <NodeForm curriculumId={node.curriculumId} initial={node} />
    </FormScreen>
  );
}

// --- Màn form YCCĐ ------------------------------------------------------------------

interface OutcomeRow {
  id: string;
  nodeId: string;
  content: string;
  position: number;
  sourceKind: string;
  sourceRef: string | null;
  derivedFromId: string | null;
}

function OutcomeForm({ nodeId, initial, backTo }: { nodeId: string; initial?: OutcomeRow; backTo: string }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [content, setContent] = useState(initial?.content ?? '');
  const [position, setPosition] = useState(String(initial?.position ?? 1));
  const [sourceKind, setSourceKind] = useState(initial?.sourceKind ?? 'program');
  const [sourceRef, setSourceRef] = useState(initial?.sourceRef ?? '');
  const [derivedFromId, setDerivedFromId] = useState(initial?.derivedFromId ?? '');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const payload = {
      content,
      position: Number(position),
      sourceKind,
      sourceRef: sourceRef === '' ? null : sourceRef,
      derivedFromId: derivedFromId === '' ? null : derivedFromId,
    };
    try {
      if (initial) {
        await apiJson(`/api/v1/curriculum/outcomes/${initial.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await apiJson('/api/v1/curriculum/outcomes', {
          method: 'POST',
          body: JSON.stringify({ nodeId, ...payload }),
        });
      }
      navigate(backTo);
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="outcome-content">{t('curriculumOutcomeContent')}</Label>
        <textarea
          id="outcome-content"
          className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="outcome-position">{t('curriculumPosition')}</Label>
        <Input id="outcome-position" type="number" min={1} value={position} onChange={(e) => setPosition(e.target.value)} />
      </div>
      <div className="space-y-2">
        <span id="outcome-source-kind-label" className="text-sm font-medium">
          {t('curriculumOutcomeSourceKind')}
        </span>
        <Select
          items={{ program: t('curriculumSourceKind_program'), derived: t('curriculumSourceKind_derived') }}
          value={sourceKind}
          onValueChange={(v) => v && setSourceKind(v)}
        >
          <SelectTrigger aria-labelledby="outcome-source-kind-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="program">{t('curriculumSourceKind_program')}</SelectItem>
            <SelectItem value="derived">{t('curriculumSourceKind_derived')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="outcome-source-ref">{t('curriculumOutcomeSourceRef')}</Label>
        <Input id="outcome-source-ref" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} />
      </div>
      {sourceKind === 'derived' ? (
        <div className="space-y-2">
          <Label htmlFor="outcome-derived-from">{t('curriculumOutcomeDerivedFrom')}</Label>
          <Input id="outcome-derived-from" value={derivedFromId} onChange={(e) => setDerivedFromId(e.target.value)} />
        </div>
      ) : null}
      <Button type="submit">{t('curriculumSave')}</Button>
    </form>
  );
}

export function AdminOutcomeNewPage() {
  const { t } = useTranslation('app');
  const { nodeId } = useParams();
  const [node, setNode] = useState<NodeRow | null>(null);
  useEffect(() => {
    if (!nodeId) return;
    void apiJson<NodeRow>(`/api/v1/curriculum/nodes/${nodeId}`).then(setNode).catch(() => setNode(null));
  }, [nodeId]);
  if (!nodeId) return null;
  const backTo = node ? `/admin/curriculum/curricula/${node.curriculumId}` : '/admin/curriculum';
  return (
    <FormScreen title={t('curriculumCreateOutcome')} backTo={backTo}>
      <OutcomeForm nodeId={nodeId} backTo={backTo} />
    </FormScreen>
  );
}

export function AdminOutcomeEditPage() {
  const { t } = useTranslation('app');
  const { outcomeId } = useParams();
  const [outcome, setOutcome] = useState<OutcomeRow | null>(null);
  const [node, setNode] = useState<NodeRow | null>(null);
  useEffect(() => {
    if (!outcomeId) return;
    void (async () => {
      try {
        const row = await apiJson<OutcomeRow>(`/api/v1/curriculum/outcomes/${outcomeId}`);
        setOutcome(row);
        setNode(await apiJson<NodeRow>(`/api/v1/curriculum/nodes/${row.nodeId}`));
      } catch {
        setOutcome(null);
      }
    })();
  }, [outcomeId]);
  if (!outcome) {
    return (
      <PageShell width="narrow">
        <p className="text-sm text-muted-foreground">{t('curriculumLoading')}</p>
      </PageShell>
    );
  }
  const backTo = node ? `/admin/curriculum/curricula/${node.curriculumId}` : '/admin/curriculum';
  return (
    <FormScreen title={t('curriculumEditOutcome')} backTo={backTo}>
      <OutcomeForm nodeId={outcome.nodeId} initial={outcome} backTo={backTo} />
    </FormScreen>
  );
}

/** Export mặc định cho route danh sách (xem src/routes.ts). */
export default AdminCurriculumPage;
