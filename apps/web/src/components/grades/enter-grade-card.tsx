/**
 * Card nhập điểm trên trang Điểm theo bài (pages/grades.tsx), chỉ
 * render cho staff của khoá: form chọn bài, học sinh, điểm và phản
 * hồi để nhập/sửa điểm một bài cho một học sinh; khối lịch sử điểm
 * nằm ngay bên dưới trong cùng card — chọn bài + học sinh rồi xem
 * các lần ghi điểm của học viên đó trên mục điểm. State form, state
 * lịch sử và kết quả lịch sử do file trang giữ; thao tác ghi và tải
 * lịch sử đi qua handler của trang truyền xuống qua props.
 */
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { CourseActivityGrid, GradeItem } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { ErrorAlert } from '#components/error-alert';

import type { GradeHistoryView } from '#lib/course-grade-data';

/** Props của card nhập điểm (gồm khối lịch sử điểm). */
export interface EnterGradeCardProps {
  /** Các mục điểm của khoá (đích chọn của form nhập điểm và form lịch sử). */
  items: GradeItem[];
  /** Các dòng học sinh của lưới lớp (đích chọn học sinh ở cả hai form). */
  rows: CourseActivityGrid['rows'];
  /** Mục điểm đang chọn ở form nhập điểm. */
  gradeItemId: string;
  /** Cập nhật mục điểm đang chọn ở form nhập điểm. */
  onGradeItemIdChange: (value: string) => void;
  /** Học sinh đang chọn ở form nhập điểm. */
  gradeUserId: string;
  /** Cập nhật học sinh đang chọn ở form nhập điểm. */
  onGradeUserIdChange: (value: string) => void;
  /** Giá trị điểm đang nhập (chuỗi, trang chuyển số khi gửi). */
  gradeValue: string;
  /** Cập nhật giá trị điểm đang nhập. */
  onGradeValueChange: (value: string) => void;
  /** Phản hồi đang nhập kèm điểm. */
  gradeFeedback: string;
  /** Cập nhật phản hồi đang nhập. */
  onGradeFeedbackChange: (value: string) => void;
  /** Gửi form nhập/sửa điểm. */
  onSubmitGrade: (event: FormEvent) => Promise<void>;
  /** Mục điểm đang chọn ở form lịch sử. */
  historyItemId: string;
  /** Cập nhật mục điểm đang chọn ở form lịch sử. */
  onHistoryItemIdChange: (value: string) => void;
  /** Học sinh đang chọn ở form lịch sử. */
  historyUserId: string;
  /** Cập nhật học sinh đang chọn ở form lịch sử. */
  onHistoryUserIdChange: (value: string) => void;
  /** Các dòng lịch sử đã tải (null khi chưa tải hoặc đang tải lại). */
  historyRows: GradeHistoryView[] | null;
  /** Lỗi tải lịch sử (null khi không có lỗi). */
  historyError: string | null;
  /** Gửi form xem lịch sử điểm. */
  onLoadHistory: (event: FormEvent) => Promise<void>;
}

/**
 * Card nhập điểm và lịch sử điểm.
 *
 * @param props - State form nhập điểm, state lịch sử và các handler của trang.
 * @returns Card gồm form nhập điểm và khối lịch sử điểm bên dưới.
 */
export function EnterGradeCard({
  items,
  rows,
  gradeItemId,
  onGradeItemIdChange,
  gradeUserId,
  onGradeUserIdChange,
  gradeValue,
  onGradeValueChange,
  gradeFeedback,
  onGradeFeedbackChange,
  onSubmitGrade,
  historyItemId,
  onHistoryItemIdChange,
  historyUserId,
  onHistoryUserIdChange,
  historyRows,
  historyError,
  onLoadHistory,
}: EnterGradeCardProps) {
  const { t } = useTranslation('app');
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{t('enterGradeTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmitGrade}>
          <FieldGroup>
            <Field>
              <FieldLabel>{t('gradeItem')}</FieldLabel>
              <Select value={gradeItemId} onValueChange={(value) => onGradeItemIdChange(value ?? '')}>
                <SelectTrigger aria-label={t('gradeItem')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.itemName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>{t('gradesStudentColumn')}</FieldLabel>
              <Select value={gradeUserId} onValueChange={(value) => onGradeUserIdChange(value ?? '')}>
                <SelectTrigger aria-label={t('gradesStudentColumn')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rows.map((row) => (
                    <SelectItem key={row.userId} value={row.userId}>
                      {row.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>{t('gradeValue')}</FieldLabel>
              <Input value={gradeValue} onChange={(e) => onGradeValueChange(e.target.value)} inputMode="decimal" />
            </Field>
            <Field>
              <FieldLabel>{t('gradesFeedback')}</FieldLabel>
              <Input value={gradeFeedback} onChange={(e) => onGradeFeedbackChange(e.target.value)} />
            </Field>
          </FieldGroup>
          <Button type="submit" className="mt-3" disabled={!gradeItemId || !gradeUserId}>
            {t('saveGrade')}
          </Button>
        </form>

        <h3 className="mt-8 font-medium">{t('gradeHistoryTitle')}</h3>
        <p className="text-sm text-muted-foreground">{t('gradeHistoryDescription')}</p>
        <form onSubmit={onLoadHistory} className="mt-3 flex flex-wrap items-end gap-2">
          <Field>
            <FieldLabel>{t('gradeItem')}</FieldLabel>
            <Select value={historyItemId} onValueChange={(value) => onHistoryItemIdChange(value ?? '')}>
              <SelectTrigger aria-label={t('gradeItem')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.itemName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>{t('gradesStudentColumn')}</FieldLabel>
            <Select value={historyUserId} onValueChange={(value) => onHistoryUserIdChange(value ?? '')}>
              <SelectTrigger aria-label={t('gradesStudentColumn')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {rows.map((row) => (
                  <SelectItem key={row.userId} value={row.userId}>
                    {row.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button type="submit" variant="outline" disabled={!historyItemId || !historyUserId}>
            {t('viewHistory')}
          </Button>
        </form>
        {historyError && (
          <ErrorAlert variant="destructive" className="mt-3">
            {historyError}
          </ErrorAlert>
        )}
        {historyRows && (
          <ul className="mt-3 space-y-1 text-sm">
            {historyRows.map((row) => (
              <li key={row.id}>
                {row.updatedAt} · {row.finalGrade ?? '—'} · {row.source ?? ''}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
