import { describe, expect, it } from 'vitest';
import { describeUserAgent } from './user-agent';

const UNKNOWN_LABEL = 'Không rõ';

/** Hàm dịch mẫu dùng trong test: đúng mẫu vi "{{browser}} trên {{os}}" của catalog. */
function formatDescription(browser: string, os: string): string {
  return `${browser} trên ${os}`;
}

describe('Hàm describeUserAgent', () => {
  it('mô tả Chrome trên Windows khi phân tích được cả trình duyệt và hệ điều hành', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        UNKNOWN_LABEL,
        formatDescription,
      ),
    ).toBe('Chrome trên Windows');
  });

  it('mô tả Chrome trên Linux', () => {
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0', UNKNOWN_LABEL, formatDescription)).toBe(
      'Chrome trên Linux',
    );
  });

  it('mô tả Safari trên macOS', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        UNKNOWN_LABEL,
        formatDescription,
      ),
    ).toBe('Safari trên macOS');
  });

  it('mô tả Mobile Safari trên iOS', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        UNKNOWN_LABEL,
        formatDescription,
      ),
    ).toBe('Mobile Safari trên iOS');
  });

  it('chỉ trả tên trình duyệt khi không phân tích được hệ điều hành', () => {
    expect(describeUserAgent('Mozilla/5.0 Firefox/140.0', UNKNOWN_LABEL, formatDescription)).toBe('Firefox');
  });

  it('trả nguyên chuỗi gốc khi không phân tích được gì', () => {
    expect(describeUserAgent('LMS mobile app', UNKNOWN_LABEL, formatDescription)).toBe('LMS mobile app');
  });

  it('rút gọn chuỗi gốc dài không phân tích được ở 48 ký tự kèm dấu ba chấm', () => {
    const raw = 'x'.repeat(60);
    expect(describeUserAgent(raw, UNKNOWN_LABEL, formatDescription)).toBe(`${'x'.repeat(48)}…`);
  });

  it('trả nhãn không rõ khi user-agent là null', () => {
    expect(describeUserAgent(null, UNKNOWN_LABEL, formatDescription)).toBe(UNKNOWN_LABEL);
  });

  it('trả nhãn không rõ khi user-agent rỗng hoặc chỉ khoảng trắng', () => {
    expect(describeUserAgent('', UNKNOWN_LABEL, formatDescription)).toBe(UNKNOWN_LABEL);
    expect(describeUserAgent('   ', UNKNOWN_LABEL, formatDescription)).toBe(UNKNOWN_LABEL);
  });
});
