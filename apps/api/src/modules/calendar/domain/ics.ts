/**
 * Serializer iCalendar (RFC 5545) cho calendar export — phía đối tác của
 * parser ICS phía worker (`apps/worker/src/domain/ics.ts`): cùng dùng dạng
 * ngày UTC `YYYYMMDDTHHMMSSZ`, cùng quy ước escape (\n cho xuống dòng, \,
 * cho dấu phẩy) để file export nhập lại được bằng chính parser đó.
 * Sự kiện lặp KHÔNG xuất RRULE: listing đã materialise từng occurrence
 * (và exception đã thay occurrence tương ứng) nên mỗi dòng sự kiện thành
 * một VEVENT độc lập, đúng nội dung người dùng đang thấy.
 */

/** Dữ liệu tối thiểu của một sự kiện cần để ghi VEVENT khi xuất lịch. */
export interface IcsExportEvent {
  id: string;
  name: string;
  description: string;
  location: string;
  timestart: Date;
  timeduration: number;
  timemodified: Date;
}

/**
 * Định dạng một mốc thời gian thành dạng UTC của ICS (`YYYYMMDDTHHMMSSZ`) —
 * dạng worker parser đọc lại được.
 */
export function formatIcsDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * Escape văn bản theo RFC 5545: gạch chéo, dấu chấm phẩy, dấu phẩy và ký tự
 * xuống dòng phải được escape trước khi đưa vào một dòng thuộc tính ICS.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Serialize danh sách sự kiện thành nội dung file .ics hoàn chỉnh
 * (VCALENDAR bọc các VEVENT, ngắt dòng CRLF). UID ổn định theo id của
 * sự kiện (`<id>@lms`) nên xuất lại nhiều lần không đổi danh tính sự kiện;
 * DTEND luôn có mặt: bằng DTSTART cộng timeduration (giây).
 */
export function serializeCalendar(events: IcsExportEvent[], options: { calName?: string } = {}): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LMS//Calendar Export//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  if (options.calName) lines.push(`X-WR-CALNAME:${escapeIcsText(options.calName)}`);
  for (const event of events) {
    const end = new Date(event.timestart.getTime() + Math.max(0, event.timeduration) * 1000);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.id}@lms`);
    lines.push(`DTSTAMP:${formatIcsDate(event.timemodified)}`);
    lines.push(`DTSTART:${formatIcsDate(event.timestart)}`);
    lines.push(`DTEND:${formatIcsDate(end)}`);
    lines.push(`SUMMARY:${escapeIcsText(event.name)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
