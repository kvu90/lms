import { formatWithOptions } from '#lib/date-format';

// Khuôn dùng chung của các bề mặt Bài tập (trang assignment và các panel con).

export const selectClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';

/** Định dạng mốc thời gian ISO cho người đọc (theo ngôn ngữ trình duyệt). */
export function dateLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatWithOptions(d, undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

