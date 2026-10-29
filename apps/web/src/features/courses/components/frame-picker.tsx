import { Badge } from '@lms/ui/components/badge';
import { Checkbox } from '@lms/ui/components/checkbox';
import { useTranslation } from 'react-i18next';
import type { FrameUnit } from '#lib/curriculum';
import '#config/i18n';

/**
 * Danh sách tích chọn đơn vị khung chương trình để nạp vào khoá (K0a):
 * trình bày NHÓM THEO MẠCH NỘI DUNG như văn bản chương trình của Bộ —
 * đơn vị gốc (mạch) thành tiêu đề nhóm, các chủ đề nằm trong nhóm của
 * nó; mỗi đơn vị mở ra được danh sách Nội dung | Yêu cầu cần đạt của
 * các bài thuộc đơn vị (YCCĐ neo ở đơn vị tổ tiên gần nhất, không nhân
 * bản). Hành vi chọn giữ nguyên: tích vào đơn vị nào thì nạp cả
 * subtree của đơn vị đó. Dùng chung cho form tạo khoá (courses.tsx)
 * và panel nạp khung trong quản trị khoá (course-admin.tsx).
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
  // Nhóm theo đơn vị gốc (độ sâu 0): mỗi nhóm bắt đầu ở một đơn vị gốc
  // và gồm mọi đơn vị theo sau cho tới trước đơn vị gốc kế tiếp.
  const groups: FrameUnit[][] = [];
  for (const unit of units) {
    if (unit.depth === 0 || groups.length === 0) groups.push([unit]);
    else groups[groups.length - 1]!.push(unit);
  }

  function renderUnit(unit: FrameUnit, isGroupRoot: boolean) {
    const inputId = `${idPrefix}-${unit.nodeId}`;
    const checked = selected.includes(unit.nodeId);
    const outcomeTotal = unit.outcomeTexts.reduce((n, g) => n + g.texts.length, 0);
    return (
      <li
        key={unit.nodeId}
        className={`flex flex-wrap items-center gap-2 text-sm ${isGroupRoot ? 'rounded bg-muted/40 px-2 py-1 font-medium' : ''}`}
        style={{ paddingLeft: `${(isGroupRoot ? 0 : unit.depth) * 1.25}rem` }}
      >
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
        {outcomeTotal > 0 ? (
          <details className="basis-full pl-6">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t('frameOutcomeListLabel', { count: outcomeTotal })}
            </summary>
            <ul className="mt-1 flex flex-col gap-2">
              {unit.outcomeTexts.map((group) => (
                <li key={group.lesson}>
                  <span className="font-medium">{group.lesson}</span>
                  <ul className="list-inside list-disc pl-2 font-normal">
                    {group.texts.map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </li>
    );
  }

  return (
    <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto" aria-label={t('frameUnitsLabel')}>
      {groups.map((group) => (
        <li key={group[0]!.nodeId}>
          <ul className="flex flex-col gap-1">
            {group.map((unit, i) => renderUnit(unit, i === 0))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
