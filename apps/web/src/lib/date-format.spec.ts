/**
 * Kiểm chứng helper định dạng ngày giờ dùng chung (lib/date-format): khóa
 * CHUỖI ĐẦU RA CHÍNH XÁC của từng khuôn hiển thị đã hợp nhất về helper,
 * với mốc thời gian cố định và cả hai ngôn ngữ giao diện đang dùng (vi,
 * en-US). Đây là bằng chứng cho yêu cầu "chuỗi ngày giờ hiển thị không
 * đổi" của đợt hợp nhất khuôn lặp: mỗi kỳ vọng dưới đây là đúng chuỗi mà
 * lời gọi `toLocale*` / `Intl.DateTimeFormat` gốc tại vị trí đã chuyển
 * sinh ra cho cùng đầu vào và locale.
 */
import { describe, expect, it } from 'vitest';

import { formatDate, formatDateTime, formatTime, formatWithOptions } from './date-format';

// Mốc cố định: 05/01/2026 14:30:00 giờ địa phương — ngày giờ có cả thành
// phần ngày, tháng, giờ, phút để mọi khuôn đều lộ đủ ký tự phân tách.
const MOMENT = new Date(2026, 0, 5, 14, 30, 0);
const MOMENT_ISO = MOMENT.toISOString();

describe('formatDate — khuôn ngày mặc định (toLocaleDateString)', () => {
  it('khóa chuỗi cho locale vi', () => {
    expect(formatDate(MOMENT, 'vi')).toBe('5/1/2026');
  });

  it('khóa chuỗi cho locale en-US', () => {
    expect(formatDate(MOMENT, 'en-US')).toBe('1/5/2026');
  });

  it('nhận cả chuỗi ISO và cho cùng kết quả như đối tượng Date', () => {
    expect(formatDate(MOMENT_ISO, 'vi')).toBe(formatDate(MOMENT, 'vi'));
    expect(formatDate(MOMENT_ISO, 'en-US')).toBe(formatDate(MOMENT, 'en-US'));
  });
});

describe('formatDateTime — khuôn ngày giờ mặc định (toLocaleString)', () => {
  it('khóa chuỗi cho locale vi', () => {
    expect(formatDateTime(MOMENT, 'vi')).toBe('14:30:00 5/1/2026');
  });

  it('khóa chuỗi cho locale en-US', () => {
    expect(formatDateTime(MOMENT, 'en-US')).toBe('1/5/2026, 2:30:00 PM');
  });

  it('nhận cả chuỗi ISO và cho cùng kết quả như đối tượng Date', () => {
    expect(formatDateTime(MOMENT_ISO, 'vi')).toBe(formatDateTime(MOMENT, 'vi'));
  });
});

describe('formatTime — khuôn giờ của trang lịch (giờ hai chữ số + phút)', () => {
  it('khóa chuỗi cho locale vi', () => {
    expect(formatTime(MOMENT, 'vi')).toBe('14:30');
  });

  it('khóa chuỗi cho locale en-US', () => {
    expect(formatTime(MOMENT, 'en-US')).toBe('02:30 PM');
  });
});

describe('formatWithOptions — các khuôn tùy chọn tường minh', () => {
  it('khóa nhãn ngày dd/MM của trang tổng quan', () => {
    const options: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit' };
    expect(formatWithOptions(MOMENT, 'vi', options)).toBe('05-01');
    expect(formatWithOptions(MOMENT, 'en-US', options)).toBe('01/05');
  });

  it('khóa nhãn ngày dd/MM/yyyy của bề mặt phụ huynh', () => {
    const options: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' };
    expect(formatWithOptions(MOMENT, 'vi', options)).toBe('05/01/2026');
    expect(formatWithOptions(MOMENT, 'en-US', options)).toBe('01/05/2026');
  });

  it('khóa nhãn ngày giờ ngắn (trang tổng quan và bề mặt phụ huynh)', () => {
    const options: Intl.DateTimeFormatOptions = {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    };
    expect(formatWithOptions(MOMENT, 'vi', options)).toBe('14:30 05-01');
    expect(formatWithOptions(MOMENT, 'en-US', options)).toBe('01/05, 02:30 PM');
  });

  it('khóa nhãn ngày dài của trang lịch (thứ + ngày + tháng + năm)', () => {
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    };
    expect(formatWithOptions(MOMENT, 'vi', options)).toBe('Thứ Hai, 5 tháng 1, 2026');
    expect(formatWithOptions(MOMENT, 'en-US', options)).toBe('Monday, January 5, 2026');
  });

  it('khóa tiêu đề tháng của trang lịch (tháng + năm)', () => {
    const options: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };
    expect(formatWithOptions(MOMENT, 'vi', options)).toBe('tháng 1 năm 2026');
    expect(formatWithOptions(MOMENT, 'en-US', options)).toBe('January 2026');
  });

  it('khóa khuôn dateStyle/timeStyle của khối assignment (locale để trình duyệt quyết)', () => {
    const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
    expect(formatWithOptions(MOMENT, 'vi', options)).toBe('14:30 5 thg 1, 2026');
    expect(formatWithOptions(MOMENT, 'en-US', options)).toBe('Jan 5, 2026, 2:30 PM');
  });
});
