import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  COURSE_CONTENT_TYPES,
  type Course, type CourseContent, type CourseGroup, type CourseGrouping, type GradeItem,
} from '@lms/contracts';
import { AvailabilityEditor } from '#components/availability-editor';
import { CurriculumFramePanel, BookFramePanel } from '#components/curriculum-frame-panel';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';
import { usePermissions } from '#lib/permissions';

/**
 * Builder Outline (K1 — issue #68): trang xây dựng khoá học RIÊNG,
 * tách khỏi trang quản trị khoá gộp theo chuẩn §9. Gồm: thông tin khoá
 * (+ cờ khoá mẫu tổ/trường), panel "Thêm từ khung" (K0a), outline
 * section/module với kéo–thả đổi thứ tự (kèm nút lên/xuống), nhân
 * bản/xoá ngay tại dòng, thêm nội dung bằng MENU chọn loại (không gõ
 * chuỗi component), trạng thái Nháp/Đã mở/Mở theo lịch qua trường
 * ngày mở `openAt` riêng, điều kiện truy cập nâng cao (availability)
 * giữ nguyên từ bản cũ, panel "Dùng lại từ khoá khác" và tiêu chí
 * hoàn thành khoá. Quyền: teaching của khoá hoặc quản trị hệ thống —
 * API vẫn thực thi capability thật cho từng thao tác ghi.
 */
type ItemStatusChoice = 'draft' | 'open' | 'scheduled';

function statusChoiceOf(visible: boolean, openAt: string | null | undefined): ItemStatusChoice {
  if (!visible) return 'draft';
  return openAt ? 'scheduled' : 'open';
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function CourseBuilderPage() {
  const { t } = useTranslation('app');
  const { id } = useParams();
  const courseId = id ?? '';
  const perms = usePermissions();
  const navigate = useNavigate();

  const courseAccess = perms.courses.find((c) => c.course.id === courseId);
  const canBuild =
    perms.canAdminister ||
    perms.teaching.some((c) => c.course.id === courseId) ||
    (courseAccess?.capabilities.includes('course:update') ?? false);
  const canManageCompletion =
    perms.canAdminister || (courseAccess?.capabilities.includes('completion:manage') ?? false);

  const [course, setCourse] = useState<Course | null>(null);
  const [content, setContent] = useState<CourseContent | null>(null);
  const [groups, setGroups] = useState<CourseGroup[]>([]);
  const [groupings, setGroupings] = useState<CourseGrouping[]>([]);
  const [gradeItems, setGradeItems] = useState<GradeItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Form thông tin khoá.
  const [fullName, setFullname] = useState('');
  const [shortName, setShortname] = useState('');
  const [courseCategory, setCourseCategory] = useState('');
  const [summary, setSummary] = useState('');
  const [courseVisible, setCourseVisible] = useState(true);
  const [isTemplate, setIsTemplate] = useState(false);
  const [startDate, setStartdate] = useState('');
  const [endDate, setEnddate] = useState('');
  // Outline.
  const [newSectionName, setNewSectionName] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sectionEdits, setSectionEdits] = useState<Record<string, { name: string; status: ItemStatusChoice; openAt: string }>>({});
  const [moduleEdits, setModuleEdits] = useState<Record<string, { name: string; status: ItemStatusChoice; openAt: string }>>({});
  const [moduleDrafts, setModuleDrafts] = useState<Record<string, { component: string; name: string }>>({});
  const [availabilityDrafts, setAvailabilityDrafts] = useState<Record<string, unknown>>({});
  const [dragSectionId, setDragSectionId] = useState<string | null>(null);
  const [dragModule, setDragModule] = useState<{ sectionId: string; moduleId: string } | null>(null);
  // Dùng lại từ khoá khác.
  const [otherCourses, setOtherCourses] = useState<Course[]>([]);
  const [importSourceId, setImportSourceId] = useState('');
  const [importContent, setImportContent] = useState<CourseContent | null>(null);
  const [importSections, setImportSections] = useState<string[]>([]);
  const [importModules, setImportModules] = useState<string[]>([]);
  // Tiêu chí hoàn thành.
  const [criteriaMethod, setCriteriaMethod] = useState(1);
  const [criteriaDraft, setCriteriaDraft] = useState<{ criteriaType: string; moduleInstance: string; date: string }[]>([]);

  const reload = useCallback(async () => {
    const [courseRes, contentRes, itemsRes, criteriaRes, groupsRes, groupingsRes] = await Promise.all([
      apiJson<Course>(`/api/v1/courses/${courseId}`).catch(() => null),
      apiJson<CourseContent>(`/api/v1/courses/${courseId}/content`).catch(() => null),
      apiJson<GradeItem[]>(`/api/v1/courses/${courseId}/grades/items`).catch(() => []),
      apiJson<{
        method: number;
        criteria: { id: string; criteriaType: string; moduleInstance: string | null; date: string | null }[];
      }>(`/api/v1/courses/${courseId}/completion/criteria`).catch(() => null),
      apiJson<CourseGroup[]>(`/api/v1/courses/${courseId}/groups`).catch(() => []),
      apiJson<CourseGrouping[]>(`/api/v1/courses/${courseId}/groupings`).catch(() => []),
    ]);
    setGradeItems(itemsRes);
    setGroups(groupsRes);
    setGroupings(groupingsRes);
    if (criteriaRes) {
      setCriteriaMethod(criteriaRes.method);
      setCriteriaDraft(
        criteriaRes.criteria.map((criterion) => ({
          criteriaType: criterion.criteriaType,
          moduleInstance: criterion.moduleInstance ?? '',
          date: criterion.date ? String(criterion.date).slice(0, 10) : '',
        })),
      );
    }
    if (courseRes) {
      setCourse(courseRes);
      setFullname(courseRes.fullName);
      setShortname(courseRes.shortName);
      setCourseCategory(courseRes.category);
      setSummary(courseRes.summary);
      setCourseVisible(courseRes.visible);
      setIsTemplate(courseRes.isTemplate);
      setStartdate(courseRes.startDate ? courseRes.startDate.slice(0, 10) : '');
      setEnddate(courseRes.endDate ? courseRes.endDate.slice(0, 10) : '');
    }
    if (contentRes) {
      setContent(contentRes);
      setSectionEdits(
        Object.fromEntries(
          contentRes.sections.map((s) => [
            s.id,
            {
              name: s.name ?? '',
              status: statusChoiceOf(s.visible, s.openAt),
              openAt: s.openAt ? String(s.openAt).slice(0, 10) : '',
            },
          ]),
        ),
      );
      setModuleEdits(
        Object.fromEntries(
          contentRes.sections.flatMap((s) =>
            s.modules.map((m) => [
              m.id,
              {
                name: m.name,
                status: statusChoiceOf(m.visible, m.openAt),
                openAt: m.openAt ? String(m.openAt).slice(0, 10) : '',
              },
            ]),
          ),
        ),
      );
      setAvailabilityDrafts(
        Object.fromEntries([
          ...contentRes.sections.map((s) => [`section:${s.id}`, s.availability ?? null] as const),
          ...contentRes.sections.flatMap((s) => s.modules.map((m) => [`module:${m.id}`, m.availability ?? null] as const)),
        ]),
      );
    }
    if (!courseRes && !contentRes) setLoadError(t('builderLoadFailed'));
  }, [courseId, t]);

  useEffect(() => {
    if (canBuild) void reload();
  }, [canBuild, reload]);

  useEffect(() => {
    void apiJson<Course[]>('/api/v1/courses')
      .then((list) => setOtherCourses(list.filter((c) => c.id !== courseId)))
      .catch(() => setOtherCourses([]));
  }, [courseId]);

  useEffect(() => {
    setImportSections([]);
    setImportModules([]);
    if (!importSourceId) {
      setImportContent(null);
      return;
    }
    void apiJson<CourseContent>(`/api/v1/courses/${importSourceId}/content`)
      .then(setImportContent)
      .catch(() => setImportContent(null));
  }, [importSourceId]);

  async function saveCourse(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fullName,
          shortName,
          category: courseCategory,
          summary,
          visible: courseVisible,
          isTemplate,
          startDate: startDate ? startDate : null,
          endDate: endDate ? endDate : null,
        }),
      });
      setMessage(t('courseSaved'));
      await reload();
    } catch {
      setMessage(t('courseSaveFailed'));
    }
  }

  async function createSection(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/sections`, {
        method: 'POST',
        body: JSON.stringify(newSectionName.trim() ? { name: newSectionName.trim() } : {}),
      });
      setNewSectionName('');
      setMessage(t('sectionCreated'));
      await reload();
    } catch {
      setMessage(t('sectionCreateFailed'));
    }
  }

  /** Lưu tên + trạng thái mở của section: Nháp = ẩn; Đã mở = hiện, không lịch; Mở theo lịch = hiện + openAt. */
  async function saveSection(sectionId: string) {
    const edit = sectionEdits[sectionId];
    if (!edit) return;
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: edit.name,
          visible: edit.status !== 'draft',
          openAt: edit.status === 'scheduled' && edit.openAt ? new Date(`${edit.openAt}T00:00:00`).toISOString() : null,
        }),
      });
      setMessage(t('sectionSaved'));
      await reload();
    } catch {
      setMessage(t('sectionSaveFailed'));
    }
  }

  async function deleteSection(sectionId: string, sectionName: string) {
    if (!window.confirm(t('confirmDeleteSection', { name: sectionName }))) return;
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}`, { method: 'DELETE' });
      setMessage(t('sectionDeleted'));
      await reload();
    } catch {
      setMessage(t('sectionDeleteFailed'));
    }
  }

  async function duplicateSection(sectionId: string) {
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
      setMessage(t('builderDuplicated'));
      await reload();
    } catch {
      setMessage(t('builderDuplicateFailed'));
    }
  }

  /** Đổi thứ tự section: gửi toàn bộ danh sách id theo thứ tự mới (API đòi đủ mọi section). */
  async function reorderSections(orderedIds: string[]) {
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/reorder-sections`, {
        method: 'POST',
        body: JSON.stringify({ sectionIds: orderedIds }),
      });
      await reload();
    } catch {
      setMessage(t('builderReorderFailed'));
      await reload();
    }
  }

  async function reorderModules(sectionId: string, orderedIds: string[]) {
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}/reorder-modules`, {
        method: 'POST',
        body: JSON.stringify({ moduleIds: orderedIds }),
      });
      await reload();
    } catch {
      setMessage(t('builderReorderFailed'));
      await reload();
    }
  }

  /**
   * Thêm nội dung bằng menu chọn loại: `mod_quiz` đi qua endpoint quiz
   * (tự tạo module + grade item rồi mở trang soạn đề); các loại khác
   * qua POST /courses/:id/modules — không còn ô gõ chuỗi component.
   */
  async function createModule(event: FormEvent, sectionId: string) {
    event.preventDefault();
    const draft = moduleDrafts[sectionId] ?? { component: 'mod_page', name: '' };
    setMessage(null);
    try {
      if (draft.component === 'mod_quiz') {
        if (!draft.name.trim()) return;
        const created = await apiJson<{ id: string }>(`/api/v1/courses/${courseId}/quizzes`, {
          method: 'POST',
          body: JSON.stringify({ sectionId, name: draft.name.trim() }),
        });
        await navigate(`/courses/${courseId}/quizzes/${created.id}`);
        return;
      }
      await apiJson(`/api/v1/courses/${courseId}/modules`, {
        method: 'POST',
        body: JSON.stringify({
          sectionId,
          component: draft.component,
          ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
        }),
      });
      setModuleDrafts((prev) => ({ ...prev, [sectionId]: { component: 'mod_page', name: '' } }));
      setMessage(t('moduleCreated'));
      await reload();
    } catch {
      setMessage(t('moduleCreateFailed'));
    }
  }

  async function saveModule(cmId: string) {
    const edit = moduleEdits[cmId];
    if (!edit) return;
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/modules/${cmId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: edit.name,
          visible: edit.status !== 'draft',
          openAt: edit.status === 'scheduled' && edit.openAt ? new Date(`${edit.openAt}T00:00:00`).toISOString() : null,
        }),
      });
      setMessage(t('moduleSaved'));
      await reload();
    } catch {
      setMessage(t('moduleSaveFailed'));
    }
  }

  async function deleteModule(cmId: string, moduleName: string) {
    if (!window.confirm(t('confirmDeleteModule', { name: moduleName }))) return;
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/modules/${cmId}`, { method: 'DELETE' });
      setMessage(t('moduleDeleted'));
      await reload();
    } catch {
      setMessage(t('moduleDeleteFailed'));
    }
  }

  async function duplicateModule(cmId: string) {
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/modules/${cmId}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
      setMessage(t('builderDuplicated'));
      await reload();
    } catch {
      setMessage(t('builderDuplicateFailed'));
    }
  }

  async function saveSectionAvailability(sectionId: string) {
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ availability: availabilityDrafts[`section:${sectionId}`] ?? null }),
      });
      setMessage(t('availabilitySaved'));
      await reload();
    } catch {
      setMessage(t('availabilitySaveFailed'));
    }
  }

  async function saveModuleAvailability(cmId: string) {
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/modules/${cmId}`, {
        method: 'PATCH',
        body: JSON.stringify({ availability: availabilityDrafts[`module:${cmId}`] ?? null }),
      });
      setMessage(t('availabilitySaved'));
      await reload();
    } catch {
      setMessage(t('availabilitySaveFailed'));
    }
  }

  /** "Dùng lại từ khoá khác": POST import-content với các section/module đã tích chọn ở khoá nguồn. */
  async function submitImport(event: FormEvent) {
    event.preventDefault();
    if (!importSourceId || (importSections.length === 0 && importModules.length === 0)) return;
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/import-content`, {
        method: 'POST',
        body: JSON.stringify({
          sourceCourseId: importSourceId,
          ...(importSections.length ? { sectionIds: importSections } : {}),
          ...(importModules.length ? { moduleIds: importModules } : {}),
        }),
      });
      setMessage(t('builderImported'));
      setImportSections([]);
      setImportModules([]);
      await reload();
    } catch {
      setMessage(t('builderImportFailed'));
    }
  }

  async function saveCriteria(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/completion/criteria`, {
        method: 'PUT',
        body: JSON.stringify({
          method: criteriaMethod,
          criteria: criteriaDraft.map((criterion) => ({
            criteriaType: criterion.criteriaType,
            ...(criterion.criteriaType === 'module' ? { moduleInstance: criterion.moduleInstance } : {}),
            ...(criterion.criteriaType === 'date' ? { date: criterion.date } : {}),
          })),
        }),
      });
      setMessage(t('completionCriteriaSaved'));
      await reload();
    } catch {
      setMessage(t('completionCriteriaSaveFailed'));
    }
  }

  async function recalculateCompletion() {
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/completion/recalculate`, { method: 'POST' });
      setMessage(t('recalculatedCompletion'));
      await reload();
    } catch {
      setMessage(t('recalculateFailed'));
    }
  }

  if (!canBuild) {
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('courseBuilder')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{t('builderNoAccess')}</p>
            <p className="pt-2 text-sm">
              <Link to={`/courses/${courseId}`}>{t('wizardBackToCourses')}</Link>
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  const sections = content?.sections ?? [];
  const selectClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';
  const statusBadge = (status: string | undefined) =>
    status === 'scheduled' ? t('builderStatusScheduled') : status === 'draft' ? t('builderStatusDraft') : t('builderStatusOpen');

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('courseBuilder')}</CardTitle>
          <CardDescription>{t('courseBuilderDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? <p role="alert">{loadError}</p> : null}
          {course ? (
            <form onSubmit={(e) => void saveCourse(e)} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="builder-fullname">{t('courseFullName')}</Label>
                <Input id="builder-fullname" value={fullName} onChange={(e) => setFullname(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="builder-shortname">{t('courseShortName')}</Label>
                <Input id="builder-shortname" value={shortName} onChange={(e) => setShortname(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="builder-category">{t('courseCategory')}</Label>
                <Input id="builder-category" value={courseCategory} onChange={(e) => setCourseCategory(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="builder-summary">{t('courseSummary')}</Label>
                <Input id="builder-summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="builder-startdate">{t('courseStartDate')}</Label>
                <Input id="builder-startdate" type="date" value={startDate} onChange={(e) => setStartdate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="builder-enddate">{t('courseEndDate')}</Label>
                <Input id="builder-enddate" type="date" value={endDate} onChange={(e) => setEnddate(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={courseVisible} onChange={(e) => setCourseVisible(e.target.checked)} />
                {t('courseVisible')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isTemplate} onChange={(e) => setIsTemplate(e.target.checked)} />
                {t('builderIsTemplate')}
              </label>
              <div className="flex gap-2">
                <Button type="submit">{t('saveCourse')}</Button>
                <Link className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 text-sm font-medium" to={`/courses/${courseId}/admin`}>{t('builderToAdmin')}</Link>
              </div>
            </form>
          ) : null}
          {message ? (
            <p role="status" className="pt-2 text-sm">
              {message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <CurriculumFramePanel
        courseId={courseId}
        course={course}
        sections={sections.map((s) => ({ section: s.section, name: s.name }))}
        onApplied={() => void reload()}
      />

      <BookFramePanel
        courseId={courseId}
        course={course}
        sections={sections.map((s) => ({ section: s.section, name: s.name }))}
        onApplied={() => void reload()}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('builderOutlineTitle')}</CardTitle>
          <CardDescription>{t('builderOutlineDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form onSubmit={(e) => void createSection(e)} className="space-y-2">
            <Label htmlFor="new-section-name">{t('newSectionName')}</Label>
            <Input id="new-section-name" value={newSectionName} onChange={(e) => setNewSectionName(e.target.value)} />
            <Button type="submit">{t('createSection')}</Button>
          </form>
          {content && sections.length === 0 ? <p>{t('noSections')}</p> : null}
          {sections.map((section, sectionIndex) => {
            const edit = sectionEdits[section.id] ?? {
              name: section.name ?? '',
              status: statusChoiceOf(section.visible, section.openAt),
              openAt: section.openAt ? String(section.openAt).slice(0, 10) : '',
            };
            const draft = moduleDrafts[section.id] ?? { component: 'mod_page', name: '' };
            const displayName = section.name ?? t('sectionDefaultName', { number: section.section });
            const isCollapsed = collapsed[section.id] ?? false;
            return (
              <div
                key={section.id}
                data-testid={`section-builder-${section.id}`}
                className="space-y-3 rounded border p-3"
                draggable
                onDragStart={() => setDragSectionId(section.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (!dragSectionId || dragSectionId === section.id) return;
                  const from = sections.findIndex((s) => s.id === dragSectionId);
                  if (from < 0) return;
                  void reorderSections(moveItem(sections, from, sectionIndex).map((s) => s.id));
                  setDragSectionId(null);
                }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('builderToggleSection')}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [section.id]: !isCollapsed }))}
                  >
                    {isCollapsed ? '▸' : '▾'}
                  </Button>
                  <span className="font-medium">{displayName}</span>
                  <span className="rounded bg-accent px-2 py-0.5 text-xs">{statusBadge(section.status)}</span>
                  {section.openAt ? (
                    <span className="text-xs text-muted-foreground">
                      {t('builderOpenAtLabel', { date: String(section.openAt).slice(0, 10) })}
                    </span>
                  ) : null}
                  <span className="ml-auto flex gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t('builderMoveUp')}
                      disabled={sectionIndex === 0}
                      onClick={() => void reorderSections(moveItem(sections, sectionIndex, sectionIndex - 1).map((s) => s.id))}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t('builderMoveDown')}
                      disabled={sectionIndex === sections.length - 1}
                      onClick={() => void reorderSections(moveItem(sections, sectionIndex, sectionIndex + 1).map((s) => s.id))}
                    >
                      ↓
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => void duplicateSection(section.id)}>
                      {t('builderDuplicate')}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => void deleteSection(section.id, displayName)}
                    >
                      {t('deleteSection')}
                    </Button>
                  </span>
                </div>
                {!isCollapsed ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor={`section-name-${section.id}`}>{t('sectionName')}</Label>
                      <Input
                        id={`section-name-${section.id}`}
                        value={edit.name}
                        onChange={(e) => setSectionEdits((prev) => ({ ...prev, [section.id]: { ...edit, name: e.target.value } }))}
                      />
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="space-y-1">
                          <Label htmlFor={`section-status-${section.id}`}>{t('builderStatusLabel')}</Label>
                          <select
                            id={`section-status-${section.id}`}
                            className={selectClass}
                            value={edit.status}
                            onChange={(e) =>
                              setSectionEdits((prev) => ({
                                ...prev,
                                [section.id]: { ...edit, status: e.target.value as ItemStatusChoice },
                              }))
                            }
                          >
                            <option value="draft">{t('builderStatusDraft')}</option>
                            <option value="open">{t('builderStatusOpen')}</option>
                            <option value="scheduled">{t('builderStatusScheduled')}</option>
                          </select>
                        </div>
                        {edit.status === 'scheduled' ? (
                          <div className="space-y-1">
                            <Label htmlFor={`section-openat-${section.id}`}>{t('builderOpenAtField')}</Label>
                            <Input
                              id={`section-openat-${section.id}`}
                              type="date"
                              value={edit.openAt}
                              onChange={(e) =>
                                setSectionEdits((prev) => ({ ...prev, [section.id]: { ...edit, openAt: e.target.value } }))
                              }
                            />
                          </div>
                        ) : null}
                        <Button type="button" variant="outline" size="sm" onClick={() => void saveSection(section.id)}>
                          {t('saveSection')}
                        </Button>
                      </div>
                    </div>
                    <ul className="space-y-3">
                      {section.modules.map((cm, moduleIndex) => {
                        const mEdit = moduleEdits[cm.id] ?? {
                          name: cm.name,
                          status: statusChoiceOf(cm.visible, cm.openAt),
                          openAt: cm.openAt ? String(cm.openAt).slice(0, 10) : '',
                        };
                        return (
                          <li
                            key={cm.id}
                            data-testid={`module-builder-${cm.id}`}
                            className="space-y-2 rounded border p-2"
                            draggable
                            onDragStart={() => setDragModule({ sectionId: section.id, moduleId: cm.id })}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => {
                              if (!dragModule || dragModule.sectionId !== section.id || dragModule.moduleId === cm.id) return;
                              const from = section.modules.findIndex((m) => m.id === dragModule.moduleId);
                              if (from < 0) return;
                              void reorderModules(section.id, moveItem(section.modules, from, moduleIndex).map((m) => m.id));
                              setDragModule(null);
                            }}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium">
                                {cm.name || cm.component}{' '}
                                <span className="text-muted-foreground">({t(`contentType_${cm.component}`, { defaultValue: cm.component })})</span>
                              </p>
                              <span className="rounded bg-accent px-2 py-0.5 text-xs">{statusBadge(cm.status)}</span>
                              <span className="ml-auto flex gap-1">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  aria-label={t('builderMoveUp')}
                                  disabled={moduleIndex === 0}
                                  onClick={() =>
                                    void reorderModules(section.id, moveItem(section.modules, moduleIndex, moduleIndex - 1).map((m) => m.id))
                                  }
                                >
                                  ↑
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  aria-label={t('builderMoveDown')}
                                  disabled={moduleIndex === section.modules.length - 1}
                                  onClick={() =>
                                    void reorderModules(section.id, moveItem(section.modules, moduleIndex, moduleIndex + 1).map((m) => m.id))
                                  }
                                >
                                  ↓
                                </Button>
                                <Button type="button" variant="outline" size="sm" onClick={() => void duplicateModule(cm.id)}>
                                  {t('builderDuplicate')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => void deleteModule(cm.id, cm.name || cm.component)}
                                >
                                  {t('deleteModule')}
                                </Button>
                              </span>
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor={`module-name-${cm.id}`}>{t('moduleName')}</Label>
                              <Input
                                id={`module-name-${cm.id}`}
                                value={mEdit.name}
                                onChange={(e) => setModuleEdits((prev) => ({ ...prev, [cm.id]: { ...mEdit, name: e.target.value } }))}
                              />
                              <div className="flex flex-wrap items-end gap-2">
                                <div className="space-y-1">
                                  <Label htmlFor={`module-status-${cm.id}`}>{t('builderStatusLabel')}</Label>
                                  <select
                                    id={`module-status-${cm.id}`}
                                    className={selectClass}
                                    value={mEdit.status}
                                    onChange={(e) =>
                                      setModuleEdits((prev) => ({
                                        ...prev,
                                        [cm.id]: { ...mEdit, status: e.target.value as ItemStatusChoice },
                                      }))
                                    }
                                  >
                                    <option value="draft">{t('builderStatusDraft')}</option>
                                    <option value="open">{t('builderStatusOpen')}</option>
                                    <option value="scheduled">{t('builderStatusScheduled')}</option>
                                  </select>
                                </div>
                                {mEdit.status === 'scheduled' ? (
                                  <div className="space-y-1">
                                    <Label htmlFor={`module-openat-${cm.id}`}>{t('builderOpenAtField')}</Label>
                                    <Input
                                      id={`module-openat-${cm.id}`}
                                      type="date"
                                      value={mEdit.openAt}
                                      onChange={(e) =>
                                        setModuleEdits((prev) => ({ ...prev, [cm.id]: { ...mEdit, openAt: e.target.value } }))
                                      }
                                    />
                                  </div>
                                ) : null}
                                <Button type="button" variant="outline" size="sm" onClick={() => void saveModule(cm.id)}>
                                  {t('saveModule')}
                                </Button>
                              </div>
                              <div className="space-y-2" data-testid={`module-availability-${cm.id}`}>
                                <h5 className="text-sm font-medium">{t('availabilityTitle')}</h5>
                                <AvailabilityEditor
                                  key={`module-availability-editor-${cm.id}`}
                                  value={cm.availability}
                                  onChange={(next) => setAvailabilityDrafts((prev) => ({ ...prev, [`module:${cm.id}`]: next }))}
                                  groups={groups.map((g) => ({ id: g.id, name: g.name }))}
                                  groupings={groupings.map((g) => ({ id: g.id, name: g.name }))}
                                  modules={sections.flatMap((s) => s.modules.map((m) => ({ id: m.id, name: m.name || m.component })))}
                                  gradeItems={gradeItems.map((item) => ({ id: item.id, name: item.itemName }))}
                                />
                                <Button type="button" variant="outline" size="sm" onClick={() => void saveModuleAvailability(cm.id)}>
                                  {t('availabilitySave')}
                                </Button>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                      {section.modules.length === 0 ? <li className="text-sm text-muted-foreground">{t('noModulesInSection')}</li> : null}
                    </ul>
                    <form onSubmit={(e) => void createModule(e, section.id)} className="space-y-2">
                      <div className="space-y-2">
                        <Label htmlFor={`module-type-${section.id}`}>{t('builderContentType')}</Label>
                        <select
                          id={`module-type-${section.id}`}
                          className={selectClass}
                          value={draft.component}
                          onChange={(e) =>
                            setModuleDrafts((prev) => ({ ...prev, [section.id]: { ...draft, component: e.target.value } }))
                          }
                        >
                          {COURSE_CONTENT_TYPES.map((type) => (
                            <option key={type.component} value={type.component}>
                              {t(`contentType_${type.component}`, { defaultValue: type.component })}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`module-new-name-${section.id}`}>{t('moduleName')}</Label>
                        <Input
                          id={`module-new-name-${section.id}`}
                          value={draft.name}
                          onChange={(e) => setModuleDrafts((prev) => ({ ...prev, [section.id]: { ...draft, name: e.target.value } }))}
                        />
                      </div>
                      <Button type="submit" variant="outline">
                        {t('addModule')}
                      </Button>
                    </form>
                    <div className="space-y-2" data-testid={`section-availability-${section.id}`}>
                      <h4 className="text-sm font-medium">{t('availabilityTitle')}</h4>
                      <p className="text-sm text-muted-foreground">{t('availabilityDescription')}</p>
                      <AvailabilityEditor
                        key={`section-availability-editor-${section.id}`}
                        value={section.availability}
                        onChange={(next) => setAvailabilityDrafts((prev) => ({ ...prev, [`section:${section.id}`]: next }))}
                        groups={groups.map((g) => ({ id: g.id, name: g.name }))}
                        groupings={groupings.map((g) => ({ id: g.id, name: g.name }))}
                        modules={sections.flatMap((s) => s.modules.map((m) => ({ id: m.id, name: m.name || m.component })))}
                        gradeItems={gradeItems.map((item) => ({ id: item.id, name: item.itemName }))}
                      />
                      <Button type="button" variant="outline" size="sm" onClick={() => void saveSectionAvailability(section.id)}>
                        {t('availabilitySave')}
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('builderImportTitle')}</CardTitle>
          <CardDescription>{t('builderImportDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void submitImport(e)} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="import-source">{t('builderImportSource')}</Label>
              <select id="import-source" className={selectClass} value={importSourceId} onChange={(e) => setImportSourceId(e.target.value)}>
                <option value="">{t('wizardPickSource')}</option>
                {otherCourses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName} ({c.shortName})
                  </option>
                ))}
              </select>
            </div>
            {importContent ? (
              <div className="space-y-3">
                {importContent.sections.map((s) => (
                  <div key={s.id} className="space-y-1 rounded border p-2">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input
                        type="checkbox"
                        checked={importSections.includes(s.id)}
                        onChange={(e) =>
                          setImportSections((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))
                        }
                      />
                      {s.name ?? t('sectionDefaultName', { number: s.section })} {t('builderImportWholeSection')}
                    </label>
                    {s.modules.map((m) => (
                      <label key={m.id} className="ml-6 flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={importModules.includes(m.id)}
                          onChange={(e) =>
                            setImportModules((prev) => (e.target.checked ? [...prev, m.id] : prev.filter((x) => x !== m.id)))
                          }
                        />
                        {m.name || m.component}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            <Button type="submit" disabled={!importSourceId || (importSections.length === 0 && importModules.length === 0)}>
              {t('builderImportSubmit')}
            </Button>
          </form>
        </CardContent>
      </Card>

      {canManageCompletion ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('completionCriteriaTitle')}</CardTitle>
            <CardDescription>{t('completionCriteriaDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void saveCriteria(e)} className="space-y-3" data-testid="completion-criteria">
              <div className="space-y-2">
                <Label htmlFor="criteria-method">{t('completionMethod')}</Label>
                <select
                  id="criteria-method"
                  aria-label={t('completionMethod')}
                  className={selectClass}
                  value={criteriaMethod}
                  onChange={(e) => setCriteriaMethod(Number(e.target.value))}
                >
                  <option value={1}>{t('completionMethodAll')}</option>
                  <option value={2}>{t('completionMethodAny')}</option>
                </select>
              </div>
              {criteriaDraft.length === 0 ? <p className="text-sm text-muted-foreground">{t('noCriteria')}</p> : null}
              {criteriaDraft.map((criterion, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={`criterion-type-${index}`}>{t('criterionType')}</Label>
                    <select
                      id={`criterion-type-${index}`}
                      className={selectClass}
                      value={criterion.criteriaType}
                      onChange={(e) =>
                        setCriteriaDraft((prev) =>
                          prev.map((c, i) =>
                            i === index
                              ? {
                                  ...c,
                                  criteriaType: e.target.value,
                                  moduleInstance:
                                    e.target.value === 'module' && !c.moduleInstance
                                      ? (sections.flatMap((s) => s.modules)[0]?.id ?? '')
                                      : c.moduleInstance,
                                }
                              : c,
                          ),
                        )
                      }
                    >
                      <option value="module">{t('criterionTypeModule')}</option>
                      <option value="date">{t('criterionTypeDate')}</option>
                      <option value="grade">{t('criterionTypeGrade')}</option>
                    </select>
                  </div>
                  {criterion.criteriaType === 'module' ? (
                    <div className="space-y-1">
                      <Label htmlFor={`criterion-module-${index}`}>{t('criterionModule')}</Label>
                      <select
                        id={`criterion-module-${index}`}
                        className={selectClass}
                        value={criterion.moduleInstance}
                        onChange={(e) =>
                          setCriteriaDraft((prev) => prev.map((c, i) => (i === index ? { ...c, moduleInstance: e.target.value } : c)))
                        }
                      >
                        {sections
                          .flatMap((s) => s.modules)
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name || m.component}
                            </option>
                          ))}
                      </select>
                    </div>
                  ) : null}
                  {criterion.criteriaType === 'date' ? (
                    <div className="space-y-1">
                      <Label htmlFor={`criterion-date-${index}`}>{t('criterionDate')}</Label>
                      <Input
                        id={`criterion-date-${index}`}
                        type="date"
                        value={criterion.date}
                        onChange={(e) =>
                          setCriteriaDraft((prev) => prev.map((c, i) => (i === index ? { ...c, date: e.target.value } : c)))
                        }
                      />
                    </div>
                  ) : null}
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => setCriteriaDraft((prev) => prev.filter((_, i) => i !== index))}
                  >
                    {t('removeCriterion')}
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCriteriaDraft((prev) => [...prev, { criteriaType: 'grade', moduleInstance: '', date: '' }])}
                >
                  {t('addCriterion')}
                </Button>
                <Button type="submit">{t('saveCriteria')}</Button>
                <Button type="button" variant="outline" onClick={() => void recalculateCompletion()}>
                  {t('recalculateCompletion')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default CourseBuilderPage;
