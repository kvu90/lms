/**
 * Minimal RRULE support (report §2#13: a series is ONE logical series with
 * exceptions, not N unrelated events). Supported: FREQ=DAILY|WEEKLY|MONTHLY
 * with COUNT or UNTIL — the subset Moodle's repeat UI exposes
 * (repeat every day/week/month, N times or until a date).
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

/** Occurrence start times for a series beginning at `start` (the first occurrence is `start` itself). */
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
    if (!spec.count && !spec.until) break; // no count/until: single occurrence
  }
  return out;
}
