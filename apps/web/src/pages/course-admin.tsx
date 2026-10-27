import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type {
  Cohort,
  CourseGroup,
  CourseGrouping,
  UserEnrolment,
} from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lms/ui/components/select';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { usePermissions } from '#lib/permissions';
import {
  courseAdminPageClientLoader,
  useAddCohortMember,
  useAddCourseGroupMember,
  useAddGroupToGrouping,
  useCohortMembers,
  useCohorts,
  useCourseCompletions,
  useCourseConversation,
  useCourseDetail,
  useCourseEnrolInstances,
  useCourseEnrolments,
  useCourseGroupingGroups,
  useCourseGroupings,
  useCourseGroupMembers,
  useCourseGroups,
  useCreateCourseGroup,
  useCreateCourseGrouping,
  useDeleteCourseGroup,
  useDeleteCourseGrouping,
  useEnrolUserManually,
  useOpenGroupConversation,
  useRemoveCohortMember,
  useRemoveCourseGroupMember,
  useRenameCourseGroup,
  useSaveCourseGroupMode,
  useToggleCourseConversation,
  useToggleEnrolSuspend,
} from '#lib/course-admin-data';

/**
 * Quản trị khoá học: nhóm, cohort, ghi danh thủ công kèm tạm khoá/kích
 * hoạt lại và tiến độ hoàn thành của học viên. Khu XÂY DỰNG khoá học
 * (thông tin khoá, section, module, khung chương trình, tiêu chí hoàn
 * thành) đã tách sang trang Builder Outline riêng `/courses/:id/builder`
 * (K1 — chuẩn §9: mỗi mảng một màn riêng); trang này chỉ còn thẻ liên
 * kết sang builder cho người có quyền xây dựng khoá. Quyền suy từ
 * `usePermissions()`; API vẫn là nơi thực thi quyền thật.
 *
 * Luồng dữ liệu (F-01 của rà soát #133): mọi mảng của trang đọc qua
 * TanStack Query từ lib/course-admin-data — danh sách nền tải lỗi thì
 * rỗng như bản thủ công; thành viên của nhóm/cohort và nhóm của
 * grouping chỉ tải khi dòng được mở (component con gắn truy vấn theo
 * dòng) và lỗi tải báo đúng thông điệp của mảng đó; ghi thao tác đi
 * qua đột biến, làm mới đúng cụm khoá bị ảnh hưởng.
 */

// --- Các mảng lười tải theo dòng mở rộng ---------------------------------------

/** Mảng thành viên của một nhóm khoá đang mở: tải khi mở lần đầu, thêm/gỡ qua đột biến rồi danh sách tự làm mới. */
function GroupMembersSection({
  courseId,
  group,
  enrolments,
  canManageGroups,
  selection,
  onSelectionChange,
  onMessage,
}: {
  courseId: string;
  group: CourseGroup;
  enrolments: UserEnrolment[];
  canManageGroups: boolean;
  selection: string;
  onSelectionChange: (userId: string) => void;
  onMessage: (text: string) => void;
}) {
  const { t } = useTranslation('app');
  const membersQuery = useCourseGroupMembers(courseId, group.id);
  const addMember = useAddCourseGroupMember(courseId);
  const removeMember = useRemoveCourseGroupMember(courseId);

  useEffect(() => {
    if (membersQuery.isError) onMessage(t('groupMembersLoadFailed'));
  }, [membersQuery.isError, onMessage, t]);

  const members = membersQuery.data ?? [];
  const memberIds = new Set(members.map((m) => m.userId));
  const candidates = enrolments.filter(
    (e, idx, all) =>
      e.status === 0 && !memberIds.has(e.userId) && all.findIndex((x) => x.userId === e.userId) === idx,
  );

  /** Thêm một học sinh đã ghi danh vào nhóm; API chặn người chưa ghi danh hiệu lực (400 group.member_not_enrolled). */
  async function addGroupMember() {
    if (!selection) return;
    try {
      await addMember.mutateAsync({ groupId: group.id, userId: selection });
      onSelectionChange('');
      onMessage(t('groupMemberAdded'));
    } catch {
      onMessage(t('groupMemberAddFailed'));
    }
  }

  /** Gỡ thành viên khỏi nhóm (chỉ gỡ khỏi nhóm, ghi danh khoá giữ nguyên). */
  async function removeGroupMember(userId: string) {
    try {
      await removeMember.mutateAsync({ groupId: group.id, userId });
      onMessage(t('groupMemberRemoved'));
    } catch {
      onMessage(t('groupMemberRemoveFailed'));
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t('groupMembersTitle', { name: group.name })}</p>
      <ul className="space-y-1">
        {members.map((m) => (
          <li key={m.userId} className="flex items-center gap-2 text-sm">
            <span>{t('groupMemberLine', { userId: m.userId, time: m.timeAdded })}</span>
            {canManageGroups && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void removeGroupMember(m.userId)}
              >
                {t('groupRemoveMember')}
              </Button>
            )}
          </li>
        ))}
        {members.length === 0 && (
          <li className="text-sm text-muted-foreground">{t('groupNoMembers')}</li>
        )}
      </ul>
      {canManageGroups && candidates.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <span id={`group-add-${group.id}-label`} className="text-sm font-medium">
              {t('groupAddMemberLabel')}
            </span>
            <Select
              items={Object.fromEntries([
                ['none', '—'],
                ...candidates.map((e) => [e.userId, e.userId] as [string, string]),
              ])}
              value={selection === '' ? 'none' : selection}
              onValueChange={(v) => onSelectionChange(!v || v === 'none' ? '' : v)}
            >
              <SelectTrigger aria-labelledby={`group-add-${group.id}-label`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">—</SelectItem>
                {candidates.map((e) => (
                  <SelectItem key={e.userId} value={e.userId}>
                    {e.userId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void addGroupMember()}>
            {t('groupAddMember')}
          </Button>
        </div>
      )}
      {canManageGroups && candidates.length === 0 && members.length > 0 && (
        <p className="text-sm text-muted-foreground">{t('groupAllEnrolledInGroup')}</p>
      )}
    </div>
  );
}

/** Mảng các nhóm trong một grouping đang mở: tải khi mở lần đầu, gắn nhóm qua đột biến rồi danh sách tự làm mới. */
function GroupingGroupsSection({
  courseId,
  grouping,
  groups,
  selection,
  onSelectionChange,
  onMessage,
}: {
  courseId: string;
  grouping: CourseGrouping;
  groups: CourseGroup[];
  selection: string;
  onSelectionChange: (groupId: string) => void;
  onMessage: (text: string) => void;
}) {
  const { t } = useTranslation('app');
  const groupsQuery = useCourseGroupingGroups(courseId, grouping.id);
  const addGroup = useAddGroupToGrouping(courseId);

  useEffect(() => {
    if (groupsQuery.isError) onMessage(t('groupingGroupsLoadFailed'));
  }, [groupsQuery.isError, onMessage, t]);

  const inGrouping = groupsQuery.data ?? [];
  const candidates = groups.filter((gr) => !inGrouping.some((x) => x.id === gr.id));

  /** Gắn một nhóm vào grouping qua POST groupings/:groupingId/groups với `{ groupId }`. */
  async function addGroupToGrouping() {
    if (!selection) return;
    try {
      await addGroup.mutateAsync({ groupingId: grouping.id, groupId: selection });
      onMessage(t('groupingGroupAdded'));
    } catch {
      onMessage(t('groupingGroupAddFailed'));
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t('groupingGroupsTitle', { name: grouping.name })}</p>
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
            <span id={`grouping-add-${grouping.id}-label`} className="text-sm font-medium">
              {t('groupingAddGroupLabel')}
            </span>
            <Select
              items={Object.fromEntries([
                ['none', '—'],
                ...candidates.map((gr) => [gr.id, gr.name] as [string, string]),
              ])}
              value={selection === '' ? 'none' : selection}
              onValueChange={(v) => onSelectionChange(!v || v === 'none' ? '' : v)}
            >
              <SelectTrigger aria-labelledby={`grouping-add-${grouping.id}-label`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">—</SelectItem>
                {candidates.map((gr) => (
                  <SelectItem key={gr.id} value={gr.id}>
                    {gr.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void addGroupToGrouping()}>
            {t('groupingAddGroup')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Mảng thành viên của một cohort đang mở: tải khi mở lần đầu, thêm/gỡ qua đột biến rồi danh sách tự làm mới. */
function CohortMembersSection({
  cohort,
  canManageCohorts,
  input,
  onInputChange,
  onMessage,
}: {
  cohort: Cohort;
  canManageCohorts: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onMessage: (text: string) => void;
}) {
  const { t } = useTranslation('app');
  const membersQuery = useCohortMembers(cohort.id);
  const addMember = useAddCohortMember();
  const removeMember = useRemoveCohortMember();

  useEffect(() => {
    if (membersQuery.isError) onMessage(t('cohortMembersLoadFailed'));
  }, [membersQuery.isError, onMessage, t]);

  const members = membersQuery.data ?? [];

  /** Thêm thành viên vào cohort; backend kích hoạt đồng bộ ghi danh theo cohort. */
  async function addCohortMember() {
    const userId = input.trim();
    if (!userId) return;
    try {
      await addMember.mutateAsync({ cohortId: cohort.id, userId });
      onInputChange('');
      onMessage(t('cohortMemberAdded'));
    } catch {
      onMessage(t('cohortMemberAddFailed'));
    }
  }

  /** Gỡ thành viên khỏi cohort qua DELETE /cohorts/:id/members/:userId. */
  async function removeCohortMember(userId: string) {
    try {
      await removeMember.mutateAsync({ cohortId: cohort.id, userId });
      onMessage(t('cohortMemberRemoved'));
    } catch {
      onMessage(t('cohortMemberRemoveFailed'));
    }
  }

  return (
    <div className="space-y-2 rounded border p-3">
      <p className="text-sm font-medium">{t('cohortMembersTitle', { name: cohort.name })}</p>
      <ul className="space-y-1">
        {members.map((m) => (
          <li key={m.userId} className="flex items-center gap-2 text-sm">
            <span>{t('cohortMemberLine', { userId: m.userId, time: m.timeAdded })}</span>
            {canManageCohorts && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void removeCohortMember(m.userId)}
              >
                {t('cohortRemoveMember')}
              </Button>
            )}
          </li>
        ))}
        {members.length === 0 && (
          <li className="text-sm text-muted-foreground">{t('cohortNoMembers')}</li>
        )}
      </ul>
      {canManageCohorts && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`cohort-member-${cohort.id}`}>{t('cohortMemberUserId')}</Label>
            <Input
              id={`cohort-member-${cohort.id}`}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
            />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void addCohortMember()}>
            {t('cohortAddMember')}
          </Button>
        </div>
      )}
    </div>
  );
}

// --- Trang quản trị --------------------------------------------------------------

export function CourseAdminPage() {
  const { t } = useTranslation('app');
  const { id } = useParams();
  const navigate = useNavigate();
  const courseId = id ?? '';
  const perms = usePermissions();
  const [groupName, setGroupName] = useState('');
  const [enrolUserId, setEnrolUserId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [groupingDraft, setGroupingDraft] = useState({ name: '', idNumber: '', description: '' });
  const [expandedGroupingId, setExpandedGroupingId] = useState('');
  const [groupingAddSelection, setGroupingAddSelection] = useState<Record<string, string>>({});
  const [expandedCohortId, setExpandedCohortId] = useState('');
  const [cohortMemberInputs, setCohortMemberInputs] = useState<Record<string, string>>({});
  const [expandedGroupId, setExpandedGroupId] = useState('');
  const [groupMemberSelection, setGroupMemberSelection] = useState<Record<string, string>>({});
  const [renamingGroupId, setRenamingGroupId] = useState('');
  const [groupRenameDraft, setGroupRenameDraft] = useState('');
  /** Bản nháp chế độ nhóm của khoá (GN-3): khởi tạo một lần từ GET khoá, GV sửa rồi lưu qua PATCH khoá. */
  const [groupModeDraft, setGroupModeDraft] = useState<number | null>(null);
  const [groupModeForceDraft, setGroupModeForceDraft] = useState(false);
  const groupModeInitRef = useRef(false);

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

  const groupsQuery = useCourseGroups(courseId);
  const groupingsQuery = useCourseGroupings(courseId);
  const cohortsQuery = useCohorts();
  const instancesQuery = useCourseEnrolInstances(courseId);
  const enrolmentsQuery = useCourseEnrolments(courseId);
  const completionsQuery = useCourseCompletions(courseId);
  const chatQuery = useCourseConversation(courseId);
  const courseQuery = useCourseDetail(courseId);

  const groups = groupsQuery.data ?? [];
  const groupings = groupingsQuery.data ?? [];
  const cohorts = cohortsQuery.data ?? [];
  const instances = instancesQuery.data ?? [];
  const enrolments = enrolmentsQuery.data ?? [];
  const completions = completionsQuery.data ?? [];
  /** Trạng thái chat toàn lớp (conversation cấp khoá): null = chưa nạp được/không thuộc khoá. */
  const courseChat = chatQuery.data ?? null;
  const loading = [
    groupsQuery, groupingsQuery, cohortsQuery, instancesQuery,
    enrolmentsQuery, completionsQuery, chatQuery, courseQuery,
  ].some((q) => q.isPending);

  // Khởi tạo bản nháp chế độ nhóm đúng một lần từ chi tiết khoá —
  // không ghi đè lựa chọn đang sửa dở khi truy vấn chạy lại.
  useEffect(() => {
    const course = courseQuery.data;
    if (course && !groupModeInitRef.current) {
      groupModeInitRef.current = true;
      setGroupModeDraft(course.groupMode);
      setGroupModeForceDraft(course.groupModeForce);
    }
  }, [courseQuery.data]);

  const createGroupMutation = useCreateCourseGroup(courseId);
  const renameGroupMutation = useRenameCourseGroup(courseId);
  const deleteGroupMutation = useDeleteCourseGroup(courseId);
  const saveGroupModeMutation = useSaveCourseGroupMode(courseId);
  const toggleChatMutation = useToggleCourseConversation(courseId);
  const openGroupChatMutation = useOpenGroupConversation();
  const createGroupingMutation = useCreateCourseGrouping(courseId);
  const deleteGroupingMutation = useDeleteCourseGrouping(courseId);
  const enrolMutation = useEnrolUserManually(courseId);
  const suspendMutation = useToggleEnrolSuspend(courseId);

  const manualInstance = instances.find((i) => i.enrol === 'manual');

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    try {
      await createGroupMutation.mutateAsync(groupName);
      setGroupName('');
      setMessage(t('groupCreated'));
    } catch {
      setMessage(t('groupCreateFailed'));
    }
  }

  /** Mở/thu danh sách thành viên của một nhóm khoá: mảng con tự tải khi được gắn. */
  function toggleGroupMembers(groupId: string) {
    setExpandedGroupId((prev) => (prev === groupId ? '' : groupId));
  }

  /** Đổi tên nhóm ngay tại dòng qua đột biến PATCH groups/:groupId (chỉ gửi `name`). */
  async function renameGroup(groupId: string) {
    const name = groupRenameDraft.trim();
    if (!name) return;
    try {
      await renameGroupMutation.mutateAsync({ groupId, name });
      setRenamingGroupId('');
      setGroupRenameDraft('');
      setMessage(t('groupRenamed'));
    } catch {
      setMessage(t('groupRenameFailed'));
    }
  }

  /** Xoá nhóm qua đột biến DELETE groups/:groupId — hỏi xác nhận trước; thành viên bị gỡ khỏi nhóm nhưng ghi danh khoá không đổi. */
  async function deleteGroup(group: CourseGroup) {
    if (!window.confirm(t('confirmDeleteGroup', { name: group.name }))) return;
    try {
      await deleteGroupMutation.mutateAsync(group.id);
      if (expandedGroupId === group.id) setExpandedGroupId('');
      setMessage(t('groupDeleted'));
    } catch {
      setMessage(t('groupDeleteFailed'));
    }
  }

  /** Lưu chế độ nhóm của khoá qua đột biến PATCH /courses/:id (`groupMode` + `groupModeForce` — hai trường API khoá đã nhận). */
  async function saveGroupMode(event: FormEvent) {
    event.preventDefault();
    if (groupModeDraft === null) return;
    try {
      await saveGroupModeMutation.mutateAsync({ groupMode: groupModeDraft, groupModeForce: groupModeForceDraft });
      setMessage(t('groupModeSaved'));
    } catch {
      setMessage(t('groupModeSaveFailed'));
    }
  }

  /** Bật/tắt chat toàn lớp qua đột biến PATCH /messages/conversations/:id (cờ `enabled` sẵn có; chỉ staff khoá đổi được — API thực thi). */
  async function toggleCourseChat() {
    if (!courseChat) return;
    try {
      await toggleChatMutation.mutateAsync({ conversationId: courseChat.id, enabled: !courseChat.enabled });
      setMessage(t('courseChatUpdated'));
    } catch {
      setMessage(t('courseChatUpdateFailed'));
    }
  }

  /** Mở chat của một course group: tạo hội thoại nhóm (đường sẵn có) rồi deep-link trang Tin nhắn. */
  async function openGroupChat(groupId: string) {
    try {
      const conv = await openGroupChatMutation.mutateAsync(groupId);
      navigate(`/messages?conversation=${conv.id}`);
    } catch {
      setMessage(t('groupChatOpenFailed'));
    }
  }

  /** Tạo grouping qua đột biến POST /courses/:id/groupings (`createGroupingSchema`: name bắt buộc, idNumber/description tuỳ chọn). */
  async function createGrouping(event: FormEvent) {
    event.preventDefault();
    try {
      await createGroupingMutation.mutateAsync({
        name: groupingDraft.name,
        ...(groupingDraft.idNumber.trim() ? { idNumber: groupingDraft.idNumber.trim() } : {}),
        ...(groupingDraft.description.trim() ? { description: groupingDraft.description.trim() } : {}),
      });
      setGroupingDraft({ name: '', idNumber: '', description: '' });
      setMessage(t('groupingCreated'));
    } catch {
      setMessage(t('groupingCreateFailed'));
    }
  }

  /** Xoá grouping qua đột biến DELETE /courses/:id/groupings/:groupingId — hỏi xác nhận trước; các nhóm trong khoá không bị xoá theo. */
  async function deleteGrouping(grouping: CourseGrouping) {
    if (!window.confirm(t('confirmDeleteGrouping', { name: grouping.name }))) return;
    try {
      await deleteGroupingMutation.mutateAsync(grouping.id);
      if (expandedGroupingId === grouping.id) setExpandedGroupingId('');
      setMessage(t('groupingDeleted'));
    } catch {
      setMessage(t('groupingDeleteFailed'));
    }
  }

  /** Mở/thu danh sách nhóm của một grouping: mảng con tự tải khi được gắn. */
  function toggleGroupingGroups(groupingId: string) {
    setExpandedGroupingId((prev) => (prev === groupingId ? '' : groupingId));
  }

  /** Mở/thu danh sách thành viên của một cohort: mảng con tự tải khi được gắn. */
  function toggleCohortMembers(cohortId: string) {
    setExpandedCohortId((prev) => (prev === cohortId ? '' : cohortId));
  }

  async function ensureManualAndEnrol(event: FormEvent) {
    event.preventDefault();
    try {
      await enrolMutation.mutateAsync({ manualInstanceId: manualInstance?.id ?? null, userId: enrolUserId });
      setMessage(t('userEnrolled'));
    } catch {
      setMessage(t('userEnrolFailed'));
    }
  }

  async function toggleSuspend(ue: UserEnrolment) {
    try {
      await suspendMutation.mutateAsync(ue);
    } catch {
      setMessage(t('enrolStatusChangeFailed'));
    }
  }

  return (
    <PageShell width="full">
      <PageHeader title={t('courseAdminHeading')} />
      {loading ? (
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : null}
      {!loading && (<>
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
          <CardTitle>{t('courseChatSettings')}</CardTitle>
          <CardDescription>{t('courseChatSettingsDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {courseChat ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm">{courseChat.enabled ? t('courseChatStateOn') : t('courseChatStateOff')}</span>
              <Button type="button" variant="outline" size="sm" disabled={toggleChatMutation.isPending} onClick={() => void toggleCourseChat()}>
                {courseChat.enabled ? t('courseChatDisable') : t('courseChatEnable')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => navigate(`/messages?conversation=${courseChat.id}`)}
              >
                {t('courseChatOpen')}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('courseChatLoadFailed')}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('groups')}</CardTitle>
          <CardDescription>{t('groupsInCourse')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {groups.map((g) => {
              return (
                <li key={g.id} data-testid={`group-${g.id}`} className="space-y-2 rounded border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {renamingGroupId === g.id ? (
                      <>
                        <Input
                          aria-label={t('groupRenameLabel', { name: g.name })}
                          value={groupRenameDraft}
                          onChange={(e) => setGroupRenameDraft(e.target.value)}
                          className="w-48"
                        />
                        <Button type="button" size="sm" onClick={() => void renameGroup(g.id)}>
                          {t('groupRenameSave')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setRenamingGroupId('');
                            setGroupRenameDraft('');
                          }}
                        >
                          {t('groupRenameCancel')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="font-medium">{g.name}</span>
                        <Button type="button" variant="outline" size="sm" onClick={() => toggleGroupMembers(g.id)}>
                          {t('groupViewMembers')}
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => void openGroupChat(g.id)}>
                          {t('groupChatOpen')}
                        </Button>
                        {canManageGroups && (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setRenamingGroupId(g.id);
                                setGroupRenameDraft(g.name);
                              }}
                            >
                              {t('groupRename')}
                            </Button>
                            <Button type="button" variant="destructive" size="sm" onClick={() => void deleteGroup(g)}>
                              {t('deleteGroup')}
                            </Button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                  {expandedGroupId === g.id && (
                    <GroupMembersSection
                      courseId={courseId}
                      group={g}
                      enrolments={enrolments}
                      canManageGroups={canManageGroups}
                      selection={groupMemberSelection[g.id] ?? ''}
                      onSelectionChange={(userId) =>
                        setGroupMemberSelection((prev) => ({ ...prev, [g.id]: userId }))
                      }
                      onMessage={setMessage}
                    />
                  )}
                </li>
              );
            })}
            {groups.length === 0 && <li className="text-sm">{t('noGroups')}</li>}
          </ul>
          {canManageGroups && (
            <form onSubmit={createGroup} className="mt-3 space-y-2">
              <Label htmlFor="group-name">{t('newGroupName')}</Label>
              <Input id="group-name" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
              <Button type="submit">{t('createGroup')}</Button>
            </form>
          )}
        </CardContent>
      </Card>

      {canBuild && (
        <Card>
          <CardHeader>
            <CardTitle>{t('groupModeSettings')}</CardTitle>
            <CardDescription>{t('groupModeDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            {groupModeDraft === null ? (
              <p className="text-sm text-muted-foreground">{t('groupModeLoadFailed')}</p>
            ) : (
              <form onSubmit={(e) => void saveGroupMode(e)} className="space-y-3">
                <div className="space-y-1">
                  <span id="group-mode-label" className="text-sm font-medium">
                    {t('groupModeLabel')}
                  </span>
                  <Select
                    items={Object.fromEntries([
                      ['0', t('groupModeNone')],
                      ['1', t('groupModeSeparate')],
                      ['2', t('groupModeVisible')],
                    ])}
                    value={String(groupModeDraft)}
                    onValueChange={(v) => v && setGroupModeDraft(Number(v))}
                  >
                    <SelectTrigger aria-labelledby="group-mode-label">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">{t('groupModeNone')}</SelectItem>
                      <SelectItem value="1">{t('groupModeSeparate')}</SelectItem>
                      <SelectItem value="2">{t('groupModeVisible')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <span className="flex items-center gap-2">
                  <Checkbox
                    id="group-mode-force"
                    checked={groupModeForceDraft}
                    onCheckedChange={(checked) => setGroupModeForceDraft(checked === true)}
                  />
                  <Label htmlFor="group-mode-force">{t('groupModeForceLabel')}</Label>
                </span>
                <Button type="submit">{t('groupModeSave')}</Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {canManageGroups && (
        <Card>
          <CardHeader>
            <CardTitle>{t('groupings')}</CardTitle>
            <CardDescription>{t('groupingsDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-3">
              {groupings.map((g) => {
                return (
                  <li key={g.id} data-testid={`grouping-${g.id}`} className="space-y-2 rounded border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{g.name}</span>
                      {g.idNumber ? <span className="text-sm text-muted-foreground">({g.idNumber})</span> : null}
                      <Button type="button" variant="outline" size="sm" onClick={() => toggleGroupingGroups(g.id)}>
                        {t('groupingViewGroups')}
                      </Button>
                      <Button type="button" variant="destructive" size="sm" onClick={() => void deleteGrouping(g)}>
                        {t('deleteGrouping')}
                      </Button>
                    </div>
                    {expandedGroupingId === g.id && (
                      <GroupingGroupsSection
                        courseId={courseId}
                        grouping={g}
                        groups={groups}
                        selection={groupingAddSelection[g.id] ?? ''}
                        onSelectionChange={(groupId) =>
                          setGroupingAddSelection((prev) => ({ ...prev, [g.id]: groupId }))
                        }
                        onMessage={setMessage}
                      />
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
                  <Button type="button" variant="outline" size="sm" onClick={() => toggleCohortMembers(c.id)}>
                    {t('cohortViewMembers')}
                  </Button>
                </div>
                {expandedCohortId === c.id && (
                  <CohortMembersSection
                    cohort={c}
                    canManageCohorts={canManageCohorts}
                    input={cohortMemberInputs[c.id] ?? ''}
                    onInputChange={(value) =>
                      setCohortMemberInputs((prev) => ({ ...prev, [c.id]: value }))
                    }
                    onMessage={setMessage}
                  />
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
      </>)}
    </PageShell>
  );
}

/**
 * clientLoader (F-01, rà soát #133): nạp trước tám nguồn nền của
 * trang quản trị khoá vào đúng các khoá trang dùng để vào trang
 * không phải chờ chuỗi tải phía client.
 */
export async function clientLoader({ params }: { params: Record<string, string | undefined> }) {
  if (params.id) await courseAdminPageClientLoader(params.id);
  return null;
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default CourseAdminPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Quản trị khoá học');
}
