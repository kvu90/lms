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
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">{t('gradeItem')}</th>
                <th className="py-2 pr-4 font-medium">{t('grade')}</th>
                <th className="py-2 pr-4 font-medium">{t('gradesFeedback')}</th>
                <th className="py-2 font-medium">{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {activities.map(({ item, grade, publication }) => (
                <tr key={item.id} className="border-t">
                  <td className="py-2 pr-4">{item.itemName}</td>
                  <td className="py-2 pr-4">
                    {grade?.finalGrade !== null && grade?.finalGrade !== undefined
                      ? `${scoreLabel(grade.finalGrade, locale)} / ${scoreLabel(item.gradeMax, locale)}`
                      : '—'}
                  </td>
                  <td className="py-2 pr-4">{grade?.feedback ?? ''}</td>
                  <td className="py-2">{publication.published ? t('gradesPublished') : t('gradesUnpublished')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
