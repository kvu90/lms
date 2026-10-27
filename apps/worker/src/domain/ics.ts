/**
 * Phân tích ICS (RFC 5545) cơ bản cho việc nhập lịch đăng ký (calendar subscription) — ở
 * mức "parse cơ bản": mở các dòng tiếp nối (unfold), đọc các khối VEVENT,
 * trích xuất UID/SUMMARY/DESCRIPTION/DTSTART/DTEND. Ngày tháng hỗ trợ
 * dạng UTC (…Z) và các dạng floating/date mà chính test fixtures của Moodle dùng
 * (oracle: calendar/tests/lib_test test_add_subscription, trong đó các fixture —
 * Outlook 2010, OSX Yosemite, Google Gmail, repeated events — mỗi fixture nhập
 * đúng các VEVENT của nó).
 */
/**
 * Một sự kiện đọc từ file iCalendar (.ics) khi nhập lịch đăng ký (subscription import).
 */
export interface IcsEvent {
  uid: string;
  summary: string;
  description: string;
  start: Date;
  end?: Date;
}

/**
 * Phân tích mốc thời gian ICS (dạng UTC hoặc floating) thành Date; undefined khi không hợp lệ.
 */
export function parseIcsDate(value: string): Date | undefined {
  const v = value.trim();
  const dateTime = /^(\d{4})(\d{2})(\d{2})[Tt](\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (dateTime) {
    const [, y, mo, d, h, mi, s, z] = dateTime;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : 'Z'}`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    const parsed = new Date(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Phân tích toàn bộ nội dung .ics thành danh sách sự kiện (VEVENT) phục vụ đồng bộ lịch.
 */
export function parseIcs(ics: string): IcsEvent[] {
  // Mở dòng tiếp nối (unfold): các dòng bắt đầu bằng khoảng trắng/tab là phần tiếp nối của dòng trước.
  const lines = ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r\n|\n|\r/);
  const events: IcsEvent[] = [];
  let current: Record<string, string> | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line === 'END:VEVENT') {
      if (current) {
        const start = current.DTSTART ? parseIcsDate(current.DTSTART) : undefined;
        if (start) {
          events.push({
            uid: current.UID ?? `no-uid-${events.length}-${start.getTime()}`,
            summary: current.SUMMARY ?? '(no summary)',
            description: current.DESCRIPTION ?? '',
            start,
            end: current.DTEND ? parseIcsDate(current.DTEND) : undefined,
          });
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).split(';')[0]!.toUpperCase();
    current[key] = line.slice(colon + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',');
  }
  return events;
}
