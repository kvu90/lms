import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Label } from '@lms/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { PageHeader, PageShell } from '../components/page-shell';
import { ProgramGroupTable } from '../components/admin-curriculum/program-group-table';
import { buildProgramGroups, PROGRAM_PAGE_SIZE } from '../components/admin-curriculum/tree-page';
import { ApiError } from '#lib/api';
import { useAccessContexts } from '#lib/access';
import { useCourseList } from '#lib/course-new-data';
import {
  useCurriculumCurriculaScoped,
  useCurriculumSubjectsScoped,
  useCurriculumTreeScoped,
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
  // Chuỗi đọc phụ thuộc khoá → môn → lớp → cây qua TanStack Query
  // (F-01 của #133): khoá qua khoá `courses`, môn/lớp/cây qua các
  // hook có phạm vi của `lib/curriculum.ts` với khoá gồm cả ngữ cảnh
  // khoá (quyền đọc đổi theo khoá). Lựa chọn hiệu lực suy từ dữ liệu
  // theo đúng thứ tự ưu tiên của các effect thủ công trước đây: môn
  // gắn sẵn của khoá thắng lựa chọn cũ, lớp theo khối của khoá thắng
  // lựa chọn cũ, còn lại giữ lựa chọn nếu còn hợp lệ, cuối cùng là
  // phần tử đầu. Trạng thái "chưa tải" (null) và "tải hỏng thì rỗng"
  // giữ nguyên như bản thủ công; 403 ở bất kỳ bước nào thì forbidden.
  const coursesQuery = useCourseList();
  const courses = coursesQuery.data ?? null;
  const [courseSelection, setCourseSelection] = useState<string | null>(null);
  const courseId =
    courses === null
      ? (courseSelection ?? '')
      : courseSelection && courses.some((c) => c.id === courseSelection)
        ? courseSelection
        : (courses[0]?.id ?? '');
  const course = courses?.find((c) => c.id === courseId);

  const contextsQuery = useAccessContexts();
  const systemContextId = contextsQuery.data?.find((c) => c.contextLevel === 10)?.id ?? null;
  const subjectsQuery = useCurriculumSubjectsScoped(
    systemContextId,
    courseId || undefined,
    courses !== null,
  );
  const subjectsLoaded =
    subjectsQuery.data !== undefined ||
    subjectsQuery.isError ||
    (contextsQuery.data !== undefined && systemContextId === null);
  const subjects = subjectsQuery.data ?? (subjectsLoaded ? [] : null);
  const [subjectSelection, setSubjectSelection] = useState<string | null>(null);
  const subjectId =
    subjects === null
      ? (subjectSelection ?? '')
      : course?.subjectId && subjects.some((s) => s.id === course.subjectId)
        ? course.subjectId
        : subjectSelection && subjects.some((s) => s.id === subjectSelection)
          ? subjectSelection
          : (subjects[0]?.id ?? '');

  const curriculaQuery = useCurriculumCurriculaScoped(
    subjectId,
    courseId || undefined,
    subjects !== null,
  );
  const curriculaLoaded = curriculaQuery.data !== undefined || curriculaQuery.isError;
  const curricula = curriculaQuery.data
    ? [...curriculaQuery.data].sort((a, b) => a.grade - b.grade)
    : curriculaLoaded
      ? []
      : null;
  const [curriculumSelection, setCurriculumSelection] = useState<string | null>(null);
  const preferredCurriculum =
    course?.subjectId === subjectId && course?.grade != null
      ? curricula?.find((c) => c.grade === course.grade)
      : undefined;
  const curriculumId =
    curricula === null
      ? (curriculumSelection ?? '')
      : (preferredCurriculum?.id ??
        (curriculumSelection && curricula.some((c) => c.id === curriculumSelection)
          ? curriculumSelection
          : (curricula[0]?.id ?? '')));

  const treeQuery = useCurriculumTreeScoped(curriculumId, courseId || undefined, curricula !== null);
  const tree: CurriculumTree | null = treeQuery.data ?? null;

  const isForbiddenError = (error: unknown) =>
    error instanceof ApiError && error.problem.status === 403;
  const forbidden = [
    contextsQuery.error,
    subjectsQuery.error,
    curriculaQuery.error,
    treeQuery.error,
  ].some((error) => error != null && isForbiddenError(error));

  const [page, setPage] = useState(1);
  const groupsTopRef = useRef<HTMLDivElement | null>(null);

  // Đổi (khoá, lớp) thì phân trang quay về trang đầu — như nhịp đặt
  // lại ở bước tải cây của bản thủ công.
  useEffect(() => {
    setPage(1);
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
            <Select value={courseId} onValueChange={(value) => setCourseSelection(value ?? '')}>
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
            <Select value={subjectId} onValueChange={(value) => setSubjectSelection(value ?? '')}>
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
            <Select value={curriculumId} onValueChange={(value) => setCurriculumSelection(value ?? '')}>
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
