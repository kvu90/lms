import { useCallback } from 'react';
import { Link, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AssignmentForUserView } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { ManagePanel } from '../components/assignment/manage-panel';
import { RubricView } from '../components/assignment/rubric-view';
import { dateLabel } from '../components/assignment/shared';
import { StudentPanel } from '../components/assignment/student-panel';
import { TeacherPanel } from '../components/assignment/teacher-panel';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { assignmentQueryOptions, useAssignment } from '#lib/assignment-data';
import { queryClient } from '#lib/query-client';

/**
 * Trang hoạt động Bài tập nộp tệp/ảnh (mod_assign): một trang dùng
 * chung theo cờ quyền mà API đã phân giải — học sinh nộp bài và xem
 * kết quả sau khi trả bài; giáo viên xem danh sách bài nộp, chấm +
 * thả dấu vector + trả bài (từng em/theo đợt); người quản lý sửa cài
 * đặt và dựng bảng tiêu chí ngay tại trang.
 */
export function AssignmentPage() {
  const { t } = useTranslation('app');
  const { id: courseId, assignmentId } = useParams();
  // Dữ liệu trang qua TanStack (F-01 đợt 1): clientLoader của route đã
  // prefetch cùng khoá nên lần tải đầu thường có sẵn dữ liệu khi mount;
  // trạng thái chờ chuẩn hoá trên isPending với skeleton sẵn có (F-14).
  const assignmentQuery = useAssignment(assignmentId);
  const data: AssignmentForUserView | null = assignmentQuery.data ?? null;
  const queryClientInstance = useQueryClient();

  // Các panel con gọi reload sau mỗi hành động ghi: fetchQuery làm mới
  // cache (trang tự render lại dữ liệu mới) và VẪN ném lỗi như luồng
  // fetch thủ công trước đây để panel tự bắt và báo tại chỗ.
  const reload = useCallback(async () => {
    await queryClientInstance.fetchQuery(assignmentQueryOptions(assignmentId ?? ''));
  }, [queryClientInstance, assignmentId]);

  if (assignmentQuery.isError && !data) {
    return (
      <PageShell width="wide">
        <Alert variant="destructive">
          <AlertDescription>{t('assignLoadFailed')}</AlertDescription>
        </Alert>
        <p className="mt-3 text-sm">
          <Link to={`/courses/${courseId}`} className="underline">
            {t('assignBackToCourse')}
          </Link>
        </p>
      </PageShell>
    );
  }
  if (assignmentQuery.isPending || !data) {
    return (
      <PageShell width="wide">
        <div className="space-y-3" aria-label={t('assignLoading')}>
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </PageShell>
    );
  }

  const { assignment, rubric } = data;
  return (
    <PageShell width="wide">
      <PageHeader
        title={assignment.name}
        description={
          assignment.dueDate
            ? `${t('assignDueLine', { date: dateLabel(assignment.dueDate) })} · ${t('assignGradeScaleLine', { grade: assignment.grade })} · ${t(`assignResultMode_${assignment.resultMode}`)}`
            : `${t('assignNoDue')} · ${t('assignGradeScaleLine', { grade: assignment.grade })} · ${t(`assignResultMode_${assignment.resultMode}`)}`
        }
      />
      <p className="text-sm">
        <Link to={`/courses/${courseId}`} className="underline">
          {t('assignBackToCourse')}
        </Link>
      </p>
      {assignment.intro ? (
        <Card>
          <CardContent className="whitespace-pre-wrap text-sm">{assignment.intro}</CardContent>
        </Card>
      ) : null}
      {rubric && rubric.criteria.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{rubric.title ?? t('assignRubricTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <RubricView criteria={rubric.criteria} />
          </CardContent>
        </Card>
      ) : null}
      {data.canSubmit ? <StudentPanel data={data} reload={reload} /> : null}
      {data.canViewAllSubmissions || data.canGrade ? <TeacherPanel data={data} /> : null}
      {data.canManage ? <ManagePanel data={data} courseId={courseId!} reload={reload} /> : null}
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AssignmentPage;

/**
 * clientLoader (F-01 đợt 1 + bổ sung clientLoader, rà soát #133):
 * prefetch query chính vào QueryClient singleton dùng chung (đúng
 * khoá factory) trước khi component mount — điều hướng vào trang
 * không còn thác nước mount-rồi-fetch. prefetchQuery không ném lỗi:
 * tải hỏng thì component tự xử lý qua useQuery như trước.
 */
export async function clientLoader({ params }: { params: Record<string, string | undefined> }) {
  if (params.assignmentId) {
    await queryClient.prefetchQuery(assignmentQueryOptions(params.assignmentId));
  }
  return null;
}

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('contentType_mod_assign');
}
