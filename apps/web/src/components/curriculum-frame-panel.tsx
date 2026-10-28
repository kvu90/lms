import { useEffect, useState } from 'react';
import type { Course } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import {
  useApplyBookFrame,
  useApplyCurriculumFrame,
  useUpdateCourseFrameInfo,
} from '#lib/course-builder-data';
import { FrameUnitPicker } from './frame-picker';
import {
  useBookFrameChapters, useCurriculumFrameUnits, useCurriculumSubjectsScoped,
} from '#lib/curriculum';

/**
 * Panel "Thêm từ khung" (K0a, tách thành component dùng chung ở K1):
 * gắn môn × khối cho khoá (PATCH /courses/:id) rồi nạp các đơn vị khung
 * đã chọn thành section mới kèm YCCĐ chụp tại lúc nạp (POST
 * curriculum-frame), chèn tại vị trí chọn trong outline hoặc cuối
 * outline. Nạp xong gọi `onApplied` để trang chứa nạp lại cấu trúc
 * khoá. Đường đọc cây của panel đi kèm forCourseId = khoá này nên giáo
 * viên có course:update tại khoá đọc được dù không có curriculum:view
 * hệ thống; người không có cả hai chỉ thấy thông báo nhẹ — API vẫn là
 * nơi thực thi quyền.
 */
export function CurriculumFramePanel({
  courseId,
  course,
  sections,
  onApplied,
}: {
  courseId: string;
  course: Course | null;
  sections: { section: number; name: string | null }[];
  onApplied: () => void;
}) {
  const { t } = useTranslation('app');
  const [subjectId, setSubjectId] = useState('');
  const [grade, setGrade] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [insertAt, setInsertAt] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const updateFrameInfoMutation = useUpdateCourseFrameInfo();
  const applyFrameMutation = useApplyCurriculumFrame();

  // Khởi tạo môn/khối từ chính khoá khi dữ liệu khoá về.
  useEffect(() => {
    if (!course) return;
    setSubjectId(course.subjectId ?? '');
    setGrade(course.grade != null ? String(course.grade) : '');
  }, [course?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Danh sách môn đọc qua hook TanStack kèm forCourseId = chính khoá
  // này: giáo viên cấp khoá đọc được qua nhánh course:update tại khoá
  // mình dạy (issue #66); không cần đọc context hệ thống trước — API
  // mặc định về context hệ thống khi không kèm contextId. Lỗi tải
  // (kể cả 403 khi không có cả hai nhánh quyền) suy từ trạng thái
  // query ngay khi render.
  const subjectsQuery = useCurriculumSubjectsScoped(null, courseId);
  const subjects = subjectsQuery.data ?? [];
  const loadFailed = subjectsQuery.isError;

  // Đơn vị khung của cặp (môn, khối) đang chọn, cũng qua hook: đổi
  // môn/khối là một khoá cache mới nên không còn race của effect cũ;
  // lựa chọn đang tích được đặt lại mỗi khi cặp (môn, khối) đổi.
  const frameUnitsQuery = useCurriculumFrameUnits(subjectId, grade ? Number(grade) : null, courseId);
  const curriculumId = frameUnitsQuery.data?.curriculumId ?? null;
  const units = frameUnitsQuery.data?.units ?? [];

  useEffect(() => {
    setSelected([]);
  }, [subjectId, grade]);

  /** Lưu môn/khối của khoá qua PATCH /courses/:id. */
  async function saveCourseInfo() {
    setMessage(null);
    try {
      await updateFrameInfoMutation.mutateAsync({
        courseId,
        subjectId: subjectId === '' ? null : subjectId,
        grade: grade === '' ? null : Number(grade),
      });
      setMessage(t('frameCourseInfoSaved'));
    } catch {
      setMessage(t('frameApplyFailed'));
    }
  }

  /** Nạp các đơn vị khung đã chọn vào khoá ở vị trí đã chọn. */
  async function applyFrame() {
    if (!curriculumId || selected.length === 0) return;
    setMessage(null);
    try {
      const result = await applyFrameMutation.mutateAsync({
        courseId,
        curriculumId,
        nodeIds: selected,
        ...(insertAt === '' ? {} : { insertAtSection: Number(insertAt) }),
      });
      setMessage(t('frameApplied', { count: result.sections.length }));
      setSelected([]);
      onApplied();
    } catch {
      setMessage(t('frameApplyFailed'));
    }
  }

  const selectClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('framePanelTitle')}</CardTitle>
        <CardDescription>{t('framePanelDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loadFailed ? (
          <p className="text-sm text-muted-foreground">{t('frameNoUnits')}</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="frame-subject">{t('frameSubjectLabel')}</Label>
              <select
                id="frame-subject"
                className={selectClass}
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
              >
                <option value="">{t('courseSubjectNone')}</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="frame-grade">{t('frameGradeLabel2')}</Label>
              <select id="frame-grade" className={selectClass} value={grade} onChange={(e) => setGrade(e.target.value)}>
                <option value="">{t('courseGradeNone')}</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                  <option key={g} value={g}>
                    {t('curriculumGradeLabel', { grade: g })}
                  </option>
                ))}
              </select>
            </div>
            <Button type="button" variant="outline" onClick={() => void saveCourseInfo()}>
              {t('frameSaveCourseInfo')}
            </Button>
            {curriculumId ? (
              <>
                <div className="space-y-2">
                  <Label>{t('courseFrameUnitsTitle')}</Label>
                  <FrameUnitPicker
                    units={units}
                    selected={selected}
                    idPrefix="admin-frame"
                    onToggle={(nodeId, checked) =>
                      setSelected((prev) => (checked ? [...prev, nodeId] : prev.filter((x) => x !== nodeId)))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="frame-insert-at">{t('frameInsertAt')}</Label>
                  <select
                    id="frame-insert-at"
                    className={selectClass}
                    value={insertAt}
                    onChange={(e) => setInsertAt(e.target.value)}
                  >
                    <option value="">{t('frameInsertEnd')}</option>
                    {sections
                      .filter((s) => s.section >= 1)
                      .map((s) => (
                        <option key={s.section} value={s.section}>
                          {t('frameInsertBefore', { number: s.section, name: s.name ?? '' })}
                        </option>
                      ))}
                  </select>
                </div>
                <Button type="button" disabled={selected.length === 0} onClick={() => void applyFrame()}>
                  {t('frameApply')}
                </Button>
              </>
            ) : null}
          </>
        )}
        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
/**
 * Panel khung SGK (K0b) trong quản trị khoá: với môn × khối đã gắn cho
 * khoá (panel khung chương trình ở trên), nạp các chủ đề của cuốn SGK
 * đã nạp thành section mới — các bài thành mục của section, YCCĐ của
 * mỗi bài suy qua ánh xạ sang chương trình và chụp tại lúc nạp (POST
 * book-frame). Đường đọc đi kèm forCourseId = khoá này, cùng nhánh
 * quyền với panel khung chương trình.
 */
export function BookFramePanel({
  courseId,
  course,
  sections,
  onApplied,
}: {
  courseId: string;
  course: Course | null;
  sections: { section: number; name: string | null }[];
  onApplied: () => void;
}) {
  const { t } = useTranslation('app');
  const [selected, setSelected] = useState<string[]>([]);
  const [insertAt, setInsertAt] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  // Chủ đề SGK của cặp (môn, khối) đã gắn cho khoá, đọc qua hook
  // TanStack: chưa gắn đủ (môn, khối) hoặc lỗi tải thì coi như chưa
  // có sách nào để chọn; lựa chọn đang tích đặt lại khi cặp đổi.
  const subjectId = course?.subjectId ?? '';
  const grade = course?.grade ?? null;
  const chaptersQuery = useBookFrameChapters(subjectId, grade, courseId);
  const bookId = chaptersQuery.data?.bookId ?? null;
  const chapters = chaptersQuery.data?.chapters ?? [];

  useEffect(() => {
    setSelected([]);
  }, [subjectId, grade, courseId]);

  const applyBookFrameMutation = useApplyBookFrame();

  /** Nạp các chủ đề SGK đã chọn vào khoá ở vị trí đã chọn. */
  async function applyBookFrame() {
    if (!bookId || selected.length === 0) return;
    setMessage(null);
    try {
      const result = await applyBookFrameMutation.mutateAsync({
        courseId,
        bookId,
        chapterNodeIds: selected,
        ...(insertAt === '' ? {} : { insertAtSection: Number(insertAt) }),
      });
      setMessage(t('bookFrameApplied', { count: result.sections.length }));
      setSelected([]);
      onApplied();
    } catch {
      setMessage(t('bookFrameApplyFailed'));
    }
  }

  const selectClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('bookFramePanelTitle')}</CardTitle>
        <CardDescription>{t('bookFramePanelDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!bookId ? (
          <p className="text-sm text-muted-foreground">{t('bookFrameNoBook')}</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label>{t('bookFrameChaptersTitle')}</Label>
              <ul className="flex flex-col gap-1">
                {chapters.map((chapter) => (
                  <li key={chapter.nodeId} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      id={`book-frame-${chapter.nodeId}`}
                      checked={selected.includes(chapter.nodeId)}
                      onChange={(e) =>
                        setSelected((prev) =>
                          e.target.checked ? [...prev, chapter.nodeId] : prev.filter((x) => x !== chapter.nodeId),
                        )
                      }
                    />
                    <label htmlFor={`book-frame-${chapter.nodeId}`}>{chapter.title}</label>
                    <span className="text-muted-foreground">
                      {t('bookFrameChapterMeta', { lessons: chapter.lessonCount, outcomes: chapter.outcomeCount })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-2">
              <Label htmlFor="book-frame-insert-at">{t('frameInsertAt')}</Label>
              <select
                id="book-frame-insert-at"
                className={selectClass}
                value={insertAt}
                onChange={(e) => setInsertAt(e.target.value)}
              >
                <option value="">{t('frameInsertEnd')}</option>
                {sections
                  .filter((s) => s.section >= 1)
                  .map((s) => (
                    <option key={s.section} value={s.section}>
                      {t('frameInsertBefore', { number: s.section, name: s.name ?? '' })}
                    </option>
                  ))}
              </select>
            </div>
            <Button type="button" disabled={selected.length === 0} onClick={() => void applyBookFrame()}>
              {t('bookFrameApply')}
            </Button>
          </>
        )}
        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
