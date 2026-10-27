/**
 * Hỗ trợ RRULE tối thiểu (report §2#13: một chuỗi là MỘT chuỗi logic duy nhất với
 * các ngoại lệ, không phải N sự kiện rời rạc). Hỗ trợ: FREQ=DAILY|WEEKLY|MONTHLY
 * với COUNT hoặc UNTIL — tập con mà UI lặp lại của Moodle phơi bày
 * (lặp lại mỗi ngày/tuần/tháng, N lần hoặc cho tới một ngày).
 */
/**
 * Đặc tả lặp của sự kiện lịch: tần suất (DAILY/WEEKLY/MONTHLY/YEARLY), số lần (count) hoặc hạn cuối (until).
 */
export interface RruleSpec {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  count?: number;
  until?: Date;
}

/**
 * Phân tích RRULE (dạng chuỗi iCalendar hoặc object) thành RruleSpec.
 */
export function parseRrule(input: { freq?: string; count?: number; until?: string } | string): RruleSpec {
  if (typeof input === 'string') {
    const parts = Object.fromEntries(input.split(';').map((p) => {
      const [k, v] = p.split('=');
      return [k!.trim().toUpperCase(), v!.trim()];
    }));
    const freq = String(parts.FREQ ?? 'WEEKLY').toUpperCase();
    if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) throw new Error(`Unsupported RRULE FREQ ${freq}`);
    return {
      freq: freq as RruleSpec['freq'],
      count: parts.COUNT ? Number(parts.COUNT) : undefined,
      until: parts.UNTIL ? new Date(parts.UNTIL) : undefined,
    };
  }
  const freq = String(input.freq ?? 'WEEKLY').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) throw new Error(`Unsupported RRULE FREQ ${freq}`);
  return {
    freq: freq as RruleSpec['freq'],
    count: input.count,
    until: input.until ? new Date(input.until) : undefined,
  };
}

/**
 * Định dạng RruleSpec trở lại chuỗi RRULE chuẩn.
 */
export function formatRrule(spec: RruleSpec): string {
  const parts = [`FREQ=${spec.freq}`];
  if (spec.count !== undefined) parts.push(`COUNT=${spec.count}`);
  if (spec.until) parts.push(`UNTIL=${spec.until.toISOString()}`);
  return parts.join(';');
}

/**
 * Cộng một bước lặp vào một mốc thời gian theo tần suất.
 */
export function addStep(date: Date, freq: RruleSpec['freq']): Date {
  const next = new Date(date);
  if (freq === 'DAILY') next.setUTCDate(next.getUTCDate() + 1);
  else if (freq === 'WEEKLY') next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

/** Các thời điểm bắt đầu của các lần xuất hiện trong một chuỗi bắt đầu tại `start` (lần xuất hiện đầu tiên chính là `start`). */
/**
 * Sinh danh sách thời điểm bắt đầu của các occurrence trong chuỗi lặp, có hard cap chống lặp vô hạn.
 */
export function occurrenceStarts(start: Date, spec: RruleSpec, hardCap = 366): Date[] {
  const out: Date[] = [];
  let current = new Date(start);
  const max = spec.count ?? hardCap;
  while (out.length < max) {
    if (spec.until && current > spec.until) break;
    out.push(new Date(current));
    current = addStep(current, spec.freq);
    if (!spec.count && !spec.until) break; // không có count/until: chỉ một lần xuất hiện
  }
  return out;
}
