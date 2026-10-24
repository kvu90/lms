import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import type {
  Cohort,
  Course,
  CourseCompletion,
  CourseContent,
  CourseGroup,
  CourseGrouping,
  EnrolInstance,
  GradeItem,
  UserEnrolment,
} from '@lms/contracts';
import { AvailabilityEditor } from '#components/availability-editor';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';
import { usePermissions } from '#lib/permissions';
import { FrameUnitPicker } from '../components/frame-picker';
import {
  fetchFrameUnitsFor, fetchSubjects, fetchSystemContextId,
  type CurriculumSubject, type FrameUnit,
} from '#lib/curriculum';

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
  const navigate = useNavigate();
  /** Tên bài kiểm tra (quiz) đang soạn theo từng section trong khu xây dựng. */
  const [quizNames, setQuizNames] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<CourseGroup[]>([]);
  const [groupings, setGroupings] = useState<CourseGrouping[]>([]);
  const [groupName, setGroupName] = useState('');
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [instances, setInstances] = useState<EnrolInstance[]>([]);
  const [enrolments, setEnrolments] = useState<UserEnrolment[]>([]);
  const [completions, setCompletions] = useState<CourseCompletion[]>([]);
  const [enrolUserId, setEnrolUserId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [groupingDraft, setGroupingDraft] = useState({ name: '', idNumber: '', description: '' });
  const [expandedGroupingId, setExpandedGroupingId] = useState('');
  const [groupingGroups, setGroupingGroups] = useState<Record<string, CourseGroup[]>>({});
  const [groupingAddSelection, setGroupingAddSelection] = useState<Record<string, string>>({});
  const [expandedCohortId, setExpandedCohortId] = useState('');
  const [cohortMembers, setCohortMembers] = useState<Record<string, { userId: string; timeAdded: string }[]>>({});
  const [cohortMemberInputs, setCohortMemberInputs] = useState<Record<string, string>>({});

  /** Được xây dựng khoá này hay không: teaching của khoá hoặc quản trị hệ thống. */
  const courseAccess = perms.courses.find((c) => c.course.id === courseId);
  const canBuild =
    perms.canAdminister ||
    perms.teaching.some((c) => c.course.id === courseId) ||
    (courseAccess?.capabilities.includes('course:update') ?? false);
  /** Sửa tiêu chí hoàn thành khoá cần `completion:manage` tại context khoá (đúng capability backend đòi ở completion service) hoặc quyền quản trị hệ thống. */
  const canManageCompletion =
    perms.canAdminister || (courseAccess?.capabilities.includes('completion:manage') ?? false);
  /** Quản lý grouping cần `course:managegroups` tại context khoá (đúng capability backend đòi ở groups service) hoặc quyền quản trị hệ thống. */
  const canManageGroups =
    perms.canAdminister || (courseAccess?.capabilities.includes('course:managegroups') ?? false);
  /** Quản lý thành viên cohort cần `cohort:manage` ở context của cohort; giao diện hiện thao tác khi capability này xuất hiện trong ảnh chụp quyền ở bất kỳ context nào hoặc là quản trị hệ thống — API vẫn thực thi theo đúng context của từng cohort. */
  const canManageCohorts =
    perms.canAdminister ||
    (perms.access?.contexts.some((c) => c.capabilities.includes('cohort:manage')) ?? false);

  const [course, setCourse] = useState<Course | null>(null);
  const [content, setContent] = useState<CourseContent | null>(null);
  const [builderMessage, setBuilderMessage] = useState<string | null>(null);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [fullName, setFullname] = useState('');
  const [shortName, setShortname] = useState('');
  const [courseCategory, setCourseCategory] = useState('');
  const [summary, setSummary] = useState('');
  const [courseVisible, setCourseVisible] = useState(true);
  const [startDate, setStartdate] = useState('');
  const [endDate, setEnddate] = useState('');
  const [newSectionName, setNewSectionName] = useState('');
  const [sectionEdits, setSectionEdits] = useState<Record<string, { name: string; visible: boolean }>>({});
  const [moduleDrafts, setModuleDrafts] = useState<Record<string, { component: string; name: string }>>({});
  const [moduleEdits, setModuleEdits] = useState<Record<string, { name: string; visible: boolean }>>({});
  const [gradeItems, setGradeItems] = useState<GradeItem[]>([]);
  const [availabilityDrafts, setAvailabilityDrafts] = useState<Record<string, unknown>>({});
  const [criteriaMethod, setCriteriaMethod] = useState(1);
  const [criteriaDraft, setCriteriaDraft] = useState<{ criteriaType: string; moduleInstance: string; date: string }[]>(
    [],
  );

  const reload = useCallback(async () => {
    const [g, gr, c, i, e, comp] = await Promise.all([
      apiJson<CourseGroup[]>(`/api/v1/courses/${courseId}/groups`).catch(() => []),
      apiJson<CourseGrouping[]>(`/api/v1/courses/${courseId}/groupings`).catch(() => []),
      apiJson<Cohort[]>('/api/v1/cohorts').catch(() => []),
      apiJson<EnrolInstance[]>(`/api/v1/courses/${courseId}/enrol/instances`).catch(() => []),
      apiJson<UserEnrolment[]>(`/api/v1/courses/${courseId}/enrolments`).catch(() => []),
      apiJson<CourseCompletion[]>(`/api/v1/courses/${courseId}/completion`).catch(() => []),
    ]);
    setGroups(g);
    setGroupings(gr);
    setCohorts(c);
    setInstances(i);
    setEnrolments(e);
    setCompletions(comp);
  }, [courseId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Nạp dữ liệu cho khu xây dựng: thông tin khoá từ GET /courses/:id (kèm
   * các trường phụ phía server như contextId — trang chỉ đọc các trường
   * của `Course` trong contracts) và cấu trúc section/module từ
   * GET /courses/:id/content. Đồng thời khởi tạo lại các ô sửa từ dữ liệu
   * thật để form luôn phản ánh trạng thái server sau mỗi lần nạp lại.
   */
  const reloadBuilder = useCallback(async () => {
    const [courseRes, contentRes, itemsRes, criteriaRes] = await Promise.all([
      apiJson<Course>(`/api/v1/courses/${courseId}`).catch(() => null),
      apiJson<CourseContent>(`/api/v1/courses/${courseId}/content`).catch(() => null),
      apiJson<GradeItem[]>(`/api/v1/courses/${courseId}/grades/items`).catch(() => []),
      apiJson<{
        method: number;
        criteria: { id: string; criteriaType: string; moduleInstance: string | null; date: string | null }[];
      }>(`/api/v1/courses/${courseId}/completion/criteria`).catch(() => null),
    ]);
    setGradeItems(itemsRes);
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
      setStartdate(courseRes.startDate ? courseRes.startDate.slice(0, 10) : '');
      setEnddate(courseRes.endDate ? courseRes.endDate.slice(0, 10) : '');
    }
    if (contentRes) {
      setContent(contentRes);
      setSectionEdits(
        Object.fromEntries(contentRes.sections.map((s) => [s.id, { name: s.name ?? '', visible: s.visible }])),
      );
      setModuleEdits(
        Object.fromEntries(
          contentRes.sections.flatMap((s) => s.modules.map((m) => [m.id, { name: m.name, visible: m.visible }])),
        ),
      );
      setAvailabilityDrafts(
        Object.fromEntries([
          ...contentRes.sections.map((s) => [`section:${s.id}`, s.availability ?? null] as const),
          ...contentRes.sections.flatMap((s) =>
            s.modules.map((m) => [`module:${m.id}`, m.availability ?? null] as const),
          ),
        ]),
      );
    }
    if (!courseRes && !contentRes) setBuilderError(t('builderLoadFailed'));
  }, [courseId, t]);

  useEffect(() => {
    if (canBuild) void reloadBuilder();
  }, [canBuild, reloadBuilder]);

  const manualInstance = instances.find((i) => i.enrol === 'manual');

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson(`/api/v1/courses/${courseId}/groups`, {
        method: 'POST',
        body: JSON.stringify({ name: groupName }),
      });
      setGroupName('');
      await reload();
      setMessage(t('groupCreated'));
    } catch {
      setMessage(t('groupCreateFailed'));
    }
  }

  /** Tạo grouping qua POST /courses/:id/groupings (`createGroupingSchema`: name bắt buộc, idNumber/description tuỳ chọn). */
  async function createGrouping(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson(`/api/v1/courses/${courseId}/groupings`, {
        method: 'POST',
        body: JSON.stringify({
          name: groupingDraft.name,
          ...(groupingDraft.idNumber.trim() ? { idNumber: groupingDraft.idNumber.trim() } : {}),
          ...(groupingDraft.description.trim() ? { description: groupingDraft.description.trim() } : {}),
        }),
      });
      setGroupingDraft({ name: '', idNumber: '', description: '' });
      await reload();
      setMessage(t('groupingCreated'));
    } catch {
      setMessage(t('groupingCreateFailed'));
    }
  }

  /** Xoá grouping qua DELETE /courses/:id/groupings/:groupingId — hỏi xác nhận trước; các nhóm trong khoá không bị xoá theo. */
  async function deleteGrouping(grouping: CourseGrouping) {
    if (!window.confirm(t('confirmDeleteGrouping', { name: grouping.name }))) return;
    try {
      await apiJson(`/api/v1/courses/${courseId}/groupings/${grouping.id}`, { method: 'DELETE' });
      if (expandedGroupingId === grouping.id) setExpandedGroupingId('');
      await reload();
      setMessage(t('groupingDeleted'));
    } catch {
      setMessage(t('groupingDeleteFailed'));
    }
  }

  /** Mở/thu danh sách nhóm của một grouping: GET /courses/:id/groupings/:groupingId/groups khi mở lần đầu. */
  async function toggleGroupingGroups(groupingId: string) {
    if (expandedGroupingId === groupingId) {
      setExpandedGroupingId('');
      return;
    }
    setExpandedGroupingId(groupingId);
    if (!groupingGroups[groupingId]) {
      try {
        const rows = await apiJson<CourseGroup[]>(`/api/v1/courses/${courseId}/groupings/${groupingId}/groups`);
        setGroupingGroups((prev) => ({ ...prev, [groupingId]: rows }));
      } catch {
        setMessage(t('groupingGroupsLoadFailed'));
      }
    }
  }

  /** Gắn một nhóm vào grouping qua POST groupings/:groupingId/groups với `{ groupId }` (`groupingGroupSchema`). */
  async function addGroupToGrouping(groupingId: string) {
    const groupId = groupingAddSelection[groupingId];
    if (!groupId) return;
    try {
      await apiJson(`/api/v1/courses/${courseId}/groupings/${groupingId}/groups`, {
        method: 'POST',
        body: JSON.stringify({ groupId }),
      });
      const rows = await apiJson<CourseGroup[]>(`/api/v1/courses/${courseId}/groupings/${groupingId}/groups`).catch(
        () => groupingGroups[groupingId] ?? [],
      );
      setGroupingGroups((prev) => ({ ...prev, [groupingId]: rows }));
      setMessage(t('groupingGroupAdded'));
    } catch {
      setMessage(t('groupingGroupAddFailed'));
    }
  }

  /** Mở/thu danh sách thành viên của một cohort: GET /cohorts/:id/members (mảng `{ userId, timeAdded }`). */
  async function toggleCohortMembers(cohortId: string) {
    if (expandedCohortId === cohortId) {
      setExpandedCohortId('');
      return;
    }
    setExpandedCohortId(cohortId);
    if (!cohortMembers[cohortId]) {
      try {
        const rows = await apiJson<{ userId: string; timeAdded: string }[]>(`/api/v1/cohorts/${cohortId}/members`);
        setCohortMembers((prev) => ({ ...prev, [cohortId]: rows }));
      } catch {
        setMessage(t('cohortMembersLoadFailed'));
      }
    }
  }

  /** Thêm thành viên vào cohort qua POST /cohorts/:id/members (`groupMemberSchema`); backend kích hoạt đồng bộ ghi danh theo cohort. */
  async function addCohortMember(cohortId: string) {
    const userId = (cohortMemberInputs[cohortId] ?? '').trim();
    if (!userId) return;
    try {
      await apiJson(`/api/v1/cohorts/${cohortId}/members`, { method: 'POST', body: JSON.stringify({ userId }) });
      setCohortMemberInputs((prev) => ({ ...prev, [cohortId]: '' }));
      const rows = await apiJson<{ userId: string; timeAdded: string }[]>(`/api/v1/cohorts/${cohortId}/members`).catch(
        () => cohortMembers[cohortId] ?? [],
      );
      setCohortMembers((prev) => ({ ...prev, [cohortId]: rows }));
      setMessage(t('cohortMemberAdded'));
    } catch {
      setMessage(t('cohortMemberAddFailed'));
    }
  }

  /** Gỡ thành viên khỏi cohort qua DELETE /cohorts/:id/members/:userId. */
  async function removeCohortMember(cohortId: string, userId: string) {
    try {
      await apiJson(`/api/v1/cohorts/${cohortId}/members/${userId}`, { method: 'DELETE' });
      const rows = await apiJson<{ userId: string; timeAdded: string }[]>(`/api/v1/cohorts/${cohortId}/members`).catch(
        () => (cohortMembers[cohortId] ?? []).filter((m) => m.userId !== userId),
      );
      setCohortMembers((prev) => ({ ...prev, [cohortId]: rows }));
      setMessage(t('cohortMemberRemoved'));
    } catch {
      setMessage(t('cohortMemberRemoveFailed'));
    }
  }

  async function ensureManualAndEnrol(event: FormEvent) {
    event.preventDefault();
    try {
      let instance = manualInstance;
      if (!instance) {
        instance = await apiJson<EnrolInstance>(`/api/v1/courses/${courseId}/enrol/instances`, {
          method: 'POST',
          body: JSON.stringify({ method: 'manual' }),
        });
      }
      await apiJson(`/api/v1/courses/${courseId}/enrol/instances/${instance.id}/enrol`, {
        method: 'POST',
        body: JSON.stringify({ userId: enrolUserId }),
      });
      await reload();
      setMessage(t('userEnrolled'));
    } catch {
      setMessage(t('userEnrolFailed'));
    }
  }

  async function toggleSuspend(ue: UserEnrolment) {
    const action = ue.status === 1 ? 'reactivate' : 'suspend';
    try {
      await apiJson(`/api/v1/courses/${courseId}/enrol/instances/${ue.enrolId}/users/${ue.userId}/${action}`, {
        method: 'POST',
      });
      await reload();
    } catch {
      setMessage(t('enrolStatusChangeFailed'));
    }
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
          fullName,
          shortName,
          category: courseCategory,
          summary,
          visible: courseVisible,
          startDate: startDate ? startDate : null,
          endDate: endDate ? endDate : null,
        }),
      });
      setBuilderMessage(t('courseSaved'));
      await reloadBuilder();
    } catch {
      setBuilderMessage(t('courseSaveFailed'));
    }
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
    } catch {
      setBuilderMessage(t('sectionCreateFailed'));
    }
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
    } catch {
      setBuilderMessage(t('sectionSaveFailed'));
    }
  }

  /** Xoá một section qua DELETE — luôn hỏi xác nhận vì thao tác xoá cả module bên trong. */
  async function deleteSection(sectionId: string, sectionName: string) {
    if (!window.confirm(t('confirmDeleteSection', { name: sectionName }))) return;
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}`, { method: 'DELETE' });
      setBuilderMessage(t('sectionDeleted'));
      await reloadBuilder();
    } catch {
      setBuilderMessage(t('sectionDeleteFailed'));
    }
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
    } catch {
      setBuilderMessage(t('moduleCreateFailed'));
    }
  }

  /**
   * Tạo hoạt động Quiz trong một section qua POST /courses/:id/quizzes
   * (API tự tạo course module + grade item) rồi chuyển thẳng tới trang
   * quiz để giáo viên dựng đề và cài đặt.
   */
  async function createQuiz(event: FormEvent, sectionId: string) {
    event.preventDefault();
    const name = (quizNames[sectionId] ?? '').trim();
    if (!name) return;
    setBuilderMessage(null);
    try {
      const created = await apiJson<{ id: string }>(`/api/v1/courses/${courseId}/quizzes`, {
        method: 'POST',
        body: JSON.stringify({ sectionId, name }),
      });
      setQuizNames((prev) => ({ ...prev, [sectionId]: '' }));
      await navigate(`/courses/${courseId}/quizzes/${created.id}`);
    } catch {
      setBuilderMessage(t('quizCreateFailed'));
    }
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
    } catch {
      setBuilderMessage(t('moduleSaveFailed'));
    }
  }

  /** Xoá một module qua DELETE — luôn hỏi xác nhận trước. */
  async function deleteModule(cmId: string, moduleName: string) {
    if (!window.confirm(t('confirmDeleteModule', { name: moduleName }))) return;
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/modules/${cmId}`, { method: 'DELETE' });
      setBuilderMessage(t('moduleDeleted'));
      await reloadBuilder();
    } catch {
      setBuilderMessage(t('moduleDeleteFailed'));
    }
  }

  /**
   * Lưu cây availability của một section qua PATCH section: gửi đúng
   * trường `availability` của `updateCourseSectionSchema` — payload là cây
   * JSON do trình sửa phát ra, hoặc `null` khi cây đã rỗng (xoá hạn chế).
   */
  async function saveSectionAvailability(sectionId: string) {
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ availability: availabilityDrafts[`section:${sectionId}`] ?? null }),
      });
      setBuilderMessage(t('availabilitySaved'));
      await reloadBuilder();
    } catch {
      setBuilderMessage(t('availabilitySaveFailed'));
    }
  }

  /** Lưu cây availability của một course module qua PATCH module (trường `availability` của `updateCourseModuleSchema`). */
  async function saveModuleAvailability(cmId: string) {
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/modules/${cmId}`, {
        method: 'PATCH',
        body: JSON.stringify({ availability: availabilityDrafts[`module:${cmId}`] ?? null }),
      });
      setBuilderMessage(t('availabilitySaved'));
      await reloadBuilder();
    } catch {
      setBuilderMessage(t('availabilitySaveFailed'));
    }
  }

  /**
   * Lưu toàn bộ bộ tiêu chí hoàn thành qua PUT /courses/:id/completion/criteria
   * (`completionCriteriaSchema`): method 1 = đạt tất cả (ALL), 2 = đạt bất kỳ
   * (ANY); từng tiêu chí gửi kèm moduleInstance với loại `module` hoặc date với
   * loại `date`, loại `grade` không cần thêm trường.
   */
  async function saveCriteria(event: FormEvent) {
    event.preventDefault();
    setBuilderMessage(null);
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
      setBuilderMessage(t('completionCriteriaSaved'));
      await reloadBuilder();
    } catch {
      setBuilderMessage(t('completionCriteriaSaveFailed'));
    }
  }

  /** Yêu cầu tính lại trạng thái hoàn thành cho cả khoá qua POST /courses/:id/completion/recalculate. */
  async function recalculateCompletion() {
    setBuilderMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}/completion/recalculate`, { method: 'POST' });
      setBuilderMessage(t('recalculatedCompletion'));
      await reloadBuilder();
    } catch {
      setBuilderMessage(t('recalculateFailed'));
    }
  }

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
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
                    <Input id="builder-fullname" value={fullName} onChange={(e) => setFullname(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="builder-shortname">{t('courseShortName')}</Label>
                    <Input id="builder-shortname" value={shortName} onChange={(e) => setShortname(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="builder-category">{t('courseCategory')}</Label>
                    <Input
                      id="builder-category"
                      value={courseCategory}
                      onChange={(e) => setCourseCategory(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="builder-summary">{t('courseSummary')}</Label>
                    <Input id="builder-summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="builder-startdate">{t('courseStartDate')}</Label>
                    <Input
                      id="builder-startdate"
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartdate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="builder-enddate">{t('courseEndDate')}</Label>
                    <Input
                      id="builder-enddate"
                      type="date"
                      value={endDate}
                      onChange={(e) => setEnddate(e.target.value)}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={courseVisible}
                      onChange={(e) => setCourseVisible(e.target.checked)}
                    />
                    {t('courseVisible')}
                  </label>
                  <Button type="submit">{t('saveCourse')}</Button>
                </form>
              ) : null}
              {builderMessage ? (
                <p role="status" className="pt-2 text-sm">
                  {builderMessage}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <CurriculumFramePanel
            courseId={courseId}
            course={course}
            sections={(content?.sections ?? []).map((s) => ({ section: s.section, name: s.name }))}
            onApplied={() => void reloadBuilder()}
          />

          <Card>
            <CardHeader>
              <CardTitle>{t('sectionsBuilderTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <form onSubmit={(e) => void createSection(e)} className="space-y-2">
                <Label htmlFor="new-section-name">{t('newSectionName')}</Label>
                <Input
                  id="new-section-name"
                  value={newSectionName}
                  onChange={(e) => setNewSectionName(e.target.value)}
                />
                <Button type="submit">{t('createSection')}</Button>
              </form>
              {content && content.sections.length === 0 ? <p>{t('noSections')}</p> : null}
              {(content?.sections ?? []).map((section) => {
                const edit = sectionEdits[section.id] ?? { name: section.name ?? '', visible: section.visible };
                const draft = moduleDrafts[section.id] ?? { component: '', name: '' };
                const displayName = section.name ?? t('sectionDefaultName', { number: section.section });
                return (
                  <div
                    key={section.id}
                    data-testid={`section-builder-${section.id}`}
                    className="space-y-3 rounded border p-3"
                  >
                    <div className="space-y-2">
                      <Label htmlFor={`section-name-${section.id}`}>{t('sectionName')}</Label>
                      <Input
                        id={`section-name-${section.id}`}
                        value={edit.name}
                        onChange={(e) =>
                          setSectionEdits((prev) => ({ ...prev, [section.id]: { ...edit, name: e.target.value } }))
                        }
                      />
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={edit.visible}
                          onChange={(e) =>
                            setSectionEdits((prev) => ({
                              ...prev,
                              [section.id]: { ...edit, visible: e.target.checked },
                            }))
                          }
                        />
                        {t('sectionVisible')}
                      </label>
                      <div className="flex gap-2">
                        <Button type="button" variant="outline" onClick={() => void saveSection(section.id)}>
                          {t('saveSection')}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => void deleteSection(section.id, displayName)}
                        >
                          {t('deleteSection')}
                        </Button>
                      </div>
                    </div>
                    <ul className="space-y-3">
                      {section.modules.map((cm) => {
                        const mEdit = moduleEdits[cm.id] ?? { name: cm.name, visible: cm.visible };
                        return (
                          <li
                            key={cm.id}
                            data-testid={`module-builder-${cm.id}`}
                            className="space-y-2 rounded border p-2"
                          >
                            <p className="text-sm font-medium">
                              {cm.name || cm.component} <span className="text-muted-foreground">({cm.component})</span>
                            </p>
                            <div className="space-y-2">
                              <Label htmlFor={`module-name-${cm.id}`}>{t('moduleName')}</Label>
                              <Input
                                id={`module-name-${cm.id}`}
                                value={mEdit.name}
                                onChange={(e) =>
                                  setModuleEdits((prev) => ({ ...prev, [cm.id]: { ...mEdit, name: e.target.value } }))
                                }
                              />
                              <label className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={mEdit.visible}
                                  onChange={(e) =>
                                    setModuleEdits((prev) => ({
                                      ...prev,
                                      [cm.id]: { ...mEdit, visible: e.target.checked },
                                    }))
                                  }
                                />
                                {t('moduleVisible')}
                              </label>
                              <div className="flex gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void saveModule(cm.id)}
                                >
                                  {t('saveModule')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => void deleteModule(cm.id, cm.name || cm.component)}
                                >
                                  {t('deleteModule')}
                                </Button>
                              </div>
                              <div className="space-y-2" data-testid={`module-availability-${cm.id}`}>
                                <h5 className="text-sm font-medium">{t('availabilityTitle')}</h5>
                                <AvailabilityEditor
                                  key={`module-availability-editor-${cm.id}`}
                                  value={cm.availability}
                                  onChange={(next) =>
                                    setAvailabilityDrafts((prev) => ({ ...prev, [`module:${cm.id}`]: next }))
                                  }
                                  groups={groups.map((g) => ({ id: g.id, name: g.name }))}
                                  groupings={groupings.map((g) => ({ id: g.id, name: g.name }))}
                                  modules={(content?.sections ?? []).flatMap((s) =>
                                    s.modules.map((m) => ({ id: m.id, name: m.name || m.component })),
                                  )}
                                  gradeItems={gradeItems.map((item) => ({ id: item.id, name: item.itemName }))}
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void saveModuleAvailability(cm.id)}
                                >
                                  {t('availabilitySave')}
                                </Button>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                      {section.modules.length === 0 ? (
                        <li className="text-sm text-muted-foreground">{t('noModulesInSection')}</li>
                      ) : null}
                    </ul>
                    <form onSubmit={(e) => void createModule(e, section.id)} className="space-y-2">
                      <div className="space-y-2">
                        <Label htmlFor={`module-component-${section.id}`}>{t('moduleComponent')}</Label>
                        <Input
                          id={`module-component-${section.id}`}
                          value={draft.component}
                          onChange={(e) =>
                            setModuleDrafts((prev) => ({
                              ...prev,
                              [section.id]: { ...draft, component: e.target.value },
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`module-new-name-${section.id}`}>{t('moduleName')}</Label>
                        <Input
                          id={`module-new-name-${section.id}`}
                          value={draft.name}
                          onChange={(e) =>
                            setModuleDrafts((prev) => ({ ...prev, [section.id]: { ...draft, name: e.target.value } }))
                          }
                        />
                      </div>
                      <Button type="submit" variant="outline">
                        {t('addModule')}
                      </Button>
                    </form>
                    <form onSubmit={(e) => void createQuiz(e, section.id)} className="space-y-2">
                      <div className="space-y-2">
                        <Label htmlFor={`quiz-new-name-${section.id}`}>{t('quizName')}</Label>
                        <Input
                          id={`quiz-new-name-${section.id}`}
                          value={quizNames[section.id] ?? ''}
                          onChange={(e) => setQuizNames((prev) => ({ ...prev, [section.id]: e.target.value }))}
                        />
                      </div>
                      <Button type="submit" variant="outline">
                        {t('addQuiz')}
                      </Button>
                    </form>
                    <div className="space-y-2" data-testid={`section-availability-${section.id}`}>
                      <h4 className="text-sm font-medium">{t('availabilityTitle')}</h4>
                      <p className="text-sm text-muted-foreground">{t('availabilityDescription')}</p>
                      <AvailabilityEditor
                        key={`section-availability-editor-${section.id}`}
                        value={section.availability}
                        onChange={(next) =>
                          setAvailabilityDrafts((prev) => ({ ...prev, [`section:${section.id}`]: next }))
                        }
                        groups={groups.map((g) => ({ id: g.id, name: g.name }))}
                        groupings={groupings.map((g) => ({ id: g.id, name: g.name }))}
                        modules={(content?.sections ?? []).flatMap((s) =>
                          s.modules.map((m) => ({ id: m.id, name: m.name || m.component })),
                        )}
                        gradeItems={gradeItems.map((item) => ({ id: item.id, name: item.itemName }))}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void saveSectionAvailability(section.id)}
                      >
                        {t('availabilitySave')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}

      {canBuild && canManageCompletion && (
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
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
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
                      className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
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
                                      ? ((content?.sections ?? []).flatMap((s) => s.modules)[0]?.id ?? '')
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
                        className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                        value={criterion.moduleInstance}
                        onChange={(e) =>
                          setCriteriaDraft((prev) =>
                            prev.map((c, i) => (i === index ? { ...c, moduleInstance: e.target.value } : c)),
                          )
                        }
                      >
                        {(content?.sections ?? [])
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
                          setCriteriaDraft((prev) =>
                            prev.map((c, i) => (i === index ? { ...c, date: e.target.value } : c)),
                          )
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
                  onClick={() =>
                    setCriteriaDraft((prev) => [...prev, { criteriaType: 'grade', moduleInstance: '', date: '' }])
                  }
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
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('groups')}</CardTitle>
          <CardDescription>{t('groupsInCourse')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul>
            {groups.map((g) => (
              <li key={g.id}>{g.name}</li>
            ))}
          </ul>
          <form onSubmit={createGroup} className="mt-3 space-y-2">
            <Label htmlFor="group-name">{t('newGroupName')}</Label>
            <Input id="group-name" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
            <Button type="submit">{t('createGroup')}</Button>
          </form>
        </CardContent>
      </Card>

      {canManageGroups && (
        <Card>
          <CardHeader>
            <CardTitle>{t('groupings')}</CardTitle>
            <CardDescription>{t('groupingsDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-3">
              {groupings.map((g) => {
                const inGrouping = groupingGroups[g.id] ?? [];
                const candidates = groups.filter((gr) => !inGrouping.some((x) => x.id === gr.id));
                return (
                  <li key={g.id} data-testid={`grouping-${g.id}`} className="space-y-2 rounded border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{g.name}</span>
                      {g.idNumber ? <span className="text-sm text-muted-foreground">({g.idNumber})</span> : null}
                      <Button type="button" variant="outline" size="sm" onClick={() => void toggleGroupingGroups(g.id)}>
                        {t('groupingViewGroups')}
                      </Button>
                      <Button type="button" variant="destructive" size="sm" onClick={() => void deleteGrouping(g)}>
                        {t('deleteGrouping')}
                      </Button>
                    </div>
                    {expandedGroupingId === g.id && (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">{t('groupingGroupsTitle', { name: g.name })}</p>
                        <ul className="space-y-1">
                          {inGrouping.map((gr) => (
                            <li key={gr.id} className="text-sm">
                              {gr.name}
                            </li>
                          ))}
                          {inGrouping.length === 0 && (
                            <li className="text-sm text-muted-foreground">{t('groupingNoGroups')}</li>
                          )}
                        </ul>
                        {candidates.length > 0 && (
                          <div className="flex flex-wrap items-end gap-2">
                            <div className="space-y-1">
                              <Label htmlFor={`grouping-add-${g.id}`}>{t('groupingAddGroupLabel')}</Label>
                              <select
                                id={`grouping-add-${g.id}`}
                                className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
                                value={groupingAddSelection[g.id] ?? ''}
                                onChange={(e) =>
                                  setGroupingAddSelection((prev) => ({ ...prev, [g.id]: e.target.value }))
                                }
                              >
                                <option value="">—</option>
                                {candidates.map((gr) => (
                                  <option key={gr.id} value={gr.id}>
                                    {gr.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void addGroupToGrouping(g.id)}
                            >
                              {t('groupingAddGroup')}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
              {groupings.length === 0 && <li className="text-sm">{t('noGroupings')}</li>}
            </ul>
            <form onSubmit={(e) => void createGrouping(e)} className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="grouping-name">{t('groupingName')}</Label>
                <Input
                  id="grouping-name"
                  value={groupingDraft.name}
                  onChange={(e) => setGroupingDraft({ ...groupingDraft, name: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="grouping-idnumber">{t('groupingIdnumber')}</Label>
                <Input
                  id="grouping-idnumber"
                  value={groupingDraft.idNumber}
                  onChange={(e) => setGroupingDraft({ ...groupingDraft, idNumber: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="grouping-description">{t('groupingDescriptionField')}</Label>
                <Input
                  id="grouping-description"
                  value={groupingDraft.description}
                  onChange={(e) => setGroupingDraft({ ...groupingDraft, description: e.target.value })}
                />
              </div>
              <Button type="submit">{t('createGrouping')}</Button>
            </form>
            <p className="text-sm text-muted-foreground">{t('groupingApiNote')}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('cohorts')}</CardTitle>
          <CardDescription>{t('cohortsDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {cohorts.map((c) => (
              <li key={c.id} data-testid={`cohort-${c.id}`} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    {c.name} ({c.idNumber || t('noIdnumber')})
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={() => void toggleCohortMembers(c.id)}>
                    {t('cohortViewMembers')}
                  </Button>
                </div>
                {expandedCohortId === c.id && (
                  <div className="space-y-2 rounded border p-3">
                    <p className="text-sm font-medium">{t('cohortMembersTitle', { name: c.name })}</p>
                    <ul className="space-y-1">
                      {(cohortMembers[c.id] ?? []).map((m) => (
                        <li key={m.userId} className="flex items-center gap-2 text-sm">
                          <span>{t('cohortMemberLine', { userId: m.userId, time: m.timeAdded })}</span>
                          {canManageCohorts && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void removeCohortMember(c.id, m.userId)}
                            >
                              {t('cohortRemoveMember')}
                            </Button>
                          )}
                        </li>
                      ))}
                      {(cohortMembers[c.id] ?? []).length === 0 && (
                        <li className="text-sm text-muted-foreground">{t('cohortNoMembers')}</li>
                      )}
                    </ul>
                    {canManageCohorts && (
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="space-y-1">
                          <Label htmlFor={`cohort-member-${c.id}`}>{t('cohortMemberUserId')}</Label>
                          <Input
                            id={`cohort-member-${c.id}`}
                            value={cohortMemberInputs[c.id] ?? ''}
                            onChange={(e) => setCohortMemberInputs((prev) => ({ ...prev, [c.id]: e.target.value }))}
                          />
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => void addCohortMember(c.id)}>
                          {t('cohortAddMember')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {cohorts.length === 0 && <p>{t('noCohorts')}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('enrolment')}</CardTitle>
          <CardDescription>{t('enrolmentDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={ensureManualAndEnrol} className="space-y-2">
            <Label htmlFor="enrol-userid">{t('userIdToEnrol')}</Label>
            <Input id="enrol-userid" value={enrolUserId} onChange={(e) => setEnrolUserId(e.target.value)} />
            <Button type="submit">{t('enrolUser')}</Button>
          </form>
          <ul className="mt-4 space-y-2">
            {enrolments.map((ue) => (
              <li key={ue.id} className="flex items-center gap-3">
                <span>
                  {t('enrolUserLine', {
                    userId: ue.userId,
                    status:
                      ue.status === 0 ? t('enrolActive') : ue.status === 1 ? t('enrolSuspended') : t('enrolWithdrawn'),
                    method: ue.enrolMethod ?? '',
                  })}
                </span>
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
        <CardHeader>
          <CardTitle>{t('completionProgress')}</CardTitle>
          <CardDescription>{t('completionProgressDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul>
            {completions.map((c) => (
              <li key={c.id}>
                {t('completionLine', {
                  userId: c.userId,
                  status: c.status,
                  suffix: c.timeCompleted ? t('completionSuffix', { time: c.timeCompleted }) : '',
                })}
              </li>
            ))}
          </ul>
          {completions.length === 0 && <p>{t('noCompletionRecords')}</p>}
          {message && (
            <p role="status" className="pt-2 text-sm">
              {message}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default CourseAdminPage;

/**
 * Panel khung chương trình (K0a) trong quản trị khoá: gắn môn × khối cho
 * khoá (PATCH /courses/:id) rồi nạp các đơn vị khung đã chọn thành
 * section mới kèm YCCĐ chụp tại lúc nạp (POST curriculum-frame), chèn
 * tại vị trí chọn trong outline hoặc cuối outline. Nạp xong gọi
 * `onApplied` để trang nạp lại cấu trúc khoá. Người không đọc được cây
 * chương trình (thiếu curriculum:view) chỉ thấy thông báo nhẹ — API vẫn
 * là nơi thực thi quyền.
 */
function CurriculumFramePanel({
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
  const [subjects, setSubjects] = useState<CurriculumSubject[]>([]);
  const [subjectId, setSubjectId] = useState('');
  const [grade, setGrade] = useState('');
  const [units, setUnits] = useState<FrameUnit[]>([]);
  const [curriculumId, setCurriculumId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [insertAt, setInsertAt] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Khởi tạo môn/khối từ chính khoá khi dữ liệu khoá về.
  useEffect(() => {
    if (!course) return;
    setSubjectId(course.subjectId ?? '');
    setGrade(course.grade != null ? String(course.grade) : '');
  }, [course?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void (async () => {
      try {
        const contextId = await fetchSystemContextId();
        if (contextId) setSubjects(await fetchSubjects(contextId));
      } catch {
        setLoadFailed(true);
      }
    })();
  }, []);

  useEffect(() => {
    setSelected([]);
    if (!subjectId || !grade) {
      setUnits([]);
      setCurriculumId(null);
      return;
    }
    void fetchFrameUnitsFor(subjectId, Number(grade))
      .then(({ curriculumId: found, units: foundUnits }) => {
        setCurriculumId(found);
        setUnits(foundUnits);
      })
      .catch(() => {
        setCurriculumId(null);
        setUnits([]);
      });
  }, [subjectId, grade]);

  /** Lưu môn/khối của khoá qua PATCH /courses/:id. */
  async function saveCourseInfo() {
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/${courseId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          subjectId: subjectId === '' ? null : subjectId,
          grade: grade === '' ? null : Number(grade),
        }),
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
      const result = await apiJson<{ sections: unknown[] }>(`/api/v1/courses/${courseId}/curriculum-frame`, {
        method: 'POST',
        body: JSON.stringify({
          curriculumId,
          nodeIds: selected,
          ...(insertAt === '' ? {} : { insertAtSection: Number(insertAt) }),
        }),
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
