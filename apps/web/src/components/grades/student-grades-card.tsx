/**
 * Card điểm của chính người dùng trên trang Điểm theo bài
 * (pages/grades.tsx): bảng từng bài của người dùng hiện tại — điểm,
 * phản hồi và trạng thái công bố của từng bài. Chỉ bài đã công bố mới
 * hiện điểm (dữ liệu do file trang nạp qua hook của
 * lib/course-grade-data rồi truyền xuống; card chỉ trình bày).
 */
import { useTranslation } from 'react-i18next';

import type { ActivityGradeView } from '@lms/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';

import { DataTable, type DataColumn } from '#components/data-table';

import { scoreLabel } from './gradebook-helpers';

/** Props của card điểm của chính người dùng. */
export interface StudentGradesCardProps {
  /** Các bài của người dùng trong khoá (điểm + trạng thái công bố từng bài). */
  activities: ActivityGradeView[];
  /** Ngôn ngữ hiển thị hiện tại, dùng để định dạng số điểm. */
  locale: string;
}

/**
 * Card điểm của chính người dùng.
 *
 * @param props - Danh sách bài kèm điểm của người dùng và ngôn ngữ hiển thị.
 * @returns Card bảng điểm từng bài, hoặc trạng thái rỗng khi chưa có bài nào.
 */
export function StudentGradesCard({ activities, locale }: StudentGradesCardProps) {
  const { t } = useTranslation('app');
  // Cột của bảng điểm từng bài trên bảng dùng chung: đúng bốn cột và
  // nội dung ô của bảng tự vẽ trước đây (điểm chỉ hiện khi đã có điểm
  // cuối, kèm mức tối đa của mục điểm; trạng thái đọc từ công bố).
  const columns: DataColumn<ActivityGradeView>[] = [
    { id: 'item', header: t('gradeItem'), cell: ({ item }) => item.itemName },
    {
      id: 'grade',
      header: t('grade'),
      cell: ({ item, grade }) =>
        grade?.finalGrade !== null && grade?.finalGrade !== undefined
          ? `${scoreLabel(grade.finalGrade, locale)} / ${scoreLabel(item.gradeMax, locale)}`
          : '—',
    },
    { id: 'feedback', header: t('gradesFeedback'), cell: ({ grade }) => grade?.feedback ?? '' },
    {
      id: 'status',
      header: t('status'),
      cell: ({ publication }) => (publication.published ? t('gradesPublished') : t('gradesUnpublished')),
    },
  ];
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{t('myGradesTitle')}</CardTitle>
        <CardDescription>{t('myGradesDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {activities.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t('gradesNoActivities')}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <DataTable
            data={activities}
            columns={columns}
            labels={{
              columns: t('dashboard:tableColumns'),
              previous: t('dashboard:tablePrevious'),
              next: t('dashboard:tableNext'),
              empty: t('dashboard:emptyTable'),
              pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
            }}
            getRowId={({ item }) => item.id}
            pageSize={100}
          />
        )}
      </CardContent>
    </Card>
  );
}
