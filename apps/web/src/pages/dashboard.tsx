import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { CourseCategoryTreeNode, Role, UserListResponse } from '@lms/contracts';
import '../i18n';
import { ApiError, apiJson } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePermissions, type CourseAccess } from '@/lib/permissions';
import { queryKeys } from '@/lib/query-keys';
import { DashboardSkeleton } from '@/components/dashboard-skeleton';
import { SectionCards, type StatCard } from '@/components/section-cards';
import { Skeleton } from '@lms/ui/components/ui/skeleton';
import { ChartAreaInteractive, type ChartPoint } from '@/components/chart-area-interactive';
import { DataTable, type DataColumn } from '@/components/data-table';
import { Badge } from '@lms/ui/components/ui/badge';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/ui/card';

/** Hình dạng sự kiện lịch mà trang này cần (khớp EventView của trang lịch). */
interface CalendarEventView {
  id: string;
  name: string;
  timestart: string;
}

/** Hình dạng thông báo mà trang này cần (khớp NotificationView của trang thông báo). */
interface NotificationLite {
  id: string;
  timeread: string | null;
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
 * đồ gom tài khoản theo tuần tạo từ `timecreated`.
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
        const created = new Date(u.timecreated);
        return created >= start && created < end;
      }).length;
      return { label: dayLabel(start, i18n.language), value };
    });
  }, [users, i18n.language]);

  const columns: DataColumn<UserListResponse['users'][number]>[] = [
    { id: 'username', header: t('app:username'), cell: (u) => u.username, sortValue: (u) => u.username },
    {
      id: 'fullname',
      header: t('dashboard:colFullName'),
      cell: (u) => `${u.firstname} ${u.lastname}`.trim(),
      sortValue: (u) => `${u.firstname} ${u.lastname}`,
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
            pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Khối giảng dạy: dựng hoàn toàn từ dữ liệu PermissionsProvider đã dò theo
 * từng khoá (báo cáo điểm toàn lớp). Thẻ "chưa có điểm" là hàng đợi chấm
 * thật — học viên trong báo cáo chưa có điểm tổng. Biểu đồ phân bố điểm
 * chuẩn hoá theo điểm tối đa của từng khoá (đọc từ sổ điểm của khoá đó).
 */
function TeacherSection() {
  const { t } = useTranslation('dashboard');
  const perms = usePermissions();
  const teaching = perms.teaching;

  const rows = teaching.flatMap((c) => c.report?.rows ?? []);
  const graded = rows.filter((r) => r.finalgrade !== null).length;
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
      const max = access.gradebook?.courseTotal?.item.grademax;
      if (!max || max <= 0) continue;
      for (const row of access.report?.rows ?? []) {
        if (row.finalgrade === null) continue;
        const pct = (row.finalgrade / max) * 100;
        const idx = buckets.findIndex((b) => pct >= b.min && pct < b.max);
        if (idx >= 0) counts[idx] = (counts[idx] ?? 0) + 1;
      }
    }
    return buckets.map((b, i) => ({ label: b.label, value: counts[i]! }));
  }, [teaching]);

  const columns: DataColumn<CourseAccess>[] = [
    {
      id: 'course',
      header: t('colCourse'),
      cell: (c) => <Link to={`/courses/${c.course.id}`}>{c.course.fullname}</Link>,
      sortValue: (c) => c.course.fullname,
    },
    {
      id: 'students',
      header: t('colStudents'),
      cell: (c) => String(c.report?.rows.length ?? 0),
      sortValue: (c) => c.report?.rows.length ?? 0,
    },
    {
      id: 'ungraded',
      header: t('colUngraded'),
      cell: (c) => String((c.report?.rows ?? []).filter((r) => r.finalgrade === null).length),
      sortValue: (c) => (c.report?.rows ?? []).filter((r) => r.finalgrade === null).length,
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
          pageInfo: (page, pages) => t('tablePageInfo', { page, pages }),
        }}
      />
    </section>
  );
}

/**
 * Khối học tập của học viên: khoá đang học và điểm của chính mình lấy từ
 * tầng quyền (ghi danh + sổ điểm cá nhân theo từng khoá); huy hiệu đã cấp
 * và thông báo chưa đọc gọi các endpoint tự phục vụ tương ứng; biểu đồ là
 * sự kiện lịch 30 ngày tới theo ngày. Học viên không bao giờ chạm endpoint
 * quản trị hay báo cáo lớp từ khối này.
 */
function StudentSection() {
  const { t, i18n } = useTranslation(['dashboard', 'app']);
  const perms = usePermissions();
  const learning = perms.learning;
  // Huy hiệu, thông báo và sự kiện lịch là ba query độc lập chạy SONG
  // SONG — trước đây một effect await lần lượt từng endpoint nên thẻ
  // thống kê mọc nối tiếp và đẩy bố cục (nguồn CLS đội audit đo được).
  const badgesQuery = useQuery({
    queryKey: queryKeys.myBadges,
    queryFn: () => apiJson<unknown[]>('/api/v1/badges/mine'),
  });
  const notificationsQuery = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => apiJson<NotificationLite[]>('/api/v1/notifications'),
  });
  const eventRange = useMemo(() => {
    const from = new Date();
    const to = new Date(from.getTime() + 30 * 86_400_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);
  const eventsQuery = useQuery({
    queryKey: queryKeys.calendarEvents(eventRange.from, eventRange.to),
    queryFn: () => apiJson<CalendarEventView[]>(`/api/v1/calendar/events?from=${eventRange.from}&to=${eventRange.to}`),
  });

  const badgeCount = badgesQuery.data ? badgesQuery.data.length : null;
  const unread = notificationsQuery.data ? notificationsQuery.data.filter((n) => n.timeread === null).length : null;
  const events = eventsQuery.data ?? [];

  const gradedTotals: { grade: number; max: number }[] = [];
  for (const access of learning) {
    const total = access.gradebook?.courseTotal;
    if (total?.grade?.finalgrade !== null && total?.grade?.finalgrade !== undefined && total.item.grademax > 0) {
      gradedTotals.push({ grade: total.grade.finalgrade, max: total.item.grademax });
    }
  }
  const average =
    gradedTotals.length > 0
      ? gradedTotals.reduce((sum, entry) => sum + (entry.grade / entry.max) * 100, 0) / gradedTotals.length
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
      footer: t('statAverageFooter', { count: gradedTotals.length }),
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
        const at = new Date(e.timestart);
        return at >= day && at < next;
      }).length;
      return { label: dayLabel(day, i18n.language), value };
    });
  }, [events, i18n.language]);

  const columns: DataColumn<CourseAccess>[] = [
    {
      id: 'course',
      header: t('colCourse'),
      cell: (c) => <Link to={`/courses/${c.course.id}`}>{c.course.fullname}</Link>,
      sortValue: (c) => c.course.fullname,
    },
    {
      id: 'mygrade',
      header: t('colMyGrade'),
      cell: (c) => {
        const total = c.gradebook?.courseTotal;
        if (!total?.grade) return '—';
        return `${total.grade.finalgrade ?? '—'} / ${total.item.grademax}`;
      },
      sortValue: (c) => c.gradebook?.courseTotal?.grade?.finalgrade ?? -1,
    },
    {
      id: 'letter',
      header: t('app:letter'),
      cell: (c) => c.gradebook?.courseTotal?.grade?.letter ?? '',
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
  const name = user ? `${user.firstname} ${user.lastname}`.trim() || user.username : '';

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
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
    </main>
  );
}
