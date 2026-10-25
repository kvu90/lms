import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import {
  COURSE_CARD_COLOR_HEX,
  COURSE_CARD_COLORS,
  saveCourseCardPref,
  type CourseCardColor,
  type CourseCardPrefView,
} from '#lib/course-cards';

/**
 * Panel sửa thẻ khoá tại dòng (DASH1, issue #121): chọn màu trong bảng màu
 * cố định + nhập biệt danh — chỉ áp cho chính người dùng đang đăng nhập,
 * tên gốc của khoá không đổi. Lưu xong gọi onSaved để trang cha cập nhật
 * ngay pref đang hiển thị.
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
  const [color, setColor] = useState<CourseCardColor | null>(initial?.color ?? null);
  const [nickname, setNickname] = useState(initial?.nickname ?? '');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async (nextColor: CourseCardColor | null, nextNickname: string | null) => {
    setSaving(true);
    setFailed(false);
    try {
      const pref = await saveCourseCardPref(courseId, { color: nextColor, nickname: nextNickname });
      onSaved(pref);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
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
        onClick={() => void save(color, nickname.trim() ? nickname.trim() : null)}
      >
        {t('cardPrefSave')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={saving}
        data-testid="card-pref-clear"
        onClick={() => void save(null, null)}
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
