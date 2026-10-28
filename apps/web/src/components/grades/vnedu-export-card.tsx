/**
 * Card xuất vnEdu trên trang Điểm theo bài (pages/grades.tsx), chỉ
 * render cho staff của khoá: bảng gán loại cột cho từng mục điểm đủ
 * điều kiện, các trường học kỳ/năm học/môn/lớp và thông báo kết quả
 * xuất. Chỉ các bài ĐÃ CÔNG BỐ mới chọn được loại cột (mục chưa công
 * bố khóa chọn và hiện nhãn chưa công bố). State ánh xạ và các trường
 * thông tin xuất do file trang giữ; thao tác tải file do handler của
 * trang thực hiện (trang giữ lời gọi xuất qua apiFetch) và truyền
 * xuống qua props.
 */
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { CourseActivityGrid, GradeItem } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';

import { isVneduExportableItem, type VneduColumnKind } from './gradebook-helpers';

/** Props của card xuất vnEdu. */
export interface VneduExportCardProps {
  /** Các mục điểm của khoá (card tự lọc các mục đủ điều kiện xuất). */
  items: GradeItem[];
  /** Trạng thái công bố theo mục điểm (chỉ mục đã công bố mới chọn được). */
  publications: CourseActivityGrid['publications'];
  /** Ánh xạ mục điểm → loại cột vnEdu đang chọn. */
  vneduKinds: Record<string, VneduColumnKind>;
  /** Cập nhật ánh xạ loại cột. */
  onVneduKindsChange: Dispatch<SetStateAction<Record<string, VneduColumnKind>>>;
  /** Học kỳ xuất (chuỗi '1' hoặc '2'). */
  vneduSemester: string;
  /** Cập nhật học kỳ xuất. */
  onVneduSemesterChange: (value: string) => void;
  /** Năm học xuất (để trống thì server lấy mặc định từ khoá học). */
  vneduSchoolYear: string;
  /** Cập nhật năm học xuất. */
  onVneduSchoolYearChange: (value: string) => void;
  /** Tên môn xuất (để trống thì server lấy mặc định từ khoá học). */
  vneduSubject: string;
  /** Cập nhật tên môn xuất. */
  onVneduSubjectChange: (value: string) => void;
  /** Tên lớp xuất (để trống thì server lấy mặc định từ khoá học). */
  vneduClass: string;
  /** Cập nhật tên lớp xuất. */
  onVneduClassChange: (value: string) => void;
  /** Thông báo kết quả xuất (null khi chưa có). */
  vneduMessage: string | null;
  /** Gửi form xuất file vnEdu. */
  onDownload: (event: FormEvent) => Promise<void>;
}

/**
 * Card xuất vnEdu.
 *
 * @param props - Mục điểm, trạng thái công bố, state ánh xạ/trường xuất và handler tải file của trang.
 * @returns Card bảng gán loại cột và form thông tin xuất vnEdu.
 */
export function VneduExportCard({
  items,
  publications,
  vneduKinds,
  onVneduKindsChange,
  vneduSemester,
  onVneduSemesterChange,
  vneduSchoolYear,
  onVneduSchoolYearChange,
  vneduSubject,
  onVneduSubjectChange,
  vneduClass,
  onVneduClassChange,
  vneduMessage,
  onDownload,
}: VneduExportCardProps) {
  const { t } = useTranslation('app');
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{t('exportGradesVnedu')}</CardTitle>
        <CardDescription>{t('gradesVneduOnlyPublished')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onDownload}>
          <ul className="divide-y">
            {items.filter(isVneduExportableItem).map((item) => {
              const published = publications[item.id]?.published ?? false;
              return (
                <li key={item.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="w-56">{item.itemName}</span>
                  <Select
                    value={vneduKinds[item.id] ?? 'none'}
                    onValueChange={(value) =>
                      onVneduKindsChange((prev) => ({ ...prev, [item.id]: value as VneduColumnKind }))
                    }
                    disabled={!published}
                  >
                    <SelectTrigger className="w-48" aria-label={item.itemName}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('vneduKindNone')}</SelectItem>
                      <SelectItem value="regular">{t('vneduKindRegular')}</SelectItem>
                      <SelectItem value="midterm">{t('vneduKindMidterm')}</SelectItem>
                      <SelectItem value="final">{t('vneduKindFinal')}</SelectItem>
                    </SelectContent>
                  </Select>
                  {!published && <span className="text-sm text-muted-foreground">{t('gradesUnpublished')}</span>}
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <Field>
              <FieldLabel>{t('vneduSemester')}</FieldLabel>
              <Select value={vneduSemester} onValueChange={(value) => onVneduSemesterChange(value ?? '1')}>
                <SelectTrigger className="w-32" aria-label={t('vneduSemester')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1</SelectItem>
                  <SelectItem value="2">2</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>{t('vneduSchoolYear')}</FieldLabel>
              <Input value={vneduSchoolYear} onChange={(e) => onVneduSchoolYearChange(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>{t('vneduSubjectName')}</FieldLabel>
              <Input value={vneduSubject} onChange={(e) => onVneduSubjectChange(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>{t('vneduClassName')}</FieldLabel>
              <Input value={vneduClass} onChange={(e) => onVneduClassChange(e.target.value)} />
            </Field>
            <Button type="submit">{t('exportGradesVnedu')}</Button>
          </div>
          {vneduMessage && (
            <Alert className="mt-3">
              <AlertDescription>{vneduMessage}</AlertDescription>
            </Alert>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
