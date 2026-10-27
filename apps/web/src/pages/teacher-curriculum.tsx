import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Label } from '@lms/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import type { Course } from '@lms/contracts';
import { PageHeader, PageShell } from '../components/page-shell';
import { ProgramGroupTable } from '../components/admin-curriculum/program-group-table';
import { buildProgramGroups, PROGRAM_PAGE_SIZE } from '../components/admin-curriculum/tree-page';
import { ApiError, apiJson } from '#lib/api';
import {
  fetchCurricula,
  fetchSubjects,
  fetchSystemContextId,
  fetchTree,
  type Curriculum,
  type CurriculumSubject,
  type CurriculumTree,
} from '#lib/curriculum';
import '../i18n';

/**
 * TRANG XEM CHƯƠNG TRÌNH GDPT CHO GIÁO VIÊN (issue #161, lát T2 —
 * quyết định 3 của issue: mọi bề mặt nhìn chương trình đều trình bày
 * môn → lớp → bảng nhóm theo Mạch nội dung, 2 cột
 * "Nội dung | Yêu cầu cần đạt" theo mẫu bảng của Bộ).
 *
 * Bối cảnh: trước lát này bề mặt xem bảng Bộ chỉ có ở khu QUẢN TRỊ
 * (gate `curriculum:view` tại context quốc gia) — giáo viên thật
 * không vào được, dù chính họ là người tra cứu chương trình khi soạn
 * bài, soạn câu hỏi và xây dựng đề. Trang này là bề mặt CHỈ XEM cho
 * giáo viên, dùng lại đúng component trình bày của phía quản trị ở
 * chế độ `readOnly`.
 *
 * QUYỀN ĐỌC — bám đúng cổng phía API (`assertCanRead`): chương trình
 * quốc gia neo ở context hệ thống; giáo viên đọc được khi có
 * `curriculum:view` tại context của môn, HOẶC khi ngữ cảnh khoá
 * (`forCourseId`) cấp `course:update` tại một khoá họ dạy (tiền lệ đã
 * chốt cho phía giáo viên). Vì vậy mọi lời đọc của trang đều mang
 * `forCourseId` = khoá đang chọn; khoá ở đây CHỈ là ngữ cảnh quyền
 * xem — không một dữ liệu nào của khoá bị thay đổi. Người dùng không
 * có khoá nào thì trang thử đọc trực tiếp (phủ trường hợp có
 * `curriculum:view`); vẫn 403 thì hiện thông báo giải thích thay vì
 * trang trắng.
 *
 * Điều hướng mặc định theo khoá: khoá học đã gắn môn + khối lớp của
 * chương trình thì khi chọn khoá, trang mở sẵn đúng môn và lớp đó
 * (giáo viên vẫn đổi sang môn/lớp khác bằng các bộ chọn).
 *
 * Điểm trình bày T1 (bản ghi thiếu nhóm mạch) ở lát này: bản ghi
 * không thuộc mạch nào render vào bảng không tiêu đề nhóm — đúng
 * hành vi hiện tại của bề mặt quản trị; việc gán mạch cho đủ 2.115
 * bản ghi là việc dữ liệu, làm riêng theo quy trình đối chiếu văn bản
 * chính chủ. Điểm T3 (giữ cấu trúc dòng của YCCĐ) được sửa ở component
 * trình bày dùng chung. Điểm T4 (số đếm bị cắt ở ký tự đặc biệt) là
 * việc dữ liệu, không thuộc lát trình bày này.
 */

type ProgramGroup = ReturnType<typeof buildProgramGroups>[number];

/** Danh sách số trang ở nút phân trang — cùng quy tắc rút gọn với trang cây quản trị (1 … quanh trang hiện tại … cuối). */
function pageNumberItems(total: number, current: number): (number | 'gap')[] {
  if (total <= 12) return Array.from({ length: total }, (_, i) => i + 1);
  const wanted = new Set([1, 2, total - 1, total, current - 1, current, current + 1]);
  const nums = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  let prev = 0;
  for (const n of nums) {
    if (prev > 0 && n - prev > 1) out.push('gap');
    out.push(n);
    prev = n;
  }
  return out;
}

export function TeacherCurriculumPage() {
  const { t } = useTranslation('app');
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [courseId, setCourseId] = useState('');
  const [subjects, setSubjects] = useState<CurriculumSubject[] | null>(null);
  const [subjectId, setSubjectId] = useState('');
  const [curricula, setCurricula] = useState<Curriculum[] | null>(null);
  const [curriculumId, setCurriculumId] = useState('');
  const [tree, setTree] = useState<CurriculumTree | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [page, setPage] = useState(1);
  const groupsTopRef = useRef<HTMLDivElement | null>(null);

  // Bước 1: danh sách khoá của người dùng (ngữ cảnh quyền xem) — chọn
  // sẵn khoá đầu tiên nếu chưa chọn.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await apiJson<Course[]>('/api/v1/courses');
        if (cancelled) return;
        setCourses(list);
        if (list.length > 0) {
          setCourseId((prev) => (list.some((c) => c.id === prev) ? prev : list[0]!.id));
        }
      } catch {
        if (!cancelled) setCourses([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bước 2: danh sách môn — qua ngữ cảnh khoá đã chọn; khoá đã gắn môn
  // chương trình thì mở sẵn môn đó.
  useEffect(() => {
    if (courses === null) return;
    let cancelled = false;
    setSubjects(null);
    setTree(null);
    setForbidden(false);
    void (async () => {
      try {
        const contextId = await fetchSystemContextId();
        if (cancelled) return;
        if (!contextId) {
          setSubjects([]);
          return;
        }
        const list = await fetchSubjects(contextId, courseId || undefined);
        if (cancelled) return;
        setSubjects(list);
        const course = courses.find((c) => c.id === courseId);
        setSubjectId((prev) => {
          if (course?.subjectId && list.some((s) => s.id === course.subjectId)) return course.subjectId;
          return list.some((s) => s.id === prev) ? prev : (list[0]?.id ?? '');
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.problem.status === 403) setForbidden(true);
        setSubjects([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [courses, courseId]);

  // Bước 3: các lớp của môn đã chọn — khoá đã gắn khối lớp thì mở sẵn
  // lớp đó, mặc định lớp nhỏ nhất.
  useEffect(() => {
    if (!subjectId) {
      setCurricula(null);
      return;
    }
    let cancelled = false;
    setCurricula(null);
    setTree(null);
    void (async () => {
      try {
        const list = await fetchCurricula(subjectId, courseId || undefined);
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => a.grade - b.grade);
        setCurricula(sorted);
        const course = (courses ?? []).find((c) => c.id === courseId);
        const preferred =
          course?.subjectId === subjectId && course.grade != null
            ? sorted.find((c) => c.grade === course.grade)
            : undefined;
        setCurriculumId(
          (prev) => preferred?.id ?? (sorted.some((c) => c.id === prev) ? prev : (sorted[0]?.id ?? '')),
        );
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.problem.status === 403) setForbidden(true);
        setCurricula([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subjectId, courseId, courses]);

  // Bước 4: cây chương trình của lớp đã chọn.
  useEffect(() => {
    if (!curriculumId) {
      setTree(null);
      return;
    }
    let cancelled = false;
    setTree(null);
    setPage(1);
    void (async () => {
      try {
        const loaded = await fetchTree(curriculumId, courseId || undefined);
        if (!cancelled) setTree(loaded);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.problem.status === 403) setForbidden(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [curriculumId, courseId]);

  // Phân trang theo dòng Nội dung trên toàn cây — cùng quy tắc với
  // trang cây quản trị: mạch giữ nguyên thứ tự, mạch đang dở được
  // trình bày tiếp ở trang sau với tiêu đề lặp lại kèm dấu (tiếp).
  const groups: ProgramGroup[] = tree ? buildProgramGroups(tree) : [];
  const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);
  const totalPages = Math.max(1, Math.ceil(totalRows / PROGRAM_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PROGRAM_PAGE_SIZE;
  const pageEnd = pageStart + PROGRAM_PAGE_SIZE;
  const segments: { group: ProgramGroup; rows: ProgramGroup['rows']; continued: boolean }[] = [];
  if (tree) {
    let cursor = 0;
    for (const group of groups) {
      const start = cursor;
      const end = start + group.rows.length;
      cursor = end;
      if (group.rows.length === 0) {
        const attachIndex = Math.min(start, Math.max(totalRows - 1, 0));
        if (Math.floor(attachIndex / PROGRAM_PAGE_SIZE) + 1 === currentPage) {
          segments.push({ group, rows: [], continued: false });
        }
        continue;
      }
      const from = Math.max(start, pageStart);
      const to = Math.min(end, pageEnd);
      if (from < to) {
        segments.push({ group, rows: group.rows.slice(from - start, to - start), continued: start < pageStart });
      }
    }
  }

  function goToPage(next: number) {
    setPage(Math.max(1, Math.min(next, totalPages)));
    groupsTopRef.current?.scrollIntoView?.({ block: 'start' });
  }

  const hasCourses = courses !== null && courses.length > 0;

  return (
    <PageShell>
      <PageHeader title={t('teacherProgrammeTitle')} description={t('teacherProgrammeDescription')} />
      {forbidden ? (
        <Alert variant="destructive">
          <AlertDescription>{hasCourses ? t('teacherProgrammeForbidden') : t('teacherProgrammeNoCourse')}</AlertDescription>
        </Alert>
      ) : null}
      {!forbidden && courses !== null && !hasCourses && subjects !== null && subjects.length === 0 ? (
        <Alert>
          <AlertDescription>{t('teacherProgrammeNoCourse')}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-end gap-4">
        {hasCourses ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="teacher-programme-course">{t('teacherProgrammeCourseLabel')}</Label>
            <Select value={courseId} onValueChange={(value) => setCourseId(value ?? '')}>
              <SelectTrigger id="teacher-programme-course" className="w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {courses.map((course) => (
                  <SelectItem key={course.id} value={course.id}>
                    {course.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {subjects !== null && subjects.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="teacher-programme-subject">{t('teacherProgrammeSubjectLabel')}</Label>
            <Select value={subjectId} onValueChange={(value) => setSubjectId(value ?? '')}>
              <SelectTrigger id="teacher-programme-subject" className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {subjects.map((subject) => (
                  <SelectItem key={subject.id} value={subject.id}>
                    {subject.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {curricula !== null && curricula.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="teacher-programme-grade">{t('teacherProgrammeGradeLabel')}</Label>
            <Select value={curriculumId} onValueChange={(value) => setCurriculumId(value ?? '')}>
              <SelectTrigger id="teacher-programme-grade" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {curricula.map((curriculum) => (
                  <SelectItem key={curriculum.id} value={curriculum.id}>
                    {t('curriculumGradeLabel', { grade: curriculum.grade })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      {tree ? (
        <>
          <h2 className="text-lg font-semibold">
            {t('curriculumTreeTitle', { subject: tree.subject.name, grade: tree.curriculum.grade })}
          </h2>
          <div className="flex flex-col gap-4" ref={groupsTopRef}>
            {segments.map(({ group, rows, continued }) => (
              <ProgramGroupTable
                key={`${group.key}-${continued ? 'cont' : 'start'}`}
                title={group.title}
                groupNode={group.groupNode}
                rows={rows}
                curriculumId={tree.curriculum.id}
                continued={continued}
                readOnly
              />
            ))}
          </div>
          {totalPages > 1 ? (
            <nav aria-label={t('curriculumPaginationLabel')} className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>
                {t('curriculumPagePrevious')}
              </Button>
              {pageNumberItems(totalPages, currentPage).map((item, i) =>
                item === 'gap' ? (
                  <span key={`gap-${i}`} className="text-sm text-muted-foreground">
                    …
                  </span>
                ) : (
                  <Button
                    key={item}
                    type="button"
                    variant={item === currentPage ? 'default' : 'outline'}
                    size="sm"
                    aria-current={item === currentPage ? 'page' : undefined}
                    onClick={() => goToPage(item)}
                  >
                    {item}
                  </Button>
                ),
              )}
              <Button type="button" variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => goToPage(currentPage + 1)}>
                {t('curriculumPageNext')}
              </Button>
              <span className="text-sm text-muted-foreground">
                {t('curriculumPageStatus', { current: currentPage, total: totalPages })}
              </span>
            </nav>
          ) : null}
        </>
      ) : !forbidden ? (
        <p className="text-sm text-muted-foreground">{t('curriculumLoading')}</p>
      ) : null}
    </PageShell>
  );
}

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('teacherProgrammeTitle');
}
