import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@lms/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { ErrorAlert } from '#components/error-alert';
import {
  useCreateCurriculumRow, useCurriculumRow, useUpdateCurriculumRow,
} from '#lib/curriculum';
import { FormScreen } from './form-screen';
import { errorText } from '../utils/shared';

export function AdminCurriculumNewPage() {
  const { t } = useTranslation('app');
  const { subjectId } = useParams();
  const navigate = useNavigate();
  const [grade, setGrade] = useState('1');
  const [error, setError] = useState<string | null>(null);
  // Tạo chương trình qua đột biến của lib/curriculum (F-01 của rà
  // soát #133) — danh sách chương trình của môn được làm mới sau ghi.
  const createRow = useCreateCurriculumRow();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createRow.mutateAsync({ subjectId, grade: Number(grade) });
      navigate('/admin/curriculum');
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <FormScreen title={t('curriculumCreateCurriculum')} backTo="/admin/curriculum">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        {error ? (
          <ErrorAlert variant="destructive">
            {error}
          </ErrorAlert>
        ) : null}
        <div className="space-y-2">
          <span id="curriculum-grade-label" className="text-sm font-medium">
            {t('curriculumGrade')}
          </span>
          <Select items={Object.fromEntries(
              Array.from({ length: 12 }, (_, i) => i + 1).map((g) => [String(g), t('curriculumGradeLabel', { grade: g })]),
            )} value={grade} onValueChange={(v) => v && setGrade(v)}>
            <SelectTrigger aria-labelledby="curriculum-grade-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                <SelectItem key={g} value={String(g)}>
                  {t('curriculumGradeLabel', { grade: g })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit">{t('curriculumSave')}</Button>
      </form>
    </FormScreen>
  );
}

export function AdminCurriculumEditPage() {
  const { t } = useTranslation('app');
  const { curriculumId } = useParams();
  const navigate = useNavigate();
  const [grade, setGrade] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Đọc chương trình qua TanStack Query để lấy khối hiện tại làm giá
  // trị đầu của form; ghi qua đột biến sửa khối (F-01, rà soát #133).
  const rowQuery = useCurriculumRow(curriculumId);
  const updateRow = useUpdateCurriculumRow();
  const appliedRowId = useRef<string | null>(null);

  useEffect(() => {
    // Chỉ nạp khối vào form một lần cho mỗi chương trình mở ra —
    // không ghi đè lựa chọn đang sửa dở khi truy vấn chạy lại.
    if (rowQuery.data && appliedRowId.current !== rowQuery.data.id) {
      appliedRowId.current = rowQuery.data.id;
      setGrade(String(rowQuery.data.grade));
    }
  }, [rowQuery.data]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!curriculumId) return;
    try {
      await updateRow.mutateAsync({ curriculumId, grade: Number(grade) });
      navigate('/admin/curriculum');
    } catch (err) {
      setError(errorText(err, t('curriculumSaveFailed')));
    }
  }

  return (
    <FormScreen title={t('curriculumEditCurriculum')} backTo="/admin/curriculum">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        {error ? (
          <ErrorAlert variant="destructive">
            {error}
          </ErrorAlert>
        ) : null}
        <div className="space-y-2">
          <span id="curriculum-grade-edit-label" className="text-sm font-medium">
            {t('curriculumGrade')}
          </span>
          <Select items={Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => i + 1).map((g) => [String(g), t('curriculumGradeLabel', { grade: g })]),
          )} value={grade} onValueChange={(v) => v && setGrade(v)}>
            <SelectTrigger aria-labelledby="curriculum-grade-edit-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                <SelectItem key={g} value={String(g)}>
                  {t('curriculumGradeLabel', { grade: g })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit">{t('curriculumSave')}</Button>
      </form>
    </FormScreen>
  );
}
