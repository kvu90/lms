/**
 * Card lưới điểm của lớp trên trang Điểm theo bài
 * (`features/grades/routes/grades.tsx`):
 * lưới CHỈ-ĐỌC học sinh × các bài dành cho staff của khoá, kèm trạng
 * thái công bố dưới tên từng bài. Dữ liệu lưới do file trang nạp qua
 * hook dùng chung `src/hooks/use-courses-grade-data.ts` rồi truyền xuống nguyên khối; card
 * chỉ trình bày, không có thao tác ghi nào.
 */
import { useTranslation } from 'react-i18next';

import type { CourseActivityGrid } from '@lms/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';

import { scoreLabel } from '../utils/gradebook-helpers';

/** Props của card lưới điểm của lớp. */
export interface ClassGradesGridCardProps {
  /** Lưới điểm toàn lớp: các bài, trạng thái công bố và điểm từng học sinh. */
  report: CourseActivityGrid;
  /** Ngôn ngữ hiển thị hiện tại, dùng để định dạng số điểm. */
  locale: string;
}

/**
 * Card lưới điểm của lớp.
 *
 * @param props - Lưới điểm toàn lớp và ngôn ngữ hiển thị.
 * @returns Card bảng học sinh × các bài (chỉ-đọc).
 */
export function ClassGradesGridCard({ report, locale }: ClassGradesGridCardProps) {
  const { t } = useTranslation('app');
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{t('gradesGridTitle')}</CardTitle>
        <CardDescription>{t('gradesGridDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">{t('gradesStudentColumn')}</th>
                {report.items.map((item) => (
                  <th key={item.id} className="py-2 pr-4 font-medium">
                    {item.itemName}
                    <span className="block text-xs font-normal">
                      {report.publications[item.id]?.published ? t('gradesPublished') : t('gradesUnpublished')}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.userId} className="border-t">
                  <td className="py-2 pr-4">{row.displayName}</td>
                  {report.items.map((item) => (
                    <td key={item.id} className="py-2 pr-4">
                      {row.grades[item.id] !== null && row.grades[item.id] !== undefined
                        ? scoreLabel(row.grades[item.id]!, locale)
                        : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
