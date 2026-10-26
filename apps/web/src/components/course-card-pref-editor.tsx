import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import {
  COURSE_CARD_COLOR_HEX,
  COURSE_CARD_COLORS,
  useSaveCourseCardPref,
  type CourseCardColor,
  type CourseCardPrefView,
} from '#lib/course-cards';

/**
 * Panel sửa thẻ khoá tại dòng (DASH1, issue #121): chọn màu trong bảng màu
 * cố định + nhập biệt danh — chỉ áp cho chính người dùng đang đăng nhập,
 * tên gốc của khoá không đổi. Lưu qua mutation `useSaveCourseCardPref`
 * (F-04, rà soát #133): mutation tự invalidate khoá `courseCards` trong
 * TanStack cache nên dashboard (đọc pref qua `useCourseCardPrefs`) tươi
 * lại pref mới; trang cha vẫn nhận pref qua onSaved để cập nhật ngay
 * danh sách đang hiển thị. Lỗi lưu hiện tại chỗ, nút khoá trong lúc lưu.
 */
export function CourseCardPrefEditor({
  courseId,
  initial,
  onSaved,
  onCancel,
}: {
  courseId: string;
  initial: CourseCardPrefView | undefined;
  onSaved: (pref: CourseCardPrefView) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('app');
  const savePref = useSaveCourseCardPref();
  const [color, setColor] = useState<CourseCardColor | null>(initial?.color ?? null);
  const [nickname, setNickname] = useState(initial?.nickname ?? '');
  const saving = savePref.isPending;
  const failed = savePref.isError;

  const save = (nextColor: CourseCardColor | null, nextNickname: string | null) => {
    savePref.mutate(
      { courseId, body: { color: nextColor, nickname: nextNickname } },
      { onSuccess: (pref) => onSaved(pref) },
    );
  };

  return (
    <span
      className="mt-1 flex flex-wrap items-center gap-2"
      data-testid="course-card-pref-editor"
    >
      <span className="flex items-center gap-1" role="radiogroup" aria-label={t('cardPrefColor')}>
        {COURSE_CARD_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            title={c}
            data-testid={`card-color-${c}`}
            onClick={() => setColor(color === c ? null : c)}
            className={`h-5 w-5 rounded-full border ${color === c ? 'ring-2 ring-offset-1' : ''}`}
            style={{ backgroundColor: COURSE_CARD_COLOR_HEX[c] }}
          />
        ))}
      </span>
      <Input
        value={nickname}
        onChange={(e) => setNickname(e.target.value)}
        placeholder={t('cardPrefNicknamePlaceholder')}
        maxLength={60}
        className="h-8 w-44"
        data-testid="card-pref-nickname"
        aria-label={t('cardPrefNickname')}
      />
      <Button
        size="sm"
        disabled={saving}
        data-testid="card-pref-save"
        onClick={() => save(color, nickname.trim() ? nickname.trim() : null)}
      >
        {t('cardPrefSave')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={saving}
        data-testid="card-pref-clear"
        onClick={() => save(null, null)}
      >
        {t('cardPrefClear')}
      </Button>
      <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
        {t('cardPrefCancel')}
      </Button>
      {failed && <span className="text-sm text-destructive">{t('cardPrefFailed')}</span>}
    </span>
  );
}
