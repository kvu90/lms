import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { CourseCategoryTreeNode, DashboardOverviewView, Role, UserListResponse } from '@lms/contracts';
import '../i18n';
import { ApiError, apiJson } from '#lib/api';
import { useAuth } from '#lib/auth';
import { usePermissions, type CourseAccess } from '#lib/permissions';
import { useCoursesGradeData } from '#lib/course-grade-data';
import { upcomingDaysRangeIso } from '#lib/calendar';
import { queryKeys } from '#lib/query-keys';
import { displayCourseName, useCourseCardPrefs } from '#lib/course-cards';
import { DashboardSkeleton } from '#components/dashboard-skeleton';
import { SectionCards, type StatCard } from '#components/section-cards';
import { Skeleton } from '@lms/ui/components/skeleton';
import { ChartAreaInteractive, type ChartPoint } from '#components/chart-area-interactive';
import { DataTable, type DataColumn } from '#components/data-table';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { PageShell } from '../components/page-shell';

/** Hình dạng sự kiện lịch mà trang này cần (khớp EventView của trang lịch). */
interface CalendarEventView {
  id: string;
  name: string;
  timeStart: string;
}



/** Lỗi có phải 403 hay không — để hiện thông báo thân thiện thay vì lỗi thô. */
function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.problem.status === 403;
}

/** Nhãn ngày dd/MM theo ngôn ngữ giao diện hiện tại. */
function dayLabel(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' }).format(date);
}

/** Tiêu đề một khối vai trò trên trang tổng quan. */
function SectionHeading({ title }: { title: string }) {
  return (
    <h2 className="px-4 text-lg font-semibold lg:px-6" data-testid="dashboard-section-title">
      {title}
    </h2>
  );
}

/**
 * Khối tổng hợp DASH1 dùng chung cho cả hai vai: đúng MỘT query
 * `GET /dashboard/overview` (TanStack dedupe theo queryKey nên khối GV và
 * khối HS trên cùng trang chỉ phát một request). Endpoint đồng thời cập
 * nhật mốc xem trước phía server khi tính xong danh sách "mới".
 */
function useDashboardOverview() {
  return useQuery({
    queryKey: queryKeys.dashboardOverview,
    queryFn: () => apiJson<DashboardOverviewView>('/api/v1/dashboard/overview?days=7'),
  });
}

/** Nhãn ngày giờ ngắn theo ngôn ngữ giao diện. */
function dateTimeLabel(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * Khối "Việc cần làm" của học sinh (DASH1): hoạt động sắp đến hạn trong 7
 * ngày (quá hạn tách lên đầu, có badge trạng thái) và điểm/phản hồi mới đã
 * công bố kể từ lần xem trước. Dữ liệu đã qua cổng công bố PH-0 phía
 * server — khối này không bao giờ thấy điểm chưa công bố.
 */
function StudentTodoBlock() {
  const { t, i18n } = useTranslation('dashboard');
  const overview = useDashboardOverview();
  const data = overview.data;
  if (overview.isPending) {
    return (
      <div className="px-4 lg:px-6" data-testid="dashboard-todo">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (!data) return null;
  const statusLabel = (status: string) =>
    status === 'overdue' ? t('todoOverdue') : status === 'in_progress' ? t('todoInProgress') : t('todoNotStarted');
  return (
    <Card data-testid="dashboard-todo">
      <CardHeader>
        <CardTitle>{t('todoTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <h3 className="mb-2 text-sm font-medium">{t('todoDueTitle')}</h3>
          {data.dueItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('todoEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.dueItems.map((item) => (
                <li
                  key={`${item.kind}-${item.cmId}`}
                  className="flex flex-wrap items-center gap-2 text-sm"
                  data-testid="todo-due-item"
                >
                  <Badge variant={item.status === 'overdue' ? 'destructive' : 'secondary'}>
                    {statusLabel(item.status)}
                  </Badge>
                  <Link
                    to={
                      item.kind === 'quiz'
                        ? `/courses/${item.courseId}/exams/${item.activityId}`
                        : `/courses/${item.courseId}/assignments/${item.activityId}`
                    }
                    className="font-medium hover:underline"
                  >
                    {item.name}
                  </Link>
                  <span className="text-muted-foreground">
                    {item.kind === 'quiz' ? t('todoKindQuiz') : t('todoKindAssignment')} · {item.courseName} ·{' '}
                    {t('todoDueAt', { date: dateTimeLabel(item.dueAt, i18n.language) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {data.newResults.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium">{t('todoNewResultsTitle')}</h3>
            <ul className="flex flex-col gap-2">
              {data.newResults.map((result, idx) => (
                <li key={`${result.kind}-${result.itemId ?? result.courseId}-${idx}`} className="text-sm" data-testid="todo-new-result">
                  <Link
                    to={`/courses/${result.courseId}/grades`}
                    className="font-medium hover:underline"
                  >
                    {`${result.itemName ?? ''} — ${t('newResultGrade', { grade: result.finalGrade ?? '—', max: result.gradeMax ?? '—' })}`}
                  </Link>
                  <span className="text-muted-foreground"> · {result.courseName}</span>
                  {result.feedback && <span className="block text-muted-foreground">{result.feedback}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Khối "Hàng đợi chấm" của giáo viên (DASH1): số bài chờ chấm gộp theo
 * khoá (bài nộp C2 chưa trả bài + lượt quiz chờ chấm tay + phiếu giấy
 * CAM-0 chờ xử lý) và bài chờ lâu nhất; bấm vào tới sổ điểm của khoá để
 * xử lý hàng đợi, riêng phần phiếu giấy là deep-link thẳng tới bề mặt rà
 * soát CAM-0 của quiz có phiếu chờ lâu nhất (issue #187).
 */
function TeacherGradingBlock() {
  const { t, i18n } = useTranslation('dashboard');
  const overview = useDashboardOverview();
  const prefs = useCourseCardPrefs();
  const data = overview.data;
  if (overview.isPending) {
    return (
      <div className="px-4 lg:px-6" data-testid="dashboard-grading-queue">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (!data) return null;
  return (
    <Card data-testid="dashboard-grading-queue">
      <CardHeader>
        <CardTitle>{t('gradingQueueTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.gradingQueue.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('gradingQueueEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.gradingQueue.map((row) => (
              <li key={row.courseId} className="flex flex-wrap items-center gap-2 text-sm" data-testid="grading-queue-row">
                <Link to={`/courses/${row.courseId}/grades`} className="font-medium hover:underline">
                  {displayCourseName(prefs.data?.get(row.courseId), row.courseName)}
                </Link>
                <Badge>{t('gradingPending', { count: row.pendingCount })}</Badge>
                <span className="text-muted-foreground">
                  {row.assignmentPending > 0 ? t('gradingAssignmentPart', { count: row.assignmentPending }) : null}
                  {row.assignmentPending > 0 && row.quizPending > 0 ? ' · ' : null}
                  {row.quizPending > 0 ? t('gradingQuizPart', { count: row.quizPending }) : null}
                  {(row.assignmentPending > 0 || row.quizPending > 0) && row.paperPending > 0 ? ' · ' : null}
                  {row.paperPending > 0 && row.paperPinId ? (
                    <Link
                      to={`/courses/${row.courseId}/exams/${row.paperPinId}/paper`}
                      className="font-medium text-foreground hover:underline"
                      data-testid="grading-paper-link"
                    >
                      {t('gradingPaperPart', { count: row.paperPending })}
                    </Link>
                  ) : null}
                  {row.oldestPendingAt
                    ? ` · ${t('gradingOldest', { date: dateTimeLabel(row.oldestPendingAt, i18n.language) })}`
                    : ''}
                </span>
                <Button size="sm" variant="outline" render={<Link to={`/courses/${row.courseId}/grades`} />}>
                  {t('viewGradingQueue')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Thông báo khi một khối không tải được (kể cả 403 do quyền vừa thay đổi). */
function BlockNotice() {
  const { t } = useTranslation('dashboard');
  return <p className="px-4 text-sm text-muted-foreground lg:px-6">{t('blockForbidden')}</p>;
}

/**
 * Khối quản trị hệ thống: chỉ render khi PermissionsProvider đã xác nhận
 * người dùng có capability quản trị, và chỉ gọi các endpoint quản trị
 * (danh sách người dùng, cây danh mục, danh sách vai trò). Số liệu lấy từ
 * chính các response đó — tổng người dùng từ trường `total` của API, biểu
 * đồ gom tài khoản theo tuần tạo từ `createdAt`.
 */
function AdminSection() {
  const { t, i18n } = useTranslation(['dashboard', 'app']);
  const perms = usePermissions();
  // Ba nguồn dữ liệu của khối là ba query độc lập: TanStack Query cho
  // chúng chạy SONG SONG (trước đây nạp tuần tự trong một effect), và
  // từng thẻ/bảng tự lấp khi nguồn của nó về thay vì chờ cả khối.
  const usersQuery = useQuery({
    queryKey: queryKeys.adminUsers(1, 100),
    queryFn: () => apiJson<UserListResponse>('/api/v1/users?page=1&pageSize=100'),
  });
  const treeQuery = useQuery({
    queryKey: queryKeys.categoryTree,
    queryFn: () => apiJson<CourseCategoryTreeNode[]>('/api/v1/courses/categories/tree'),
  });
  const rolesQuery = useQuery({
    queryKey: queryKeys.roles,
    queryFn: () => apiJson<Role[]>('/api/v1/access/roles'),
  });

  const users = usersQuery.data ?? null;
  const categoryCount = useMemo(() => {
    if (!treeQuery.data) return null;
    let total = 0;
    const walk = (nodes: CourseCategoryTreeNode[]) => {
      for (const node of nodes) {
        total += 1;
        walk(node.children);
      }
    };
    walk(treeQuery.data);
    return { total, topLevel: treeQuery.data.length };
  }, [treeQuery.data]);
  const roles = rolesQuery.data ?? null;
  const failed = usersQuery.isError && isForbidden(usersQuery.error);

  // Lưới thẻ LUÔN đủ 4 ô: ô nào chưa có dữ liệu thì ở trạng thái loading
  // (giữ ô) hoặc hiện "—" khi nguồn lỗi, thay vì mọc thêm từng thẻ.
  const active = users ? users.users.filter((u) => !u.suspended && !u.deleted).length : 0;
  const cards: StatCard[] = [
    {
      id: 'admin-users',
      label: t('dashboard:statTotalUsers'),
      value: users ? String(users.total) : '—',
      footer:
        users && users.users.length >= users.total ? t('dashboard:statUsersFooter', { count: active }) : undefined,
      loading: usersQuery.isPending,
    },
    {
      id: 'admin-courses',
      label: t('dashboard:statTotalCourses'),
      value: String(perms.courses.length),
      footer: t('dashboard:statCoursesFooter', {
        count: perms.courses.filter((c) => c.course.visible).length,
      }),
    },
    {
      id: 'admin-categories',
      label: t('dashboard:statTotalCategories'),
      value: categoryCount ? String(categoryCount.total) : '—',
      footer: categoryCount ? t('dashboard:statCategoriesFooter', { count: categoryCount.topLevel }) : undefined,
      loading: treeQuery.isPending,
    },
    {
      id: 'admin-roles',
      label: t('dashboard:statTotalRoles'),
      value: roles ? String(roles.length) : '—',
      footer: roles
        ? t('dashboard:statRolesFooter', {
            count: roles.filter((r) => r.archetype !== null).length,
          })
        : undefined,
      loading: rolesQuery.isPending,
    },
  ];

  const chartData: ChartPoint[] = useMemo(() => {
    if (!users) return [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return Array.from({ length: 8 }, (_, i) => {
      const start = new Date(now.getTime() - (7 - i) * 7 * 86_400_000);
      const end = new Date(start.getTime() + 7 * 86_400_000);
      const value = users.users.filter((u) => {
        const created = new Date(u.createdAt);
        return created >= start && created < end;
      }).length;
      return { label: dayLabel(start, i18n.language), value };
    });
  }, [users, i18n.language]);

  const columns: DataColumn<UserListResponse['users'][number]>[] = [
    { id: 'username', header: t('app:username'), cell: (u) => u.username, sortValue: (u) => u.username },
    {
      id: 'fullName',
      header: t('dashboard:colFullName'),
      cell: (u) => `${u.firstName} ${u.lastName}`.trim(),
      sortValue: (u) => `${u.firstName} ${u.lastName}`,
    },
    { id: 'email', header: t('app:email'), cell: (u) => u.email ?? '—', sortValue: (u) => u.email ?? '' },
    {
      id: 'status',
      header: t('app:status'),
      cell: (u) =>
        u.deleted ? (
          <Badge variant="destructive">{t('app:deletedSuffix')}</Badge>
        ) : u.suspended ? (
          <Badge variant="secondary">{t('dashboard:statusSuspended')}</Badge>
        ) : (
          <Badge variant="outline">{t('dashboard:statusActive')}</Badge>
        ),
    },
  ];

  if (failed) return <BlockNotice />;
  return (
    <section className="flex flex-col gap-4 md:gap-6" data-testid="dashboard-admin">
      <SectionHeading title={t('dashboard:adminSection')} />
      <SectionCards cards={cards} />
      {usersQuery.isPending ? (
        <Skeleton className="mx-4 h-97 lg:mx-6" />
      ) : (
        <ChartAreaInteractive
          title={t('dashboard:chartAdminTitle')}
          description={t('dashboard:chartAdminDescription')}
          seriesLabel={t('dashboard:chartAdminSeries')}
          emptyText={t('dashboard:chartNoData')}
          data={chartData}
        />
      )}
      {usersQuery.isPending ? (
        <Skeleton className="mx-4 h-75 lg:mx-6" />
      ) : users ? (
        <DataTable
          title={t('dashboard:tableUsersTitle')}
          data={users.users}
          columns={columns}
          getRowId={(u) => u.id}
          labels={{
            columns: t('dashboard:tableColumns'),
            previous: t('dashboard:tablePrevious'),
            next: t('dashboard:tableNext'),
            empty: t('dashboard:emptyTable'),
            filterPlaceholder: t('dashboard:tableFilterPlaceholder'),
            pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Khối giảng dạy: phân loại khoá dạy lấy từ PermissionsProvider, còn
 * lưới điểm theo bài toàn lớp tải lười tại khối này qua
 * `useCoursesGradeData` (F-02, rà soát #133 — provider không còn dò
 * dữ liệu điểm khi nạp app). Thẻ "chưa có điểm" là hàng đợi chấm thật
 * — học viên chưa có điểm ở bất kỳ bài nào. Biểu đồ phân bố điểm tính
 * theo từng ô của lưới, chuẩn hoá theo điểm tối đa của bài đó.
 */
function TeacherSection() {
  const { t } = useTranslation('dashboard');
  const perms = usePermissions();
  const prefs = useCourseCardPrefs();
  const teaching = perms.teaching;
  const gradeData = useCoursesGradeData(teaching.map((c) => c.course.id));
  const reportOf = (c: CourseAccess) => gradeData.get(c.course.id)?.report ?? null;

  const rows = teaching.flatMap((c) => reportOf(c)?.rows ?? []);
  const graded = rows.filter((r) => Object.values(r.grades).some((g) => g !== null)).length;
  const cards: StatCard[] = [
    {
      id: 'teacher-courses',
      label: t('statTeachingCourses'),
      value: String(teaching.length),
      footer: t('statTeachingFooter'),
    },
    {
      id: 'teacher-students',
      label: t('statMyStudents'),
      value: String(rows.length),
      footer: t('statMyStudentsFooter', { count: graded }),
    },
    {
      id: 'teacher-ungraded',
      label: t('statUngraded'),
      value: String(rows.length - graded),
      footer: t('statUngradedFooter'),
    },
  ];

  const chartData: ChartPoint[] = useMemo(() => {
    const buckets = [
      { label: '0–49%', min: 0, max: 50 },
      { label: '50–64%', min: 50, max: 65 },
      { label: '65–79%', min: 65, max: 80 },
      { label: '80–89%', min: 80, max: 90 },
      { label: '90–100%', min: 90, max: 101 },
    ];
    const counts = buckets.map(() => 0);
    for (const access of teaching) {
      const report = reportOf(access);
      const maxByItem = new Map((report?.items ?? []).map((i) => [i.id, i.gradeMax]));
      for (const row of report?.rows ?? []) {
        for (const [itemId, grade] of Object.entries(row.grades)) {
          if (grade === null) continue;
          const max = maxByItem.get(itemId);
          if (!max || max <= 0) continue;
          const pct = (grade / max) * 100;
          const idx = buckets.findIndex((b) => pct >= b.min && pct < b.max);
          if (idx >= 0) counts[idx] = (counts[idx] ?? 0) + 1;
        }
      }
    }
    return buckets.map((b, i) => ({ label: b.label, value: counts[i]! }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teaching, gradeData]);

  const columns: DataColumn<CourseAccess>[] = [
    {
      id: 'course',
      header: t('colCourse'),
      cell: (c) => <Link to={`/courses/${c.course.id}`}>{displayCourseName(prefs.data?.get(c.course.id), c.course.fullName)}</Link>,
      sortValue: (c) => c.course.fullName,
    },
    {
      id: 'students',
      header: t('colStudents'),
      cell: (c) => String(reportOf(c)?.rows.length ?? 0),
      sortValue: (c) => reportOf(c)?.rows.length ?? 0,
    },
    {
      id: 'ungraded',
      header: t('colUngraded'),
      cell: (c) => String((reportOf(c)?.rows ?? []).filter((r) => !Object.values(r.grades).some((g) => g !== null)).length),
      sortValue: (c) => (reportOf(c)?.rows ?? []).filter((r) => !Object.values(r.grades).some((g) => g !== null)).length,
    },
    {
      id: 'actions',
      header: t('colActions'),
      cell: (c) => (
        <span className="flex gap-2">
          <Button size="sm" variant="outline" render={<Link to={`/courses/${c.course.id}/grades`} />}>
            {t('viewGradebook')}
          </Button>
          <Button size="sm" variant="outline" render={<Link to={`/courses/${c.course.id}/admin`} />}>
            {t('manageCourse')}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-4 md:gap-6" data-testid="dashboard-teacher">
      <SectionHeading title={t('teacherSection')} />
      <TeacherGradingBlock />
      <SectionCards cards={cards} />
      <ChartAreaInteractive
        title={t('chartTeacherTitle')}
        description={t('chartTeacherDescription')}
        seriesLabel={t('chartTeacherSeries')}
        emptyText={t('chartNoData')}
        data={chartData}
      />
      <DataTable
        title={t('tableTeachingTitle')}
        data={teaching}
        columns={columns}
        getRowId={(c) => c.course.id}
        labels={{
          columns: t('tableColumns'),
          previous: t('tablePrevious'),
          next: t('tableNext'),
          empty: t('emptyTable'),
          filterPlaceholder: t('tableFilterPlaceholder'),
          pageInfo: (page, pages) => t('tablePageInfo', { page, pages }),
        }}
      />
    </section>
  );
}

/**
 * Khối học tập của học viên: khoá đang học lấy từ tầng quyền (ghi
 * danh), điểm của chính mình theo từng khoá tải lười tại khối này qua
 * `useCoursesGradeData` (F-02, rà soát #133); huy hiệu đã cấp
 * và thông báo chưa đọc gọi các endpoint tự phục vụ tương ứng; biểu đồ là
 * sự kiện lịch 30 ngày tới theo ngày. Học viên không bao giờ chạm endpoint
 * quản trị hay báo cáo lớp từ khối này.
 */
function StudentSection() {
  const { t, i18n } = useTranslation(['dashboard', 'app']);
  const perms = usePermissions();
  const prefs = useCourseCardPrefs();
  const learning = perms.learning;
  const gradeData = useCoursesGradeData(learning.map((c) => c.course.id));
  const gradebookOf = (c: CourseAccess) => gradeData.get(c.course.id)?.gradebook ?? null;
  // Huy hiệu, thông báo và sự kiện lịch là ba query độc lập chạy SONG
  // SONG — trước đây một effect await lần lượt từng endpoint nên thẻ
  // thống kê mọc nối tiếp và đẩy bố cục (nguồn CLS đội audit đo được).
  const badgesQuery = useQuery({
    queryKey: queryKeys.myBadges,
    queryFn: () => apiJson<unknown[]>('/api/v1/badges/mine'),
  });
  // Chỉ cần SỐ chưa đọc cho thẻ thống kê: dùng endpoint đếm riêng,
  // không tải toàn bộ lịch sử thông báo về rồi lọc phía client nữa
  // (trung tâm thông báo v2, issue #51).
  const notificationsQuery = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => apiJson<{ unread: number }>('/api/v1/notifications/unread-count'),
  });
  // Cửa sổ sự kiện 30 ngày: tính theo múi giờ ứng dụng qua helper
  // dùng chung với loader SL-1 của route `/` (trước đây lấy đúng mốc
  // tức thời lúc mount — key chứa mốc mili-giây thì loader phía
  // server không bao giờ tính lại trùng để dehydrate được; xem
  // `upcomingDaysRangeIso` ở lib/calendar.ts). Cửa sổ mới bắt đầu từ
  // 00:00 hôm nay nên phủ đúng ô ngày đầu của biểu đồ bên dưới.
  const eventRange = useMemo(() => upcomingDaysRangeIso(30), []);
  const eventsQuery = useQuery({
    queryKey: queryKeys.calendarEvents(eventRange.from, eventRange.to),
    queryFn: () => apiJson<CalendarEventView[]>(`/api/v1/calendar/events?from=${eventRange.from}&to=${eventRange.to}`),
  });

  const badgeCount = badgesQuery.data ? badgesQuery.data.length : null;
  const unread = notificationsQuery.data ? notificationsQuery.data.unread : null;
  const events = eventsQuery.data ?? [];

  const activityPcts: number[] = [];
  for (const access of learning) {
    for (const activity of gradebookOf(access)?.activities ?? []) {
      if (activity.grade?.finalGrade !== null && activity.grade?.finalGrade !== undefined && activity.item.gradeMax > 0) {
        activityPcts.push((activity.grade.finalGrade / activity.item.gradeMax) * 100);
      }
    }
  }
  const average =
    activityPcts.length > 0
      ? activityPcts.reduce((sum, pct) => sum + pct, 0) / activityPcts.length
      : null;

  // Lưới thẻ luôn đủ 4 ô: thẻ huy hiệu/thông báo giữ ô ở trạng thái
  // loading trong lúc query chạy và hiện "—" nếu nguồn lỗi, thay vì
  // biến mất rồi làm lưới co lại như trước.
  const cards: StatCard[] = [
    {
      id: 'student-courses',
      label: t('statLearningCourses'),
      value: String(learning.length),
      footer: t('statLearningFooter'),
    },
    {
      id: 'student-average',
      label: t('statAverageGrade'),
      value: average === null ? '—' : `${average.toFixed(1)}%`,
      footer: t('statAverageFooter', { count: activityPcts.length }),
    },
    {
      id: 'student-badges',
      label: t('statMyBadges'),
      value: badgeCount === null ? '—' : String(badgeCount),
      footer: t('statBadgesFooter'),
      loading: badgesQuery.isPending,
    },
    {
      id: 'student-unread',
      label: t('statUnread'),
      value: unread === null ? '—' : String(unread),
      footer: t('statUnreadFooter'),
      loading: notificationsQuery.isPending,
    },
  ];

  const chartData: ChartPoint[] = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: 30 }, (_, i) => {
      const day = new Date(start.getTime() + i * 86_400_000);
      const next = new Date(day.getTime() + 86_400_000);
      const value = events.filter((e) => {
        const at = new Date(e.timeStart);
        return at >= day && at < next;
      }).length;
      return { label: dayLabel(day, i18n.language), value };
    });
  }, [events, i18n.language]);

  const columns: DataColumn<CourseAccess>[] = [
    {
      id: 'course',
      header: t('colCourse'),
      cell: (c) => <Link to={`/courses/${c.course.id}`}>{displayCourseName(prefs.data?.get(c.course.id), c.course.fullName)}</Link>,
      sortValue: (c) => c.course.fullName,
    },
    {
      id: 'mygrade',
      header: t('colMyGrade'),
      cell: (c) => {
        const pcts = (gradebookOf(c)?.activities ?? [])
          .filter((a) => a.grade?.finalGrade !== null && a.grade?.finalGrade !== undefined && a.item.gradeMax > 0)
          .map((a) => (a.grade!.finalGrade! / a.item.gradeMax) * 100);
        if (!pcts.length) return '—';
        return `${(pcts.reduce((x, y) => x + y, 0) / pcts.length).toFixed(1)}%`;
      },
      sortValue: (c) => {
        const pcts = (gradebookOf(c)?.activities ?? [])
          .filter((a) => a.grade?.finalGrade !== null && a.grade?.finalGrade !== undefined && a.item.gradeMax > 0)
          .map((a) => (a.grade!.finalGrade! / a.item.gradeMax) * 100);
        return pcts.length ? pcts.reduce((x, y) => x + y, 0) / pcts.length : -1;
      },
    },
    {
      id: 'actions',
      header: t('colActions'),
      cell: (c) => (
        <span className="flex gap-2">
          <Button size="sm" variant="outline" render={<Link to={`/courses/${c.course.id}`} />}>
            {t('openCourse')}
          </Button>
          <Button size="sm" variant="outline" render={<Link to={`/courses/${c.course.id}/grades`} />}>
            {t('viewGradebook')}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-4 md:gap-6" data-testid="dashboard-student">
      <SectionHeading title={t('studentSection')} />
      <StudentTodoBlock />
      <SectionCards cards={cards} />
      <ChartAreaInteractive
        title={t('chartStudentTitle')}
        description={t('chartStudentDescription')}
        seriesLabel={t('chartStudentSeries')}
        emptyText={t('chartNoData')}
        data={chartData}
        ranges={[
          { value: '7', label: t('rangeDays', { count: 7 }), count: 7 },
          { value: '30', label: t('rangeDays', { count: 30 }), count: 30 },
        ]}
      />
      <DataTable
        title={t('tableLearningTitle')}
        data={learning}
        columns={columns}
        getRowId={(c) => c.course.id}
        labels={{
          columns: t('tableColumns'),
          previous: t('tablePrevious'),
          next: t('tableNext'),
          empty: t('emptyTable'),
          filterPlaceholder: t('tableFilterPlaceholder'),
          pageInfo: (page, pages) => t('tablePageInfo', { page, pages }),
        }}
      />
    </section>
  );
}

/**
 * Trang tổng quan sau đăng nhập (route `/` khi đã đăng nhập), khung trình
 * bày theo block dashboard-01. Nội dung CHIA THEO VAI TRÒ từ ảnh chụp
 * quyền: khối quản trị chỉ hiện với người có capability quản trị, khối
 * giảng dạy chỉ với người đang dạy ít nhất một khoá, khối học tập chỉ với
 * người đang học ít nhất một khoá. Người có nhiều vai trò thấy các khối
 * tương ứng xếp chồng — mỗi khối chỉ chứa chức năng vai trò đó thao tác
 * được, không có phần tử thừa dẫn tới 403.
 */
export function DashboardPage() {
  const { t } = useTranslation(['dashboard', 'app']);
  const { user } = useAuth();
  const perms = usePermissions();

  // Chưa phân loại được vai trò (ảnh chụp quyền + danh sách khoá đang
  // về — hai query song song) thì hiện khung giữ chỗ đúng hình học của
  // trang thay vì một dòng chữ "Đang tải…" chiếm cả trang như trước;
  // từng khối sau đó tự lấp dữ liệu theo query của nó.
  if (!perms.ready) {
    return <DashboardSkeleton />;
  }

  const hasBlocks = perms.canAdminister || perms.teaching.length > 0 || perms.learning.length > 0;
  const name = user ? `${user.firstName} ${user.lastName}`.trim() || user.username : '';

  return (
    // PageShell wide (1280px) theo §3.2; các khối bên trong tự giữ đệm
    // ngang px-4/lg:px-6 của riêng chúng nên PageShell tắt đệm của mình.
    <PageShell width="wide" className="px-0 lg:px-0">
      <h1 className="px-4 text-2xl font-semibold lg:px-6">{t('dashboard:welcome', { name })}</h1>
      {perms.canAdminister ? <AdminSection /> : null}
      {perms.teaching.length > 0 ? <TeacherSection /> : null}
      {perms.learning.length > 0 ? <StudentSection /> : null}
      {!hasBlocks ? (
        <div className="px-4 lg:px-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('dashboard:noBlocksTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-start gap-4">
              <p className="text-sm text-muted-foreground">{t('dashboard:noBlocksBody')}</p>
              <Button render={<Link to="/courses" />}>{t('dashboard:browseCourses')}</Button>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </PageShell>
  );
}
