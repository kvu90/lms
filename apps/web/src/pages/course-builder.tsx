import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type {
  Course, CourseContent, CourseGroup, CourseGrouping, GradeItem,
} from '@lms/contracts';
import { CurriculumFramePanel, BookFramePanel } from '#components/curriculum-frame-panel';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';
import { fetchItems, insertItem, type LibraryItem } from '#lib/content-bank';
import { usePermissions } from '#lib/permissions';
import { CompletionCard } from '../components/course-builder/completion-card';
import { CourseInfoCard } from '../components/course-builder/course-info-card';
import { ImportCard } from '../components/course-builder/import-card';
import { OutlineCard } from '../components/course-builder/outline-card';
import { statusChoiceOf, type ItemStatusChoice } from '../components/course-builder/utils';

/**
 * Builder Outline (K1 — issue #68): trang xây dựng khoá học RIÊNG,
 * tách khỏi trang quản trị khoá gộp theo chuẩn §9. Gồm: thông tin khoá
 * (+ cờ khoá mẫu tổ/trường), panel "Thêm từ khung" (K0a), outline
 * section/module với kéo–thả đổi thứ tự (kèm nút lên/xuống), nhân
 * bản/xoá ngay tại dòng, thêm nội dung bằng MENU chọn loại (không gõ
 * chuỗi component), khối "Thêm từ kho" trong từng section (CB-1 —
 * issue #107: cắm học liệu của Kho học liệu vào section qua endpoint
 * insert sẵn có của CB-1), trạng thái Nháp/Đã mở/Mở theo lịch qua
 * trường ngày mở `openAt` riêng, điều kiện truy cập nâng cao
 * (availability) giữ nguyên từ bản cũ, panel "Dùng lại từ khoá khác"
 * và tiêu chí hoàn thành khoá. Quyền: teaching của khoá hoặc quản trị
 * hệ thống — API vẫn thực thi capability thật cho từng thao tác ghi.
 */
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
  // Thêm từ kho học liệu (CB-1, issue #107).
  const [bankOpenSectionId, setBankOpenSectionId] = useState<string | null>(null);
  const [bankItems, setBankItems] = useState<LibraryItem[] | null>(null);
  const [bankQuery, setBankQuery] = useState('');
  const [bankLoadError, setBankLoadError] = useState<string | null>(null);
  const [bankBusyId, setBankBusyId] = useState<string | null>(null);
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
   * Thêm nội dung bằng menu chọn loại: `mod_quiz` đi qua endpoint
   * exam-pins dạng newExam (tạo đề + ghim, tự tạo module + grade item
   * rồi mở trang lần ghim); các loại khác qua POST
   * /courses/:id/modules — không còn ô gõ chuỗi component.
   */
  async function createModule(event: FormEvent, sectionId: string) {
    event.preventDefault();
    const draft = moduleDrafts[sectionId] ?? { component: 'mod_page', name: '' };
    setMessage(null);
    try {
      if (draft.component === 'mod_quiz') {
        if (!draft.name.trim()) return;
        // Sau gộp Đề (#226): "thêm bài kiểm tra" = tạo ĐỀ mới trong
        // bank cá nhân của GV + GHIM vào khoá trong một thao tác
        // (newExam); GV soạn câu hỏi tiếp ở trình soạn đề của pin.
        const created = await apiJson<{ id: string }>(`/api/v1/courses/${courseId}/exam-pins`, {
          method: 'POST',
          body: JSON.stringify({ sectionId, newExam: { name: draft.name.trim() } }),
        });
        await navigate(`/courses/${courseId}/exams/${created.id}`);
        return;
      }
      if (draft.component === 'mod_assign') {
        if (!draft.name.trim()) return;
        const created = await apiJson<{ id: string }>(`/api/v1/courses/${courseId}/assignments`, {
          method: 'POST',
          body: JSON.stringify({ sectionId, name: draft.name.trim() }),
        });
        await navigate(`/courses/${courseId}/assignments/${created.id}`);
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

  /**
   * Mở/đóng panel "Thêm từ kho" của một section. Danh sách học liệu
   * tải lười biếng một lần cho cả trang (API list của CB-1 đã lọc
   * theo quyền xem: học liệu của mình + đã duyệt của đồng nghiệp).
   */
  async function toggleBankPanel(sectionId: string) {
    if (bankOpenSectionId === sectionId) {
      setBankOpenSectionId(null);
      return;
    }
    setBankOpenSectionId(sectionId);
    setBankQuery('');
    if (bankItems === null) {
      setBankLoadError(null);
      try {
        setBankItems(await fetchItems());
      } catch {
        setBankItems([]);
        setBankLoadError(t('builderBankLoadFailed'));
      }
    }
  }

  /**
   * Cắm một học liệu từ kho vào section: API insert của CB-1 tạo
   * module `mod_resource` bằng bản sao file trong context của module
   * mới (sửa ở kho không đổi bản đã cắm); reload để module hiện ngay
   * trong outline.
   */
  async function insertFromBank(item: LibraryItem, sectionId: string) {
    setMessage(null);
    setBankBusyId(item.id);
    try {
      await insertItem(item.id, courseId, sectionId);
      setMessage(t('builderBankInserted', { name: item.name }));
      await reload();
    } catch {
      setMessage(t('builderBankInsertFailed'));
    } finally {
      setBankBusyId(null);
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
  const bankQueryNormalized = bankQuery.trim().toLowerCase();
  const bankFiltered = (bankItems ?? []).filter((item) => {
    if (!bankQueryNormalized) return true;
    const haystack = [item.name, item.description ?? '', ...(item.keywords ?? [])].join(' ').toLowerCase();
    return haystack.includes(bankQueryNormalized);
  });
  const selectClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';
  const statusBadge = (status: string | undefined) =>
    status === 'scheduled' ? t('builderStatusScheduled') : status === 'draft' ? t('builderStatusDraft') : t('builderStatusOpen');

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <CourseInfoCard
        course={course}
        loadError={loadError}
        courseId={courseId}
        fullName={fullName}
        setFullname={setFullname}
        shortName={shortName}
        setShortname={setShortname}
        courseCategory={courseCategory}
        setCourseCategory={setCourseCategory}
        summary={summary}
        setSummary={setSummary}
        startDate={startDate}
        setStartdate={setStartdate}
        endDate={endDate}
        setEnddate={setEnddate}
        courseVisible={courseVisible}
        setCourseVisible={setCourseVisible}
        isTemplate={isTemplate}
        setIsTemplate={setIsTemplate}
        onSaveCourse={saveCourse}
        message={message}
      />

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

      <OutlineCard
        content={content}
        sections={sections}
        newSectionName={newSectionName}
        setNewSectionName={setNewSectionName}
        onCreateSection={createSection}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        dragSectionId={dragSectionId}
        setDragSectionId={setDragSectionId}
        dragModule={dragModule}
        setDragModule={setDragModule}
        sectionEdits={sectionEdits}
        setSectionEdits={setSectionEdits}
        moduleEdits={moduleEdits}
        setModuleEdits={setModuleEdits}
        moduleDrafts={moduleDrafts}
        setModuleDrafts={setModuleDrafts}
        onSaveSection={saveSection}
        onDeleteSection={deleteSection}
        onDuplicateSection={duplicateSection}
        onReorderSections={reorderSections}
        onReorderModules={reorderModules}
        onSaveModule={saveModule}
        onDeleteModule={deleteModule}
        onDuplicateModule={duplicateModule}
        onCreateModule={createModule}
        groups={groups}
        groupings={groupings}
        gradeItems={gradeItems}
        setAvailabilityDrafts={setAvailabilityDrafts}
        onSaveSectionAvailability={saveSectionAvailability}
        onSaveModuleAvailability={saveModuleAvailability}
        bankOpenSectionId={bankOpenSectionId}
        onToggleBankPanel={toggleBankPanel}
        bankQuery={bankQuery}
        setBankQuery={setBankQuery}
        bankLoadError={bankLoadError}
        bankItems={bankItems}
        bankFiltered={bankFiltered}
        bankBusyId={bankBusyId}
        onInsertFromBank={insertFromBank}
        selectClass={selectClass}
        statusBadge={statusBadge}
      />

      <ImportCard
        otherCourses={otherCourses}
        importSourceId={importSourceId}
        setImportSourceId={setImportSourceId}
        importContent={importContent}
        importSections={importSections}
        setImportSections={setImportSections}
        importModules={importModules}
        setImportModules={setImportModules}
        onSubmitImport={submitImport}
        selectClass={selectClass}
      />

      <CompletionCard
        canManageCompletion={canManageCompletion}
        criteriaMethod={criteriaMethod}
        setCriteriaMethod={setCriteriaMethod}
        criteriaDraft={criteriaDraft}
        setCriteriaDraft={setCriteriaDraft}
        sections={sections}
        onSaveCriteria={saveCriteria}
        onRecalculate={recalculateCompletion}
        selectClass={selectClass}
      />
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default CourseBuilderPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Xây dựng khoá học');
}
