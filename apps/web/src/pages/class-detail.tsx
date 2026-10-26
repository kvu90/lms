import { useRef, useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Badge } from '@lms/ui/components/badge';
import { Button, buttonVariants } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Skeleton } from '@lms/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@lms/ui/components/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import {
  addRosterMember,
  addRosterStudentByIdentity,
  CLASS_STAFF_ROLE_ORDER,
  decideJoinRequest,
  downloadRosterTemplate,
  fetchClass,
  fetchClassCourses,
  fetchClassStaff,
  fetchJoinRequests,
  fetchRoster,
  fetchSuspendedMembers,
  importRosterFile,
  personName,
  removeRosterMember,
  setClassStaffRoles,
  type ClassRosterImportReport,
  type ClassStaffRole,
} from '#lib/classes';
import { queryKeys } from '#lib/query-keys';

/**
 * Chi tiết lớp (CLASS-1, issue #184): khoá học trong lớp + roster là
 * nguồn sự thật của ghi danh. Các khối quản trị trên màn này:
 *  - thêm HS theo định danh (khớp tài khoản theo email/SĐT hoặc tạo mới
 *    kèm mật khẩu tạm hiện MỘT lần) và import Excel với báo cáo từng dòng;
 *  - đình chỉ/kích hoạt lại theo vòng đời CLASS-0 (gỡ khỏi roster ở chế
 *    độ suspend → hiện ở mục "Đã đình chỉ", thêm lại là kích hoạt lại);
 *  - hàng chờ duyệt tự báo danh (duyệt = nạp roster đầy đủ đường API);
 *  - phân quyền 3 vai tại context lớp cho đồng GV (khuôn Azota).
 * Quyền thật nằm ở API (capability tại context lớp); màn này chỉ dẫn
 * luồng và hiển thị kết quả API trả về.
 */
export function ClassDetailPage() {
  const { t } = useTranslation('app');
  const { id } = useParams<{ id: string }>();
  const classId = id ?? '';
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const classQuery = useQuery({ queryKey: queryKeys.classDetail(classId), queryFn: () => fetchClass(classId), enabled: Boolean(classId) });
  const coursesQuery = useQuery({ queryKey: queryKeys.classCourses(classId), queryFn: () => fetchClassCourses(classId), enabled: Boolean(classId) });
  const rosterQuery = useQuery({ queryKey: queryKeys.classRoster(classId), queryFn: () => fetchRoster(classId), enabled: Boolean(classId) });
  const suspendedQuery = useQuery({ queryKey: queryKeys.classSuspended(classId), queryFn: () => fetchSuspendedMembers(classId), enabled: Boolean(classId) });
  const staffQuery = useQuery({ queryKey: queryKeys.classStaff(classId), queryFn: () => fetchClassStaff(classId), enabled: Boolean(classId) });
  const requestsQuery = useQuery({ queryKey: queryKeys.classJoinRequests(classId), queryFn: () => fetchJoinRequests(classId), enabled: Boolean(classId) });

  const invalidateRoster = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.classRoster(classId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.classSuspended(classId) });
  };
  const invalidateStaff = () => void queryClient.invalidateQueries({ queryKey: queryKeys.classStaff(classId) });
  const invalidateRequests = () => void queryClient.invalidateQueries({ queryKey: queryKeys.classJoinRequests(classId) });

  // --- Thêm học sinh theo định danh ---
  const [studentName, setStudentName] = useState('');
  const [studentEmail, setStudentEmail] = useState('');
  const [studentPhone, setStudentPhone] = useState('');
  const addStudentMutation = useMutation({
    mutationFn: () =>
      addRosterStudentByIdentity(classId, {
        fullName: studentName.trim(),
        ...(studentEmail.trim() ? { email: studentEmail.trim() } : {}),
        ...(studentPhone.trim() ? { phone: studentPhone.trim() } : {}),
      }),
    onSuccess: (result) => {
      const name = result.fullName;
      if (result.outcome === 'created') setMessage(t('classStudentCreated', { name, password: result.temporaryPassword ?? '' }));
      else if (result.outcome === 'matched') setMessage(t('classStudentMatched', { name }));
      else setMessage(t('classStudentAlready', { name }));
      setStudentName('');
      setStudentEmail('');
      setStudentPhone('');
      invalidateRoster();
    },
    onError: () => setMessage(t('classAddStudentFailed')),
  });

  function onAddStudent(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    addStudentMutation.mutate();
  }

  // --- Import Excel ---
  const fileRef = useRef<HTMLInputElement>(null);
  const [importReport, setImportReport] = useState<ClassRosterImportReport | null>(null);
  const importMutation = useMutation({
    mutationFn: (file: File) => importRosterFile(classId, file),
    onSuccess: (report) => {
      setImportReport(report);
      setMessage(null);
      invalidateRoster();
    },
    onError: () => setMessage(t('classImportFailed')),
  });

  function onImport(event: FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setImportReport(null);
    setMessage(null);
    importMutation.mutate(file);
  }

  // --- Đình chỉ / kích hoạt lại ---
  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeRosterMember(classId, userId),
    onSuccess: () => {
      setMessage(t('classSuspendDone'));
      invalidateRoster();
    },
    onError: () => setMessage(t('classSuspendFailed')),
  });
  const reactivateMutation = useMutation({
    mutationFn: (userId: string) => addRosterMember(classId, userId),
    onSuccess: (_data, userId) => {
      const member = suspendedQuery.data?.find((m) => m.userId === userId);
      setMessage(t('classReactivated', { name: member ? personName(member) : userId }));
      invalidateRoster();
    },
    onError: () => setMessage(t('classReactivateFailed')),
  });

  function onRemove(userId: string, name: string) {
    const confirmText = classQuery.data?.onLeave === 'unenrol' ? t('classRemoveWithdrawConfirm', { name }) : t('classSuspendConfirm', { name });
    if (!window.confirm(confirmText)) return;
    setMessage(null);
    removeMutation.mutate(userId);
  }

  // --- Hàng chờ duyệt ---
  const decideMutation = useMutation({
    mutationFn: (input: { requestId: string; approve: boolean }) => decideJoinRequest(classId, input.requestId, input.approve),
    onSuccess: () => {
      setMessage(t('classRequestDone'));
      invalidateRequests();
      invalidateRoster();
    },
    onError: () => setMessage(t('classRequestFailed')),
  });

  // --- Phân quyền đồng GV ---
  const [staffEmail, setStaffEmail] = useState('');
  const [staffRoles, setStaffRoles] = useState<ClassStaffRole[]>([]);
  const staffMutation = useMutation({
    mutationFn: (input: { userId?: string; email?: string; roles: ClassStaffRole[] }) => setClassStaffRoles(classId, input),
    onSuccess: () => {
      setMessage(t('classStaffSaved'));
      setStaffEmail('');
      setStaffRoles([]);
      invalidateStaff();
    },
    onError: () => setMessage(t('classStaffFailed')),
  });

  function onAddStaff(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    staffMutation.mutate({ email: staffEmail.trim(), roles: staffRoles });
  }

  function toggleStaffRole(userId: string, current: ClassStaffRole[], role: ClassStaffRole, on: boolean) {
    const roles = on ? [...new Set([...current, role])] : current.filter((r) => r !== role);
    setMessage(null);
    staffMutation.mutate({ userId, roles });
  }

  const cls = classQuery.data;
  const roleLabel: Record<ClassStaffRole, string> = {
    classassigner: t('classStaffRoleAssign'),
    classgrader: t('classStaffRoleGrade'),
    classrostermanager: t('classStaffRoleRoster'),
  };

  return (
    <PageShell>
      <PageHeader
        title={cls ? cls.name : t('classesHeading')}
        description={cls?.description || undefined}
        actions={
          <Link className={buttonVariants({ variant: 'outline' })} to={`/classes/${classId}/edit`}>
            {t('classEdit')}
          </Link>
        }
      />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      {classQuery.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : classQuery.isError || !cls ? (
        <Alert variant="destructive">
          <AlertDescription>{t('classDetailLoadFailed')}</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {cls.code ? <Badge variant="secondary">{cls.code}</Badge> : null}
            {cls.schoolYear ? <Badge variant="outline">{cls.schoolYear}</Badge> : null}
            <Badge variant={cls.status === 'archived' ? 'destructive' : 'default'}>{cls.status === 'archived' ? t('classStatusArchived') : t('classStatusActive')}</Badge>
            {cls.allowSelfReport && cls.joinCode ? (
              <span className="text-sm text-muted-foreground">
                {t('classJoinCode')}: <strong>{cls.joinCode}</strong>
              </span>
            ) : null}
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>{t('classCoursesInClass')}</CardTitle>
              <Link className={buttonVariants({ size: 'sm' })} to={`/courses/new?classId=${classId}`}>
                {t('classCreateCourse')}
              </Link>
            </CardHeader>
            <CardContent>
              {coursesQuery.isPending ? (
                <Skeleton className="h-16 w-full" />
              ) : !coursesQuery.data || coursesQuery.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('classNoCourses')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {coursesQuery.data.map((course) => (
                    <li key={course.id} className="flex items-center justify-between gap-3 text-sm">
                      <span>{course.fullName}</span>
                      <Link className={buttonVariants({ size: 'sm', variant: 'outline' })} to={`/courses/${course.id}`}>
                        {t('classOpenCourse')}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {requestsQuery.data && requestsQuery.data.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('classPendingRequests')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('classRosterStudent')}</TableHead>
                      <TableHead>{t('classRosterUsername')}</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {requestsQuery.data.map((req) => (
                      <TableRow key={req.id}>
                        <TableCell>{personName(req)}</TableCell>
                        <TableCell>{req.username}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button type="button" size="sm" disabled={decideMutation.isPending} onClick={() => decideMutation.mutate({ requestId: req.id, approve: true })}>
                              {t('classApprove')}
                            </Button>
                            <Button type="button" size="sm" variant="outline" disabled={decideMutation.isPending} onClick={() => decideMutation.mutate({ requestId: req.id, approve: false })}>
                              {t('classReject')}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t('classRoster')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {rosterQuery.isPending ? (
                <Skeleton className="h-24 w-full" />
              ) : !rosterQuery.data || rosterQuery.data.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>{t('classRosterEmpty')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('classRosterStudent')}</TableHead>
                      <TableHead>{t('classRosterUsername')}</TableHead>
                      <TableHead>{t('classRosterEmail')}</TableHead>
                      <TableHead>{t('classRosterAddedAt')}</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rosterQuery.data.map((member) => (
                      <TableRow key={member.userId}>
                        <TableCell>{personName(member)}</TableCell>
                        <TableCell>{member.username}</TableCell>
                        <TableCell>{member.email}</TableCell>
                        <TableCell>{new Date(member.timeAdded).toLocaleDateString()}</TableCell>
                        <TableCell className="text-right">
                          <Button type="button" size="sm" variant="outline" disabled={removeMutation.isPending} onClick={() => onRemove(member.userId, personName(member))}>
                            {t('classSuspend')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              <form onSubmit={onAddStudent}>
                <FieldGroup>
                  <p className="text-sm font-medium">{t('classAddStudent')}</p>
                  <p className="text-sm text-muted-foreground">{t('classAddStudentHint')}</p>
                  <div className="grid gap-3 md:grid-cols-3">
                    <Field>
                      <FieldLabel htmlFor="student-name">{t('classAddStudentName')}</FieldLabel>
                      <Input id="student-name" value={studentName} onChange={(e) => setStudentName(e.target.value)} required />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="student-email">{t('classAddStudentEmail')}</FieldLabel>
                      <Input id="student-email" type="email" value={studentEmail} onChange={(e) => setStudentEmail(e.target.value)} />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="student-phone">{t('classAddStudentPhone')}</FieldLabel>
                      <Input id="student-phone" value={studentPhone} onChange={(e) => setStudentPhone(e.target.value)} />
                    </Field>
                  </div>
                  <div>
                    <Button type="submit" disabled={addStudentMutation.isPending || !studentName.trim()}>
                      {t('classAddStudentSubmit')}
                    </Button>
                  </div>
                </FieldGroup>
              </form>

              <form onSubmit={onImport}>
                <FieldGroup>
                  <p className="text-sm font-medium">{t('classImport')}</p>
                  <p className="text-sm text-muted-foreground">{t('classImportHint')}</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Input ref={fileRef} type="file" accept=".xlsx" aria-label={t('classImportFile')} className="max-w-sm" />
                    <Button type="button" variant="outline" onClick={() => void downloadRosterTemplate().catch(() => setMessage(t('classImportFailed')))}>
                      {t('classImportTemplate')}
                    </Button>
                    <Button type="submit" disabled={importMutation.isPending}>
                      {t('classImportSubmit')}
                    </Button>
                  </div>
                  {importReport ? (
                    <div className="flex flex-col gap-1 text-sm">
                      <p>
                        {t('classImportReport', {
                          total: importReport.total,
                          added: importReport.added,
                          created: importReport.created,
                          already: importReport.alreadyMembers,
                          failed: importReport.failed,
                        })}
                      </p>
                      {importReport.results.map((row) =>
                        row.status === 'error' ? (
                          <p key={row.row} className="text-destructive">
                            {t('classImportRowError', { row: row.row, name: row.fullName, error: row.error ?? '' })}
                          </p>
                        ) : row.temporaryPassword ? (
                          <p key={row.row}>
                            {t('classImportCreatedRow', { row: row.row, username: row.username ?? '', password: row.temporaryPassword })}
                          </p>
                        ) : null,
                      )}
                    </div>
                  ) : null}
                </FieldGroup>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('classSuspendedList')}</CardTitle>
            </CardHeader>
            <CardContent>
              {suspendedQuery.isPending ? (
                <Skeleton className="h-16 w-full" />
              ) : !suspendedQuery.data || suspendedQuery.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('classSuspendedEmpty')}</p>
              ) : (
                <Table>
                  <TableBody>
                    {suspendedQuery.data.map((member) => (
                      <TableRow key={member.userId}>
                        <TableCell>{personName(member)}</TableCell>
                        <TableCell>{member.username}</TableCell>
                        <TableCell>{member.email}</TableCell>
                        <TableCell className="text-right">
                          <Button type="button" size="sm" disabled={reactivateMutation.isPending} onClick={() => reactivateMutation.mutate(member.userId)}>
                            {t('classReactivate')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('classStaff')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">{t('classStaffHint')}</p>
              {staffQuery.isPending ? (
                <Skeleton className="h-24 w-full" />
              ) : staffQuery.isError || !staffQuery.data ? (
                <p className="text-sm text-muted-foreground">{t('classNotOwnerNote')}</p>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('classRosterStudent')}</TableHead>
                        {CLASS_STAFF_ROLE_ORDER.map((role) => (
                          <TableHead key={role}>{roleLabel[role]}</TableHead>
                        ))}
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {staffQuery.data.staff.map((member) => (
                        <TableRow key={member.userId}>
                          <TableCell>
                            {personName(member)} {member.isOwner ? <Badge variant="secondary">{t('classStaffOwner')}</Badge> : null}
                          </TableCell>
                          {CLASS_STAFF_ROLE_ORDER.map((role) => (
                            <TableCell key={role}>
                              <Checkbox
                                checked={member.isOwner || member.roles.includes(role)}
                                disabled={member.isOwner || !staffQuery.data.canShare || staffMutation.isPending}
                                aria-label={roleLabel[role]}
                                onCheckedChange={(v) => toggleStaffRole(member.userId, member.roles, role, v === true)}
                              />
                            </TableCell>
                          ))}
                          <TableCell className="text-right">
                            {!member.isOwner && staffQuery.data.canShare ? (
                              <Button type="button" size="sm" variant="outline" disabled={staffMutation.isPending} onClick={() => staffMutation.mutate({ userId: member.userId, roles: [] })}>
                                {t('classStaffRemove')}
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {staffQuery.data.canShare ? (
                    <form onSubmit={onAddStaff}>
                      <FieldGroup>
                        <p className="text-sm font-medium">{t('classStaffAdd')}</p>
                        <div className="flex flex-wrap items-end gap-3">
                          <Field className="min-w-64 flex-1">
                            <FieldLabel htmlFor="staff-email">{t('classStaffEmail')}</FieldLabel>
                            <Input id="staff-email" type="email" value={staffEmail} onChange={(e) => setStaffEmail(e.target.value)} required />
                          </Field>
                          {CLASS_STAFF_ROLE_ORDER.map((role) => (
                            <label key={role} className="flex items-center gap-2 pb-2 text-sm">
                              <Checkbox
                                checked={staffRoles.includes(role)}
                                onCheckedChange={(v) => setStaffRoles((prev) => (v === true ? [...prev, role] : prev.filter((r) => r !== role)))}
                              />
                              {roleLabel[role]}
                            </label>
                          ))}
                          <Button type="submit" disabled={staffMutation.isPending || !staffEmail.trim()}>
                            {t('classStaffAddSubmit')}
                          </Button>
                        </div>
                      </FieldGroup>
                    </form>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </PageShell>
  );
}

export default ClassDetailPage;
