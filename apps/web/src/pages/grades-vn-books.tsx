import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lms/ui/components/select';
import '../i18n';
import { ApiError, apiJson } from '#lib/api';

/**
 * Bề mặt web sổ điểm VN (TT 22/2021) cho giáo viên — issue #183. Các view
 * khai báo tại chỗ theo tiền lệ grades.tsx vì contracts chưa có schema
 * response cho họ route vn-books (API là nguồn sự thật của hình dạng).
 */
interface VnBookSummary {
  id: string;
  courseId: string;
  term: string;
  assessmentMode: 'score' | 'comment';
  subjectPeriodsPerYear: number | null;
}

interface VnGridItem {
  id: string;
  itemName: string;
  vnRole: string | null;
  vnOrdinal: number | null;
}

interface VnGridColumn {
  itemId: string;
  role: string;
  ordinal: number | null;
  grade: number | null;
  status: 'graded' | 'awaiting_makeup' | 'missing';
}

interface VnGridComputation {
  complete: boolean;
  columns: VnGridColumn[];
  dtbHk: number | null;
}

interface VnGridSnapshot {
  dtbHk: number | null;
  commentResult: string | null;
  version: number;
}

interface VnGridRow {
  userId: string;
  userName: string;
  computation: VnGridComputation | null;
  snapshot: VnGridSnapshot | null;
  published: boolean;
  sourceDiverged: boolean;
}

interface VnBookGrid {
  book: VnBookSummary;
  items: VnGridItem[];
  students: VnGridRow[];
}

interface VnCandidate {
  mappingId: string;
  userId: string;
  activityName: string;
  targetRole: string | null;
  targetOrdinal: number | null;
  convertedGrade: number;
  state: string;
}

interface BlockedStudent {
  userId: string;
  reason: 'awaiting_makeup' | 'incomplete';
  roles: string[];
}

function formatScore(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

/**
 * Khu sổ điểm VN trong trang điểm của khoá (chỉ staff thấy): chọn/tạo sổ
 * theo (khoá × kỳ), lưới điểm cột TT 22 với ĐTB tính trực tiếp, hộp ứng
 * viên từ hoạt động, chốt lẻ + chốt cả lớp nguyên tử, công bố theo PH-0
 * và cảnh báo lệch nguồn khi sửa cột của học sinh đã có bản chốt.
 */
export function VnBooksSection({ courseId }: { courseId: string }) {
  const { t } = useTranslation('app');
  const [books, setBooks] = useState<VnBookSummary[]>([]);
  const [bookId, setBookId] = useState('');
  const [grid, setGrid] = useState<VnBookGrid | null>(null);
  const [candidates, setCandidates] = useState<VnCandidate[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<BlockedStudent[]>([]);
  const [cellDrafts, setCellDrafts] = useState<Record<string, string>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [newTerm, setNewTerm] = useState('hk1');
  const [newPeriods, setNewPeriods] = useState('70');
  const [newMode, setNewMode] = useState('score');

  const base = `/api/v1/courses/${courseId}/grades/vn-books`;

  const reloadBooks = useCallback(async () => {
    const list = await apiJson<VnBookSummary[]>(base).catch(() => [] as VnBookSummary[]);
    setBooks(list);
    setBookId((prev) => prev || (list[0]?.id ?? ''));
  }, [base]);

  const reloadGrid = useCallback(async () => {
    if (!bookId) {
      setGrid(null);
      setCandidates([]);
      return;
    }
    const [g, c] = await Promise.all([
      apiJson<VnBookGrid>(`${base}/${bookId}/grid`).catch(() => null),
      apiJson<{ candidates: VnCandidate[] }>(`${base}/${bookId}/candidates`).catch(() => ({ candidates: [] })),
    ]);
    setGrid(g);
    setCandidates(c.candidates.filter((x) => x.state === 'pending'));
    if (g) {
      const drafts: Record<string, string> = {};
      for (const row of g.students) {
        for (const col of row.computation?.columns ?? []) {
          drafts[`${row.userId}|${col.itemId}`] = col.grade === null ? '' : String(col.grade);
        }
      }
      setCellDrafts(drafts);
    }
  }, [base, bookId]);

  useEffect(() => {
    void reloadBooks();
  }, [reloadBooks]);

  useEffect(() => {
    void reloadGrid();
  }, [reloadGrid]);

  async function createBook(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      const body: Record<string, unknown> = { term: newTerm, assessmentMode: newMode };
      if (newMode === 'score') body.subjectPeriodsPerYear = Number(newPeriods);
      const created = await apiJson<{ book: VnBookSummary }>(base, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setMessage(t('vnBookCreated'));
      await reloadBooks();
      setBookId(created.book.id);
    } catch {
      setMessage(t('vnBookCreateFailed'));
    }
  }

  /**
   * Lưu một ô điểm qua setGrade dùng chung. Học sinh ĐÃ có bản chốt thì
   * điểm cột sửa sẽ làm bản chốt lệch nguồn — cảnh báo rõ trước khi lưu
   * (không cấm sửa; bản chốt giữ nguyên cho tới khi chốt lại).
   */
  async function saveCell(row: VnGridRow, itemId: string) {
    const raw = (cellDrafts[`${row.userId}|${itemId}`] ?? '').trim();
    if (row.snapshot && !window.confirm(t('vnBookDivergedConfirm', { name: row.userName }))) return;
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/items/${itemId}/grades`, {
        method: 'POST',
        body: JSON.stringify({ userId: row.userId, rawGrade: raw === '' ? null : Number(raw) }),
      });
      setMessage(t('vnBookCellSaved'));
      await reloadGrid();
    } catch {
      setMessage(t('vnBookCellSaveFailed'));
    }
  }

  async function setMakeup(row: VnGridRow, itemId: string, state: string) {
    if (!state) return;
    setMessage(null);
    try {
      await apiJson(`${base}/${bookId}/columns/${itemId}/students/${row.userId}/makeup-status`, {
        method: 'POST',
        body: JSON.stringify({ state }),
      });
      await reloadGrid();
    } catch {
      setMessage(t('vnBookCellSaveFailed'));
    }
  }

  async function finalizeOne(row: VnGridRow) {
    setMessage(null);
    setBlocked([]);
    try {
      await apiJson(`${base}/${bookId}/results/${row.userId}/finalize`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setMessage(t('vnBookFinalizedOne', { name: row.userName }));
      await reloadGrid();
    } catch {
      setMessage(t('vnBookFinalizeFailed'));
    }
  }

  /**
   * Chốt cả lớp nguyên tử: API từ chối cả lượt khi còn học sinh bị chặn
   * (chờ kiểm tra bù Điều 7.4 hoặc thiếu cột) và trả danh sách bị chặn
   * trong problem-details — hiển thị đích danh từng học sinh + lý do.
   */
  async function finalizeAll() {
    setMessage(null);
    setBlocked([]);
    try {
      const result = await apiJson<{ finalizedCount: number }>(`${base}/${bookId}/finalize-all`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setMessage(t('vnBookFinalizedAll', { count: result.finalizedCount }));
      await reloadGrid();
    } catch (err) {
      if (err instanceof ApiError && err.problem.code === 'grades.vn_finalize_book_blocked') {
        setBlocked(err.problem.blockedStudents ?? []);
      } else {
        setMessage(t('vnBookFinalizeFailed'));
      }
    }
  }

  async function togglePublish(row: VnGridRow) {
    setMessage(null);
    try {
      await apiJson(`${base}/${bookId}/results/${row.userId}/${row.published ? 'unpublish' : 'publish'}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await reloadGrid();
    } catch {
      setMessage(t('vnBookPublishFailed'));
    }
  }

  async function saveCommentResult(row: VnGridRow) {
    const result = commentDrafts[row.userId] ?? row.snapshot?.commentResult ?? 'Đạt';
    setMessage(null);
    try {
      await apiJson(`${base}/${bookId}/results/${row.userId}/comment-result`, {
        method: 'POST',
        body: JSON.stringify({ result }),
      });
      setMessage(t('vnBookCommentSaved'));
      await reloadGrid();
    } catch {
      setMessage(t('vnBookCellSaveFailed'));
    }
  }

  async function decideCandidate(candidate: VnCandidate, action: 'commit' | 'dismiss') {
    setMessage(null);
    try {
      await apiJson(`${base}/${bookId}/candidates/${candidate.mappingId}/students/${candidate.userId}/${action}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setMessage(t('vnBookCandidateDone'));
      await reloadGrid();
    } catch {
      setMessage(t('vnBookCellSaveFailed'));
    }
  }

  const nameOf = (userId: string) => grid?.students.find((s) => s.userId === userId)?.userName ?? userId;
  const isCommentBook = grid?.book.assessmentMode === 'comment';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('vnBooksTitle')}</CardTitle>
        <CardDescription>{t('vnBooksDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={(e) => void createBook(e)} className="flex flex-wrap items-end gap-2">
          <Field>
            <FieldLabel htmlFor="vn-book-term">{t('vnBookTerm')}</FieldLabel>
            <Select value={newTerm} onValueChange={setNewTerm}>
              <SelectTrigger id="vn-book-term">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hk1">{t('vnBookTermHk1')}</SelectItem>
                <SelectItem value="hk2">{t('vnBookTermHk2')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="vn-book-mode">{t('vnBookMode')}</FieldLabel>
            <Select value={newMode} onValueChange={setNewMode}>
              <SelectTrigger id="vn-book-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="score">{t('vnBookModeScore')}</SelectItem>
                <SelectItem value="comment">{t('vnBookModeComment')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {newMode === 'score' && (
            <Field>
              <FieldLabel htmlFor="vn-book-periods">{t('vnBookPeriods')}</FieldLabel>
              <Input
                id="vn-book-periods"
                type="number"
                min={1}
                value={newPeriods}
                onChange={(e) => setNewPeriods(e.target.value)}
              />
            </Field>
          )}
          <Button type="submit">{t('vnBookCreate')}</Button>
        </form>

        {books.length > 0 ? (
          <Field>
            <FieldLabel htmlFor="vn-book-select">{t('vnBookSelect')}</FieldLabel>
            <Select value={bookId} onValueChange={setBookId}>
              <SelectTrigger id="vn-book-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {books.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {t(b.term === 'hk1' ? 'vnBookTermHk1' : 'vnBookTermHk2')} —{' '}
                    {t(b.assessmentMode === 'comment' ? 'vnBookModeComment' : 'vnBookModeScore')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <p className="text-sm text-muted-foreground">{t('vnBookNone')}</p>
        )}

        {message ? (
          <Alert>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}

        {blocked.length > 0 ? (
          <Alert>
            <AlertDescription>
              <p className="font-medium">{t('vnBookBlockedTitle')}</p>
              <ul className="list-disc pl-5">
                {blocked.map((b) => (
                  <li key={b.userId}>
                    {nameOf(b.userId)} —{' '}
                    {t(b.reason === 'awaiting_makeup' ? 'vnBookBlockedAwaitingMakeup' : 'vnBookBlockedIncomplete')}
                    {b.roles.length > 0 ? ` (${b.roles.join(', ')})` : ''}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {grid && !isCommentBook ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left">{t('vnBookStudent')}</th>
                  {grid.items.map((item) => (
                    <th key={item.id} className="text-left">
                      {item.itemName}
                    </th>
                  ))}
                  <th className="text-left">{t('vnBookDtb')}</th>
                  <th className="text-left">{t('vnBookSnapshot')}</th>
                  <th className="text-left">{t('vnBookPublished')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grid.students.map((row) => (
                  <tr key={row.userId} className="align-top">
                    <td>{row.userName}</td>
                    {grid.items.map((item) => {
                      const col = row.computation?.columns.find((c) => c.itemId === item.id);
                      const periodic = item.vnRole === 'dggk' || item.vnRole === 'dgck';
                      return (
                        <td key={item.id}>
                          <div className="flex items-center gap-1">
                            <Input
                              aria-label={`${row.userName} — ${item.itemName}`}
                              className="w-20"
                              value={cellDrafts[`${row.userId}|${item.id}`] ?? ''}
                              onChange={(e) =>
                                setCellDrafts((prev) => ({ ...prev, [`${row.userId}|${item.id}`]: e.target.value }))
                              }
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void saveCell(row, item.id)}
                            >
                              {t('vnBookSaveCell')}
                            </Button>
                          </div>
                          {col?.status === 'awaiting_makeup' ? (
                            <p className="text-xs text-amber-600">{t('vnBookStatusAwaitingMakeup')}</p>
                          ) : col?.status === 'missing' ? (
                            <p className="text-xs text-muted-foreground">{t('vnBookStatusMissing')}</p>
                          ) : null}
                          {periodic ? (
                            <Select value="" onValueChange={(v) => void setMakeup(row, item.id, v)}>
                              <SelectTrigger aria-label={t('vnBookMakeupLabel')} className="mt-1 w-32">
                                <SelectValue placeholder={t('vnBookMakeupLabel')} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="awaiting_makeup">{t('vnBookMakeupAwaiting')}</SelectItem>
                                <SelectItem value="zero">{t('vnBookMakeupZero')}</SelectItem>
                                <SelectItem value="clear">{t('vnBookMakeupClear')}</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : null}
                        </td>
                      );
                    })}
                    <td>{formatScore(row.computation?.dtbHk ?? null)}</td>
                    <td>
                      {row.snapshot ? formatScore(row.snapshot.dtbHk) : '—'}
                      {row.sourceDiverged ? (
                        <p className="text-xs font-medium text-red-600">{t('vnBookDiverged')}</p>
                      ) : null}
                    </td>
                    <td>{row.published ? t('vnBookPublishedYes') : t('vnBookPublishedNo')}</td>
                    <td>
                      <div className="flex flex-col gap-1">
                        <Button type="button" size="sm" variant="outline" onClick={() => void finalizeOne(row)}>
                          {t('vnBookFinalizeOne')}
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => void togglePublish(row)}>
                          {row.published ? t('vnBookUnpublish') : t('vnBookPublish')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-end pt-2">
              <Button type="button" onClick={() => void finalizeAll()}>
                {t('vnBookFinalizeAll')}
              </Button>
            </div>
          </div>
        ) : null}

        {grid && isCommentBook ? (
          <div className="space-y-2">
            {grid.students.map((row) => (
              <div key={row.userId} className="flex flex-wrap items-center gap-2">
                <span className="min-w-40">{row.userName}</span>
                <Select
                  value={commentDrafts[row.userId] ?? row.snapshot?.commentResult ?? 'Đạt'}
                  onValueChange={(v) => setCommentDrafts((prev) => ({ ...prev, [row.userId]: v }))}
                >
                  <SelectTrigger aria-label={`${row.userName} — ${t('vnBookCommentResult')}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Đạt">{t('vnBookCommentPass')}</SelectItem>
                    <SelectItem value="Chưa đạt">{t('vnBookCommentFail')}</SelectItem>
                  </SelectContent>
                </Select>
                <Button type="button" size="sm" variant="outline" onClick={() => void saveCommentResult(row)}>
                  {t('vnBookCommentSave')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {row.published ? t('vnBookPublishedYes') : t('vnBookPublishedNo')}
                </span>
                <Button type="button" size="sm" variant="outline" onClick={() => void togglePublish(row)}>
                  {row.published ? t('vnBookUnpublish') : t('vnBookPublish')}
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {grid && !isCommentBook ? (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t('vnBookCandidatesTitle')}</h3>
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('vnBookCandidatesEmpty')}</p>
            ) : (
              candidates.map((c) => (
                <div key={`${c.mappingId}|${c.userId}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>
                    {nameOf(c.userId)} — {c.activityName} → {formatScore(c.convertedGrade)}
                  </span>
                  <Button type="button" size="sm" onClick={() => void decideCandidate(c, 'commit')}>
                    {t('vnBookCandidateCommit')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void decideCandidate(c, 'dismiss')}
                  >
                    {t('vnBookCandidateDismiss')}
                  </Button>
                </div>
              ))
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
