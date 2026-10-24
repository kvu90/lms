import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { Course, CourseContent } from '@lms/contracts';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson, ApiError } from '#lib/api';
import { fetchSubjects, fetchSystemContextId, type CurriculumSubject } from '#lib/curriculum';
import {
  LEVELS, RESOURCE_TYPES, REVIEW_STATUSES, deleteItem, fetchItemFileUrl, fetchItems, fetchSpaces, insertItem,
  reviewItem, submitItem, type LibraryItem, type LibrarySpace, type ReviewChecklist,
} from '#lib/content-bank';

const SELECT_CLASS = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (err.problem.detail ?? err.problem.title ?? fallback) : fallback;
}

function spaceKey(space: LibrarySpace): string {
  return `${space.scope}:${space.spaceId ?? ''}`;
}

function itemSpaceKey(item: LibraryItem): string {
  return `${item.scope}:${item.scope === 'org' ? (item.spaceId ?? '') : ''}`;
}

/**
 * Trang Kho học liệu (CB-1, chuẩn §9): danh sách học liệu theo KHÔNG GIAN
 * (của tôi / từng tổ chuyên môn / toàn trường), bấm vào không gian thì
 * thu/mở danh sách; lọc theo môn – khối – loại – trạng thái duyệt; tạo
 * mới là màn riêng, mỗi dòng có Sửa/Xoá ngay tại dòng. Học liệu chia sẻ
 * có nút Gửi duyệt; người duyệt (tổ trưởng) thấy nút Duyệt/Từ chối ngay
 * tại dòng đang chờ. "Thêm vào khoá" mở panel chọn khoá + section rồi
 * cắm học liệu vào khoá bằng bản sao (API insert). Học liệu chưa duyệt
 * không xuất hiện ở scope tổ/trường — phía server đã gác, trang chỉ
 * hiển thị những gì API trả.
 */
export function ContentBankLibraryPage() {
  const { t } = useTranslation();
  const [spaces, setSpaces] = useState<LibrarySpace[]>([]);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [subjects, setSubjects] = useState<CurriculumSubject[]>([]);
  const [openSpaces, setOpenSpaces] = useState<Record<string, boolean>>({});
  const [subjectFilter, setSubjectFilter] = useState('');
  const [gradeFilter, setGradeFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewChecks, setReviewChecks] = useState<Record<string, ReviewChecklist>>({});
  const checklistFor = (id: string): ReviewChecklist =>
    reviewChecks[id] ?? { contentAccurate: false, sourceClear: false, pedagogyAesthetics: false, mobileReady: false };
  const [insertFor, setInsertFor] = useState<string | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [insertCourseId, setInsertCourseId] = useState('');
  const [insertSections, setInsertSections] = useState<CourseContent['sections']>([]);
  const [insertSectionId, setInsertSectionId] = useState('');

  const reload = useCallback(async () => {
    try {
      const [spaceRows, itemRows] = await Promise.all([fetchSpaces(), fetchItems()]);
      setSpaces(spaceRows);
      setItems(itemRows);
      setOpenSpaces((prev) => {
        const next = { ...prev };
        for (const s of spaceRows) if (next[spaceKey(s)] === undefined) next[spaceKey(s)] = s.scope === 'personal';
        return next;
      });
      setError(null);
    } catch (err) {
      setError(errorText(err, t('libraryLoadFailed')));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void (async () => {
      const sys = await fetchSystemContextId().catch(() => null);
      if (sys) setSubjects(await fetchSubjects(sys).catch(() => []));
    })();
  }, []);

  const subjectName = useCallback(
    (id: string | null) => subjects.find((s) => s.id === id)?.name ?? null,
    [subjects],
  );

  const filtered = useMemo(
    () =>
      items.filter(
        (i) =>
          (!subjectFilter || i.subjectId === subjectFilter) &&
          (!gradeFilter || i.grade === Number(gradeFilter)) &&
          (!levelFilter || i.level === levelFilter) &&
          (!typeFilter || i.resourceType === typeFilter) &&
          (!statusFilter || i.reviewStatus === statusFilter),
      ),
    [items, subjectFilter, gradeFilter, levelFilter, typeFilter, statusFilter],
  );

  async function runAction(id: string, action: () => Promise<unknown>, done?: string) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
      await reload();
    } catch (err) {
      setError(errorText(err, t('libraryActionFailed')));
    } finally {
      setBusyId(null);
    }
  }

  async function download(item: LibraryItem) {
    try {
      const { url } = await fetchItemFileUrl(item.id);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError(errorText(err, t('libraryActionFailed')));
    }
  }

  async function openInsert(item: LibraryItem) {
    setInsertFor(item.id);
    setInsertCourseId('');
    setInsertSections([]);
    setInsertSectionId('');
    if (courses.length === 0) {
      const rows = await apiJson<Course[]>('/api/v1/courses').catch(() => [] as Course[]);
      setCourses(rows);
    }
  }

  async function pickCourse(courseId: string) {
    setInsertCourseId(courseId);
    setInsertSections([]);
    setInsertSectionId('');
    if (!courseId) return;
    const content = await apiJson<CourseContent>(`/api/v1/courses/${courseId}/content`).catch(() => null);
    if (content) {
      setInsertSections(content.sections);
      if (content.sections[0]) setInsertSectionId(content.sections[0].id);
    }
  }

  const typeLabel = (type: string) =>
    t(
      type === 'multimedia_lecture'
        ? 'libraryTypeMultimediaLecture'
        : type === 'lab_guide'
          ? 'libraryTypeLabGuide'
          : type === 'simulation'
            ? 'libraryTypeSimulation'
            : type === 'question_set'
              ? 'libraryTypeQuestionSet'
              : 'libraryTypeReference',
    );
  const statusLabel = (status: string) =>
    t(
      status === 'pending'
        ? 'libraryStatusPending'
        : status === 'approved'
          ? 'libraryStatusApproved'
          : status === 'rejected'
            ? 'libraryStatusRejected'
            : 'libraryStatusDraft',
    );

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('libraryTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('librarySubtitle')}</p>
        </div>
        <Link
          to="/contentbank/new"
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          {t('libraryNew')}
        </Link>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p>{notice}</p> : null}

      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="lib-filter-subject">{t('libraryFilterSubject')}</Label>
            <select id="lib-filter-subject" className={SELECT_CLASS} value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)}>
              <option value="">{t('libraryFilterAll')}</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lib-filter-grade">{t('libraryFilterGrade')}</Label>
            <select id="lib-filter-grade" className={SELECT_CLASS} value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}>
              <option value="">{t('libraryFilterAll')}</option>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                <option key={g} value={g}>{t('libraryGradeOption', { grade: g })}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lib-filter-level">{t('libraryFormLevel')}</Label>
            <select id="lib-filter-level" className={SELECT_CLASS} value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
              <option value="">{t('libraryFilterAll')}</option>
              {LEVELS.map((lv) => (
                <option key={lv} value={lv}>
                  {t(lv === 'primary' ? 'libraryLevelPrimary' : lv === 'lower_secondary' ? 'libraryLevelLowerSecondary' : lv === 'upper_secondary' ? 'libraryLevelUpperSecondary' : 'libraryLevelMulti')}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lib-filter-type">{t('libraryFilterType')}</Label>
            <select id="lib-filter-type" className={SELECT_CLASS} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">{t('libraryFilterAll')}</option>
              {RESOURCE_TYPES.map((type) => (
                <option key={type} value={type}>{typeLabel(type)}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lib-filter-status">{t('libraryFilterStatus')}</Label>
            <select id="lib-filter-status" className={SELECT_CLASS} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">{t('libraryFilterAll')}</option>
              {REVIEW_STATUSES.map((status) => (
                <option key={status} value={status}>{statusLabel(status)}</option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <section aria-label={t('librarySpaces')} className="space-y-4">
        {spaces.map((space) => {
          const key = spaceKey(space);
          const rows = filtered.filter((i) => itemSpaceKey(i) === key);
          const open = openSpaces[key] ?? false;
          return (
            <Card key={key}>
              <CardHeader>
                <button
                  type="button"
                  className="flex w-full items-center justify-between text-left"
                  aria-expanded={open}
                  onClick={() => setOpenSpaces((prev) => ({ ...prev, [key]: !open }))}
                >
                  <CardTitle>
                    {space.name} <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
                  </CardTitle>
                  <span aria-hidden>{open ? '▾' : '▸'}</span>
                </button>
              </CardHeader>
              {open ? (
                <CardContent>
                  {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('libraryEmpty')}</p>
                  ) : (
                    <ul aria-label={t('libraryItems')} className="space-y-2">
                      {rows.map((item) => (
                        <li key={item.id} className="space-y-2 rounded border p-3" data-testid={`library-item-${item.id}`}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{item.name}</span>
                            <Badge variant="secondary">{typeLabel(item.resourceType)}</Badge>
                            <Badge variant={item.reviewStatus === 'approved' ? 'default' : 'outline'}>{statusLabel(item.reviewStatus)}</Badge>
                            {subjectName(item.subjectId) ? <span className="text-sm text-muted-foreground">{subjectName(item.subjectId)}</span> : null}
                            {item.grade ? <span className="text-sm text-muted-foreground">{t('libraryGradeOption', { grade: item.grade })}</span> : null}
                            {item.reviewNote ? <span className="text-sm text-muted-foreground">“{item.reviewNote}”</span> : null}
                          </div>
                          {item.originalAuthor || item.sourceCitation || item.license || item.derivedFromId ? (
                            <p className="text-sm text-muted-foreground">
                              {[
                                item.originalAuthor ? t('libraryAttributionAuthor', { author: item.originalAuthor }) : null,
                                item.sourceCitation ? t('libraryAttributionSource', { source: item.sourceCitation }) : null,
                                item.license ? t('libraryAttributionLicense', { license: item.license }) : null,
                                item.derivedFromId ? t('libraryAttributionDerived') : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                          ) : null}
                          {item.description ? <p className="text-sm text-muted-foreground">{item.description}</p> : null}
                          <div className="flex flex-wrap items-center gap-2">
                            {item.fileId ? (
                              <Button type="button" variant="outline" size="sm" onClick={() => void download(item)}>
                                {t('libraryFileDownload')}
                              </Button>
                            ) : null}
                            {!(item.resourceType === 'question_set' && !item.fileId) ? (
                              <Button type="button" variant="outline" size="sm" onClick={() => void openInsert(item)}>
                                {t('libraryInsert')}
                              </Button>
                            ) : null}
                            {item.scope !== 'personal' && (item.reviewStatus === 'draft' || item.reviewStatus === 'rejected') ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={busyId === item.id}
                                onClick={() => void runAction(item.id, () => submitItem(item.id))}
                              >
                                {t('librarySubmitReview')}
                              </Button>
                            ) : null}
                            <Link
                              to={`/contentbank/${item.id}/edit`}
                              className="inline-flex h-8 items-center rounded-md border border-input bg-transparent px-3 text-sm"
                            >
                              {t('libraryEdit')}
                            </Link>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busyId === item.id}
                              onClick={() => {
                                if (window.confirm(t('libraryDeleteConfirm', { name: item.name }))) {
                                  void runAction(item.id, () => deleteItem(item.id));
                                }
                              }}
                            >
                              {t('libraryDelete')}
                            </Button>
                          </div>
                          {space.canReview && item.reviewStatus === 'pending' ? (
                            <div className="space-y-2">
                              <div className="flex flex-wrap gap-x-4 gap-y-1">
                                {(
                                  [
                                    ['contentAccurate', 'libraryChecklistContent'],
                                    ['sourceClear', 'libraryChecklistSource'],
                                    ['pedagogyAesthetics', 'libraryChecklistPedagogy'],
                                    ['mobileReady', 'libraryChecklistMobile'],
                                  ] as const
                                ).map(([field, labelKey]) => (
                                  <label key={field} className="flex items-center gap-1 text-sm">
                                    <input
                                      type="checkbox"
                                      checked={checklistFor(item.id)[field]}
                                      onChange={(e) =>
                                        setReviewChecks((prev) => ({
                                          ...prev,
                                          [item.id]: { ...checklistFor(item.id), [field]: e.target.checked },
                                        }))
                                      }
                                    />
                                    {t(labelKey)}
                                  </label>
                                ))}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Input
                                  aria-label={t('libraryReviewNote')}
                                  placeholder={t('libraryReviewNote')}
                                  value={reviewNotes[item.id] ?? ''}
                                  onChange={(e) => setReviewNotes((prev) => ({ ...prev, [item.id]: e.target.value }))}
                                  className="max-w-xs"
                                />
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={
                                    busyId === item.id ||
                                    !(
                                      checklistFor(item.id).contentAccurate &&
                                      checklistFor(item.id).sourceClear &&
                                      checklistFor(item.id).pedagogyAesthetics &&
                                      checklistFor(item.id).mobileReady
                                    )
                                  }
                                  onClick={() =>
                                    void runAction(item.id, () =>
                                      reviewItem(item.id, 'approved', reviewNotes[item.id] || undefined, checklistFor(item.id)),
                                    )
                                  }
                                >
                                  {t('libraryApprove')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={busyId === item.id || !(reviewNotes[item.id] ?? '').trim()}
                                  onClick={() => void runAction(item.id, () => reviewItem(item.id, 'rejected', reviewNotes[item.id]))}
                                >
                                  {t('libraryReject')}
                                </Button>
                              </div>
                            </div>
                          ) : null}
                          {insertFor === item.id ? (
                            <div className="space-y-2 rounded border border-dashed p-3">
                              <p className="text-sm font-medium">{t('libraryInsertTitle')}</p>
                              <div className="grid gap-2 sm:grid-cols-2">
                                <select
                                  aria-label={t('libraryInsertCourse')}
                                  className={SELECT_CLASS}
                                  value={insertCourseId}
                                  onChange={(e) => void pickCourse(e.target.value)}
                                >
                                  <option value="">{t('libraryInsertPickCourse')}</option>
                                  {courses.map((c) => (
                                    <option key={c.id} value={c.id}>{c.fullName}</option>
                                  ))}
                                </select>
                                <select
                                  aria-label={t('libraryInsertSection')}
                                  className={SELECT_CLASS}
                                  value={insertSectionId}
                                  onChange={(e) => setInsertSectionId(e.target.value)}
                                >
                                  {insertSections.map((s) => (
                                    <option key={s.id} value={s.id}>{s.name ?? `#${s.section}`}</option>
                                  ))}
                                </select>
                              </div>
                              <Button
                                type="button"
                                size="sm"
                                disabled={!insertCourseId || !insertSectionId || busyId === item.id}
                                onClick={() => {
                                  setBusyId(item.id);
                                  setError(null);
                                  void insertItem(item.id, insertCourseId, insertSectionId)
                                    .then((res) => {
                                      setNotice(t('libraryInsertDone', { cmId: res.cmId }));
                                      setInsertFor(null);
                                    })
                                    .catch((err: unknown) => setError(errorText(err, t('libraryActionFailed'))))
                                    .finally(() => setBusyId(null));
                                }}
                              >
                                {t('libraryInsertAction')}
                              </Button>
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              ) : null}
            </Card>
          );
        })}
      </section>
    </main>
  );
}

export default ContentBankLibraryPage;
