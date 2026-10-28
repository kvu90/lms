/**
 * Card quản trị mục điểm trên trang Điểm theo bài (pages/grades.tsx),
 * chỉ render cho staff của khoá: sửa tên/thang điểm từng mục, đặt
 * chính sách công bố, công bố/thu hồi công bố, xoá mục, và form tạo
 * mục điểm nhập tay mới. State sửa mục, state form tạo và thông báo
 * quản trị do file trang giữ; các thao tác ghi đi qua handler của
 * trang (đột biến của lib/course-grade-data) truyền xuống qua props.
 */
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { CourseActivityGrid, GradeItem } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { ErrorAlert } from '#components/error-alert';

/** Bản sửa tên/thang điểm đang soạn của một mục điểm. */
export interface GradeItemEdit {
  itemName: string;
  gradeMax: string;
}

/** Props của card quản trị mục điểm. */
export interface GradeItemsAdminCardProps {
  /** Các mục điểm của khoá (từ lưới lớp hoặc từ điểm của người dùng). */
  items: GradeItem[];
  /** Trạng thái công bố theo mục điểm (chính sách + đã công bố hay chưa). */
  publications: CourseActivityGrid['publications'];
  /** Thông báo kết quả của khu quản trị (null khi chưa có). */
  adminMessage: string | null;
  /** Bản sửa đang soạn theo id mục điểm. */
  itemEdits: Record<string, GradeItemEdit>;
  /** Cập nhật bản sửa đang soạn. */
  onItemEditsChange: Dispatch<SetStateAction<Record<string, GradeItemEdit>>>;
  /** Tên mục điểm mới trong form tạo. */
  newItemName: string;
  /** Cập nhật tên mục điểm mới. */
  onNewItemNameChange: (value: string) => void;
  /** Thang điểm của mục điểm mới trong form tạo. */
  newItemMax: string;
  /** Cập nhật thang điểm của mục điểm mới. */
  onNewItemMaxChange: (value: string) => void;
  /** Gửi form tạo mục điểm mới. */
  onCreateItem: (event: FormEvent) => Promise<void>;
  /** Lưu sửa tên/thang điểm của một mục. */
  onSaveItemEdit: (item: GradeItem) => Promise<void>;
  /** Xoá một mục điểm (trang hỏi xác nhận trước khi ghi). */
  onDeleteItem: (item: GradeItem) => Promise<void>;
  /** Đặt chính sách công bố của một bài. */
  onSetPostingPolicy: (item: GradeItem, policy: 'auto' | 'manual') => Promise<void>;
  /** Công bố / thu hồi công bố điểm của một bài. */
  onSetPublished: (item: GradeItem, published: boolean) => Promise<void>;
}

/**
 * Card quản trị mục điểm.
 *
 * @param props - Mục điểm, trạng thái công bố, state soạn thảo và các handler ghi của trang.
 * @returns Card danh sách mục điểm kèm thao tác quản trị và form tạo mục mới.
 */
export function GradeItemsAdminCard({
  items,
  publications,
  adminMessage,
  itemEdits,
  onItemEditsChange,
  newItemName,
  onNewItemNameChange,
  newItemMax,
  onNewItemMaxChange,
  onCreateItem,
  onSaveItemEdit,
  onDeleteItem,
  onSetPostingPolicy,
  onSetPublished,
}: GradeItemsAdminCardProps) {
  const { t } = useTranslation('app');
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{t('gradeItemsAdminTitle')}</CardTitle>
        <CardDescription>{t('gradeAdminDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {adminMessage && (
          <ErrorAlert className="mb-4">
            {adminMessage}
          </ErrorAlert>
        )}
        <ul className="divide-y">
          {items.map((item) => {
            const publication = publications[item.id] ?? { policy: 'auto' as const, published: true };
            const edit = itemEdits[item.id] ?? { itemName: item.itemName, gradeMax: String(item.gradeMax) };
            return (
              <li key={item.id} className="flex flex-wrap items-center gap-2 py-3">
                <Input
                  aria-label={t('gradeItemName')}
                  className="w-56"
                  value={edit.itemName}
                  onChange={(e) =>
                    onItemEditsChange((prev) => ({ ...prev, [item.id]: { ...edit, itemName: e.target.value } }))
                  }
                />
                <Input
                  aria-label={t('gradeItemMax')}
                  className="w-24"
                  type="number"
                  value={edit.gradeMax}
                  onChange={(e) =>
                    onItemEditsChange((prev) => ({ ...prev, [item.id]: { ...edit, gradeMax: e.target.value } }))
                  }
                />
                <span className="text-sm text-muted-foreground">{item.itemType}</span>
                <Select
                  value={publication.policy}
                  onValueChange={(value) => void onSetPostingPolicy(item, value as 'auto' | 'manual')}
                >
                  <SelectTrigger className="w-64" aria-label={t('gradesPostingPolicy')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{t('gradesPostingAuto')}</SelectItem>
                    <SelectItem value="manual">{t('gradesPostingManual')}</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" onClick={() => void onSaveItemEdit(item)}>
                  {t('saveGradeItem')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void onSetPublished(item, !publication.published)}>
                  {publication.published ? t('gradesUnpublish') : t('gradesPublish')}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => void onDeleteItem(item)}>
                  {t('deleteGradeItem')}
                </Button>
              </li>
            );
          })}
        </ul>
        <form onSubmit={onCreateItem} className="mt-4 flex flex-wrap items-end gap-2">
          <Field>
            <FieldLabel>{t('gradeItemName')}</FieldLabel>
            <Input
              id="grade-item-name"
              value={newItemName}
              onChange={(e) => onNewItemNameChange(e.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel>{t('gradeItemMax')}</FieldLabel>
            <Input
              id="grade-item-max"
              type="number"
              className="w-24"
              value={newItemMax}
              onChange={(e) => onNewItemMaxChange(e.target.value)}
              required
            />
          </Field>
          <Button type="submit">{t('createGradeItem')}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
