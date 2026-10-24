import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type {
  Cohort,
  CourseCompletion,
  CourseGroup,
  CourseGrouping,
  EnrolInstance,
  UserEnrolment,
} from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';
import { usePermissions } from '#lib/permissions';

/**
 * Quản trị khoá học: nhóm, cohort, ghi danh thủ công kèm tạm khoá/kích
 * hoạt lại và tiến độ hoàn thành của học viên. Khu XÂY DỰNG khoá học
 * (thông tin khoá, section, module, khung chương trình, tiêu chí hoàn
 * thành) đã tách sang trang Builder Outline riêng `/courses/:id/builder`
 * (K1 — chuẩn §9: mỗi mảng một màn riêng); trang này chỉ còn thẻ liên
 * kết sang builder cho người có quyền xây dựng khoá. Quyền suy từ
 * `usePermissions()`; API vẫn là nơi thực thi quyền thật.
 */
export function CourseAdminPage() {
  const { t } = useTranslation('app');
  const { id } = useParams();
  const courseId = id ?? '';
  const perms = usePermissions();
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
  /** Quản lý grouping cần `course:managegroups` tại context khoá (đúng capability backend đòi ở groups service) hoặc quyền quản trị hệ thống. */
  const canManageGroups =
    perms.canAdminister || (courseAccess?.capabilities.includes('course:managegroups') ?? false);
  /** Quản lý thành viên cohort cần `cohort:manage` ở context của cohort; giao diện hiện thao tác khi capability này xuất hiện trong ảnh chụp quyền ở bất kỳ context nào hoặc là quản trị hệ thống — API vẫn thực thi theo đúng context của từng cohort. */
  const canManageCohorts =
    perms.canAdminister ||
    (perms.access?.contexts.some((c) => c.capabilities.includes('cohort:manage')) ?? false);


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

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      {canBuild && (
        <Card>
          <CardHeader>
            <CardTitle>{t('courseBuilder')}</CardTitle>
            <CardDescription>{t('builderMovedDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground" to={`/courses/${courseId}/builder`}>{t('builderOpen')}</Link>
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
