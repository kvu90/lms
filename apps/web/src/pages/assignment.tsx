import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
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
import { apiJson } from '#lib/api';

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
  const [data, setData] = useState<AssignmentForUserView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const fresh = await apiJson<AssignmentForUserView>(`/api/v1/assignments/${assignmentId}`);
    setData(fresh);
  }, [assignmentId]);

  useEffect(() => {
    void reload().catch(() => setError(t('assignLoadFailed')));
  }, [reload, t]);

  if (error) {
    return (
      <PageShell width="wide">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <p className="mt-3 text-sm">
          <Link to={`/courses/${courseId}`} className="underline">
            {t('assignBackToCourse')}
          </Link>
        </p>
      </PageShell>
    );
  }
  if (!data) {
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

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('contentType_mod_assign');
}
