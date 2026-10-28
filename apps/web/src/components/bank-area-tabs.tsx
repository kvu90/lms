import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { cn } from '@lms/ui/lib/utils';
import type { BankArea } from '../pages/questions';
import '../i18n';

/**
 * Thanh tab Cá nhân | Hệ thống dùng CHUNG cho mọi màn danh sách ngân
 * hàng (quyết định chốt lại 11:40 ngày 26/10/2026, issue #228 — thay mục
 * "Ngân hàng hệ thống" riêng ở sidebar): mỗi loại thực thể (câu hỏi /
 * đề / ma trận) có đúng hai tab, dùng chung một khung danh sách, chỉ
 * khác nguồn dữ liệu của trang đích. Tab là ĐIỀU HƯỚNG theo route —
 * mỗi khu vực giữ path riêng theo chuẩn đường dẫn (issue #221), KHÔNG
 * dùng query định danh khu vực; tab đang đứng mang `aria-current`.
 * Vỏ tab bám đúng component Tabs dùng chung của @lms/ui (nền muted,
 * tab active nền background + shadow) nhưng render bằng Link vì đây
 * là điều hướng giữa hai trang, không phải chuyển panel tại chỗ.
 */
const BANK_TAB_PATHS: Record<'questions' | 'exams' | 'matrices', { personal: string; system: string }> = {
  questions: { personal: '/questions', system: '/system-bank/questions' },
  exams: { personal: '/exams', system: '/system-bank/exams' },
  matrices: { personal: '/matrices', system: '/system-bank/matrices' },
};

export function bankTabsForArea(area: BankArea): {
  personalPath: string;
  systemPath: string;
  active: 'personal' | 'system';
} {
  const entity =
    area === 'my-exams' || area === 'system-exams'
      ? 'exams'
      : area === 'my-matrices' || area === 'system-matrices'
        ? 'matrices'
        : 'questions';
  const paths = BANK_TAB_PATHS[entity];
  return {
    personalPath: paths.personal,
    systemPath: paths.system,
    active: area.startsWith('system') ? 'system' : 'personal',
  };
}

export function BankAreaTabs({ area }: { area: BankArea }) {
  const { t } = useTranslation('app');
  const tabs = bankTabsForArea(area);
  const items = [
    { key: 'personal', label: t('bankTabPersonal'), to: tabs.personalPath, active: tabs.active === 'personal' },
    { key: 'system', label: t('bankTabSystem'), to: tabs.systemPath, active: tabs.active === 'system' },
  ] as const;
  return (
    <nav
      aria-label={t('bankTabsLabel')}
      className="inline-flex h-9 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground"
    >
      {items.map((item) => (
        <Link
          key={item.key}
          to={item.to}
          aria-current={item.active ? 'page' : undefined}
          data-active={item.active || undefined}
          className={cn(
            'inline-flex h-[calc(100%-1px)] items-center justify-center rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all hover:text-foreground',
            'data-active:bg-background data-active:text-foreground data-active:shadow-sm dark:data-active:bg-input/30',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
