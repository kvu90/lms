import { Badge } from '@lms/ui/components/badge';
import { Checkbox } from '@lms/ui/components/checkbox';
import { useTranslation } from 'react-i18next';
import type { FrameUnit } from '#lib/curriculum';
import '../i18n';

/**
 * Danh sách tích chọn đơn vị khung chương trình để nạp vào khoá (K0a):
 * mỗi dòng là một chủ đề/mạch với số YCCĐ nó mang theo; thụt lề theo
 * độ sâu trong cây. Dùng chung cho form tạo khoá (courses.tsx) và panel
 * nạp khung trong quản trị khoá (course-admin.tsx).
 */
export function FrameUnitPicker({
  units,
  selected,
  onToggle,
  idPrefix,
}: {
  units: FrameUnit[];
  selected: string[];
  onToggle: (nodeId: string, checked: boolean) => void;
  idPrefix: string;
}) {
  const { t } = useTranslation('app');
  if (units.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('frameNoUnits')}</p>;
  }
  return (
    <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto" aria-label={t('frameUnitsLabel')}>
      {units.map((unit) => {
        const inputId = `${idPrefix}-${unit.nodeId}`;
        const checked = selected.includes(unit.nodeId);
        return (
          <li key={unit.nodeId} className="flex items-center gap-2 text-sm" style={{ paddingLeft: `${unit.depth * 1.25}rem` }}>
            <Checkbox
              id={inputId}
              aria-label={unit.title}
              checked={checked}
              onCheckedChange={(value) => onToggle(unit.nodeId, value === true)}
            />
            <label htmlFor={inputId} className="flex flex-wrap items-center gap-2">
              <span>{unit.title}</span>
              <Badge variant="secondary">{t('frameOutcomeCount', { count: unit.outcomeCount })}</Badge>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
