import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import type { Cohort, Course, CourseCompletion, CourseContent, CourseGroup, EnrolInstance, UserEnrolment } from '@lms/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

/**
 * Quản trị khoá học: nhóm, cohort, ghi danh thủ công kèm tạm khoá/kích hoạt
 * lại, tiến độ hoàn thành của học viên, và khu xây dựng khoá học (thông tin
 * khoá, section, module) chỉ dành cho đội giảng dạy của khoá hoặc quản trị
 * viên. Quyền xem khu xây dựng suy từ `usePermissions()`: người dùng thuộc
 * `teaching` của chính khoá này (có grade:viewall tại context khoá) hoặc có
 * quyền quản trị cấp hệ thống (`canAdminister`); API vẫn là nơi thực thi
 * quyền thật cho từng thao tác ghi.
 */
export function CourseAdminPage() {
  const { t } = useTranslation('app');
  const { id } = useParams();
  const courseId = id ?? '';
  const perms = usePermissions();
  const [groups, setGroups] = useState<CourseGroup[]>([]);
  const [groupName, setGroupName] = useState('');
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [instances, setInstances] = useState<EnrolInstance[]>([]);
  const [enrolments, setEnrolments] = useState<UserEnrolment[]>([]);
  const [completions, setCompletions] = useState<CourseCompletion[]>([]);
  const [enrolUserId, setEnrolUserId] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  /** Được xây dựng khoá này hay không: teaching của khoá hoặc quản trị hệ thống. */
  const courseAccess = perms.courses.find((c) => c.course.id === courseId);
  const canBuild = perms.canAdminister || perms.teaching.some((c) => c.course.id === courseId) || (courseAccess?.capabilities.includes('moodle/course:update') ?? false);

  const [course, setCourse] = useState<Course | null>(null);
  const [content, setContent] = useState<CourseContent | null>(null);
  const [builderMessage, setBuilderMessage] = useState<string | null>(null);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [fullname, setFullname] = useState('');
  const [shortname, setShortname] = useState('');
  const [courseCategory, setCourseCategory] = useState('');
  const [summary, setSummary] = useState('');
  const [courseVisible, setCourseVisible] = useState(true);
  const [startdate, setStartdate] = useState('');
  const [enddate, setEnddate] = useState('');
  const [newSectionName, setNewSectionName] = useState('');
  const [sectionEdits, setSectionEdits] = useState<Record<string, { name: string; visible: boolean }>>({});
  const [moduleDrafts, setModuleDrafts] = useState<Record<string, { component: string; name: string }>>({});
  const [moduleEdits, setModuleEdits] = useState<Record<string, { name: string; visible: boolean }>>({});

  const reload = useCallback(async () => {
    const [g, c, i, e, comp] = await Promise.all([
      apiJson<CourseGroup[]>(`/api/v1/courses/${courseId}/groups`).catch(() => []),
      apiJson<Cohort[]>('/api/v1/cohorts').catch(() => []),
      apiJson<EnrolInstance[]>(`/api/v1/courses/${courseId}/enrol/instances`).catch(() => []),
      apiJson<UserEnrolment[]>(`/api/v1/courses/${courseId}/enrolments`).catch(() => []),
      apiJson<CourseCompletion[]>(`/api/v1/courses/${courseId}/completion`).catch(() => []),
    ]);
    setGroups(g); setCohorts(c); setInstances(i); setEnrolments(e); setCompletions(comp);
  }, [courseId]);

  useEffect(() => { void reload(); }, [reload]);

  /**
   * Nạp dữ liệu cho khu xây dựng: thông tin khoá từ GET /courses/:id (kèm
   * các trường phụ phía server như contextId — trang chỉ đọc các trường
   * của `Course` trong contracts) và cấu trúc section/module từ
   * GET /courses/:id/content. Đồng thời khởi tạo lại các ô sửa từ dữ liệu
   * thật để form luôn phản ánh trạng thái server sau mỗi lần nạp lại.
   */
  const reloadBuilder = useCallback(async () => {
    const [courseRes, contentRes] = await Promise.all([
      apiJson<Course>(`/api/v1/courses/${courseId}`).catch(() => null),
      apiJson<CourseContent>(`/api/v1/courses/${courseId}/content`).catch(() => null),
    ]);
    if (courseRes) {
      setCourse(courseRes);
      setFullname(courseRes.fullname);
      setShortname(courseRes.shortname);
      setCourseCategory(courseRes.category);
      setSummary(courseRes.summary);
      setCourseVisible(courseRes.visible);
      setStartdate(courseRes.startdate ? courseRes.startdate.slice(0, 10) : '');
      setEnddate(courseRes.enddate ? courseRes.enddate.slice(0, 10) : '');
    }
    if (contentRes) {
      setContent(contentRes);
      setSectionEdits(Object.fromEntries(contentRes.sections.map((s) => [s.id, { name: s.name ?? '', visible: s.visible }])));
      setModuleEdits(Object.fromEntries(contentRes.sections.flatMap((s) => s.modules.map((m) => [m.id, { name: m.name, visible: m.visible }]))));
    }
    if (!courseRes && !contentRes) setBuilderError(t('builderLoadFailed'));
  }, [courseId, t]);

  useEffect(() => { if (canBuild) void reloadBuilder(); }, [canBuild, reloadBuilder]);

  const manualInstance = instances.find((i) => i.enrol === 'manual');

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson(`/api/v1/courses/${courseId}/groups`, { method: 'POST', body: JSON.stringify({ name: groupName }) });
      setGroupName('');
      await reload();
      setMessage(t('groupCreated'));
    } catch { setMessage(t('groupCreateFailed')); }
  }

  async function ensureManualAndEnrol(event: FormEvent) {
    event.preventDefault();
    try {
      let instance = manualInstance;
      if (!instance) {
        instance = await apiJson<EnrolInstance>(`/api/v1/courses/${courseId}/enrol/instances`, {
          method: 'POST', body: JSON.stringify({ method: 'manual' }),
        });
      }
      await apiJson(`/api/v1/courses/${courseId}/enrol/instances/${instance.id}/enrol`, {
        method: 'POST', body: JSON.stringify({ userid: enrolUserId }),
      });
      await reload();
      setMessage(t('userEnrolled'));
    } catch { setMessage(t('userEnrolFailed')); }
  }

  async function toggleSuspend(ue: UserEnrolment) {
    const action = ue.status === 1 ? 'reactivate' : 'suspend';
    try {
      await apiJson(`/api/v1/courses/${courseId}/enrol/instances/${ue.enrolid}/users/${ue.userid}/${action}`, { method: 'POST' });
      await reload();
    } catch { setMessage(t('enrolStatusChangeFailed')); }
  }

  /**
   * Lưu thông tin khoá qua PATCH /courses/:id với đúng các trường của
   * `updateCourseSchema` trong contracts; ngày trống gửi `null` để xoá mốc
   * thời gian (schema cho phép nullable ở hai trường này).
   */
  async function saveCourse(event: FormEvent) {
    event.preventDefault();
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fullname, shortname, category: courseCategory, summary,
          visible: courseVisible,
          startdate: startdate ? startdate : null,
          enddate: enddate ? enddate : null,
        }),
      });
      setBuilderMessage(t('courseSaved'));
      await reloadBuilder();
    } catch { setBuilderMessage(t('courseSaveFailed')); }
  }

  /** Tạo section mới qua POST /courses/:id/sections (`createCourseSectionSchema`: chỉ gửi `name` khi đã nhập). */
  async function createSection(event: FormEvent) {
    event.preventDefault();
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/sections`, {
        method: 'POST',
        body: JSON.stringify(newSectionName.trim() ? { name: newSectionName.trim() } : {}),
      });
      setNewSectionName('');
      setBuilderMessage(t('sectionCreated'));
      await reloadBuilder();
    } catch { setBuilderMessage(t('sectionCreateFailed')); }
  }

  /** Lưu tên/hiển thị của một section qua PATCH /courses/:id/sections/:sectionId (`updateCourseSectionSchema`). */
  async function saveSection(sectionId: string) {
    const edit = sectionEdits[sectionId];
    if (!edit) return;
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: edit.name, visible: edit.visible }),
      });
      setBuilderMessage(t('sectionSaved'));
      await reloadBuilder();
    } catch { setBuilderMessage(t('sectionSaveFailed')); }
  }

  /** Xoá một section qua DELETE — luôn hỏi xác nhận vì thao tác xoá cả module bên trong. */
  async function deleteSection(sectionId: string, sectionName: string) {
    if (!window.confirm(t('confirmDeleteSection', { name: sectionName }))) return;
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}`, { method: 'DELETE' });
      setBuilderMessage(t('sectionDeleted'));
      await reloadBuilder();
    } catch { setBuilderMessage(t('sectionDeleteFailed')); }
  }

  /**
   * Thêm module vào một section qua POST /courses/:id/modules với đúng
   * `createCourseModuleSchema` (`sectionId`, `component`, `name` tuỳ chọn).
   */
  async function createModule(event: FormEvent, sectionId: string) {
    event.preventDefault();
    const draft = moduleDrafts[sectionId] ?? { component: '', name: '' };
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/modules`, {
        method: 'POST',
        body: JSON.stringify({
          sectionId,
          component: draft.component,
          ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
        }),
      });
      setModuleDrafts((prev) => ({ ...prev, [sectionId]: { component: '', name: '' } }));
      setBuilderMessage(t('moduleCreated'));
      await reloadBuilder();
    } catch { setBuilderMessage(t('moduleCreateFailed')); }
  }

  /** Lưu tên/hiển thị của một module qua PATCH /courses/:id/modules/:cmId (`updateCourseModuleSchema`). */
  async function saveModule(cmId: string) {
    const edit = moduleEdits[cmId];
    if (!edit) return;
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/modules/${cmId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: edit.name, visible: edit.visible }),
      });
      setBuilderMessage(t('moduleSaved'));
      await reloadBuilder();
    } catch { setBuilderMessage(t('moduleSaveFailed')); }
  }

  /** Xoá một module qua DELETE — luôn hỏi xác nhận trước. */
  async function deleteModule(cmId: string, moduleName: string) {
    if (!window.confirm(t('confirmDeleteModule', { name: moduleName }))) return;
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/modules/${cmId}`, { method: 'DELETE' });
      setBuilderMessage(t('moduleDeleted'));
      await reloadBuilder();
    } catch { setBuilderMessage(t('moduleDeleteFailed')); }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      {canBuild && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('courseBuilder')}</CardTitle>
              <CardDescription>{t('courseBuilderDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              {builderError ? <p role="alert">{builderError}</p> : null}
              {course ? (
                <form onSubmit={(e) => void saveCourse(e)} className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="builder-fullname">{t('courseFullName')}</Label>
                    <Input id="builder-fullname" value={fullname} onChange={(e) => setFullname(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="builder-shortname">{t('courseShortName')}</Label>
                    <Input id="builder-shortname" value={shortname} onChange={(e) => setShortname(e.target.value)} />
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
                    <Input id="builder-startdate" type="date" value={startdate} onChange={(e) => setStartdate(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="builder-enddate">{t('courseEndDate')}</Label>
                    <Input id="builder-enddate" type="date" value={enddate} onChange={(e) => setEnddate(e.target.value)} />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={courseVisible} onChange={(e) => setCourseVisible(e.target.checked)} />
                    {t('courseVisible')}
                  </label>
                  <Button type="submit">{t('saveCourse')}</Button>
                </form>
              ) : null}
              {builderMessage ? <p role="status" className="pt-2 text-sm">{builderMessage}</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('sectionsBuilderTitle')}</CardTitle></CardHeader>
            <CardContent className="space-y-6">
              <form onSubmit={(e) => void createSection(e)} className="space-y-2">
                <Label htmlFor="new-section-name">{t('newSectionName')}</Label>
                <Input id="new-section-name" value={newSectionName} onChange={(e) => setNewSectionName(e.target.value)} />
                <Button type="submit">{t('createSection')}</Button>
              </form>
              {content && content.sections.length === 0 ? <p>{t('noSections')}</p> : null}
              {(content?.sections ?? []).map((section) => {
                const edit = sectionEdits[section.id] ?? { name: section.name ?? '', visible: section.visible };
                const draft = moduleDrafts[section.id] ?? { component: '', name: '' };
                const displayName = section.name ?? t('sectionDefaultName', { number: section.section });
                return (
                  <div key={section.id} data-testid={`section-builder-${section.id}`} className="space-y-3 rounded border p-3">
                    <div className="space-y-2">
                      <Label htmlFor={`section-name-${section.id}`}>{t('sectionName')}</Label>
                      <Input
                        id={`section-name-${section.id}`}
                        value={edit.name}
                        onChange={(e) => setSectionEdits((prev) => ({ ...prev, [section.id]: { ...edit, name: e.target.value } }))}
                      />
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={edit.visible}
                          onChange={(e) => setSectionEdits((prev) => ({ ...prev, [section.id]: { ...edit, visible: e.target.checked } }))}
                        />
                        {t('sectionVisible')}
                      </label>
                      <div className="flex gap-2">
                        <Button type="button" variant="outline" onClick={() => void saveSection(section.id)}>{t('saveSection')}</Button>
                        <Button type="button" variant="destructive" onClick={() => void deleteSection(section.id, displayName)}>{t('deleteSection')}</Button>
                      </div>
                    </div>
                    <ul className="space-y-3">
                      {section.modules.map((cm) => {
                        const mEdit = moduleEdits[cm.id] ?? { name: cm.name, visible: cm.visible };
                        return (
                          <li key={cm.id} data-testid={`module-builder-${cm.id}`} className="space-y-2 rounded border p-2">
                            <p className="text-sm font-medium">{cm.name || cm.component} <span className="text-muted-foreground">({cm.component})</span></p>
                            <div className="space-y-2">
                              <Label htmlFor={`module-name-${cm.id}`}>{t('moduleName')}</Label>
                              <Input
                                id={`module-name-${cm.id}`}
                                value={mEdit.name}
                                onChange={(e) => setModuleEdits((prev) => ({ ...prev, [cm.id]: { ...mEdit, name: e.target.value } }))}
                              />
                              <label className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={mEdit.visible}
                                  onChange={(e) => setModuleEdits((prev) => ({ ...prev, [cm.id]: { ...mEdit, visible: e.target.checked } }))}
                                />
                                {t('moduleVisible')}
                              </label>
                              <div className="flex gap-2">
                                <Button type="button" variant="outline" size="sm" onClick={() => void saveModule(cm.id)}>{t('saveModule')}</Button>
                                <Button type="button" variant="destructive" size="sm" onClick={() => void deleteModule(cm.id, cm.name || cm.component)}>{t('deleteModule')}</Button>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                      {section.modules.length === 0 ? <li className="text-sm text-muted-foreground">{t('noModulesInSection')}</li> : null}
                    </ul>
                    <form onSubmit={(e) => void createModule(e, section.id)} className="space-y-2">
                      <div className="space-y-2">
                        <Label htmlFor={`module-component-${section.id}`}>{t('moduleComponent')}</Label>
                        <Input
                          id={`module-component-${section.id}`}
                          value={draft.component}
                          onChange={(e) => setModuleDrafts((prev) => ({ ...prev, [section.id]: { ...draft, component: e.target.value } }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`module-new-name-${section.id}`}>{t('moduleName')}</Label>
                        <Input
                          id={`module-new-name-${section.id}`}
                          value={draft.name}
                          onChange={(e) => setModuleDrafts((prev) => ({ ...prev, [section.id]: { ...draft, name: e.target.value } }))}
                        />
                      </div>
                      <Button type="submit" variant="outline">{t('addModule')}</Button>
                    </form>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader><CardTitle>{t('groups')}</CardTitle><CardDescription>{t('groupsInCourse')}</CardDescription></CardHeader>
        <CardContent>
          <ul>{groups.map((g) => <li key={g.id}>{g.name}</li>)}</ul>
          <form onSubmit={createGroup} className="mt-3 space-y-2">
            <Label htmlFor="group-name">{t('newGroupName')}</Label>
            <Input id="group-name" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
            <Button type="submit">{t('createGroup')}</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('cohorts')}</CardTitle><CardDescription>{t('cohortsDescription')}</CardDescription></CardHeader>
        <CardContent>
          <ul>{cohorts.map((c) => <li key={c.id}>{c.name} ({c.idnumber || t('noIdnumber')})</li>)}</ul>
          {cohorts.length === 0 && <p>{t('noCohorts')}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('enrolment')}</CardTitle><CardDescription>{t('enrolmentDescription')}</CardDescription></CardHeader>
        <CardContent>
          <form onSubmit={ensureManualAndEnrol} className="space-y-2">
            <Label htmlFor="enrol-userid">{t('userIdToEnrol')}</Label>
            <Input id="enrol-userid" value={enrolUserId} onChange={(e) => setEnrolUserId(e.target.value)} />
            <Button type="submit">{t('enrolUser')}</Button>
          </form>
          <ul className="mt-4 space-y-2">
            {enrolments.map((ue) => (
              <li key={ue.id} className="flex items-center gap-3">
                <span>{t('enrolUserLine', { userId: ue.userid, status: ue.status === 0 ? t('enrolActive') : ue.status === 1 ? t('enrolSuspended') : t('enrolWithdrawn'), method: ue.enrolMethod ?? '' })}</span>
                {ue.status !== 2 && (
                  <Button type="button" variant="outline" onClick={() => void toggleSuspend(ue)}>
                    {ue.status === 1 ? t('reactivate') : t('suspend')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('completionProgress')}</CardTitle><CardDescription>{t('completionProgressDescription')}</CardDescription></CardHeader>
        <CardContent>
          <ul>
            {completions.map((c) => (
              <li key={c.id}>{t('completionLine', { userId: c.userid, status: c.status, suffix: c.timecompleted ? t('completionSuffix', { time: c.timecompleted }) : '' })}</li>
            ))}
          </ul>
          {completions.length === 0 && <p>{t('noCompletionRecords')}</p>}
          {message && <p role="status" className="pt-2 text-sm">{message}</p>}
        </CardContent>
      </Card>
    </main>
  );
}
