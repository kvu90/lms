import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResendMailService } from './resend-mail.service';

function configStub(values: Record<string, unknown>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const MESSAGE = {
  to: 'student@example.com',
  subject: 'Mã đăng nhập LMS của bạn',
  text: 'Mã của bạn là 123456',
  html: '<p>Mã của bạn là <b>123456</b></p>',
};

/**
 * Transport Resend (issue #7 chặng 2.5): có cấu hình thì gửi qua HTTP
 * API của Resend đúng hình đã khai; Resend lỗi thì ném để consumer
 * outbox thử lại; thiếu cấu hình thì fail-soft ghi log (không gọi
 * Resend, không ném) để app vẫn chạy ở môi trường chưa cấp khoá.
 */
describe('Khối ResendMailService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gửi qua Resend HTTP API với người gửi đã cấu hình', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 're_test_123' }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ResendMailService(
      configStub({ RESEND_API_KEY: 'rk_test_key', MAIL_FROM: 'LMS <no-reply@example.com>' }),
    );
    expect(service.configured).toBe(true);

    const result = await service.send(MESSAGE);

    expect(result).toEqual({ status: 'sent', providerId: 're_test_123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer rk_test_key');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'LMS <no-reply@example.com>',
      to: ['student@example.com'],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
  });

  it('ném lỗi khi Resend từ chối request, để consumer outbox thử lại được', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({}),
      text: async () => '{"message":"invalid from address"}',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ResendMailService(
      configStub({ RESEND_API_KEY: 'rk_test_key', MAIL_FROM: 'no-reply@example.com' }),
    );
    await expect(service.send(MESSAGE)).rejects.toThrow(/Resend API trả 422/);
  });

  it('bỏ qua không gọi Resend khi thiếu RESEND_API_KEY (fail-soft đã khai báo)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new ResendMailService(configStub({ MAIL_FROM: 'no-reply@example.com' }));
    expect(service.configured).toBe(false);
    const result = await service.send(MESSAGE);
    expect(result).toEqual({ status: 'skipped', reason: 'resend_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bỏ qua không gọi Resend khi thiếu MAIL_FROM', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new ResendMailService(configStub({ RESEND_API_KEY: 'rk_test_key' }));
    expect(service.configured).toBe(false);
    const result = await service.send(MESSAGE);
    expect(result).toEqual({ status: 'skipped', reason: 'mail_from_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
